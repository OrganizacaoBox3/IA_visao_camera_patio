// MODO LEITURA (código de barras) — agregações próprias por Ponto de Leitura.
// "caixa" = leitura distinta no ponto (dedup por código+janela); "reads" = volume bruto;
// "multiReads" = caixas confirmadas por +1 câmera. perCamera = contribuição por câmera.

import { type Period, type Shift, periodDays, inShift } from "./common";

export type ReadingCell = {
  ponto: string;
  dayIndex: number;
  hour: number;
  boxes: number;
  reads: number;
  multiReads: number;
  passages: number;
  perCamera: Record<string, number>;
};
export type ReadingDataset = {
  days: number;
  pontos: string[];
  cameraLabels: Record<string, string>;
  cells: ReadingCell[];
  startMs: number;
};
export type ReadingEventRow = {
  ts: number;
  ponto: string;
  code: string;
  cameras: number;
  shift: Shift;
};
export type ReadingFilters = { period: Period; shift: Shift | "Todos"; ponto: string | "Todos" };
export type ReadingKpis = {
  boxes: number;
  reads: number;
  multiReads: number;
  multiPct: number;
  passages: number;
  noReads: number;
  ratePct: number;
  topPonto: string;
  peakHour: number;
  pontos: number;
};

export function readingWindows(ds: ReadingDataset, f: ReadingFilters) {
  const W = periodDays[f.period];
  const curLo = ds.days - W,
    curHi = ds.days - 1;
  const prevLo = ds.days - 2 * W,
    prevHi = ds.days - W - 1;
  const sel = (lo: number, hi: number) =>
    ds.cells.filter(
      (c) =>
        c.dayIndex >= lo &&
        c.dayIndex <= hi &&
        inShift(c.hour, f.shift) &&
        (f.ponto === "Todos" || c.ponto === f.ponto),
    );
  return {
    current: sel(curLo, curHi),
    previous: sel(Math.max(0, prevLo), Math.max(-1, prevHi)),
    W,
  };
}

export function readingKpis(cells: ReadingCell[]): ReadingKpis {
  const boxes = cells.reduce((a, c) => a + c.boxes, 0);
  const reads = cells.reduce((a, c) => a + c.reads, 0);
  const multiReads = cells.reduce((a, c) => a + c.multiReads, 0);
  const passages = cells.reduce((a, c) => a + (c.passages ?? c.boxes), 0);
  const noReads = Math.max(0, passages - boxes);
  const byPonto = new Map<string, number>();
  const byHour = new Array(24).fill(0) as number[];
  for (const c of cells) {
    byPonto.set(c.ponto, (byPonto.get(c.ponto) ?? 0) + c.boxes);
    byHour[c.hour] += c.boxes;
  }
  const topPonto = [...byPonto.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
  const peakHour = byHour.some((v) => v > 0) ? byHour.indexOf(Math.max(...byHour)) : 0;
  return {
    boxes,
    reads,
    multiReads,
    multiPct: boxes ? Math.round((multiReads / boxes) * 100) : 0,
    passages,
    noReads,
    ratePct: passages ? Math.min(100, Math.round((boxes / passages) * 100)) : 100,
    topPonto,
    peakHour,
    pontos: byPonto.size,
  };
}

/** Heatmap: por ponto, caixas somadas por hora (0..23). */
export function readingHeatmap(cells: ReadingCell[], pontos: string[]) {
  const rows = pontos.map((ponto) => {
    const hours = new Array(24).fill(0) as number[];
    for (const c of cells) if (c.ponto === ponto) hours[c.hour] += c.boxes;
    return { ponto, hours };
  });
  const max = Math.max(1, ...rows.flatMap((r) => r.hours));
  return { rows, max };
}

export function readingRanking(cells: ReadingCell[], pontos: string[]) {
  const rows = pontos
    .map((ponto) => {
      let boxes = 0,
        multiReads = 0,
        passages = 0;
      for (const c of cells)
        if (c.ponto === ponto) {
          boxes += c.boxes;
          multiReads += c.multiReads;
          passages += c.passages ?? c.boxes;
        }
      const noReads = Math.max(0, passages - boxes);
      return {
        ponto,
        boxes,
        multiReads,
        noReads,
        ratePct: passages ? Math.min(100, Math.round((boxes / passages) * 100)) : 100,
      };
    })
    .filter((r) => r.boxes > 0 || r.noReads > 0)
    .sort((a, b) => b.boxes - a.boxes);
  const max = Math.max(1, ...rows.map((r) => r.boxes));
  return { rows, max };
}

/** Contribuição por câmera (respeita filtros via cells). */
export function readingByCamera(cells: ReadingCell[], labels: Record<string, string>) {
  const m = new Map<string, number>();
  for (const c of cells)
    for (const [cid, n] of Object.entries(c.perCamera)) m.set(cid, (m.get(cid) ?? 0) + n);
  const rows = [...m.entries()]
    .map(([cid, reads]) => ({ camera: labels[cid] ?? cid, reads }))
    .filter((r) => r.reads > 0)
    .sort((a, b) => b.reads - a.reads);
  const max = Math.max(1, ...rows.map((r) => r.reads));
  return { rows, max };
}

export function readingEvolution(ds: ReadingDataset, f: ReadingFilters, lastN = 14) {
  const lo = Math.max(0, ds.days - lastN);
  const out: { dayIndex: number; label: string; boxes: number }[] = [];
  for (let d = lo; d < ds.days; d++) {
    let boxes = 0;
    for (const c of ds.cells)
      if (
        c.dayIndex === d &&
        inShift(c.hour, f.shift) &&
        (f.ponto === "Todos" || c.ponto === f.ponto)
      )
        boxes += c.boxes;
    const date = new Date(ds.startMs + d * 86_400_000);
    out.push({
      dayIndex: d,
      label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      boxes,
    });
  }
  const max = Math.max(1, ...out.map((o) => o.boxes));
  return { bars: out, max };
}

export function readingInsights(k: ReadingKpis): string[] {
  const out: string[] = [];
  out.push(
    k.ratePct >= 98
      ? `Taxa de leitura de ${k.ratePct}% — excelente cobertura.`
      : `Taxa de leitura de ${k.ratePct}%${k.noReads > 0 ? ` (${k.noReads.toLocaleString("pt-BR")} no-reads)` : ""}.`,
  );
  if (k.topPonto !== "—") out.push(`${k.topPonto} é o ponto de maior volume.`);
  out.push(
    k.multiPct > 0
      ? `${k.multiPct}% das caixas confirmadas por +1 câmera (redundância saudável).`
      : `Sem multi-leitura — avaliar cobertura de ângulos.`,
  );
  return out;
}
