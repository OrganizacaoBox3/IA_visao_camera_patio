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
};

/**
 * Distância RMS em dB entre o vetor vivo e um fingerprint, SÓ sobre as antenas em comum (as ausentes
 * não entram — o vivo pode não ouvir todas). Devolve null se compartilham menos que `minShared`
 * (comparar por 1 antena só é frágil: vira "antena mais próxima", não fingerprint).
 */
function rssiDistance(live: LiveVec, fp: Fingerprint, minShared: number): { dist: number; shared: number } | null {
  const liveKeys = new Map(Object.entries(live).map(([id, r]) => [srcKey(id), r] as const));
  let sum = 0;
  let shared = 0;
  for (const [id, cell] of Object.entries(fp.vec)) {
    const lv = liveKeys.get(srcKey(id));
    if (!isFiniteNum(lv) || !cell || !isFiniteNum(cell.mean)) continue;
    sum += (lv - cell.mean) ** 2;
    shared++;
  }
  if (shared < minShared) return null;
  return { dist: Math.sqrt(sum / shared), shared };
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

  const ranked: Match[] = [];
  for (const fp of Array.isArray(db) ? db : []) {
    if (!fp || !fp.vec) continue;
    const d = rssiDistance(live || {}, fp, minShared);
    if (!d) continue;
    ranked.push({ id: fp.id, label: fp.label, x: fp.x, y: fp.y, dist: d.dist, shared: d.shared });
  }
  // Ordena por distância (empate → mais antenas compartilhadas ganha, mais evidência).
  ranked.sort((a, b) => a.dist - b.dist || b.shared - a.shared);

  const best = ranked[0] ?? null;
  const margin = ranked.length >= 2 ? ranked[1].dist - ranked[0].dist : Infinity;
  // Confiança = AJUSTE ABSOLUTO (o vivo bate com a assinatura?) × MARGEM (ganha do 2º com folga?).
  //  · fit > farFitDb → não bate com NENHUMA zona conhecida (tag noutro lugar) → BAIXA;
  //  · uma zona só (sem 2º p/ comparar) → no máximo MÉDIA, e só se o ajuste for bom (nunca ALTA);
  //  · ALTA exige ajuste bom E margem clara sobre o 2º.
  let confidence: Confidence = "nenhuma";
  if (best) {
    const fit = best.dist;
    if (fit > farFitDb) confidence = "baixa";
    else if (ranked.length < 2) confidence = fit <= nearFitDb ? "media" : "baixa";
    else if (margin >= altaDb && fit <= nearFitDb) confidence = "alta";
    else if (margin >= mediaDb && fit <= farFitDb) confidence = "media";
    else confidence = "baixa";
  }

  // WKNN: média das posições dos top-k COM coordenada, peso 1/(dist²+ε) (mais perto pesa mais).
  const withPos = ranked.slice(0, Math.max(1, k)).filter((m) => isFiniteNum(m.x) && isFiniteNum(m.y));
  let pos: Vec2 | null = null;
  if (withPos.length) {
    let wx = 0;
    let wy = 0;
    let wsum = 0;
    for (const m of withPos) {
      const w = 1 / (m.dist * m.dist + 1e-6);
      wx += w * (m.x as number);
      wy += w * (m.y as number);
      wsum += w;
    }
    pos = wsum > 0 ? { x: wx / wsum, y: wy / wsum } : null;
  }

  return { best, ranked, confidence, margin: margin === Infinity ? Infinity : Math.round(margin * 10) / 10, pos };
}
