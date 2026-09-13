// View-model do modo FLUXO (linhas de contagem). Mesmo molde dos outros: "off" → nada;
// "summary" (Resumo executivo) → KPIs; "full" → também tendência/por-linha. Hooks
// incondicionais (ordem estável); o gate é interno aos memos.
//
// POR QUE O FLUXO VIROU MODO PRÓPRIO: ele era a 4ª aba de ATIVIDADE — um modo cujo filtro é
// ÁREA, que não se aplica a cruzamento nenhum (a linha é por câmera, não por área). O painel
// tinha até uma nota avisando disso. Um relatório que precisa explicar por que o filtro ao lado
// não vale para ele está no lugar errado: o fluxo tem dimensão própria (a LINHA) e agora tem
// filtro próprio.
import { useMemo } from "react";
import {
  flowWindow,
  flowPrevWindow,
  flowKpis,
  flowByHour,
  flowByLine,
  flowEvolution,
  flowLineKey,
  flowOfLine,
  flowLineOptions,
  flowLabelResolver,
  type FlowDataset,
  type FlowKpis,
  type Period,
  type ShiftFilter,
} from "../../report/calc";
import type { VmView } from "./chrome";

export type FluxoSummary = {
  k: FlowKpis;
  kPrev: FlowKpis;
  tips: string[];
  /** chave da linha de maior movimento no recorte — o cartão do Resumo precisa dela, e o Resumo
   *  não computa `details`. `null` = nenhuma travessia (não existe "a mais movimentada"). */
  topLine: string | null;
};
export type FluxoDetails = {
  byHour: ReturnType<typeof flowByHour>;
  byLine: ReturnType<typeof flowByLine>;
  evo: ReturnType<typeof flowEvolution>;
};

const EMPTY_DS: FlowDataset = { cells: [], days: 0, startMs: Date.now() };

/** Leituras que o número sozinho não dá. Nada de conselho genérico: cada uma nasce de um fato
 *  do recorte, e o SALDO é tratado como diagnóstico de instalação, não como meta de operação. */
function fluxoTips(k: FlowKpis, kPrev: FlowKpis): string[] {
  const tips: string[] = [];
  if (k.total === 0) return tips;
  if (k.peakHour !== null)
    tips.push(`Maior movimento às ${String(k.peakHour).padStart(2, "0")}h.`);
  // Desequilíbrio: num ponto de passagem quem entra acaba saindo. Acima de 20% do total, ou a
  // linha está mal posicionada, ou o motor perdeu travessias de um dos lados.
  const desvio = k.total > 0 ? Math.abs(k.saldo) / k.total : 0;
  if (desvio > 0.2)
    tips.push(
      `Entradas e saídas desequilibradas (saldo ${k.saldo > 0 ? "+" : ""}${k.saldo} em ${k.total} travessias): revise o posicionamento da linha — num ponto de passagem quem entra costuma sair.`,
    );
  if (kPrev.total > 0) {
    const delta = Math.round(((k.total - kPrev.total) / kPrev.total) * 100);
    if (Math.abs(delta) >= 15)
      tips.push(
        `Movimento ${delta > 0 ? "subiu" : "caiu"} ${Math.abs(delta)}% frente ao período anterior.`,
      );
  }
  return tips;
}

export function useFluxoVM(args: {
  view: VmView;
  ds: FlowDataset | null;
  period: Period;
  shift: ShiftFilter;
  /** chave câmera×linha, ou "Todas" — o filtro PRÓPRIO deste modo. */
  linha: string | "Todas";
}): {
  dataset: FlowDataset;
  /** opções do seletor de linha, do dataset INTEIRO (não do recorte: senão a linha sem
   *  cruzamento no período sumiria do seletor e o usuário não teria como investigá-la). */
  lineOptions: ReturnType<typeof flowLineOptions>;
  /** chave → rótulo humano. Mesma função para tela, PDF e CSV (nomes que não divergem). */
  labelOf: (key: string) => string;
  summary: FluxoSummary | null;
  details: FluxoDetails | null;
  /** células da janela FILTRADA. `null` = view "off" (não computado) — nunca vira "sem dado". */
  windowCells: number | null;
} {
  const { view, ds, period, shift, linha } = args;
  const dataset = ds ?? EMPTY_DS;
  const off = view === "off";
  const full = view === "full";

  const lineOptions = useMemo(() => flowLineOptions(dataset.cells), [dataset]);
  const labelOf = useMemo(() => flowLabelResolver(lineOptions), [lineOptions]);

  const base = useMemo(() => {
    if (off) return null;
    const cur = flowOfLine(flowWindow(dataset, period, shift), linha);
    const prev = flowOfLine(flowPrevWindow(dataset, period, shift), linha);
    const k = flowKpis(cur);
    const kPrev = flowKpis(prev);
    const linhas = flowByLine(cur); // ordenado por movimento: a 1ª é a mais movimentada
    const top = linhas.rows[0];
    const summary: FluxoSummary = {
      k,
      kPrev,
      tips: fluxoTips(k, kPrev),
      topLine: top ? flowLineKey(top.cameraId, top.tripwireId) : null,
    };
    return { cur, k, summary };
  }, [off, dataset, period, shift, linha]);

  const details = useMemo(() => {
    if (!full || !base) return null;
    return {
      byHour: flowByHour(base.cur),
      byLine: flowByLine(base.cur),
      evo: flowEvolution(dataset, shift, linha, 14),
    };
  }, [full, base, dataset, shift, linha]);

  return {
    dataset,
    lineOptions,
    labelOf,
    summary: base?.summary ?? null,
    details,
    windowCells: base ? base.cur.length : null,
  };
}
