// View-model do modo ATIVIDADE do Relatório. Computa SÓ o que a visão atual precisa:
// "off" → nada; "summary" (Resumo executivo) → janela + KPIs + insights; "full" → também
// gráficos/ranking/eventos. Hooks incondicionais (ordem estável) — o gate é interno
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
  shiftRuler,
  idleMeasurement,
  type IdleMeasurement,
  type Dataset,
  type EventRow,
  type Filters,
  type Kpis,
  type Period,
  type ShiftDef,
  type ShiftFilter,
  type ShiftRuler,
} from "../../report/calc";
import { peoplePeakOf } from "../../report/store";
import { filterByWindow, byShift } from "./aggregate";
import type { ByShift, VmView } from "./chrome";

const EMPTY_DS: Dataset = { days: 0, areas: [], cameraOf: {}, cells: [], startMs: Date.now() };

export type AtividadeSummary = {
  k: Kpis;
  kPrev: Kpis;
  kPeople: number; // pico de pessoas no recorte (0 = sem detecção no período)
  tips: string[];
  // Régua do TURNO (spec §4.3): ocupação ÷ turno−pausas (não ÷ 24h) + a linha "fora do turno"
  // (D7). `ruler.stamped=false` ⇒ o hub ainda não carimba shiftId no bucket → a UI omite.
  ruler: ShiftRuler;
  // A ociosidade foi MEDIDA no recorte? Com o motor no hub o bucket vem com idleMs=0 por
  // construção (A6) — a UI troca o número pelo selo em vez de exibir "0m". Ver calc/atividade.
  idle: IdleMeasurement;
};
export type AtividadeDetails = {
  hm: ReturnType<typeof heatmap>;
  rank: ReturnType<typeof ranking>;
  byAtiv: ReturnType<typeof byAtividade>;
  evo: ReturnType<typeof evolution>;
  byShiftA: ByShift;
  evt: EventRow[];
};

export function useAtividadeVM(args: {
  view: VmView;
  ds: Dataset | null;
  events: EventRow[];
  period: Period;
  shift: ShiftFilter;
  area: string | "Todas";
  /** cadastro de turnos (/api/shifts) — rótulo e ordem das barras "Por turno". */
  shifts: ShiftDef[];
}): {
  dataset: Dataset;
  summary: AtividadeSummary | null;
  details: AtividadeDetails | null;
  /** células da JANELA FILTRADA (período+turno+área). `null` = view "off", não computado —
   *  "não calculei" nunca pode virar "não há dado" (o gate de vazio depende disto). */
  windowCells: number | null;
} {
  const { view, ds, events, period, shift, area, shifts } = args;
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
        ruler: shiftRuler(current),
        idle: idleMeasurement(current),
      } satisfies AtividadeSummary,
    };
  }, [off, dataset, period, shift, area]);

  const details = useMemo<AtividadeDetails | null>(() => {
    if (!full || !base) return null;
    const aCur = base.cur;
    return {
      hm: heatmap(aCur, area === "Todas" ? dataset.areas : [area]),
      rank: ranking(aCur, dataset.areas),
      byAtiv: byAtividade(aCur),
      evo: evolution(dataset, { period, shift, area }, 14),
      byShiftA: byShift(aCur, (c) => c.idleMin, shifts),
      evt: filterByWindow(events, period, shift, (e) => area === "Todas" || e.area === area).slice(
        0,
        80,
      ),
    };
  }, [full, base, dataset, events, period, shift, area, shifts]);

  return {
    dataset,
    summary: base?.summary ?? null,
    details,
    windowCells: base ? base.cur.length : null,
  };
}
