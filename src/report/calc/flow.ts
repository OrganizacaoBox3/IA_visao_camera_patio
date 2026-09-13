// FLUXO DE PESSOAS (tripwire) — agregações puras sobre o dataset de cruzamentos.
// Buckets são hora×câmera×linha: o filtro de ÁREA do modo Atividade NÃO se aplica aqui
// (não existe noção de área no cruzamento). Filtros suportados: PERÍODO e TURNO, com a
// mesma geometria de janela de windows() (calc/atividade). O I/O (ingest/load) vive em
// report/store.ts; aqui só funções determinísticas (Vitest ao lado em flow.test.ts).

import { type Period, type ShiftFilter, type ShiftStamp, periodDays, inShift } from "./common";

// Carimbo de turno ADITIVO — mas ATENÇÃO (spec §8, fora de escopo v1): o cruzamento é por LINHA,
// não por zona, e a linha não tem turno atribuído. Enquanto o hub não carimbar o bucket de flow,
// o recorte por turno aqui cai no legado (derivação pela hora) — pendência registrada.
export type FlowCell = ShiftStamp & {
  cameraId: string;
  cameraLabel: string;
  tripwireId: string;
  dayIndex: number;
  hour: number;
  in: number;
  out: number;
};
export type FlowDataset = { days: number; cells: FlowCell[]; startMs: number };

/** Chave de uma LINHA (câmera × tripwire). Uma função só: a chave era remontada à mão em cada
 *  agregação, e chave divergente é o jeito clássico de dois números do mesmo relatório não
 *  fecharem. O `|` não aparece em id de câmera/tripwire (ambos são slug/gerados). */
export const flowLineKey = (cameraId: string, tripwireId: string) => `${cameraId}|${tripwireId}`;

/** Recorte "current" do período/turno. */
export function flowWindow(ds: FlowDataset, period: Period, shift: ShiftFilter): FlowCell[] {
  const W = periodDays[period];
  const lo = ds.days - W;
  const hi = ds.days - 1;
  return ds.cells.filter((c) => c.dayIndex >= lo && c.dayIndex <= hi && inShift(c, shift));
}

/** Janela ANTERIOR de mesmo tamanho — base do delta período×período (as outras dimensões já
 *  tinham; o fluxo não, e sem ela "1.240 entradas" não diz se subiu ou caiu). */
export function flowPrevWindow(ds: FlowDataset, period: Period, shift: ShiftFilter): FlowCell[] {
  const W = periodDays[period];
  const lo = Math.max(0, ds.days - 2 * W);
  const hi = ds.days - W - 1;
  if (hi < 0) return [];
  return ds.cells.filter((c) => c.dayIndex >= lo && c.dayIndex <= hi && inShift(c, shift));
}

export type FlowKpis = {
  in: number;
  out: number;
  /** entradas − saídas. Num corredor fechado tende a zero; desvio grande é linha mal posicionada
   *  ou travessia que o motor perdeu de um lado (é DIAGNÓSTICO, não meta de operação). */
  saldo: number;
  /** total de travessias (entradas + saídas) — o volume que a linha realmente mediu. */
  total: number;
  lines: number;
  /** hora de maior movimento. `null` sem nenhuma travessia (não existe pico de nada). */
  peakHour: number | null;
};

/** Totais do recorte: entradas, saídas, saldo, total, nº de linhas e hora de pico. */
export function flowKpis(cells: FlowCell[]): FlowKpis {
  let inSum = 0;
  let outSum = 0;
  const lines = new Set<string>();
  const porHora = new Array(24).fill(0) as number[];
  for (const c of cells) {
    inSum += c.in;
    outSum += c.out;
    porHora[c.hour] += c.in + c.out;
    lines.add(flowLineKey(c.cameraId, c.tripwireId));
  }
  const maxHora = Math.max(...porHora);
  return {
    in: inSum,
    out: outSum,
    saldo: inSum - outSum,
    total: inSum + outSum,
    lines: lines.size,
    peakHour: maxHora > 0 ? porHora.indexOf(maxHora) : null,
  };
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
    const key = flowLineKey(c.cameraId, c.tripwireId);
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


/** Recorte por LINHA (câmera×tripwire). "Todas" devolve tudo — o fluxo ganhou filtro próprio
 *  porque o de ÁREA nunca se aplicou a ele: cruzamento é por câmera×linha, sem noção de área. */
export function flowOfLine(cells: FlowCell[], lineKey: string | "Todas"): FlowCell[] {
  if (!lineKey || lineKey === "Todas") return cells;
  return cells.filter((c) => flowLineKey(c.cameraId, c.tripwireId) === lineKey);
}

/** Série DIÁRIA (últimos N dias do dataset) de entradas/saídas — a tendência que faltava.
 *  Mesma geometria do evolution() de atividade: dia-índice → rótulo dd/mm. */
export function flowEvolution(
  ds: FlowDataset,
  shift: ShiftFilter,
  lineKey: string | "Todas" = "Todas",
  lastN = 14,
): { bars: { dayIndex: number; label: string; in: number; out: number }[]; max: number } {
  const lo = Math.max(0, ds.days - lastN);
  const bars: { dayIndex: number; label: string; in: number; out: number }[] = [];
  for (let d = lo; d < ds.days; d++) {
    let entradas = 0;
    let saidas = 0;
    for (const c of ds.cells) {
      if (c.dayIndex !== d || !inShift(c, shift)) continue;
      if (lineKey !== "Todas" && flowLineKey(c.cameraId, c.tripwireId) !== lineKey) continue;
      entradas += c.in;
      saidas += c.out;
    }
    const date = new Date(ds.startMs + d * 86_400_000);
    bars.push({
      dayIndex: d,
      label: date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      in: entradas,
      out: saidas,
    });
  }
  const max = Math.max(1, ...bars.map((b) => Math.max(b.in, b.out)));
  return { bars, max };
}

/** Opções do seletor de linha: rótulo humano ("Câmera · linha N" quando a câmera tem mais de
 *  uma) já resolvido aqui, para tela, PDF e CSV nomearem a MESMA linha do mesmo jeito. */
export function flowLineOptions(
  cells: FlowCell[],
): { key: string; label: string; cameraLabel: string; tripwireId: string }[] {
  const porCamera = new Map<string, Set<string>>();
  const labelDe = new Map<string, string>();
  for (const c of cells) {
    if (!porCamera.has(c.cameraId)) porCamera.set(c.cameraId, new Set());
    porCamera.get(c.cameraId)!.add(c.tripwireId);
    if (c.cameraLabel) labelDe.set(c.cameraId, c.cameraLabel);
  }
  const out: { key: string; label: string; cameraLabel: string; tripwireId: string }[] = [];
  for (const [cameraId, ids] of porCamera) {
    const cam = labelDe.get(cameraId) || cameraId;
    const ordenados = [...ids].sort();
    for (const tripwireId of ordenados)
      out.push({
        key: flowLineKey(cameraId, tripwireId),
        label: ordenados.length > 1 ? `${cam} · linha ${ordenados.indexOf(tripwireId) + 1}` : cam,
        cameraLabel: cam,
        tripwireId,
      });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

/** Resolve a CHAVE da linha no rótulo humano. Existe para que tela, PDF e CSV nomeiem a mesma
 *  linha do mesmo jeito — a chave (`cameraId|tripwireId`) nunca é para olho humano. Linha que
 *  saiu do dataset (câmera removida) volta a própria chave em vez de sumir do relatório. */
export function flowLabelResolver(
  options: ReturnType<typeof flowLineOptions>,
): (key: string) => string {
  const m = new Map(options.map((o) => [o.key, o.label]));
  return (key) => m.get(key) ?? key;
}
