// MODO FADIGA (operador) — tempo em cada estado de risco + ocorrências, por posto.
// 1 amostra ≈ 1s. minutos = samples/60.

import { type Period, type ShiftFilter, type ShiftStamp, periodDays, inShift } from "./common";

// Carimbo de turno (ShiftStamp) é ADITIVO na célula e no evento — ver calc/common.
export type FadigaCell = ShiftStamp & {
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
export type FadigaEventRow = ShiftStamp & {
  ts: number;
  posto: string;
  type: string;
  shift: string;
};
export type FadigaFilters = { period: Period; shift: ShiftFilter; posto: string | "Todos" };
// AMOSTRA ZERO É `null`, NUNCA 100/0 (auditoria 2026-07-26, A2). `okPct: samples ? … : 100` fazia
// um período SEM NENHUMA amostra render "Operação saudável: 100% do tempo sem alerta" — e
// `alertPct: … : 0` pintava o KPI de verde ("≤2% é o normal"). Sem amostra não há percentual:
// `null` sobe até a UI, que escreve "—". Falso-OK é pior que erro.
export type FadigaKpis = {
  /** % do tempo em alerta. `null` = nenhuma amostra no recorte (sem denominador). */
  alertPct: number | null;
  /** % do tempo sem alerta. `null` = nenhuma amostra no recorte. */
  okPct: number | null;
  /** EAR médio. `null` = nenhuma amostra de EAR no recorte. */
  avgEar: number | null;
  /** hora de maior risco. Só tem sentido com `alertSamples > 0` (quem exibe checa). */
  peakHour: number;
  alertMin: number;
  postos: number;
  /** amostras do recorte (≈1/s). ADITIVO: é o "n" — quem exibe decide calar quando é 0. */
  samples: number;
  /** amostras em estado de risco (fadiga+celular+duplo) — o "n" do pico/das ocorrências. */
  alertSamples: number;
};

export function fadigaWindows(ds: FadigaDataset, f: FadigaFilters) {
  const W = periodDays[f.period];
  const sel = (lo: number, hi: number) =>
    ds.cells.filter(
      (c) =>
        c.dayIndex >= lo &&
        c.dayIndex <= hi &&
        inShift(c, f.shift) &&
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
    alertPct: samples ? Math.round((alert / samples) * 100) : null,
    okPct: samples ? Math.round(((samples - alert) / samples) * 100) : null,
    avgEar: earSamples ? +(earSum / earSamples).toFixed(2) : null,
    peakHour,
    alertMin: Math.round(alert / 60),
    postos: new Set(cells.map((c) => c.posto)).size,
    samples,
    alertSamples: alert,
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

// Tendência diária. `samples` viaja junto (ADITIVO): um dia sem amostra tem barra zero — que na
// tela é indistinguível de "dia perfeito". Quem desenha usa o `samples` para dizer "sem dado".
export function fadigaEvolution(ds: FadigaDataset, f: FadigaFilters, lastN = 14) {
  const lo = Math.max(0, ds.days - lastN);
  const out: { dayIndex: number; label: string; pct: number; samples: number }[] = [];
  for (let d = lo; d < ds.days; d++) {
    let samples = 0,
      alert = 0;
    for (const c of ds.cells)
      if (c.dayIndex === d && inShift(c, f.shift) && (f.posto === "Todos" || c.posto === f.posto)) {
        samples += c.samples;
        alert += c.fadiga + c.celular + c.duplo;
      }
    const date = new Date(ds.startMs + d * 86_400_000);
    out.push({
      dayIndex: d,
      label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      pct: samples ? Math.round((alert / samples) * 100) : 0,
      samples,
    });
  }
  const max = Math.max(1, ...out.map((o) => o.pct));
  return { bars: out, max };
}

// SEM AMOSTRA, SEM FRASE (mesma regra do readingInsights). "Operação saudável" com n=0 é a pior
// frase do relatório: afirma segurança onde não houve medição. Lista vazia ⇒ faixa não renderiza.
export function fadigaInsights(k: FadigaKpis, occFadiga: number, occCelular: number): string[] {
  if (k.alertPct === null || k.okPct === null) return []; // nenhuma amostra no recorte
  const out: string[] = [];
  out.push(
    k.alertPct <= 2
      ? `Operação saudável: ${k.okPct}% do tempo sem alerta.`
      : `${k.alertPct}% do tempo em alerta (${k.alertMin} min).`,
  );
  // Pico de risco sem NENHUMA amostra de risco seria sempre "00h" (o índice do máximo de um vetor
  // zerado) — um horário inventado. Só sai quando há risco medido.
  if (k.alertSamples > 0) out.push(`Pico de risco às ${String(k.peakHour).padStart(2, "0")}h.`);
  if (occFadiga + occCelular > 0)
    out.push(`${occFadiga} ocorrência(s) de fadiga, ${occCelular} de celular.`);
  return out;
}
