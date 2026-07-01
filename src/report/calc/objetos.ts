// MODO OBJETOS (contagem/identificação) — presença e contagem por Setor × Classe.
// "present" = nº de amostras com a classe em cena; presença % = present/samples.

import { type Period, type Shift, periodDays, inShift } from "./common";

export type ObjectCell = {
  setor: string;
  classe: string;
  dayIndex: number;
  hour: number;
  samples: number;
  countSum: number;
  peak: number;
  present: number;
};
export type ObjectDataset = {
  days: number;
  setores: string[];
  classes: string[];
  cells: ObjectCell[];
  startMs: number;
};
export type ObjectEventRow = {
  ts: number;
  type: string;
  setor: string;
  classe: string;
  shift: Shift;
};
export type ObjectFilters = { period: Period; shift: Shift | "Todos"; setor: string | "Todos" };
export type ObjectKpis = {
  avgCount: number;
  peak: number;
  topClasse: string;
  presenceTopPct: number;
  setores: number;
  classes: number;
};

export function objectWindows(ds: ObjectDataset, f: ObjectFilters) {
  const W = periodDays[f.period];
  const sel = (lo: number, hi: number) =>
    ds.cells.filter(
      (c) =>
        c.dayIndex >= lo &&
        c.dayIndex <= hi &&
        inShift(c.hour, f.shift) &&
        (f.setor === "Todos" || c.setor === f.setor),
    );
  return {
    current: sel(ds.days - W, ds.days - 1),
    previous: sel(Math.max(0, ds.days - 2 * W), Math.max(-1, ds.days - W - 1)),
    W,
  };
}

export function objectKpis(cells: ObjectCell[]): ObjectKpis {
  const samples = cells.reduce((a, c) => a + c.samples, 0);
  const countSum = cells.reduce((a, c) => a + c.countSum, 0);
  const peak = cells.reduce((a, c) => Math.max(a, c.peak), 0);
  const byClasse = new Map<string, { count: number; present: number; samples: number }>();
  for (const c of cells) {
    const e = byClasse.get(c.classe) ?? { count: 0, present: 0, samples: 0 };
    e.count += c.countSum;
    e.present += c.present;
    e.samples += c.samples;
    byClasse.set(c.classe, e);
  }
  const top = [...byClasse.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  const topClasse = top?.[0] ?? "—";
  const presenceTopPct =
    top && top[1].samples ? Math.round((top[1].present / top[1].samples) * 100) : 0;
  return {
    avgCount: samples ? +(countSum / samples).toFixed(1) : 0,
    peak,
    topClasse,
    presenceTopPct,
    setores: new Set(cells.map((c) => c.setor)).size,
    classes: byClasse.size,
  };
}

/** Heatmap: por classe, contagem média por hora. */
export function objectHeatmap(cells: ObjectCell[], classes: string[]) {
  const rows = classes.map((classe) => {
    const cnt = new Array(24).fill(0) as number[];
    const smp = new Array(24).fill(0) as number[];
    for (const c of cells)
      if (c.classe === classe) {
        cnt[c.hour] += c.countSum;
        smp[c.hour] += c.samples;
      }
    return { classe, hours: cnt.map((v, h) => (smp[h] ? +(v / smp[h]).toFixed(1) : 0)) };
  });
  const max = Math.max(0.1, ...rows.flatMap((r) => r.hours));
  return { rows, max };
}

/** Matriz Setor × Classe: presença % (o "raio-x" — empilhadeira no setor?). */
export function objectPresence(cells: ObjectCell[], setores: string[], classes: string[]) {
  const m: Record<string, Record<string, number>> = {};
  for (const s of setores) {
    m[s] = {};
    for (const cl of classes) {
      let present = 0,
        samples = 0;
      for (const c of cells)
        if (c.setor === s && c.classe === cl) {
          present += c.present;
          samples += c.samples;
        }
      m[s][cl] = samples ? Math.round((present / samples) * 100) : 0;
    }
  }
  return m;
}

export function objectRanking(cells: ObjectCell[], setores: string[]) {
  const rows = setores
    .map((setor) => {
      let count = 0,
        samples = 0,
        peak = 0;
      for (const c of cells)
        if (c.setor === setor) {
          count += c.countSum;
          samples += c.samples;
          peak = Math.max(peak, c.peak);
        }
      return { setor, avg: samples ? +(count / samples).toFixed(1) : 0, peak };
    })
    .filter((r) => r.avg > 0 || r.peak > 0)
    .sort((a, b) => b.avg - a.avg);
  const max = Math.max(0.1, ...rows.map((r) => r.avg));
  return { rows, max };
}

export function objectByClass(cells: ObjectCell[], classes: string[]) {
  const rows = classes
    .map((classe) => {
      let count = 0,
        samples = 0;
      for (const c of cells)
        if (c.classe === classe) {
          count += c.countSum;
          samples += c.samples;
        }
      return { classe, avg: samples ? +(count / samples).toFixed(1) : 0 };
    })
    .filter((r) => r.avg > 0)
    .sort((a, b) => b.avg - a.avg);
  const max = Math.max(0.1, ...rows.map((r) => r.avg));
  return { rows, max };
}

export function objectEvolution(ds: ObjectDataset, f: ObjectFilters, lastN = 14) {
  const lo = Math.max(0, ds.days - lastN);
  const out: { dayIndex: number; label: string; avg: number }[] = [];
  for (let d = lo; d < ds.days; d++) {
    let count = 0,
      samples = 0;
    for (const c of ds.cells)
      if (
        c.dayIndex === d &&
        inShift(c.hour, f.shift) &&
        (f.setor === "Todos" || c.setor === f.setor)
      ) {
        count += c.countSum;
        samples += c.samples;
      }
    const date = new Date(ds.startMs + d * 86_400_000);
    out.push({
      dayIndex: d,
      label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      avg: samples ? +(count / samples).toFixed(1) : 0,
    });
  }
  const max = Math.max(0.1, ...out.map((o) => o.avg));
  return { bars: out, max };
}

export function objectInsights(k: ObjectKpis, loads: number): string[] {
  const out: string[] = [];
  if (k.topClasse !== "—")
    out.push(`${k.topClasse} é o objeto mais presente (${k.presenceTopPct}% do tempo).`);
  out.push(`Pico de ${k.peak} objeto(s) simultâneos; média de ${k.avgCount} em cena.`);
  if (loads > 0) out.push(`${loads} carregamento(s) manual(is) detectado(s) no período.`);
  return out;
}
