// Motor de FUSÃO v1 (ADR-012, Fase 1) — o primeiro motor que BATE o baseline no cenário-gate.
//
// Física de UMA estação (coletor móvel + RSSI): quando o coletor vê a tag com sinal FORTE, ele está
// PERTO dela — logo o GPS do coletor naquele instante é uma boa estimativa da posição da tag. Sinal
// fraco = coletor longe = GPS pouco informativo sobre onde a tag está. O baseline (engine.ts) ignora
// isso: carimba SEMPRE o último GPS, mesmo quando o coletor está a 30 m da tag → erro = a própria
// distância coletor↔tag (dezenas de metros).
//
// Aqui, por tag, guardamos um RING pequeno das leituras recentes (posição do coletor + RSSI) e
// estimamos a posição como o CENTROIDE das posições do coletor PONDERADO pela proximidade inferida do
// RSSI. Isso (a) puxa a estimativa para as APROXIMAÇÕES mais próximas (onde coletor≈tag) e (b) MÉDIA
// várias leituras, suavizando o ruído do GPS. Determinístico e puro — sem relógio nem aleatório.
import type { LocatedEntity } from "./entity";
import type { EvidenceBatch } from "./evidence";
import type { EngineState, LocalizationEngine } from "./engine";

/** Uma leitura recente de UMA tag: onde o coletor estava e com que força a viu. */
type Reading = { lat: number; lon: number; rssi: number };

/** Estado privado por tag no `memo` (saco opaco do EngineState). */
type TagMemo = {
  /** Ring das últimas leituras (mais recente ao fim). */
  ring: Reading[];
  /** Rótulo mais recente conhecido. */
  label: string;
  /** Timestamp da última vez que a tag foi vista. */
  seenAt: number;
  /** Incerteza do GPS na última leitura, quando fornecida. */
  accuracyM: number | null;
};

/** Forma do `memo` deste motor: um mapa tagId→TagMemo. Cast a partir do `unknown` opaco. */
type FusionMemo = { tags: Map<string, TagMemo> };

/** Nº de leituras retidas por tag — janela curta o bastante p/ acompanhar tag em movimento. */
const RING_SIZE = 8;

/**
 * Peso de uma leitura pela PROXIMIDADE inferida do RSSI. No cenário, rssi ≈ -(40 + d), então a distância
 * estimada é `dEst = -rssi - 40` (m). Peso ∝ 1/(dEst² + ε): leituras de perto (dEst≈0) dominam; as de
 * longe quase não contam. O ε evita divisão por zero e limita o peso máximo de uma leitura colada.
 */
function weightOf(rssi: number): number {
  const dEst = Math.max(0, -rssi - 40);
  return 1 / (dEst * dEst + 1);
}

/** Centroide das posições do ring ponderado pela proximidade (RSSI). Assume ring não-vazio. */
function weightedCentroid(ring: Reading[]): { lat: number; lon: number } {
  let wSum = 0;
  let lat = 0;
  let lon = 0;
  for (const r of ring) {
    const w = weightOf(r.rssi);
    wSum += w;
    lat += w * r.lat;
    lon += w * r.lon;
  }
  return { lat: lat / wSum, lon: lon / wSum };
}

/**
 * Motor de fusão v1. Semântica de live/freeze idêntica ao baseline: tag vista agora = live; tag que some
 * da cena mantém a última posição estimada com live=false. Fonte "fusion".
 */
export const fusionEngine: LocalizationEngine = (batch: EvidenceBatch, prev: EngineState): EngineState => {
  // Recupera (ou inicia) o estado privado. `emptyState().memo` é undefined — tratamos isso.
  const prevMemo = prev.memo as FusionMemo | undefined;
  const tags = new Map<string, TagMemo>();
  if (prevMemo) for (const [id, m] of prevMemo.tags) tags.set(id, { ...m, ring: [...m.ring] });

  const seenIds = new Set<string>();
  for (const s of batch.seen) {
    const id = s.tagId.toUpperCase();
    seenIds.add(id);
    const m = tags.get(id) ?? { ring: [], label: s.label ?? id, seenAt: batch.ts, accuracyM: null };
    m.ring.push({ lat: batch.collectorPos.lat, lon: batch.collectorPos.lon, rssi: s.rssi });
    if (m.ring.length > RING_SIZE) m.ring.shift();
    m.label = s.label ?? m.label;
    m.seenAt = batch.ts;
    m.accuracyM = batch.accuracyM ?? null;
    tags.set(id, m);
  }

  // Reconstrói as entidades a partir do memo. Tag vista neste batch = live; as demais persistem sem live.
  const entities = new Map<string, LocatedEntity>();
  for (const [id, m] of tags) {
    const live = seenIds.has(id);
    const position = m.ring.length > 0 ? weightedCentroid(m.ring) : null;
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

  return { entities, memo: { tags } satisfies FusionMemo };
};
