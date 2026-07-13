// ESTADO dos pontos de chão das estações BLE na calibração (multi-antena F3) — lógica PURA, sem
// React, sem DOM. Extraído do CalibrationPanel porque guarda um INVARIANTE de retrocompatibilidade
// que não pode quebrar em silêncio:
//
//   INVARIANTE: `station` (o campo legado, singular) é SEMPRE o ponto da estação PRINCIPAL, ou seja
//   station === stations[principalId] — sempre que existir ao menos uma estação com ponto marcado.
//
// Por que ele importa: `calibration.station` é o que o hub/motor ANTIGO lê (e é a origem da `dist`
// da pista no frame.ts, a distância principal). Se a UI salvasse `stations` sem manter o singular
// coerente, uma câmera recalibrada passaria a medir distância a partir do ponto errado — e nada
// falharia alto: os rótulos só ficariam piores. Por isso o estado vive aqui, numa unidade só, com
// teste (a doutrina: encapsule a lógica que muta o mesmo estado, não a espalhe).
//
// Responsabilidade única: as 3 transições do conjunto de pontos (adotar da calibração salva, marcar
// /mover um ponto, remover um ponto), sempre devolvendo estado NOVO e coerente.
import type { Vec2 } from "../vision/homography";

/** Pontos por stationId + quem é a principal + o espelho legado (o `station` do payload). */
export type StationPointsState = {
  stations: Record<string, Vec2>;
  principalId: string | null;
  station: Vec2 | null;
};

const samePoint = (a: Vec2, b: Vec2): boolean => a.x === b.x && a.y === b.y;

/**
 * ADOÇÃO (carga da calibração salva): descobre qual estação é a PRINCIPAL — aquela cujo ponto o
 * campo legado `station` espelha. Três casos, todos honestos:
 *  - casou: principal = essa estação, `station` intacto;
 *  - não casou (calibração salva por um painel mais velho, ou `station` ausente): adota a primeira
 *    estação (ordem estável) e RE-SINCRONIZA o legado — o invariante nunca fica quebrado em tela;
 *  - sem estações: mundo de 1 antena — principal = null e o `station` legado segue sozinho, exato
 *    como antes da multi-antena (retrocompat dura).
 * Defensivo: ponto não-numérico do payload é descartado (nunca vira NaN na homografia).
 */
export function adoptStationPoints(
  rawStations: Record<string, Vec2> | undefined | null,
  station: Vec2 | null,
): StationPointsState {
  const stations: Record<string, Vec2> = {};
  for (const [id, p] of Object.entries(rawStations ?? {}))
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) stations[id] = { x: p.x, y: p.y };

  const ids = Object.keys(stations).sort();
  if (ids.length === 0) return { stations, principalId: null, station };

  const match = station ? ids.find((id) => samePoint(stations[id], station)) : undefined;
  const principalId = match ?? ids[0];
  return { stations, principalId, station: stations[principalId] };
}

/**
 * MARCAR/MOVER o ponto de uma estação. A PRIMEIRA estação a ganhar ponto vira a principal (o motor
 * precisa de uma origem de distância; sem essa regra o operador teria que escolher antes de marcar).
 * `id` vazio = mundo de 1 antena (nenhuma estação declarada no hub): mexe só no ponto legado.
 */
export function placeStationPoint(
  state: StationPointsState,
  id: string,
  px: Vec2,
): StationPointsState {
  if (!id) return { ...state, station: px };
  const stations = { ...state.stations, [id]: px };
  const principalId = state.principalId ?? id;
  return {
    stations,
    principalId,
    station: principalId === id ? px : (stations[principalId] ?? state.station),
  };
}

/** DEFINIR a principal (o operador trocou a antena de referência) — o legado a acompanha. */
export function setPrincipalStation(state: StationPointsState, id: string): StationPointsState {
  const px = state.stations[id];
  return { ...state, principalId: id, station: px ?? state.station };
}

/**
 * REMOVER o ponto de uma estação (a antena mudou de lugar / foi embora). Removendo a PRINCIPAL, a
 * referência passa para a primeira que sobrou — e some de vez quando não sobra nenhuma (aí o
 * `station` legado zera: manter o ponto de uma estação que não existe mais seria mentira).
 */
export function removeStationPoint(state: StationPointsState, id: string): StationPointsState {
  if (!(id in state.stations)) return state;
  const stations = { ...state.stations };
  delete stations[id];
  if (state.principalId !== id) return { ...state, stations };
  const next = Object.keys(stations).sort()[0] ?? null;
  return { stations, principalId: next, station: next ? stations[next] : null };
}
