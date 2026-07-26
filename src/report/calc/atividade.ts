// Modo ATIVIDADE — ociosidade/ocupação por Área × Hora. Agregações puras.
// Tudo aqui são INDICADORES (tempo/alertas/ocupação) — nunca imagens.

import {
  type Period,
  type ShiftFilter,
  type ShiftStamp,
  periodDays,
  inShift,
  shiftStateOf,
} from "./common";

// A célula é um bucket hora×área. Os campos de TURNO (ShiftStamp) e as amostras são ADITIVOS:
// hub antigo omite → o relatório cai no legado (CA-5/CA-8) e a régua de turno se declara
// "sem carimbo" em vez de inventar número.
export type Cell = ShiftStamp & {
  area: string;
  dayIndex: number;
  hour: number;
  idleMin: number;
  alerts: number;
  activePct: number;
  atividade?: string;
  /** amostras do bucket — PESO da ocupação (sem elas, activePct vira média simples de médias). */
  samples?: number;
  activeSamples?: number;
};
export type Dataset = {
  days: number;
  areas: string[];
  cameraOf: Record<string, string>;
  cells: Cell[];
  startMs: number;
};

export type Filters = { period: Period; shift: ShiftFilter; area: string | "Todas" };

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
        inShift(c, f.shift) &&
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

// ── OCIOSIDADE: MEDIDA ou NÃO MEDIDA? (auditoria 2026-07-26, A6) ─────────────────────────────
// Com o motor no HUB (ADR-009) o bucket "ativ" chega com `idleMs: 0` POR CONSTRUÇÃO
// (server/analysis/pipeline.js:253 — "ociosidade por motion segue no front"), e o cliente só
// mede quando alguém deixa a câmera aberta. Resultado: `idleMin` zerado NÃO significa "nada
// parou" — significa "ninguém mediu". O bucket não carrega carimbo de origem, então os dois
// casos são INDISTINGUÍVEIS aqui; entre afirmar "0m parado" e declarar ignorância, a casa
// declara (falso-OK é pior que erro). O custo é assumido e conhecido: um recorte real de
// ociosidade zero também aparece como "não medida" — conservador na direção segura.
// NÃO tente medir ociosidade aqui: isto só para de afirmar zero.
export type IdleMeasurement = {
  /** houve ALGUMA ociosidade registrada no recorte (⇒ existe medição de fato). */
  measured: boolean;
  /** há buckets no recorte (⇒ a câmera observou algo, e ainda assim o tempo parado veio zerado). */
  buckets: number;
  /** amostras observadas nos buckets (frames agregados) — 0 em hub antigo que não manda o campo. */
  observedSamples: number;
};

export function idleMeasurement(cells: Cell[]): IdleMeasurement {
  let idleMin = 0,
    observedSamples = 0;
  for (const c of cells) {
    idleMin += c.idleMin;
    observedSamples += typeof c.samples === "number" ? c.samples : 0;
  }
  return { measured: idleMin > 0, buckets: cells.length, observedSamples };
}

/** A UI deve trocar o número por um selo de indisponibilidade? (observou e não mediu) */
export function idleUnavailable(m: IdleMeasurement): boolean {
  return !m.measured && m.buckets > 0;
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

/** Ranking por ATIVIDADE (rótulo da zona): idleMin/alertas somados, só linhas com
 *  ociosidade, ordenado por tempo parado. Célula sem atividade agrega em "Indefinida". */
export function byAtividade(cells: Cell[]): {
  rows: { atividade: string; idleMin: number; alerts: number }[];
  max: number;
} {
  const m = new Map<string, { idleMin: number; alerts: number }>();
  for (const c of cells) {
    const a = c.atividade ?? "Indefinida";
    const e = m.get(a) ?? { idleMin: 0, alerts: 0 };
    e.idleMin += c.idleMin;
    e.alerts += c.alerts;
    m.set(a, e);
  }
  const rows = [...m.entries()]
    .map(([atividade, v]) => ({ atividade, ...v }))
    .filter((r) => r.idleMin > 0)
    .sort((a, b) => b.idleMin - a.idleMin);
  return { rows, max: Math.max(1, ...rows.map((r) => r.idleMin)) };
}

/** Tendência: idleMin por dia nos últimos N dias (respeita filtros de área/turno). */
export function evolution(ds: Dataset, f: Filters, lastN = 14) {
  const lo = Math.max(0, ds.days - lastN);
  const out: { dayIndex: number; label: string; idleMin: number }[] = [];
  for (let d = lo; d < ds.days; d++) {
    let idleMin = 0;
    for (const c of ds.cells)
      if (c.dayIndex === d && inShift(c, f.shift) && (f.area === "Todas" || c.area === f.area))
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

export type EventRow = ShiftStamp & {
  ts: number;
  area: string;
  camera: string;
  durationMin: number;
  /** rótulo exibível do turno (nome cadastrado ou legado) — sempre presente na linha gravada. */
  shift: string;
};

// ── RÉGUA DO TURNO (spec §4.3 + D7) ──────────────────────────────────────────────────────────
// A ociosidade só existe DENTRO do turno, fora das pausas (modelo OEE: Planned Production Time =
// turno − pausas; fora do turno é Schedule Loss, EXCLUÍDO da conta). Duas consequências duras:
//   1. o denominador da ocupação é o tempo de turno OBSERVADO — nunca 24h;
//   2. atividade FORA do turno é LINHA PRÓPRIA (D7) — nunca entra naquele denominador.
// `stamped=false` ⇒ o hub ainda NÃO carimba `shiftId` nos buckets: a régua não existe e a UI/CSV
// tem de dizer isso (número honesto ou número nenhum). Ver PENDÊNCIA no fim do arquivo.

export type ShiftRuler = {
  /** o hub carimbou turno em ALGUMA célula do recorte? false ⇒ tudo abaixo é legado/24-7. */
  stamped: boolean;
  /** ocupação DENTRO do turno: amostras ativas ÷ amostras do turno (pausas excluídas). */
  occupancyPct: number | null;
  idleMinInShift: number;
  alertsInShift: number;
  hoursInShift: number;
  /** horas-bucket em PAUSA (D3): vazio esperado — fora do numerador E do denominador. */
  pauseHours: number;
  /** D7 — atividade FORA do turno: semântica própria, jamais misturada na ocupação acima. */
  offActivePct: number | null;
  offActiveHours: number;
  offIdleMin: number;
  offAlerts: number;
  /** horas-bucket sem carimbo (dado antigo): não são "fora de turno", são desconhecidas. */
  unknownHours: number;
};

// Amostras da célula: peso real quando o hub as manda; 1 (média simples) quando não — e aí o
// activePct do bucket é tudo que existe. Degradação explícita, não silenciosa.
function weightOf(c: Cell): { samples: number; active: number } {
  const samples = typeof c.samples === "number" && c.samples > 0 ? c.samples : 1;
  const active =
    typeof c.activeSamples === "number" ? c.activeSamples : (c.activePct / 100) * samples;
  return { samples, active };
}

export function shiftRuler(cells: Cell[]): ShiftRuler {
  let inSamples = 0,
    inActive = 0,
    idleMinInShift = 0,
    alertsInShift = 0,
    hoursInShift = 0,
    pauseHours = 0;
  let offSamples = 0,
    offActive = 0,
    offIdleMin = 0,
    offAlerts = 0,
    offHours = 0,
    offActiveHours = 0;
  let unknownHours = 0;

  for (const c of cells) {
    const state = shiftStateOf(c);
    const { samples, active } = weightOf(c);
    if (state === "dentro") {
      if (c.inPause) {
        pauseHours++; // pausa = vazio ESPERADO (D3) — não vira ociosidade nem ocupação
        continue;
      }
      hoursInShift++;
      inSamples += samples;
      inActive += active;
      idleMinInShift += c.idleMin;
      alertsInShift += c.alerts;
    } else if (state === "fora") {
      offHours++;
      offSamples += samples;
      offActive += active;
      offIdleMin += c.idleMin;
      offAlerts += c.alerts;
      if (active > 0) offActiveHours++;
    } else {
      unknownHours++;
    }
  }

  const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 100) : null);
  return {
    stamped: hoursInShift + pauseHours + offHours > 0,
    occupancyPct: pct(inActive, inSamples),
    idleMinInShift,
    alertsInShift,
    hoursInShift,
    pauseHours,
    offActivePct: pct(offActive, offSamples),
    offActiveHours,
    offIdleMin,
    offAlerts,
    unknownHours,
  };
}

/** Texto único do selo de ociosidade não medida — fonte única (tela, insight e CSV). */
export const IDLE_UNAVAILABLE_NOTE =
  "Ociosidade não medida no período — o motor do hub não mede tempo parado; nenhum número de ociosidade é exibido.";

/** Insights da operação. Sem ociosidade MEDIDA, nada de "pico às 00h" nem de "área mais parada":
 *  a lista devolve a DECLARAÇÃO da indisponibilidade (ou nada, se o recorte está vazio). */
export function insights(cells: Cell[], k: Kpis): string[] {
  if (cells.length === 0) return []; // recorte vazio: quem fala é o estado de vazio, não o insight
  const idle = idleMeasurement(cells);
  const out: string[] = [];
  if (idleUnavailable(idle)) {
    out.push(IDLE_UNAVAILABLE_NOTE);
    if (k.alerts > 0)
      out.push(`${k.alerts} alertas no período; revisar limites por área para reduzir ruído.`);
    return out;
  }
  const total = k.idleMin || 1;
  const byArea = new Map<string, number>();
  for (const c of cells) byArea.set(c.area, (byArea.get(c.area) ?? 0) + c.idleMin);
  const top = [...byArea.entries()].sort((a, b) => b[1] - a[1])[0];
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
