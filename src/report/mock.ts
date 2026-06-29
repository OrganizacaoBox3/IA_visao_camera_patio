// Camada de dados do Relatório (Etapa A: MOCK realista, em memória).
// Tudo aqui são INDICADORES (tempo/alertas/ocupação) — nunca imagens.

export type Shift = "Manhã" | "Tarde" | "Noite";
export type Period = "hoje" | "7d" | "30d";

export function shiftOf(hour: number): Shift {
  if (hour >= 6 && hour < 14) return "Manhã";
  if (hour >= 14 && hour < 22) return "Tarde";
  return "Noite";
}

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

const periodDays: Record<Period, number> = { hoje: 1, "7d": 7, "30d": 30 };

export type Filters = { period: Period; shift: Shift | "Todos"; area: string | "Todas" };

function inShift(hour: number, shift: Shift | "Todos") {
  return shift === "Todos" || shiftOf(hour) === shift;
}

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

export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
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

export function fmtMin(min: number): string {
  const h = Math.floor(min / 60),
    m = min % 60;
  return h <= 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`;
}

// ════════════════════════════════════════════════════════════════════════════
// MODO LEITURA (código de barras) — agregações próprias por Ponto de Leitura.
// "caixa" = leitura distinta no ponto (dedup por código+janela); "reads" = volume bruto;
// "multiReads" = caixas confirmadas por +1 câmera. perCamera = contribuição por câmera.
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// MODO OBJETOS (contagem/identificação) — presença e contagem por Setor × Classe.
// "present" = nº de amostras com a classe em cena; presença % = present/samples.
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// MODO FADIGA (operador) — tempo em cada estado de risco + ocorrências, por posto.
// 1 amostra ≈ 1s. minutos = samples/60.
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// EVENTOS DE ALARME (Onda B, item 8 — ligação RELATÓRIO↔EVENTOS).
// Consome o contrato B1 (GET /api/alarms): SÓ METADADOS, sem imagens (LGPD).
// O relatório lê os eventos e os cruza com a própria timeline (jump-to-time +
// destaque bidirecional). As funções abaixo são puras (agregação/filtro em memória).
// ════════════════════════════════════════════════════════════════════════════

// Tipo do evento de alarme: fonte ÚNICA em src/types/alarm.ts (R2.2 — antes era redefinido aqui,
// com risco de drift vs. a cópia de api.ts). Re-exportado daqui para RETROCOMPATIBILIDADE:
// report/csv.ts, report/store.ts e ReportPage importam estes tipos via `./mock` sem alteração.
export type { AlarmEvent, AlarmPriority, AlarmState, AlarmTipo } from "../types/alarm";
import type { AlarmEvent, AlarmPriority, AlarmState } from "../types/alarm";

export type AlarmFilters = {
  period: Period;
  priority: AlarmPriority | "Todas";
  state: AlarmState | "Todos";
};
/** Janela de tempo selecionada via gráfico (jump-to-time): [from, to). */
export type AlarmWindow = { from: number; to: number; label: string };

const ALARM_DAY = 86_400_000;

/** Filtra eventos por período + prioridade + estado + (opcional) janela/hora. Janela de
 *  tempo (clique no gráfico) sobrepõe o limite inferior do período → jump-to-time funciona
 *  mesmo num dia anterior ao recorte atual. */
export function filterAlarms(
  events: AlarmEvent[],
  f: AlarmFilters,
  window: AlarmWindow | null = null,
  hourSel: number | null = null,
  now: number = Date.now(),
): AlarmEvent[] {
  const lo = now - periodDays[f.period] * ALARM_DAY;
  return events.filter(
    (e) =>
      (window ? e.ts >= window.from && e.ts < window.to : e.ts >= lo) &&
      (f.priority === "Todas" || e.priority === f.priority) &&
      (f.state === "Todos" || e.state === f.state) &&
      (hourSel == null || new Date(e.ts).getHours() === hourSel),
  );
}

export type AlarmKpis = {
  total: number;
  critical: number;
  high: number;
  advisory: number;
  news: number;
};

export function alarmKpis(events: AlarmEvent[]): AlarmKpis {
  let critical = 0,
    high = 0,
    advisory = 0,
    news = 0;
  for (const e of events) {
    if (e.priority === "critical") critical++;
    else if (e.priority === "high") high++;
    else advisory++;
    if (e.state === "new") news++;
  }
  return { total: events.length, critical, high, advisory, news };
}

/** Início (epoch-ms) do dia de um timestamp — base do bucket diário da tendência. */
export function alarmDayStart(ts: number): number {
  return Math.floor(ts / ALARM_DAY) * ALARM_DAY;
}

/** Tendência: nº de alarmes por dia nos últimos N dias (bidirecional: clicar num bar
 *  filtra a lista para aquele dia). `critical` separado p/ colorir o pico. */
export function alarmTrend(events: AlarmEvent[], lastN = 14, now: number = Date.now()) {
  const startToday = alarmDayStart(now);
  const bars: { dayStart: number; label: string; count: number; critical: number }[] = [];
  for (let i = lastN - 1; i >= 0; i--) {
    const dayStart = startToday - i * ALARM_DAY;
    bars.push({
      dayStart,
      label: new Date(dayStart).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      count: 0,
      critical: 0,
    });
  }
  const idx = new Map(bars.map((b, i) => [b.dayStart, i] as const));
  for (const e of events) {
    const i = idx.get(alarmDayStart(e.ts));
    if (i != null) {
      bars[i].count++;
      if (e.priority === "critical") bars[i].critical++;
    }
  }
  const max = Math.max(1, ...bars.map((b) => b.count));
  return { bars, max };
}

export const ALARM_PRIORITIES: AlarmPriority[] = ["critical", "high", "advisory"];

/** Heatmap: nº de alarmes por prioridade × hora-do-dia (clicar numa célula filtra por hora). */
export function alarmHeatmap(events: AlarmEvent[]) {
  const rows = ALARM_PRIORITIES.map((priority) => {
    const hours = new Array(24).fill(0) as number[];
    for (const e of events) if (e.priority === priority) hours[new Date(e.ts).getHours()]++;
    return { priority, hours };
  });
  const max = Math.max(1, ...rows.flatMap((r) => r.hours));
  return { rows, max };
}

export function alarmInsights(k: AlarmKpis, trend: ReturnType<typeof alarmTrend>): string[] {
  const out: string[] = [];
  if (k.total === 0) return ["Nenhum alarme no período."];
  const critPct = Math.round((k.critical / k.total) * 100);
  out.push(`${k.total} alarme(s) no período · ${k.critical} crítico(s) (${critPct}%).`);
  if (k.news > 0) out.push(`${k.news} ainda em aberto (não reconhecidos).`);
  const peak = [...trend.bars].sort((a, b) => b.count - a.count)[0];
  if (peak && peak.count > 0) out.push(`Pico em ${peak.label} (${peak.count} alarmes).`);
  return out;
}
