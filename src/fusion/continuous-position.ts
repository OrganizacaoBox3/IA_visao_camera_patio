// Orquestra fontes de posição sem misturar seus significados: a classificação de zona continua
// independente, o WKNN fornece X,Y primário e a geometria só entra quando passou pelos próprios gates.
import type { Classification, Confidence, Match } from "./fingerprint";
import type { FloorplanTag, FloorplanView } from "./floorplan";
import {
  createMotionTrack,
  updateMotionTrack,
  type MotionState,
  type MotionTrack,
  type PositionObservation,
  type PositionPoint,
} from "./motion-filter";

export type DisplayPositionSource = "fingerprint" | "multilateration" | "two-circle" | "none";
export type ContinuousFloorplanTag = FloorplanTag & {
  displaySource: DisplayPositionSource;
  confidence: Confidence;
  uncertaintyM: number;
  motionState: MotionState;
  zoneLabel: string | null;
  evidenceTs: number | null;
};
export type ContinuousFloorplanView = Omit<FloorplanView, "tags"> & {
  tags: ContinuousFloorplanTag[];
};

export type PositionCandidate = {
  pos: PositionPoint | null;
  source: DisplayPositionSource;
  confidence: Confidence;
  uncertaintyM: number;
  zoneLabel: string | null;
  evidenceTs: number | null;
};

const finitePoint = (p: PositionPoint | null | undefined): p is PositionPoint =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

function distinctPositionedMatches(ranked: Match[]): Match[] {
  const labels = new Set<string>();
  const out: Match[] = [];
  for (const match of ranked) {
    const key = match.label.trim().toUpperCase();
    if (labels.has(key) || !Number.isFinite(match.x) || !Number.isFinite(match.y)) continue;
    labels.add(key);
    out.push(match);
  }
  return out;
}

/** Dispersão dos pontos que participaram do WKNN. É halo diagnóstico, não intervalo estatístico. */
export function fingerprintUncertainty(classification: Classification): number {
  if (!classification.pos) return 0;
  const matches = distinctPositionedMatches(classification.ranked).slice(0, 3);
  if (matches.length < 2) return 1;
  let weightedSquare = 0;
  let weight = 0;
  for (const match of matches) {
    const w = 1 / Math.max(2, match.dist) ** 2;
    const d = Math.hypot(match.x! - classification.pos.x, match.y! - classification.pos.y);
    weightedSquare += w * d * d;
    weight += w;
  }
  return Math.max(0.5, Math.sqrt(weightedSquare / weight));
}

export function selectPositionCandidate(
  geometric: FloorplanTag,
  classification?: Classification,
  floor?: { widthM: number; heightM: number },
): PositionCandidate {
  const zoneLabel = classification?.best?.label ?? null;
  const evidenceTs = classification?.evidence.newestMeasuredAt ?? null;
  const fpPos = classification?.pos;
  const inside =
    finitePoint(fpPos) &&
    (!floor ||
      (fpPos.x >= 0 && fpPos.x <= floor.widthM && fpPos.y >= 0 && fpPos.y <= floor.heightM));
  if (
    inside &&
    classification &&
    (classification.confidence === "alta" || classification.confidence === "media")
  ) {
    return {
      pos: fpPos,
      source: "fingerprint",
      confidence: classification.confidence,
      uncertaintyM: fingerprintUncertainty(classification),
      zoneLabel,
      evidenceTs,
    };
  }

  if (
    finitePoint(geometric.pos) &&
    (geometric.quality === "good" || geometric.quality === "estimated")
  ) {
    return {
      pos: geometric.pos,
      source: geometric.source === "two-circle" ? "two-circle" : "multilateration",
      confidence: geometric.quality === "good" ? "media" : "baixa",
      uncertaintyM: Math.max(0.5, geometric.residualM ?? geometric.residualLimitM ?? 1),
      zoneLabel,
      evidenceTs,
    };
  }

  return {
    pos: null,
    source: "none",
    confidence: classification?.confidence ?? "nenhuma",
    uncertaintyM: 0,
    zoneLabel,
    evidenceTs,
  };
}

/** Estado por tag que atravessa os polls: o filtro de movimento + a FONTE corrente (para a
 *  histerese de troca) + identidade para re-exibir a tag como "última posição conhecida" quando o
 *  rádio cala (a view geométrica só produz tags OUVIDAS — sem isto, tag calada some abruptamente). */
export type TagRuntime = {
  motion: MotionTrack;
  label: string;
  source: DisplayPositionSource;
  /** Polls consecutivos em que o candidato veio de OUTRA fonte (base da histerese de troca). */
  sourceStreak: number;
  /** Última vez que a tag apareceu na view (ouvida por alguma antena). */
  lastSeenTs: number;
};

/** Downgrade fingerprint→geometria só após K polls consecutivos — evita o ping-pong de fonte
 *  (geometrias diferentes = salto visual) quando a confiança do fingerprint oscila na borda. */
const SOURCE_SWITCH_POLLS = 3;
/** Tag calada segue visível como "última posição conhecida · incerta" por até isto. */
const GHOST_TTL_MS = 60_000;
/** Crescimento do halo do fantasma (m/s) — mesmo ritmo do filtro de movimento. */
const GHOST_UNCERTAINTY_GROWTH_MPS = 0.25;

const isGeometric = (s: DisplayPositionSource) => s === "multilateration" || s === "two-circle";

export function deriveContinuousFloorplan(
  view: FloorplanView,
  classifications: ReadonlyMap<string, Classification>,
  previous: ReadonlyMap<string, TagRuntime>,
  now = Date.now(),
): { view: ContinuousFloorplanView; tracks: Map<string, TagRuntime> } {
  const tracks = new Map<string, TagRuntime>();
  const tags = view.tags.map((tag): ContinuousFloorplanTag => {
    const classification = classifications.get(tag.mac) ?? classifications.get(tag.mac.toUpperCase());
    const rawCandidate = selectPositionCandidate(tag, classification, view);
    const old = previous.get(tag.mac.toUpperCase());

    // ── Histerese de FONTE: o downgrade fingerprint→geometria só é aceito após K polls
    // consecutivos oferecendo a geometria. Enquanto espera, a observação vira "sem posição" e o
    // HOLD do filtro segura a última posição fingerprint — sem ping-pong entre geometrias. O
    // caminho inverso (→fingerprint, a fonte primária da doutrina) troca imediatamente. ──
    let candidate = rawCandidate;
    let sourceStreak = 0;
    let source = rawCandidate.source;
    if (old && old.source === "fingerprint" && isGeometric(rawCandidate.source)) {
      sourceStreak = old.sourceStreak + 1;
      if (sourceStreak < SOURCE_SWITCH_POLLS) {
        candidate = { ...rawCandidate, pos: null, source: "none", confidence: "nenhuma" };
        source = old.source; // segue "fingerprint" até a troca se confirmar
      }
    }

    const observation: PositionObservation = {
      ts: candidate.evidenceTs ?? now,
      pos: candidate.pos,
      confidence: candidate.confidence,
      uncertaintyM: candidate.uncertaintyM,
    };
    const track = old ? updateMotionTrack(old.motion, observation) : createMotionTrack(observation);
    tracks.set(tag.mac.toUpperCase(), {
      motion: track,
      label: tag.label,
      source: candidate.source === "none" ? source : candidate.source,
      sourceStreak: candidate.source === "none" ? sourceStreak : 0,
      lastSeenTs: now,
    });
    return {
      ...tag,
      pos: track.pos,
      fix: track.pos ? (candidate.confidence === "alta" ? "ok" : "weak") : "none",
      displaySource: candidate.source,
      confidence: candidate.confidence,
      uncertaintyM: track.uncertaintyM,
      motionState: track.state,
      zoneLabel: candidate.zoneLabel,
      evidenceTs: candidate.evidenceTs,
    };
  });

  // ── FANTASMAS (última posição conhecida): tag que SUMIU das leituras (rádio calou/antena caiu)
  // permanece visível por GHOST_TTL_MS como estado "incerto" com halo crescendo — em vez de
  // desaparecer abruptamente (requisito R10; estabilidade C3). A posição exibida é a última
  // publicada/confiável, NUNCA recalculada; o runtime não é mutado (derivação de leitura). ──
  for (const [mac, runtime] of previous) {
    if (tracks.has(mac)) continue;
    const silentMs = now - runtime.lastSeenTs;
    if (silentMs > GHOST_TTL_MS) continue; // morre de vez (o prune natural)
    tracks.set(mac, runtime); // preserva o estado para a volta ser re-entrada limitada, não reset
    const heldPos = runtime.motion.pos ?? runtime.motion.lastPos;
    if (!heldPos) continue; // nunca teve posição — nada a manter no mapa
    tags.push({
      mac,
      label: runtime.label,
      pos: heldPos,
      fix: "none", // não é solução geométrica atual — é memória (o desenho pinta por motionState)
      nStations: 0,
      nearest: null,
      residualM: null,
      residualLimitM: null,
      quality: "invalid",
      source: "multilateration",
      modelSource: "default",
      displaySource: "none",
      confidence: "nenhuma",
      uncertaintyM: runtime.motion.uncertaintyM + GHOST_UNCERTAINTY_GROWTH_MPS * (silentMs / 1_000),
      motionState: "incerto",
      zoneLabel: null,
      evidenceTs: null,
    } as ContinuousFloorplanTag);
  }

  return { view: { ...view, tags }, tracks };
}
