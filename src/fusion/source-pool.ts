// Pool multi-fonte de leituras BLE — o "merge por fonte" do CLIENTE (spec-multi-antena-ble, F4).
// O hub emite UM envelope `bt-readings` por POST de estação, contendo SÓ a varredura daquela fonte
// (server/routes/bt-station.js). Sem merge, quem guarda "o último envelope" ALTERNA entre
// lista-só-A e lista-só-B a cada POST: a série de RSSI de uma tag intercala amostras de DOIS
// rádios no mesmo slot (corrompe a correlação da fusão) e a estação que postou há mais tempo SOME
// do pool entre posts. Aqui: a última varredura de CADA fonte vale até a próxima DA MESMA fonte;
// fonte calada além de SOURCE_STALE_MS é podada NO PRÓXIMO merge (M6 da spec: falha de estação é
// degradação natural — o pool volta a ser só as vivas e o motor segue sem código especial). Com
// UMA fonte o pool é a própria varredura corrente — conteúdo idêntico ao comportamento antigo
// (CA-3). Genérico em T: o cliente ao vivo usa BtReading (useDashboardSocket) e o replay usa
// RawReading (session-loader) — a MESMA semântica nos dois caminhos por construção. Puro, sem
// estado próprio (o chamador é dono do Map) → testável isolado.

/** Última varredura de uma fonte + instante em que chegou (relógio de quem faz o merge). */
export type SourceBatch<T> = { ts: number; readings: readonly T[] };

/** Espelho do STALE_MS do store do servidor (server/bt/bt-readings.js): fonte calada além disto
 *  some do pool. A poda roda SÓ no merge (chegada de envelope) — sem envelope nenhum, o pool
 *  congela no último estado, exatamente como o cliente antigo fazia com o último batch. */
export const SOURCE_STALE_MS = 15_000;

/**
 * Aplica a varredura de UMA fonte ao estado (substitui a anterior DA MESMA fonte), poda as fontes
 * caladas há mais de SOURCE_STALE_MS e devolve o pool = concatenação das varreduras vivas, em
 * ordem ESTÁVEL de 1ª aparição de cada fonte (Map preserva a posição no re-set — os desempates
 * por ordem de inserção rio abaixo, ex. align() do associador, ficam determinísticos). MUTA
 * `sources` (o chamador é o dono do Map, padrão do store do servidor).
 */
export function mergeSourceBatch<T>(
  sources: Map<string, SourceBatch<T>>,
  sourceId: string,
  readings: readonly T[],
  now: number,
): T[] {
  sources.set(sourceId, { ts: now, readings });
  const pool: T[] = [];
  for (const [id, batch] of sources) {
    if (now - batch.ts > SOURCE_STALE_MS) sources.delete(id);
    else pool.push(...batch.readings);
  }
  return pool;
}
