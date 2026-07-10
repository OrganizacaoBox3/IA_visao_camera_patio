// O MOTOR de localização como FUNÇÃO PURA (dev.md §2): (batch de evidência, estado anterior) → novo
// estado. Sem I/O, sem rede, sem relógio — determinístico. O baseline de hoje e o factor graph de amanhã
// têm a MESMA assinatura, então o harness (replay.ts) mede qualquer um sem mudança. É o de-risco central:
// prova que "trocar o motor" é trocar uma função, não reescrever o sistema.
import type { LocatedEntity } from "./entity";
import type { EvidenceBatch } from "./evidence";

/** Estado interno do motor. Opaco ao harness — o baseline usa um Map; o motor futuro terá seu grafo. */
export type EngineState = {
  entities: Map<string, LocatedEntity>;
  /**
   * Estado PRIVADO do motor entre batches (ex.: ring de leituras recentes p/ fusão). Opaco ao harness e
   * ao contrato — cada motor define sua forma e faz o cast. O baseline ignora. Aditivo: não quebra ninguém.
   */
  memo?: unknown;
};

/** Um motor de localização: consome um batch + o estado anterior, devolve o novo estado. Puro. */
export type LocalizationEngine = (batch: EvidenceBatch, prev: EngineState) => EngineState;

/** Estado inicial vazio. */
export function emptyState(): EngineState {
  return { entities: new Map() };
}

/** A saída da costura para um estado: `LocatedEntity[]`. */
export function outputOf(state: EngineState): LocatedEntity[] {
  return [...state.entities.values()];
}

/**
 * Baseline v0 — o heurístico AirTag de hoje: cada tag vista recebe a posição do coletor naquele instante;
 * a última posição PERSISTE (não some quando deixa de ser vista), só perde o `live`. É a mesma regra que
 * `adapters.fromTagLocations` embrulha — aqui como função de estado, medível pelo harness.
 */
export const baselineEngine: LocalizationEngine = (batch, prev) => {
  const entities = new Map(prev.entities);
  const seenIds = new Set<string>();

  for (const s of batch.seen) {
    const id = s.tagId.toUpperCase();
    seenIds.add(id);
    entities.set(id, {
      id,
      label: s.label ?? id,
      position: { lat: batch.collectorPos.lat, lon: batch.collectorPos.lon },
      accuracyM: batch.accuracyM ?? null,
      seenAt: batch.ts,
      live: true,
      source: "gps",
    });
  }

  // Tags não vistas neste batch mantêm a última posição, mas deixam de ser live.
  for (const [id, e] of entities) {
    if (!seenIds.has(id) && e.live) entities.set(id, { ...e, live: false });
  }

  return { entities };
};
