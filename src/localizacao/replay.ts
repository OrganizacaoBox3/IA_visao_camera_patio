// O HARNESS de replay (dev.md §3, o de-risco de maior ROI): roda um MOTOR sobre uma GRAVAÇÃO
// (batch-a-batch, carregando o estado) e devolve as MÉTRICAS. Qualquer motor com a assinatura
// `LocalizationEngine` — o baseline de hoje ou o factor graph de amanhã — é medido sem mudança.
// É a máquina que torna "o motor melhorou?" uma pergunta com resposta numérica e reprodutível.
import type { EvidenceBatch } from "./evidence";
import { type LocalizationEngine, emptyState, outputOf } from "./engine";
import type { TruthPoint } from "./simulate";
import { computeMetrics, type Metrics } from "./metrics";

/** Uma gravação = as evidências + o ground truth alinhado (sintético hoje; real numa fase futura). */
export type Recording = { batches: EvidenceBatch[]; truth: TruthPoint[] };

/** Re-executa `engine` sobre `recording` e devolve as métricas comparáveis. */
export function replay(recording: Recording, engine: LocalizationEngine): Metrics {
  let state = emptyState();
  const estimates = recording.batches.map((batch) => {
    state = engine(batch, state);
    return outputOf(state).map((e) => ({ ...e })); // snapshot imutável do instante
  });
  return computeMetrics(estimates, recording.truth);
}
