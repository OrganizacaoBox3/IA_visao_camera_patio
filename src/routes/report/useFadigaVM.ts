// View-model do modo OPERADOR/FADIGA do Relatório (mesmo padrão do useAtividadeVM).
// As OCORRÊNCIAS entram já no summary: o Resumo executivo mostra fadiga/celular, que são
// contagens da lista filtrada — o "full" só acrescenta heatmap/tendência.
import { useMemo } from "react";
import {
  fadigaWindows,
  fadigaKpis,
  fadigaHeatmap,
  fadigaEvolution,
  fadigaInsights,
  type FadigaDataset,
  type FadigaEventRow,
  type FadigaFilters,
  type FadigaKpis,
  type Period,
  type Shift,
} from "../../report/calc";
import { filterByWindow } from "./aggregate";
import type { VmView } from "./chrome";

const EMPTY_FDS: FadigaDataset = { days: 0, postos: [], cells: [], startMs: Date.now() };

export type FadigaSummary = {
  fk: FadigaKpis;
  fevt: FadigaEventRow[];
  fOccFadiga: number;
  fOccCelular: number;
  fBocejos: number;
  ftips: string[];
};
export type FadigaDetails = {
  fhm: ReturnType<typeof fadigaHeatmap>;
  fevo: ReturnType<typeof fadigaEvolution>;
};

export function useFadigaVM(args: {
  view: VmView;
  ds: FadigaDataset | null;
  events: FadigaEventRow[];
  period: Period;
  shift: Shift | "Todos";
  posto: string | "Todos";
}): {
  dataset: FadigaDataset;
  summary: FadigaSummary | null;
  details: FadigaDetails | null;
  /** células da JANELA FILTRADA (período+turno+posto). `null` = view "off", não computado. */
  windowCells: number | null;
} {
  const { view, ds, events, period, shift, posto } = args;
  const dataset = ds ?? EMPTY_FDS;
  const off = view === "off";
  const full = view === "full";

  const base = useMemo(() => {
    if (off) return null;
    const f: FadigaFilters = { period, shift, posto };
    const { current } = fadigaWindows(dataset, f);
    const fk = fadigaKpis(current);
    const fevt = filterByWindow(events, period, shift, (e) =>
      posto === "Todos" ? true : e.posto === posto,
    ).slice(0, 120);
    const fOccFadiga = fevt.filter((e) => e.type === "fadiga").length;
    const fOccCelular = fevt.filter((e) => e.type === "celular").length;
    return {
      cur: current,
      summary: {
        fk,
        fevt,
        fOccFadiga,
        fOccCelular,
        fBocejos: fevt.filter((e) => e.type === "bocejo").length,
        ftips: fadigaInsights(fk, fOccFadiga, fOccCelular),
      } satisfies FadigaSummary,
    };
  }, [off, dataset, events, period, shift, posto]);

  const details = useMemo<FadigaDetails | null>(() => {
    if (!full || !base) return null;
    return {
      fhm: fadigaHeatmap(base.cur),
      fevo: fadigaEvolution(dataset, { period, shift, posto }, 14),
    };
  }, [full, base, dataset, period, shift, posto]);

  return {
    dataset,
    summary: base?.summary ?? null,
    details,
    windowCells: base ? base.cur.length : null,
  };
}
