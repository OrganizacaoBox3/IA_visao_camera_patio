// FLUXO DE PESSOAS (tripwire) — agregações puras sobre o dataset de cruzamentos.
// Buckets são hora×câmera×linha: o filtro de ÁREA do modo Atividade NÃO se aplica aqui
// (não existe noção de área no cruzamento). Filtros suportados: PERÍODO e TURNO, com a
// mesma geometria de janela de windows() (calc/atividade). O I/O (ingest/load) vive em
// report/store.ts; aqui só funções determinísticas (Vitest ao lado em flow.test.ts).

import { type Period, type Shift, periodDays, shiftOf } from "./common";

export type FlowCell = {
  cameraId: string;
  cameraLabel: string;
  tripwireId: string;
  dayIndex: number;
  hour: number;
  in: number;
  out: number;
};
export type FlowDataset = { days: number; cells: FlowCell[]; startMs: number };

/** Recorte "current" do período/turno (janela idêntica à de windows() — sem previous:
 *  o fluxo não exibe delta vs. período anterior). */
export function flowWindow(ds: FlowDataset, period: Period, shift: Shift | "Todos"): FlowCell[] {
  const W = periodDays[period];
  const lo = ds.days - W;
  const hi = ds.days - 1;
  return ds.cells.filter(
    (c) => c.dayIndex >= lo && c.dayIndex <= hi && (shift === "Todos" || shiftOf(c.hour) === shift),
  );
}

/** Totais do recorte: entradas, saídas e nº de linhas distintas com cruzamento. */
export function flowKpis(cells: FlowCell[]): { in: number; out: number; lines: number } {
  let inSum = 0;
  let outSum = 0;
  const lines = new Set<string>();
  for (const c of cells) {
    inSum += c.in;
    outSum += c.out;
    lines.add(`${c.cameraId}|${c.tripwireId}`);
  }
  return { in: inSum, out: outSum, lines: lines.size };
}

/** Série por hora do dia (0..23) com in/out somados + máximo p/ escala das barras. */
export function flowByHour(cells: FlowCell[]): {
  hours: { in: number; out: number }[];
  max: number;
} {
  const hours = Array.from({ length: 24 }, () => ({ in: 0, out: 0 }));
  for (const c of cells) {
    hours[c.hour].in += c.in;
    hours[c.hour].out += c.out;
  }
  const max = Math.max(1, ...hours.map((h) => Math.max(h.in, h.out)));
  return { hours, max };
}

export type FlowLineRow = {
  cameraId: string;
  cameraLabel: string;
  tripwireId: string;
  in: number;
  out: number;
};
/** Agregado por linha×câmera, ordenado por movimento total (ranking). */
export function flowByLine(cells: FlowCell[]): { rows: FlowLineRow[]; max: number } {
  const m = new Map<string, FlowLineRow>();
  for (const c of cells) {
    const key = `${c.cameraId}|${c.tripwireId}`;
    const r = m.get(key) ?? {
      cameraId: c.cameraId,
      cameraLabel: c.cameraLabel,
      tripwireId: c.tripwireId,
      in: 0,
      out: 0,
    };
    r.in += c.in;
    r.out += c.out;
    if (c.cameraLabel) r.cameraLabel = c.cameraLabel; // label mais recente vence o vazio
    m.set(key, r);
  }
  const rows = [...m.values()].sort((a, b) => b.in + b.out - (a.in + a.out));
  const max = Math.max(1, ...rows.map((r) => r.in + r.out));
  return { rows, max };
}
