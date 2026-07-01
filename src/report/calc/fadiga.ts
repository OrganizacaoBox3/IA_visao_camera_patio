// MODO FADIGA (operador) — tempo em cada estado de risco + ocorrências, por posto.
// 1 amostra ≈ 1s. minutos = samples/60.

import { type Period, type Shift, periodDays, inShift } from "./common";

export type FadigaCell = {
  posto: string;
  dayIndex: number;
  hour: number;
  samples: number;
  ok: number;
  fadiga: number;
  celular: number;
  duplo: number;
  earSum: number;
  earSamples: number;
};
export type FadigaDataset = {
  days: number;
  postos: string[];
  cells: FadigaCell[];
  startMs: number;
};
export type FadigaEventRow = { ts: number; posto: string; type: string; shift: Shift };
export type FadigaFilters = { period: Period; shift: Shift | "Todos"; posto: string | "Todos" };
export type FadigaKpis = {
  alertPct: number;
  okPct: number;
  avgEar: number;
  peakHour: number;
  alertMin: number;
  postos: number;
};

export function fadigaWindows(ds: FadigaDataset, f: FadigaFilters) {
  const W = periodDays[f.period];
  const sel = (lo: number, hi: number) =>
    ds.cells.filter(
      (c) =>
        c.dayIndex >= lo &&
        c.dayIndex <= hi &&
        inShift(c.hour, f.shift) &&
        (f.posto === "Todos" || c.posto === f.posto),
    );
  return {
    current: sel(ds.days - W, ds.days - 1),
    previous: sel(Math.max(0, ds.days - 2 * W), Math.max(-1, ds.days - W - 1)),
    W,
  };
}

export function fadigaKpis(cells: FadigaCell[]): FadigaKpis {
  const samples = cells.reduce((a, c) => a + c.samples, 0);
  const alert = cells.reduce((a, c) => a + c.fadiga + c.celular + c.duplo, 0);
  const earSum = cells.reduce((a, c) => a + c.earSum, 0),
    earSamples = cells.reduce((a, c) => a + c.earSamples, 0);
  const byHour = new Array(24).fill(0) as number[];
  for (const c of cells) byHour[c.hour] += c.fadiga + c.celular + c.duplo;
  const peakHour = byHour.some((v) => v > 0) ? byHour.indexOf(Math.max(...byHour)) : 0;
  return {
    alertPct: samples ? Math.round((alert / samples) * 100) : 0,
    okPct: samples ? Math.round(((samples - alert) / samples) * 100) : 100,
    avgEar: earSamples ? +(earSum / earSamples).toFixed(2) : 0,
    peakHour,
    alertMin: Math.round(alert / 60),
    postos: new Set(cells.map((c) => c.posto)).size,
  };
}

/** Heatmap: tempo (min) em cada estado de risco por hora. */
export function fadigaHeatmap(cells: FadigaCell[]) {
  const states: { key: string; label: string; pick: (c: FadigaCell) => number }[] = [
    { key: "fadiga", label: "Fadiga", pick: (c) => c.fadiga },
    { key: "celular", label: "Celular", pick: (c) => c.celular },
    { key: "duplo", label: "Duplo", pick: (c) => c.duplo },
  ];
  const rows = states.map((s) => {
    const hours = new Array(24).fill(0) as number[];
    for (const c of cells) hours[c.hour] += s.pick(c);
    return { label: s.label, hours: hours.map((v) => +(v / 60).toFixed(1)) };
  });
  const max = Math.max(0.1, ...rows.flatMap((r) => r.hours));
  return { rows, max };
}

export function fadigaEvolution(ds: FadigaDataset, f: FadigaFilters, lastN = 14) {
  const lo = Math.max(0, ds.days - lastN);
  const out: { dayIndex: number; label: string; pct: number }[] = [];
  for (let d = lo; d < ds.days; d++) {
    let samples = 0,
      alert = 0;
    for (const c of ds.cells)
      if (
        c.dayIndex === d &&
        inShift(c.hour, f.shift) &&
        (f.posto === "Todos" || c.posto === f.posto)
      ) {
        samples += c.samples;
        alert += c.fadiga + c.celular + c.duplo;
      }
    const date = new Date(ds.startMs + d * 86_400_000);
    out.push({
      dayIndex: d,
      label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      pct: samples ? Math.round((alert / samples) * 100) : 0,
    });
  }
  const max = Math.max(1, ...out.map((o) => o.pct));
  return { bars: out, max };
}

export function fadigaInsights(k: FadigaKpis, occFadiga: number, occCelular: number): string[] {
  const out: string[] = [];
  out.push(
    k.alertPct <= 2
      ? `Operação saudável: ${k.okPct}% do tempo sem alerta.`
      : `${k.alertPct}% do tempo em alerta (${k.alertMin} min).`,
  );
  out.push(`Pico de risco às ${String(k.peakHour).padStart(2, "0")}h.`);
  if (occFadiga + occCelular > 0)
    out.push(`${occFadiga} ocorrência(s) de fadiga, ${occCelular} de celular.`);
  return out;
}
