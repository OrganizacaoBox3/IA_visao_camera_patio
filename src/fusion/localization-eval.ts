export interface LocalizationEvalPoint {
  x: number;
  y: number;
}

export interface LocalizationEvalSample {
  tag: string;
  ts: number;
  split: string;
  source: string;
  real: LocalizationEvalPoint;
  estimated: LocalizationEvalPoint | null;
  accepted: boolean;
  /** Ausente significa que este mecanismo nao instrumentou clamp. */
  clamped?: boolean;
  rejectionReason?: string;
}

export interface WilsonInterval95 {
  low: number;
  high: number;
}

export interface ProportionMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
  wilson95: WilsonInterval95 | null;
}

export interface DistributionMetric {
  n: number;
  p50: number | null;
  p90: number | null;
}

export type EvaluationEvidenceStatus =
  | "measured"
  | "empty-split"
  | "no-accepted-estimates";

export interface EvaluationEvidence {
  status: EvaluationEvidenceStatus;
  /** Nao e um veredito de qualidade; apenas diz se ha evidencia para comparar metas. */
  canClaimSuccess: boolean;
  reason: string | null;
}

export interface LocalizationEvalSlice {
  evidence: EvaluationEvidence;
  sampleCount: number;
  publishedCount: number;
  coverage: ProportionMetric;
  rejectedRate: ProportionMetric;
  rejectedByReason: Record<string, ProportionMetric>;
  /** Null quando nenhum ponto publicado carregou a flag de instrumentacao. */
  clampedRate: ProportionMetric | null;
  errorM: DistributionMetric;
  stationaryJitterM: DistributionMetric;
  impossibleJumps: ProportionMetric;
}

export interface LocalizationEvaluation {
  split: string;
  availableSplits: string[];
  ignoredOtherSplits: number;
  sampleCount: number;
  evidence: EvaluationEvidence;
  overall: LocalizationEvalSlice;
  bySource: Record<string, LocalizationEvalSlice>;
}

export interface LocalizationEvalOptions {
  /** Split unico a avaliar. O chamador precisa nomea-lo para impedir mistura treino/teste. */
  split: string;
  maxJumpSpeedMps: number;
  stationaryGroundTruthSpeedMps?: number;
  maxTransitionGapMs?: number;
  minStationarySamples?: number;
}

interface ResolvedOptions {
  split: string;
  maxJumpSpeedMps: number;
  stationaryGroundTruthSpeedMps: number;
  maxTransitionGapMs: number;
  minStationarySamples: number;
}

const DEFAULT_STATIONARY_GROUND_TRUTH_SPEED_MPS = 0.05;
const DEFAULT_MIN_STATIONARY_SAMPLES = 2;
const WILSON_95_Z = 1.96;

export function wilsonInterval95(
  numerator: number,
  denominator: number,
): WilsonInterval95 | null {
  if (
    !Number.isInteger(numerator) ||
    !Number.isInteger(denominator) ||
    denominator < 0 ||
    numerator < 0 ||
    numerator > denominator
  ) {
    throw new RangeError("Wilson exige contagens inteiras com 0 <= numerator <= denominator.");
  }
  if (denominator === 0) return null;

  const p = numerator / denominator;
  const z2 = WILSON_95_Z * WILSON_95_Z;
  const denominatorAdjusted = 1 + z2 / denominator;
  const center = (p + z2 / (2 * denominator)) / denominatorAdjusted;
  const halfWidth =
    (WILSON_95_Z / denominatorAdjusted) *
    Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator));

  return {
    low: Math.max(0, center - halfWidth),
    high: Math.min(1, center + halfWidth),
  };
}

export function evaluateLocalizationSequence(
  samples: readonly LocalizationEvalSample[],
  options: LocalizationEvalOptions,
): LocalizationEvaluation {
  const resolved = resolveOptions(options);
  samples.forEach(validateSample);

  const availableSplits = [...new Set(samples.map((row) => row.split))].sort();
  const selected = samples.filter((row) => row.split === resolved.split);
  const overall = evaluateSlice(selected, resolved, true);

  const groupedBySource = groupBy(selected, (row) => row.source);
  const bySource = Object.fromEntries(
    [...groupedBySource.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, rows]) => [source, evaluateSlice(rows, resolved, false)]),
  );

  return {
    split: resolved.split,
    availableSplits,
    ignoredOtherSplits: samples.length - selected.length,
    sampleCount: selected.length,
    evidence: overall.evidence,
    overall,
    bySource,
  };
}

function evaluateSlice(
  rows: readonly LocalizationEvalSample[],
  options: ResolvedOptions,
  isWholeSplit: boolean,
): LocalizationEvalSlice {
  const published = rows.filter(hasPublishedPosition);
  const rejected = rows.filter((row) => !row.accepted);
  const instrumentedPublished = published.filter((row) => typeof row.clamped === "boolean");
  const errors = published.map((row) => distance(row.real, row.estimated));
  const impossibleJumps = calculateImpossibleJumps(rows, options);
  const stationaryJitter = calculateStationaryJitter(rows, options);

  const rejectedByReason = Object.fromEntries(
    [...groupBy(rejected, (row) => normalizedReason(row.rejectionReason)).entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([reason, rejectedForReason]) => [
        reason,
        proportion(rejectedForReason.length, rows.length),
      ]),
  );

  return {
    evidence: evidenceFor(rows.length, published.length, options.split, isWholeSplit),
    sampleCount: rows.length,
    publishedCount: published.length,
    coverage: proportion(published.length, rows.length),
    rejectedRate: proportion(rejected.length, rows.length),
    rejectedByReason,
    clampedRate:
      instrumentedPublished.length === 0
        ? null
        : proportion(
            instrumentedPublished.filter((row) => row.clamped).length,
            instrumentedPublished.length,
          ),
    errorM: distribution(errors),
    stationaryJitterM: distribution(stationaryJitter),
    impossibleJumps: proportion(impossibleJumps.count, impossibleJumps.transitions),
  };
}

function evidenceFor(
  sampleCount: number,
  publishedCount: number,
  split: string,
  isWholeSplit: boolean,
): EvaluationEvidence {
  if (sampleCount === 0) {
    return {
      status: "empty-split",
      canClaimSuccess: false,
      reason: isWholeSplit
        ? `O split '${split}' nao contem amostras elegiveis.`
        : "Este recorte nao contem amostras elegiveis.",
    };
  }
  if (publishedCount === 0) {
    return {
      status: "no-accepted-estimates",
      canClaimSuccess: false,
      reason: "Nenhuma posicao aceita foi publicada por este recorte.",
    };
  }
  return { status: "measured", canClaimSuccess: true, reason: null };
}

function calculateImpossibleJumps(
  rows: readonly LocalizationEvalSample[],
  options: ResolvedOptions,
): { count: number; transitions: number } {
  let count = 0;
  let transitions = 0;
  const series = groupBy(rows, (row) => `${row.source}\u0000${row.tag}`);

  for (const samples of series.values()) {
    const published = samples.filter(hasPublishedPosition).sort((a, b) => a.ts - b.ts);
    for (let index = 1; index < published.length; index += 1) {
      const previous = published[index - 1];
      const current = published[index];
      const deltaMs = current.ts - previous.ts;
      if (deltaMs <= 0 || deltaMs > options.maxTransitionGapMs) continue;

      transitions += 1;
      const speedMps = distance(previous.estimated, current.estimated) / (deltaMs / 1_000);
      if (speedMps > options.maxJumpSpeedMps) count += 1;
    }
  }

  return { count, transitions };
}

function calculateStationaryJitter(
  rows: readonly LocalizationEvalSample[],
  options: ResolvedOptions,
): number[] {
  const jitter: number[] = [];
  const series = groupBy(rows, (row) => `${row.source}\u0000${row.tag}`);

  for (const samples of series.values()) {
    const ordered = [...samples].sort((a, b) => a.ts - b.ts);
    if (ordered.length < options.minStationarySamples) continue;

    let stationaryRun: LocalizationEvalSample[] = [ordered[0]];
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      const deltaMs = current.ts - previous.ts;
      const isComparable = deltaMs > 0 && deltaMs <= options.maxTransitionGapMs;
      const groundTruthSpeed = isComparable
        ? distance(previous.real, current.real) / (deltaMs / 1_000)
        : Number.POSITIVE_INFINITY;

      if (groundTruthSpeed <= options.stationaryGroundTruthSpeedMps) {
        stationaryRun.push(current);
      } else {
        appendRunJitter(stationaryRun, options.minStationarySamples, jitter);
        stationaryRun = [current];
      }
    }
    appendRunJitter(stationaryRun, options.minStationarySamples, jitter);
  }

  return jitter;
}

function appendRunJitter(
  run: readonly LocalizationEvalSample[],
  minimumSamples: number,
  output: number[],
): void {
  if (run.length < minimumSamples) return;
  const published = run.filter(hasPublishedPosition);
  if (published.length < minimumSamples) return;

  const center = {
    x: percentile(
      published.map((row) => row.estimated.x),
      0.5,
    ),
    y: percentile(
      published.map((row) => row.estimated.y),
      0.5,
    ),
  };
  for (const row of published) output.push(distance(row.estimated, center));
}

function distribution(values: readonly number[]): DistributionMetric {
  if (values.length === 0) return { n: 0, p50: null, p90: null };
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p90: percentile(values, 0.9),
  };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) throw new RangeError("Percentil exige pelo menos um valor.");
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const fraction = position - lowerIndex;
  return sorted[lowerIndex] + (sorted[upperIndex] - sorted[lowerIndex]) * fraction;
}

function proportion(numerator: number, denominator: number): ProportionMetric {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
    wilson95: wilsonInterval95(numerator, denominator),
  };
}

function hasPublishedPosition(
  row: LocalizationEvalSample,
): row is LocalizationEvalSample & { estimated: LocalizationEvalPoint } {
  return row.accepted && row.estimated !== null;
}

function distance(left: LocalizationEvalPoint, right: LocalizationEvalPoint): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function normalizedReason(reason: string | undefined): string {
  const normalized = reason?.trim();
  return normalized ? normalized : "unspecified";
}

function groupBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }
  return groups;
}

function resolveOptions(options: LocalizationEvalOptions): ResolvedOptions {
  const split = options.split.trim();
  if (!split) throw new RangeError("O split de avaliacao deve ser informado.");
  if (!Number.isFinite(options.maxJumpSpeedMps) || options.maxJumpSpeedMps <= 0) {
    throw new RangeError("maxJumpSpeedMps deve ser finito e maior que zero.");
  }

  const stationaryGroundTruthSpeedMps =
    options.stationaryGroundTruthSpeedMps ?? DEFAULT_STATIONARY_GROUND_TRUTH_SPEED_MPS;
  if (!Number.isFinite(stationaryGroundTruthSpeedMps) || stationaryGroundTruthSpeedMps < 0) {
    throw new RangeError("stationaryGroundTruthSpeedMps deve ser finito e nao negativo.");
  }

  const maxTransitionGapMs = options.maxTransitionGapMs ?? Number.POSITIVE_INFINITY;
  if (!(maxTransitionGapMs > 0)) {
    throw new RangeError("maxTransitionGapMs deve ser maior que zero.");
  }

  const minStationarySamples =
    options.minStationarySamples ?? DEFAULT_MIN_STATIONARY_SAMPLES;
  if (!Number.isInteger(minStationarySamples) || minStationarySamples < 2) {
    throw new RangeError("minStationarySamples deve ser um inteiro maior ou igual a 2.");
  }

  return {
    split,
    maxJumpSpeedMps: options.maxJumpSpeedMps,
    stationaryGroundTruthSpeedMps,
    maxTransitionGapMs,
    minStationarySamples,
  };
}

function validateSample(row: LocalizationEvalSample, index: number): void {
  if (!row.tag.trim()) throw new TypeError(`Amostra ${index}: tag vazia.`);
  if (!row.source.trim()) throw new TypeError(`Amostra ${index}: source vazio.`);
  if (!row.split.trim()) throw new TypeError(`Amostra ${index}: split vazio.`);
  if (!Number.isFinite(row.ts)) throw new TypeError(`Amostra ${index}: ts invalido.`);
  validatePoint(row.real, `Amostra ${index}: ground truth`);
  if (row.estimated !== null) validatePoint(row.estimated, `Amostra ${index}: estimativa`);
}

function validatePoint(point: LocalizationEvalPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new TypeError(`${label} deve ter x e y finitos.`);
  }
}
