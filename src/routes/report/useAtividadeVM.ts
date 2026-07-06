// View-model do modo ATIVIDADE do Relatório. Computa SÓ o que a visão atual precisa:
// "off" → nada; "summary" (Resumo executivo) → janela + KPIs + insights; "full" → também
// gráficos/ranking/eventos/fluxo. Hooks incondicionais (ordem estável) — o gate é interno
// aos memos. As agregações são as puras de report/calc; aqui só a moradia dos memos.
import { useMemo } from "react";
import {
  windows,
  kpis,
  heatmap,
  ranking,
  evolution,
  insights,
  byAtividade,
  flowWindow,
  flowKpis,
  flowByHour,
  flowByLine,
  type Dataset,
  type EventRow,
  type Filters,
  type Kpis,
  type Period,
  type Shift,
  type FlowDataset,
} from "../../report/calc";
import { peoplePeakOf } from "../../report/store";
import { filterByWindow, byShift } from "./aggregate";
import type { ByShift, VmView } from "./chrome";
import type { FlowView } from "./AtividadePanel";

const EMPTY_DS: Dataset = { days: 0, areas: [], cameraOf: {}, cells: [], startMs: Date.now() };

export type AtividadeSummary = {
  k: Kpis;
  kPrev: Kpis;
  kPeople: number; // pico de pessoas no recorte (0 = sem detecção no período)
  tips: string[];
};
export type AtividadeDetails = {
  hm: ReturnType<typeof heatmap>;
  rank: ReturnType<typeof ranking>;
  byAtiv: ReturnType<typeof byAtividade>;
  evo: ReturnType<typeof evolution>;
  byShiftA: ByShift;
  evt: EventRow[];
  // Fluxo respeita período/turno; o filtro de ÁREA não se aplica (buckets são câmera×linha).
  // null = hub sem o kind "flow" → seção/aba ocultas (graceful).
  flowView: FlowView | null;
};

export function useAtividadeVM(args: {
  view: VmView;
  ds: Dataset | null;
  events: EventRow[];
  flowDs: FlowDataset | null;
  period: Period;
  shift: Shift | "Todos";
  area: string | "Todas";
}): { dataset: Dataset; summary: AtividadeSummary | null; details: AtividadeDetails | null } {
  const { view, ds, events, flowDs, period, shift, area } = args;
  const dataset = ds ?? EMPTY_DS;
  const off = view === "off";
  const full = view === "full";

  const base = useMemo(() => {
    if (off) return null;
    const f: Filters = { period, shift, area };
    const { current, previous } = windows(dataset, f);
    const k = kpis(current);
    return {
      cur: current,
      summary: {
        k,
        kPrev: kpis(previous),
        kPeople: peoplePeakOf(current),
        tips: insights(current, k),
      } satisfies AtividadeSummary,
    };
  }, [off, dataset, period, shift, area]);

  const details = useMemo<AtividadeDetails | null>(() => {
    if (!full || !base) return null;
    const aCur = base.cur;
    let flowView: FlowView | null = null;
    if (flowDs) {
      const cells = flowWindow(flowDs, period, shift);
      flowView = {
        hasAny: flowDs.cells.length > 0,
        k: flowKpis(cells),
        byHour: flowByHour(cells),
        byLine: flowByLine(cells),
      };
    }
    return {
      hm: heatmap(aCur, area === "Todas" ? dataset.areas : [area]),
      rank: ranking(aCur, dataset.areas),
      byAtiv: byAtividade(aCur),
      evo: evolution(dataset, { period, shift, area }, 14),
      byShiftA: byShift(aCur, (c) => c.idleMin),
      evt: filterByWindow(events, period, shift, (e) => area === "Todas" || e.area === area).slice(
        0,
        80,
      ),
      flowView,
    };
  }, [full, base, dataset, events, flowDs, period, shift, area]);

  return { dataset, summary: base?.summary ?? null, details };
}
