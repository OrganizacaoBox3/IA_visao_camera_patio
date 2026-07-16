// FINGERPRINTING de RSSI — localização indoor por ASSINATURA, não por geometria. Núcleo PURO
// (sem DOM/React), testável. É a rota (B) validada em campo: a trilateração por RSSI é refutada
// (multipath + ganhos de antena diferentes + saturação além de ~2 m), MAS o VETOR de RSSI das N
// antenas num ponto é uma assinatura estável e discriminante daquele ponto. Em vez de calcular
// distância/posição a partir de um modelo de rádio (que mente), casamos o vetor VIVO contra um
// SURVEY de pontos conhecidos (kNN no espaço de dB). Os ganhos de antena e o multipath ficam
// EMBUTIDOS nas assinaturas — o que quebrava a trilateração aqui é absorvido de graça.
//
// Verdade-terreno medida (3+ rodadas de empilhamento): o sinal "qual antena/assinatura" é 100%
// confiável; o X,Y métrico não é. Então o fingerprint entrega ZONA (o ponto de survey mais parecido)
// com confiança, e opcionalmente uma posição CONTÍNUA por média ponderada (WKNN) quando os pontos de
// survey têm coordenada — sem prometer precisão de fita métrica.
//
// Responsabilidade única: agregar amostras num fingerprint e classificar um vetor vivo contra o
// banco. Captura (UI), persistência (server/bt/fingerprints.js) e leitura ao vivo vivem à parte.

import type { Vec2 } from "../vision/homography";

/** Assinatura por antena: média/desvio/contagem do RSSI naquele ponto. std guia a confiança futura. */
export type FingerprintVec = Record<string, { mean: number; std: number; n: number }>;
/** Um ponto de survey: rótulo (nome da zona/lugar), posição opcional em metros, e a assinatura. */
export type Fingerprint = {
  id: string;
  label: string;
  x?: number;
  y?: number;
  vec: FingerprintVec;
  createdAt: number;
};
/** Vetor VIVO: o RSSI atual de cada antena que ouve a tag (stationId → rssi dBm). */
export type LiveVec = Record<string, number>;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const srcKey = (id: string): string => id.toUpperCase(); // casa stationId entre survey e vivo (MAIÚSC)

/**
 * Agrega amostras cruas (por antena: lista de RSSI capturados num ponto) numa assinatura mean/std/n.
 * Descarta antenas sem amostra válida. É o que a captura do survey grava como `vec` do fingerprint.
 */
export function aggregateSamples(samples: Record<string, number[]>): FingerprintVec {
  const out: FingerprintVec = {};
  for (const [id, arr] of Object.entries(samples || {})) {
    const vals = (Array.isArray(arr) ? arr : []).filter(isFiniteNum);
    if (!vals.length) continue;
    const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
    const varc = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length;
    out[srcKey(id)] = { mean, std: Math.sqrt(varc), n: vals.length };
  }
  return out;
}

/** Uma medição física de RSSI, com identidade temporal fornecida pelo hub. */
export type TaggedRssiSample = {
  stationId: string;
  mac: string;
  rssi: number;
  measuredAt: number;
};

export type AggregateEvidence = {
  nDistinct: number;
  nTags: number;
  oldestMeasuredAt?: number;
  newestMeasuredAt?: number;
  byStation: Record<string, { nDistinct: number; nTags: number }>;
};

const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

/**
 * Agrega medições identificadas sem transformar repetição de snapshot em evidência. Dentro de
 * cada antena, cada tag contribui com sua mediana e todas as tags têm o mesmo peso, mesmo quando uma
 * delas anunciou mais vezes. O desvio preserva a variação entre tags e o ruído robusto dentro delas.
 */
export function aggregateTaggedSamples(
  samples: readonly TaggedRssiSample[],
): { vec: FingerprintVec; evidence: AggregateEvidence } {
  const seen = new Set<string>();
  const tags = new Set<string>();
  const byStation = new Map<string, Map<string, number[]>>();
  let oldestMeasuredAt = Infinity;
  let newestMeasuredAt = -Infinity;

  for (const sample of samples) {
    const stationId = srcKey(String(sample?.stationId ?? "").trim());
    const mac = srcKey(String(sample?.mac ?? "").trim());
    if (!stationId || !mac || !isFiniteNum(sample?.rssi) || !isFiniteNum(sample?.measuredAt)) continue;
    const identity = `${stationId}|${mac}|${sample.measuredAt}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    tags.add(mac);
    oldestMeasuredAt = Math.min(oldestMeasuredAt, sample.measuredAt);
    newestMeasuredAt = Math.max(newestMeasuredAt, sample.measuredAt);
    const station = byStation.get(stationId) ?? new Map<string, number[]>();
    const tagSamples = station.get(mac) ?? [];
    tagSamples.push(sample.rssi);
    station.set(mac, tagSamples);
    byStation.set(stationId, station);
  }

  const vec: FingerprintVec = {};
  const stationEvidence: AggregateEvidence["byStation"] = {};
  for (const [stationId, station] of byStation) {
    const tagStats = [...station.values()].map((values) => {
      const center = median(values);
      const mad = median(values.map((value) => Math.abs(value - center)));
      return { center, robustStd: 1.4826 * mad, n: values.length };
    });
    const mean = tagStats.reduce((sum, stat) => sum + stat.center, 0) / tagStats.length;
    const variance =
      tagStats.reduce(
        (sum, stat) => sum + (stat.center - mean) ** 2 + stat.robustStd ** 2,
        0,
      ) / tagStats.length;
    const n = tagStats.reduce((sum, stat) => sum + stat.n, 0);
    vec[stationId] = { mean, std: Math.sqrt(variance), n };
    stationEvidence[stationId] = { nDistinct: n, nTags: tagStats.length };
  }

  return {
    vec,
    evidence: {
      nDistinct: seen.size,
      nTags: tags.size,
      ...(Number.isFinite(oldestMeasuredAt) ? { oldestMeasuredAt, newestMeasuredAt } : {}),
      byStation: stationEvidence,
    },
  };
}

export type Match = {
  id: string;
  label: string;
  x?: number;
  y?: number;
  /** Distância no espaço de RSSI (RMS em dB sobre as antenas COMPARTILHADAS) — menor = mais parecido. */
  dist: number;
  /** Quantas antenas o vivo e o fingerprint têm em comum (base da comparação). */
  shared: number;
};
export type Confidence = "alta" | "media" | "baixa" | "nenhuma";
export type LiveEvidence = {
  liveStations: number;
  oldestMeasuredAt?: number;
  newestMeasuredAt?: number;
  skewMs?: number;
};
export type ClassificationEvidence = LiveEvidence & {
  comparedFingerprints: number;
  distinctLabels: number;
  bestShared: number;
};
export type Classification = {
  /** Melhor casamento (menor distância) ou null se nada comparável. */
  best: Match | null;
  /** Todos os candidatos comparáveis, do mais parecido ao menos (para depuração/UI). */
  ranked: Match[];
  confidence: Confidence;
  /** Margem em dB entre o 2º e o 1º (quanto o melhor "ganha"); maior = mais confiante. */
  margin: number;
  /** Posição contínua estimada (WKNN dos top-k com coordenada), ou null. NÃO é métrica precisa. */
  pos: Vec2 | null;
  /** Evidência efetivamente usada; permite à UI separar medição de inferência. */
  evidence: ClassificationEvidence;
};

export type ClassifyOpts = {
  /** Vizinhos para a posição WKNN (default 3). */
  k?: number;
  /** Mínimo de antenas compartilhadas p/ um fingerprint entrar na comparação (default 2). */
  minShared?: number;
  /** Margem (dB) p/ confiança ALTA / MÉDIA (default 6 / 3). Abaixo de baixa>0. */
  altaDb?: number;
  mediaDb?: number;
  /** AJUSTE ABSOLUTO (RMS dB): o vivo tem de estar PERTO da assinatura, não só ser o menos pior.
   *  <= nearFitDb = bate bem (candidato a ALTA); > farFitDb = NÃO bate com nenhuma zona (→ BAIXA).
   *  Sem isso, um vivo LONGE de tudo classificaria "alto" só por ser o único/menos ruim (bug real:
   *  uma tag noutra zona batia "alta" na única zona calibrada). Medido: em-zona ~5-9 dB (ruído de
   *  13 dB entre tags coladas); entre-zonas ~30-40 dB. Defaults 10 / 18. */
  nearFitDb?: number;
  farFitDb?: number;
  /** Piso/teto do desvio por antena: evita singularidade e também que uma fonte ruidosa suma do cálculo. */
  stdFloorDb?: number;
  stdCapDb?: number;
  /** Piso da distância no WKNN: casamento exato não pode gerar peso infinito. */
  wknnFloorDb?: number;
  /** Frescor/sincronia medidos pelo chamador que montou o vetor vivo. */
  evidence?: Partial<LiveEvidence>;
};

/**
 * Distância RMS em dB entre o vetor vivo e um fingerprint, SÓ sobre as antenas em comum (as ausentes
 * não entram — o vivo pode não ouvir todas). Devolve null se compartilham menos que `minShared`
 * (comparar por 1 antena só é frágil: vira "antena mais próxima", não fingerprint).
 */
function rssiDistance(
  live: LiveVec,
  fp: Fingerprint,
  minShared: number,
  stdFloorDb: number,
  stdCapDb: number,
): { dist: number; shared: number } | null {
  const liveKeys = new Map(Object.entries(live).map(([id, r]) => [srcKey(id), r] as const));
  let weightedSquareSum = 0;
  let weightSum = 0;
  let shared = 0;
  for (const [id, cell] of Object.entries(fp.vec)) {
    const lv = liveKeys.get(srcKey(id));
    if (!isFiniteNum(lv) || !cell || !isFiniteNum(cell.mean)) continue;
    const rawStd = isFiniteNum(cell.std) ? Math.abs(cell.std) : stdCapDb;
    const effectiveStd = Math.min(stdCapDb, Math.max(stdFloorDb, rawStd));
    const weight = 1 / (effectiveStd * effectiveStd);
    weightedSquareSum += weight * (lv - cell.mean) ** 2;
    weightSum += weight;
    shared++;
  }
  if (shared < minShared || weightSum <= 0) return null;
  return { dist: Math.sqrt(weightedSquareSum / weightSum), shared };
}

/**
 * Classifica um vetor VIVO de RSSI contra o banco de fingerprints. Devolve o ponto de survey mais
 * parecido (best), o ranking, a confiança pela MARGEM (distância do 2º menos a do 1º) e uma posição
 * contínua por WKNN quando os pontos têm coordenada. Robusto a banco vazio / vivo esparso.
 */
export function classify(live: LiveVec, db: readonly Fingerprint[], opts: ClassifyOpts = {}): Classification {
  const k = opts.k ?? 3;
  const minShared = opts.minShared ?? 2;
  const altaDb = opts.altaDb ?? 6;
  const mediaDb = opts.mediaDb ?? 3;
  const nearFitDb = opts.nearFitDb ?? 10;
  const farFitDb = opts.farFitDb ?? 18;
  const stdFloorDb = Math.max(0.1, opts.stdFloorDb ?? 2);
  const stdCapDb = Math.max(stdFloorDb, opts.stdCapDb ?? 12);
  const wknnFloorDb = Math.max(0.1, opts.wknnFloorDb ?? 2);

  const ranked: Match[] = [];
  for (const fp of Array.isArray(db) ? db : []) {
    if (!fp || !fp.vec) continue;
    const d = rssiDistance(live || {}, fp, minShared, stdFloorDb, stdCapDb);
    if (!d) continue;
    ranked.push({ id: fp.id, label: fp.label, x: fp.x, y: fp.y, dist: d.dist, shared: d.shared });
  }
  // Ordena por distância (empate → mais antenas compartilhadas ganha, mais evidência).
  ranked.sort((a, b) => a.dist - b.dist || b.shared - a.shared);

  const best = ranked[0] ?? null;
  // Várias capturas do MESMO lugar refinam sua assinatura, mas não são uma zona rival. A margem
  // compara o melhor casamento com o melhor LABEL distinto; caso contrário, repetir uma calibração
  // derrubaria artificialmente a confiança desse mesmo lugar.
  const labelLeaders = new Map<string, Match>();
  for (const match of ranked) {
    const key = match.label.trim().toUpperCase();
    if (!labelLeaders.has(key)) labelLeaders.set(key, match);
  }
  const distinct = [...labelLeaders.values()];
  const margin = distinct.length >= 2 && best ? distinct[1].dist - best.dist : Infinity;
  // Confiança = AJUSTE ABSOLUTO (o vivo bate com a assinatura?) × MARGEM (ganha do 2º com folga?).
  //  · fit > farFitDb → não bate com NENHUMA zona conhecida (tag noutro lugar) → BAIXA;
  //  · uma zona só (sem 2º p/ comparar) → no máximo MÉDIA, e só se o ajuste for bom (nunca ALTA);
  //  · ALTA exige ajuste bom E margem clara sobre o 2º.
  let confidence: Confidence = "nenhuma";
  if (best) {
    const fit = best.dist;
    if (fit > farFitDb) confidence = "baixa";
    else if (distinct.length < 2) confidence = fit <= nearFitDb ? "media" : "baixa";
    else if (margin >= altaDb && fit <= nearFitDb) confidence = "alta";
    else if (margin >= mediaDb && fit <= farFitDb) confidence = "media";
    else confidence = "baixa";
  }

  // WKNN balanceado por ZONA: amostras irmãs refinam o centróide da zona, mas o total de votos da
  // zona continua sendo um. Assim, coletar dez amostras numa mesa não puxa o mapa 10× mais que uma
  // zona vizinha. O piso elimina a singularidade do casamento exato.
  let pos: Vec2 | null = null;
  if (confidence === "alta" || confidence === "media") {
    const byLabel = new Map<string, Match[]>();
    for (const match of ranked) {
      if (!isFiniteNum(match.x) || !isFiniteNum(match.y)) continue;
      const key = match.label.trim().toUpperCase();
      const samples = byLabel.get(key) ?? [];
      samples.push(match);
      byLabel.set(key, samples);
    }
    const zones = [...byLabel.values()]
      .map((samples) => {
        let sampleWeight = 0;
        let x = 0;
        let y = 0;
        for (const sample of samples) {
          const w = 1 / Math.max(wknnFloorDb, sample.dist) ** 2;
          sampleWeight += w;
          x += w * (sample.x as number);
          y += w * (sample.y as number);
        }
        return {
          dist: samples[0].dist,
          x: x / sampleWeight,
          y: y / sampleWeight,
        };
      })
      .sort((a, b) => a.dist - b.dist)
      .slice(0, Math.max(1, k));
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (const zone of zones) {
      const w = 1 / Math.max(wknnFloorDb, zone.dist) ** 2;
      wx += w * zone.x;
      wy += w * zone.y;
      wsum += w;
    }
    pos = wsum > 0 ? { x: wx / wsum, y: wy / wsum } : null;
  }

  return {
    best,
    ranked,
    confidence,
    margin: margin === Infinity ? Infinity : Math.round(margin * 10) / 10,
    pos,
    evidence: {
      liveStations: opts.evidence?.liveStations ?? Object.keys(live || {}).length,
      ...(isFiniteNum(opts.evidence?.oldestMeasuredAt)
        ? { oldestMeasuredAt: opts.evidence.oldestMeasuredAt }
        : {}),
      ...(isFiniteNum(opts.evidence?.newestMeasuredAt)
        ? { newestMeasuredAt: opts.evidence.newestMeasuredAt }
        : {}),
      ...(isFiniteNum(opts.evidence?.skewMs) ? { skewMs: opts.evidence.skewMs } : {}),
      comparedFingerprints: ranked.length,
      distinctLabels: distinct.length,
      bestShared: best?.shared ?? 0,
    },
  };
}
