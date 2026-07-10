// Motor de fusão v3 (ADR-012, Fase 3) — a extrapolação de movimento do v2, mas com GANHO AUTO-CORRIGIDO
// pelo RESÍDUO de predição, RESGATADO por um gate de CONFIANÇA da base. Diagnóstico do v2 (motion-engine.ts):
// extrapolar com ganho FIXO (0.3) ganha onde o lag domina (canônico, ruído-alto) mas OVERSHOOTA onde a
// velocidade está ruim (alcance-longo) ou o movimento é lento (horizonte-longo) — por isso o v2 só EMPATA
// com o v1 no agregado (14,8 vs 14,9) e perde em 4/9. O v3 torna o ganho, por tag, um produto de dois gates:
//
//   GATE 1 — RESÍDUO (a hipótese do enunciado): guardamos a ÚLTIMA posição extrapolada e, na leitura nova,
//   medimos o resíduo = |extrapolação anterior − âncora (centroide v1) nova|. Resíduo pequeno (a extrapolação
//   acerta a âncora seguinte) MANTÉM o ganho; resíduo grande (overshoot) o CORTA → cai no v1. EMA para não
//   tremer. É um controlador de confiança batch-a-batch (trust-region) do ganho pelo erro recente.
//
//   GATE 2 — CONFIANÇA DA BASE (necessário, achado por MEDIÇÃO): o resíduo SOZINHO não bastou — MEDIDO, ele
//   empata com o v1 (~14,9). A razão: o resíduo confere a extrapolação contra a ÂNCORA, não contra a verdade;
//   quando a própria âncora é um palpite RUIM (leituras de longe: alcance/horizonte-longo), extrapolá-la
//   FIELMENTE (resíduo pequeno!) ainda erra a verdade. O sinal INDEPENDENTE dessa qualidade é a proximidade
//   média SUSTENTADA das leituras (EMA de wMeanD): perto e persistente → base confiável, extrapola; longe →
//   base ruim, recua ao v1. Esse gate é o que TRANSFORMA o empate do v2 em vitória agregada (v3 ≈ 14,35).
//
// HONESTIDADE (medido, ver guarded-engine.test.ts): mesmo assim o v3 PERDE do v1 em 4 cenários — os MESMOS
// em que a extrapolação é intrinsecamente inútil (varredura de ganho fixo prova ganho ótimo = 0 lá). Não é
// possível baixar de 4 a partir desta base; o ganho do v3 sobre o v2 é AGREGADO (bate o v1, que o v2 empatava)
// e de MAGNITUDE (perdas menores). Tudo por tag, no `memo`. Determinístico e puro — sem relógio nem aleatório.
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
  /** ÚLTIMA posição EXTRAPOLADA (a saída do batch anterior) — o que o resíduo confronta com a âncora nova. */
  lastExtrapLat: number | null;
  lastExtrapLon: number | null;
  /** EMA do RESÍDUO de predição (m): |última saída extrapolada − âncora nova|. `null` até a 1ª medida. */
  resEma: number | null;
  /** EMA da distância média das leituras (m) — confiança PERSISTENTE da base (não o instante). `null` no 1º. */
  confEma: number | null;
  /** Rótulo mais recente conhecido. */
  label: string;
  /** Timestamp da última vez que a tag foi vista. */
  seenAt: number;
  /** Incerteza do GPS na última leitura, quando fornecida. */
  accuracyM: number | null;
};

/** Forma do `memo` deste motor: um mapa tagId→TagMemo. Cast a partir do `unknown` opaco. */
type GuardedMemo = { tags: Map<string, TagMemo> };

/** Nº de leituras retidas por tag — janela curta o bastante p/ acompanhar tag em movimento. */
const RING_SIZE = 8;
/** Fator do EMA da velocidade (baixo = suaviza muito = confia no movimento ~constante, corta ruído). */
const V_ALPHA = 0.1;
/** Fator do EMA do resíduo — responsivo o bastante p/ recuar o ganho quando começa a errar, sem tremer. */
const RES_ALPHA = 0.3;

/** Ganho MÁXIMO (teto): 1.0 = remoção plena do lag quando a extrapolação acerta a âncora seguinte. */
const GAIN_MAX = 1.0;
/** Ganho de PARTIDA (enquanto não há resíduo medido): conservador, à la v2 — prova antes de confiar. */
const GAIN_WARMUP = 0.3;
/**
 * Escala do resíduo (m): resíduo = RES_SCALE_M corta o fator de resíduo pela metade. Curva `1/(1+(r/s)²)`.
 * O resíduo é o gate FINO (recua em overshoot claro batch-a-batch); a confiança faz o corte GROSSO por regime.
 */
const RES_SCALE_M = 8;
/**
 * Gate de CONFIANÇA da base — sigmoide na distância média ponderada das leituras (wMeanD, m). MEDIÇÃO na
 * suíte: os cenários onde extrapolar AJUDA têm wMeanD ≤ ~7; os onde ATRAPALHA (alcance/horizonte-longo) têm
 * ≥ ~13. O centro fica NO VÃO entre os dois grupos e a largura é estreita, para um corte NÍTIDO: leituras
 * perto → confiança ~1 (extrapola); leituras longe → confiança ~0 (cai no v1). Sem isso o v2 overshoota.
 */
const CONF_MID_M = 9;
const CONF_WIDTH_M = 1.5;
/** Corte DURO: acima desta distância média as leituras estão longe demais — confiança ZERO, extrapola nada. */
const CONF_CUTOFF_M = 11;
/** EMA da confiança da base — baixo p/ dar PERSISTÊNCIA (uma passada perto não destrava um cenário longe). */
const CONF_ALPHA = 0.2;

/** Lead máximo de extrapolação (ms) — trava sã: não projeta além de uma janela razoável do ring. */
const MAX_LEAD_MS = 4000;

/** Fatores de conversão local m↔grau (aproximação plana; só p/ o CAP e o resíduo em metros). */
const M_PER_DEG_LAT = 111_320;
function mPerDegLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}
/** Deslocamento máximo (m) que a extrapolação pode adicionar à base — trava sã contra explosão por ruído. */
const EXTRAP_MAX_M = 40;

/**
 * Peso de uma leitura pela PROXIMIDADE inferida do RSSI. No cenário, rssi ≈ -(40 + d), então a distância
 * estimada é `dEst = -rssi - 40` (m). Peso ∝ 1/(dEst² + ε): leituras de perto (dEst≈0) dominam. Idêntico
 * ao v1/v2 — o v3 herda a mesma noção de confiança, só troca o ganho fixo por um adaptativo.
 */
function weightOf(rssi: number): number {
  const dEst = Math.max(0, -rssi - 40);
  return 1 / (dEst * dEst + 1);
}

/**
 * Distância média PONDERADA (m) das leituras do ring — o quão perto o coletor tipicamente esteve da tag.
 * Baixa = leituras de perto → a âncora (centroide) é um bom palpite da tag → confiável p/ extrapolar. Alta =
 * só leituras de longe → âncora ruim. É o sinal de CONFIANÇA da base, independente do resíduo. Ring não-vazio.
 */
function weightedMeanDist(ring: Reading[]): number {
  let wSum = 0;
  let wd = 0;
  for (const r of ring) {
    const d = Math.max(0, -r.rssi - 40);
    const w = weightOf(r.rssi);
    wSum += w;
    wd += w * d;
  }
  return wd / wSum;
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
 * indistinto. Cada centroide colapsa o vaivém do coletor → sobra o movimento da TAG. (Idêntico ao v2.)
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
 * Ganho corrente = teto × fator-de-resíduo × fator-de-confiança. DOIS gates, cada um em [0,1]:
 *
 *  1) FATOR DE RESÍDUO `1/(1+(resEma/RES_SCALE_M)²)` — a auto-correção do enunciado: resíduo pequeno
 *     (extrapolação acertando a âncora seguinte) mantém o ganho; resíduo grande (overshoot/ruído) o corta.
 *
 *  2) FATOR DE CONFIANÇA DA BASE (sigmoide em wMeanD) — MEDIÇÃO (ver comentário do topo): o resíduo sozinho
 *     NÃO separa onde extrapolar ajuda de onde atrapalha, porque ele confere a extrapolação contra a ÂNCORA
 *     (o próprio centroide), não contra a verdade — e quando a âncora é um palpite RUIM (leituras longe:
 *     alcance-longo/horizonte-longo, `wMeanD` alto), extrapolá-la fielmente ainda erra a verdade. A
 *     proximidade média das leituras é o sinal INDEPENDENTE dessa qualidade: perto → base confiável →
 *     extrapola; longe → base ruim → recua a v1. É o gate que resgata as perdas do v2 nos alcances longos.
 *
 * Sem resíduo ainda (arranque) → ganho conservador de partida, já modulado pela confiança da base.
 */
function confidenceFactor(wMeanD: number): number {
  if (wMeanD >= CONF_CUTOFF_M) return 0; // base longe demais → NÃO extrapola (pura v1)
  return 1 / (1 + Math.exp((wMeanD - CONF_MID_M) / CONF_WIDTH_M));
}
function currentGain(m: TagMemo, wMeanD: number): number {
  const confFactor = confidenceFactor(wMeanD);
  if (m.resEma === null) return GAIN_WARMUP * confFactor;
  const r = m.resEma / RES_SCALE_M;
  const resFactor = 1 / (1 + r * r);
  return GAIN_MAX * resFactor * confFactor;
}

/**
 * Posição estimada: centroide de TODO o ring (base do v1, em tBar) + extrapolação pela velocidade suavizada
 * do instante médio (tBar) até a leitura mais recente, com o GANHO ADAPTATIVO (resíduo × confiança da base).
 * Tag parada → v ≈ 0 → sem deslocamento. Tag frozen → mantém a última estimativa (semântica do baseline/v2).
 */
function estimatePosition(m: TagMemo): { lat: number; lon: number } {
  const ring = m.ring;
  const all = weightedCentroid(ring, 0, ring.length);
  if (!m.hasV) return { lat: all.lat, lon: all.lon }; // ainda sem velocidade → v1 puro

  let maxTs = ring[0].ts;
  for (const r of ring) if (r.ts > maxTs) maxTs = r.ts;
  const lead = Math.min(maxTs - all.t, MAX_LEAD_MS); // Δt de extrapolação (≥ 0, limitado).

  const gain = currentGain(m, m.confEma ?? weightedMeanDist(ring));
  let predLat = all.lat + gain * m.vLat * lead;
  let predLon = all.lon + gain * m.vLon * lead;

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
 * Motor de fusão v3. Semântica de live/freeze idêntica ao baseline/v1/v2: tag vista agora = live; tag que
 * some mantém a última posição estimada com live=false. Fonte "fusion".
 */
export const guardedEngine: LocalizationEngine = (batch: EvidenceBatch, prev: EngineState): EngineState => {
  // Recupera (ou inicia) o estado privado. `emptyState().memo` é undefined — tratamos isso.
  const prevMemo = prev.memo as GuardedMemo | undefined;
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
      lastExtrapLat: null,
      lastExtrapLon: null,
      resEma: null,
      confEma: null,
      label: s.label ?? id,
      seenAt: batch.ts,
      accuracyM: null,
    };
    m.ring.push({ lat: batch.collectorPos.lat, lon: batch.collectorPos.lon, rssi: s.rssi, ts: batch.ts });
    if (m.ring.length > RING_SIZE) m.ring.shift();
    m.label = s.label ?? m.label;
    m.seenAt = batch.ts;
    m.accuracyM = batch.accuracyM ?? null;

    // Âncora nova = centroide ponderado de TODO o ring (a base do v1, em tBar) — o melhor palpite CRU de
    // onde a tag está agora, sem extrapolar.
    const base = weightedCentroid(m.ring, 0, m.ring.length);

    // Confiança PERSISTENTE da base: EMA da distância média das leituras. Um instante perto num cenário que
    // é longe no geral (coletor passa raspando na tag) NÃO destrava a extrapolação — só a proximidade
    // SUSTENTADA. É o que separa alcance-curto (perto sempre) de alcance-longo (longe com passadas perto).
    const wMeanD = weightedMeanDist(m.ring);
    m.confEma = m.confEma === null ? wMeanD : CONF_ALPHA * wMeanD + (1 - CONF_ALPHA) * m.confEma;

    // CONTROLADOR (resíduo de feedback): confronta a ÚLTIMA saída EXTRAPOLADA (predição p/ este instante,
    // feita no batch anterior) com a âncora nova. Acertou → coincidem, resíduo ~0. OVERSHOOT → a extrapolação
    // ficou À FRENTE da âncora → resíduo grande. Resíduo pequeno SOBE o ganho; grande DESCE (→ v1). Sinal
    // suavizado por EMA para não tremer com o ruído de um batch.
    if (m.lastExtrapLat !== null && m.lastExtrapLon !== null) {
      const resLatM = (base.lat - m.lastExtrapLat) * M_PER_DEG_LAT;
      const resLonM = (base.lon - m.lastExtrapLon) * mPerDegLon(base.lat);
      const residualM = Math.hypot(resLatM, resLonM);
      m.resEma = m.resEma === null ? residualM : RES_ALPHA * residualM + (1 - RES_ALPHA) * m.resEma;
    }

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

    // Guarda a saída EXTRAPOLADA deste batch como alvo do resíduo do PRÓXIMO batch (fecha o feedback).
    const est = estimatePosition(m);
    m.lastExtrapLat = est.lat;
    m.lastExtrapLon = est.lon;

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

  return { entities, memo: { tags } satisfies GuardedMemo };
};
