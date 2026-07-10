// Motor de fusão v2 com MODELO DE MOVIMENTO (ADR-012, Fase 2) — bate o v1 (fusion-engine.ts) na tag que
// se DESLOCA, removendo o LAG do centroide.
//
// Diagnóstico do v1: a posição é o centroide das leituras recentes do coletor PONDERADO por RSSI. Cada
// leitura carrega um instante t_k; o centroide equivale, então, à posição da tag no INSTANTE MÉDIO
// PONDERADO do ring (tBar), que está no PASSADO. Para a tag parada isso é ótimo. Para a tag em movimento,
// a estimativa fica ATRASADA de `v · (agora − tBar)` — o lag que gera o erro.
//
// Correção do v2: além do centroide (posição-base em tBar), estimamos a VELOCIDADE da tag e EXTRAPOLAMOS a
// base de tBar até o instante da leitura mais recente, removendo (parte d)o lag. Tag parada → v ≈ 0 → cai no
// comportamento do v1 (sem piorar).
//
// DOIS cuidados que fazem o v2 ganhar de fato (não só num seed):
//   1) A velocidade é da TAG, não do COLETOR. Regredir as posições cruas do coletor pegaria a velocidade do
//      coletor (que passa VARRENDO a tag). Em vez disso, partimos o ring em duas janelas temporais e usamos
//      a diferença dos CENTROIDES ponderados de cada uma — cada centroide colapsa o vaivém do coletor,
//      sobrando a posição da tag no instante médio da janela.
//   2) O GPS é ruidoso (metros) e a diferença de dois centroides é ruidosa ao quadrado. Uma velocidade crua
//      extrapolada explode a variância. Então SUAVIZAMOS a velocidade entre batches (EMA — modelo de
//      velocidade ~constante) e extrapolamos com GANHO CONSERVADOR e LEAD LIMITADO: removemos parte do viés
//      de lag sem herdar a variância. Constantes calibradas p/ ganhar na MÉDIA de vários seeds, não num só.
// Determinístico e puro — sem relógio nem aleatório.
import type { LocatedEntity } from "./entity";
import type { EvidenceBatch } from "./evidence";
import type { EngineState, LocalizationEngine } from "./engine";

/** Uma leitura recente de UMA tag: onde o coletor estava, com que força a viu e QUANDO. */
type Reading = { lat: number; lon: number; rssi: number; ts: number };

/** Estado privado por tag no `memo` (saco opaco do EngineState). */
type TagMemo = {
  /** Ring das últimas leituras (mais recente ao fim). */
  ring: Reading[];
  /** Velocidade da tag SUAVIZADA (EMA), em graus/ms — lat e lon. Só válida com `hasV`. */
  vLat: number;
  vLon: number;
  /** Já há uma estimativa de velocidade acumulada? (antes disso, comportamento = v1). */
  hasV: boolean;
  /** Rótulo mais recente conhecido. */
  label: string;
  /** Timestamp da última vez que a tag foi vista. */
  seenAt: number;
  /** Incerteza do GPS na última leitura, quando fornecida. */
  accuracyM: number | null;
};

/** Forma do `memo` deste motor: um mapa tagId→TagMemo. Cast a partir do `unknown` opaco. */
type MotionMemo = { tags: Map<string, TagMemo> };

/** Nº de leituras retidas por tag — janela curta o bastante p/ acompanhar tag em movimento. */
const RING_SIZE = 8;
/** Fator do EMA da velocidade (baixo = suaviza muito = confia no movimento ~constante, corta ruído). */
const V_ALPHA = 0.1;
/** Ganho conservador da extrapolação: remove parte do lag sem importar toda a variância da velocidade crua. */
const EXTRAP_GAIN = 0.3;
/** Lead máximo de extrapolação (ms) — trava sã: não projeta além de uma janela razoável do ring. */
const MAX_LEAD_MS = 4000;

/** Fatores de conversão local m↔grau (aproximação plana; só p/ o CAP em metros da extrapolação). */
const M_PER_DEG_LAT = 111_320;
function mPerDegLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}
/** Deslocamento máximo (m) que a extrapolação pode adicionar à base — trava sã contra explosão por ruído. */
const EXTRAP_MAX_M = 40;

/**
 * Peso de uma leitura pela PROXIMIDADE inferida do RSSI. No cenário, rssi ≈ -(40 + d), então a distância
 * estimada é `dEst = -rssi - 40` (m). Peso ∝ 1/(dEst² + ε): leituras de perto (dEst≈0) dominam. Idêntico
 * ao v1 — o v2 herda a mesma noção de confiança, só acrescenta o modelo de movimento.
 */
function weightOf(rssi: number): number {
  const dEst = Math.max(0, -rssi - 40);
  return 1 / (dEst * dEst + 1);
}

/** Centroide ponderado por RSSI de um trecho [from,to) do ring + o instante médio ponderado (t). Não-vazio. */
function weightedCentroid(ring: Reading[], from: number, to: number): { lat: number; lon: number; t: number } {
  let wSum = 0;
  let lat = 0;
  let lon = 0;
  let t = 0;
  for (let i = from; i < to; i++) {
    const r = ring[i];
    const w = weightOf(r.rssi);
    wSum += w;
    lat += w * r.lat;
    lon += w * r.lon;
    t += w * r.ts;
  }
  return { lat: lat / wSum, lon: lon / wSum, t: t / wSum };
}

/**
 * Velocidade CRUA da tag a partir do ring: diferença dos centroides ponderados da janela ANTIGA e da
 * RECENTE sobre o intervalo de tempo entre elas. `null` quando não há material (poucas leituras) ou tempo
 * indistinto. Cada centroide colapsa o vaivém do coletor → sobra o movimento da TAG.
 */
function rawVelocity(ring: Reading[]): { vLat: number; vLon: number } | null {
  const n = ring.length;
  if (n < 4) return null; // sem material p/ duas janelas → sem velocidade (cai no v1)
  const mid = Math.floor(n / 2);
  const older = weightedCentroid(ring, 0, mid);
  const newer = weightedCentroid(ring, mid, n);
  const dt = newer.t - older.t;
  if (dt <= 0) return null; // janelas no mesmo instante → velocidade indeterminada
  return { vLat: (newer.lat - older.lat) / dt, vLon: (newer.lon - older.lon) / dt };
}

/**
 * Posição estimada: centroide de TODO o ring (a base do v1, em tBar) + extrapolação conservadora pela
 * velocidade suavizada, do instante médio (tBar) até a leitura mais recente do ring. Para tag viva isso é o
 * instante do batch (remove o lag); p/ tag que sumiu (freeze) é o último instante visto — estimativa estável,
 * mantida constante durante a ausência (mesma semântica do baseline: "mantém a última estimativa").
 */
function estimatePosition(m: TagMemo): { lat: number; lon: number } {
  const ring = m.ring;
  const all = weightedCentroid(ring, 0, ring.length);
  if (!m.hasV) return { lat: all.lat, lon: all.lon }; // ainda sem velocidade → v1 puro

  let maxTs = ring[0].ts;
  for (const r of ring) if (r.ts > maxTs) maxTs = r.ts;
  const lead = Math.min(maxTs - all.t, MAX_LEAD_MS); // Δt de extrapolação (≥ 0, limitado).

  let predLat = all.lat + EXTRAP_GAIN * m.vLat * lead;
  let predLon = all.lon + EXTRAP_GAIN * m.vLon * lead;

  // Trava sã: se a extrapolação empurrou a base além de EXTRAP_MAX_M, escala de volta.
  const dLatM = (predLat - all.lat) * M_PER_DEG_LAT;
  const dLonM = (predLon - all.lon) * mPerDegLon(all.lat);
  const dispM = Math.hypot(dLatM, dLonM);
  if (dispM > EXTRAP_MAX_M) {
    const k = EXTRAP_MAX_M / dispM;
    predLat = all.lat + (predLat - all.lat) * k;
    predLon = all.lon + (predLon - all.lon) * k;
  }
  return { lat: predLat, lon: predLon };
}

/**
 * Motor de fusão v2. Semântica de live/freeze idêntica ao baseline/v1: tag vista agora = live; tag que some
 * mantém a última posição estimada com live=false. Fonte "fusion".
 */
export const motionEngine: LocalizationEngine = (batch: EvidenceBatch, prev: EngineState): EngineState => {
  // Recupera (ou inicia) o estado privado. `emptyState().memo` é undefined — tratamos isso.
  const prevMemo = prev.memo as MotionMemo | undefined;
  const tags = new Map<string, TagMemo>();
  if (prevMemo) for (const [id, m] of prevMemo.tags) tags.set(id, { ...m, ring: [...m.ring] });

  const seenIds = new Set<string>();
  for (const s of batch.seen) {
    const id = s.tagId.toUpperCase();
    seenIds.add(id);
    const m = tags.get(id) ?? {
      ring: [],
      vLat: 0,
      vLon: 0,
      hasV: false,
      label: s.label ?? id,
      seenAt: batch.ts,
      accuracyM: null,
    };
    m.ring.push({ lat: batch.collectorPos.lat, lon: batch.collectorPos.lon, rssi: s.rssi, ts: batch.ts });
    if (m.ring.length > RING_SIZE) m.ring.shift();
    m.label = s.label ?? m.label;
    m.seenAt = batch.ts;
    m.accuracyM = batch.accuracyM ?? null;

    // Atualiza a velocidade suavizada (EMA) só quando há leitura nova (tag viva). Frozen mantém a última.
    const raw = rawVelocity(m.ring);
    if (raw) {
      if (!m.hasV) {
        m.vLat = raw.vLat;
        m.vLon = raw.vLon;
        m.hasV = true;
      } else {
        m.vLat = V_ALPHA * raw.vLat + (1 - V_ALPHA) * m.vLat;
        m.vLon = V_ALPHA * raw.vLon + (1 - V_ALPHA) * m.vLon;
      }
    }
    tags.set(id, m);
  }

  // Reconstrói as entidades a partir do memo. Tag vista neste batch = live; as demais persistem sem live.
  const entities = new Map<string, LocatedEntity>();
  for (const [id, m] of tags) {
    const live = seenIds.has(id);
    const position = m.ring.length > 0 ? estimatePosition(m) : null;
    entities.set(id, {
      id,
      label: m.label,
      position,
      accuracyM: m.accuracyM,
      seenAt: m.seenAt,
      live,
      source: "fusion",
    });
  }

  return { entities, memo: { tags } satisfies MotionMemo };
};
