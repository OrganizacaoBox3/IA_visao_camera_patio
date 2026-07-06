// View-model do modo OBJETOS do Relatório (mesmo padrão do useAtividadeVM).
// Os EVENTOS entram já no summary: o Resumo executivo precisa de oLoads (carregamentos),
// que é derivado da lista filtrada — o "full" só acrescenta gráficos/rankings.
import { useMemo } from "react";
import {
  objectWindows,
  objectKpis,
  objectHeatmap,
  objectPresence,
  objectRanking,
  objectByClass,
  objectEvolution,
  objectInsights,
  type ObjectDataset,
  type ObjectEventRow,
  type ObjectFilters,
  type ObjectKpis,
  type Period,
  type Shift,
} from "../../report/calc";
import { filterByWindow } from "./aggregate";
import type { VmView } from "./chrome";

const EMPTY_ODS: ObjectDataset = {
  days: 0,
  setores: [],
  classes: [],
  cells: [],
  startMs: Date.now(),
};

export type ObjetosSummary = {
  ok: ObjectKpis;
  oevt: ObjectEventRow[];
  oLoads: number;
  otips: string[];
};
export type ObjetosDetails = {
  ohm: ReturnType<typeof objectHeatmap>;
  opres: ReturnType<typeof objectPresence>;
  orank: ReturnType<typeof objectRanking>;
  obyClass: ReturnType<typeof objectByClass>;
  oevo: ReturnType<typeof objectEvolution>;
  presSetores: string[];
};

export function useObjetosVM(args: {
  view: VmView;
  ds: ObjectDataset | null;
  events: ObjectEventRow[];
  period: Period;
  shift: Shift | "Todos";
  setor: string | "Todos";
}): { dataset: ObjectDataset; summary: ObjetosSummary | null; details: ObjetosDetails | null } {
  const { view, ds, events, period, shift, setor } = args;
  const dataset = ds ?? EMPTY_ODS;
  const off = view === "off";
  const full = view === "full";

  const base = useMemo(() => {
    if (off) return null;
    const f: ObjectFilters = { period, shift, setor };
    const { current } = objectWindows(dataset, f);
    const ok = objectKpis(current);
    const oevt = filterByWindow(events, period, shift, (e) =>
      setor === "Todos" ? true : e.setor === setor,
    ).slice(0, 120);
    const oLoads = oevt.filter((e) => e.type === "carregamento").length;
    return {
      cur: current,
      summary: { ok, oevt, oLoads, otips: objectInsights(ok, oLoads) } satisfies ObjetosSummary,
    };
  }, [off, dataset, events, period, shift, setor]);

  const details = useMemo<ObjetosDetails | null>(() => {
    if (!full || !base) return null;
    const oCur = base.cur;
    const presSetores = setor === "Todos" ? dataset.setores : [setor];
    return {
      ohm: objectHeatmap(oCur, dataset.classes),
      opres: objectPresence(oCur, presSetores, dataset.classes),
      orank: objectRanking(oCur, dataset.setores),
      obyClass: objectByClass(oCur, dataset.classes),
      oevo: objectEvolution(dataset, { period, shift, setor }, 14),
      presSetores,
    };
  }, [full, base, dataset, period, shift, setor]);

  return { dataset, summary: base?.summary ?? null, details };
}
