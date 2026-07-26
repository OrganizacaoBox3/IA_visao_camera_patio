// View-model do modo LEITURA do Relatório (mesmo padrão do useAtividadeVM):
// "off" → nada; "summary" → KPIs + insights; "full" → também gráficos/ranking/leituras.
import { useMemo } from "react";
import {
  readingWindows,
  readingKpis,
  readingHeatmap,
  readingRanking,
  readingByCamera,
  readingEvolution,
  readingInsights,
  type ReadingDataset,
  type ReadingEventRow,
  type ReadingFilters,
  type ReadingKpis,
  type Period,
  type ShiftDef,
  type ShiftFilter,
} from "../../report/calc";
import { filterByWindow, byShift } from "./aggregate";
import type { ByShift, VmView } from "./chrome";

const EMPTY_RDS: ReadingDataset = {
  days: 0,
  pontos: [],
  cameraLabels: {},
  cells: [],
  startMs: Date.now(),
};

export type LeituraSummary = { rk: ReadingKpis; rkPrev: ReadingKpis; rtips: string[] };
export type LeituraDetails = {
  rhm: ReturnType<typeof readingHeatmap>;
  rrank: ReturnType<typeof readingRanking>;
  byCam: ReturnType<typeof readingByCamera>;
  revo: ReturnType<typeof readingEvolution>;
  byShiftR: ByShift;
  revt: ReadingEventRow[];
};

export function useLeituraVM(args: {
  view: VmView;
  ds: ReadingDataset | null;
  events: ReadingEventRow[];
  period: Period;
  shift: ShiftFilter;
  ponto: string | "Todos";
  /** cadastro de turnos (/api/shifts) — rótulo e ordem das barras "Por turno". */
  shifts: ShiftDef[];
}): {
  dataset: ReadingDataset;
  summary: LeituraSummary | null;
  details: LeituraDetails | null;
  /** células da JANELA FILTRADA (período+turno+ponto). `null` = view "off", não computado —
   *  "não calculei" nunca pode virar "não há dado" (o gate de vazio depende disto). */
  windowCells: number | null;
} {
  const { view, ds, events, period, shift, ponto, shifts } = args;
  const dataset = ds ?? EMPTY_RDS;
  const off = view === "off";
  const full = view === "full";

  const base = useMemo(() => {
    if (off) return null;
    const f: ReadingFilters = { period, shift, ponto };
    const { current, previous } = readingWindows(dataset, f);
    const rk = readingKpis(current);
    return {
      cur: current,
      summary: {
        rk,
        rkPrev: readingKpis(previous),
        rtips: readingInsights(rk),
      } satisfies LeituraSummary,
    };
  }, [off, dataset, period, shift, ponto]);

  const details = useMemo<LeituraDetails | null>(() => {
    if (!full || !base) return null;
    const rCur = base.cur;
    return {
      rhm: readingHeatmap(rCur, ponto === "Todos" ? dataset.pontos : [ponto]),
      rrank: readingRanking(rCur, dataset.pontos),
      byCam: readingByCamera(rCur, dataset.cameraLabels),
      revo: readingEvolution(dataset, { period, shift, ponto }, 14),
      byShiftR: byShift(rCur, (c) => c.boxes, shifts),
      revt: filterByWindow(
        events,
        period,
        shift,
        (e) => ponto === "Todos" || e.ponto === ponto,
      ).slice(0, 120),
    };
  }, [full, base, dataset, events, period, shift, ponto, shifts]);

  return {
    dataset,
    summary: base?.summary ?? null,
    details,
    windowCells: base ? base.cur.length : null,
  };
}
