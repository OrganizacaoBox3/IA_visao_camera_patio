// Helpers puros de recorte/agregação do Relatório — extraídos das repetições do ReportPage.
//  • filterByWindow: filtro por janela de período + turno (antes repetido 4×, um por modo).
//  • byShift: agregação de uma métrica por turno (antes repetido 2×: idleMin e boxes).
// Puros e determinísticos (só dependem dos args) → cobertos por Vitest (aggregate.test.ts).

import { shiftOf, periodDays, type Period, type Shift } from "../../report/calc";

// Nº de dias de cada período (fonte única: calc/common, via barrel) — base da janela "current".
// Alias mantém o nome público local (usado também pelo teste).
export const PERIOD_DAYS: Record<Period, number> = periodDays;

const DAY_MS = 86_400_000;

/**
 * Recorta linhas de eventos pela janela do período (últimos N dias) e pelo turno.
 * `extra` aplica o filtro adicional do modo (área/ponto/setor/posto). NÃO fatia — o
 * limite por modo (80/120) permanece no chamador, pois varia entre os modos.
 */
export function filterByWindow<T extends { ts: number }>(
  rows: T[],
  period: Period,
  shift: Shift | "Todos",
  extra?: (row: T) => boolean,
): T[] {
  const lo = Date.now() - PERIOD_DAYS[period] * DAY_MS;
  return rows.filter(
    (r) =>
      r.ts >= lo &&
      (shift === "Todos" || shiftOf(new Date(r.ts).getHours()) === shift) &&
      (extra ? extra(r) : true),
  );
}

/**
 * Agrega uma métrica por turno (Manhã/Tarde/Noite) a partir de células com `hour`.
 * `value` extrai a métrica de cada célula (idleMin, boxes, …). Retorna o mapa por turno
 * e o máximo (escala das barras "Por turno"), com piso 1 para evitar divisão por zero.
 */
export function byShift<T extends { hour: number }>(
  cells: T[],
  value: (cell: T) => number,
): { m: Record<Shift, number>; max: number } {
  const m: Record<Shift, number> = { Manhã: 0, Tarde: 0, Noite: 0 };
  for (const c of cells) m[shiftOf(c.hour)] += value(c);
  return { m, max: Math.max(1, ...Object.values(m)) };
}
