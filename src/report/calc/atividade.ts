// Modo ATIVIDADE — ociosidade/ocupação por Área × Hora. Agregações puras.
// Tudo aqui são INDICADORES (tempo/alertas/ocupação) — nunca imagens.

import { type Period, type Shift, periodDays, inShift } from "./common";

export type Cell = {
  area: string;
  dayIndex: number;
  hour: number;
  idleMin: number;
  alerts: number;
  activePct: number;
  atividade?: string;
};
export type Dataset = {
  days: number;
  areas: string[];
  cameraOf: Record<string, string>;
  cells: Cell[];
  startMs: number;
};

export type Filters = { period: Period; shift: Shift | "Todos"; area: string | "Todas" };

/** Recorta janelas current/previous conforme filtros. */
export function windows(ds: Dataset, f: Filters) {
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
        (f.area === "Todas" || c.area === f.area),
    );
  return {
    current: sel(curLo, curHi),
    previous: sel(Math.max(0, prevLo), Math.max(-1, prevHi)),
    W,
  };
}

export type Kpis = {
  idleMin: number;
  alerts: number;
  topArea: string;
  peakHour: number;
  activePct: number;
};

export function kpis(cells: Cell[]): Kpis {
  const idleMin = cells.reduce((a, c) => a + c.idleMin, 0);
  const alerts = cells.reduce((a, c) => a + c.alerts, 0);
  const byArea = new Map<string, number>();
  const byHour = new Array(24).fill(0) as number[];
  let pctSum = 0;
  for (const c of cells) {
    byArea.set(c.area, (byArea.get(c.area) ?? 0) + c.idleMin);
    byHour[c.hour] += c.idleMin;
    pctSum += c.activePct;
  }
  const topArea = [...byArea.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "—";
  const peakHour = byHour.indexOf(Math.max(...byHour));
  const activePct = cells.length ? Math.round(pctSum / cells.length) : 0;
  return { idleMin, alerts, topArea, peakHour: peakHour < 0 ? 0 : peakHour, activePct };
}

/** Heatmap: por área, idleMin somado por hora (0..23) + máximo p/ escala. */
export function heatmap(cells: Cell[], areas: string[]) {
  const rows = areas.map((area) => {
    const hours = new Array(24).fill(0) as number[];
    for (const c of cells) if (c.area === area) hours[c.hour] += c.idleMin;
    return { area, hours };
  });
  const max = Math.max(1, ...rows.flatMap((r) => r.hours));
  return { rows, max };
}

export function ranking(cells: Cell[], areas: string[]) {
  const rows = areas
    .map((area) => {
      let idleMin = 0,
        alerts = 0;
      for (const c of cells)
        if (c.area === area) {
          idleMin += c.idleMin;
          alerts += c.alerts;
        }
      return { area, idleMin, alerts };
    })
    .filter((r) => r.idleMin > 0)
    .sort((a, b) => b.idleMin - a.idleMin);
  const max = Math.max(1, ...rows.map((r) => r.idleMin));
  return { rows, max };
}

/** Tendência: idleMin por dia nos últimos N dias (respeita filtros de área/turno). */
export function evolution(ds: Dataset, f: Filters, lastN = 14) {
  const lo = Math.max(0, ds.days - lastN);
  const out: { dayIndex: number; label: string; idleMin: number }[] = [];
  for (let d = lo; d < ds.days; d++) {
    let idleMin = 0;
    for (const c of ds.cells)
      if (c.dayIndex === d && inShift(c.hour, f.shift) && (f.area === "Todas" || c.area === f.area))
        idleMin += c.idleMin;
    const date = new Date(ds.startMs + d * 86_400_000);
    out.push({
      dayIndex: d,
      label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      idleMin,
    });
  }
  const max = Math.max(1, ...out.map((o) => o.idleMin));
  return { bars: out, max };
}

export type EventRow = {
  ts: number;
  area: string;
  camera: string;
  durationMin: number;
  shift: Shift;
};

/** Eventos de alerta sintéticos a partir das células com alerts>0. */
export function insights(cells: Cell[], k: Kpis): string[] {
  const total = k.idleMin || 1;
  const byArea = new Map<string, number>();
  for (const c of cells) byArea.set(c.area, (byArea.get(c.area) ?? 0) + c.idleMin);
  const top = [...byArea.entries()].sort((a, b) => b[1] - a[1])[0];
  const out: string[] = [];
  if (top)
    out.push(
      `${top[0]} concentra ${Math.round((top[1] / total) * 100)}% do tempo parado do período.`,
    );
  out.push(
    `Pico de ociosidade às ${String(k.peakHour).padStart(2, "0")}h — concentrar atenção/efetivo nessa janela.`,
  );
  if (k.alerts > 0)
    out.push(`${k.alerts} alertas no período; revisar limites por área para reduzir ruído.`);
  return out;
}
