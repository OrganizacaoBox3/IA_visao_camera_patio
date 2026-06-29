// Estimativa de ALERTAS/DIA de uma zona de ATIVIDADE a partir do HISTÓRICO (report/store).
// Função PURA e read-only — não faz IO nem toca em React. Consumida pela Onda 2
// (CameraWorkspace) ao lado do slider de sensibilidade, para PREVER o volume de alertas
// que uma configuração geraria ANTES de aplicá-la (padrão "preview de impacto" do benchmark
// VMS/Cognex — analises/benchmark-interfaces/00-sintese-recomendacoes.md, Onda A #3).
//
// PREMISSAS (é uma estimativa GROSSEIRA p/ orientar, não um número exato — documentadas):
//  1. O histórico de alertas de uma área foi gerado com a sensibilidade PADRÃO (5), cujo
//     fator de limiar de movimento é 1.0 (ver sensitivityFactor). Mudar a sensibilidade
//     reescala esse limiar: MAIOR sensibilidade ⇒ detecta micro-movimento ⇒ menos
//     ociosidade ⇒ MENOS alertas; MENOR sensibilidade ⇒ MAIS alertas. Como o alerta nasce
//     da ociosidade, escalamos a linha de base pelo fator de sensibilidade.
//  2. baseline alertas/dia = (soma de alertas da área no histórico) ÷ (dias observados).
//  3. Não modelamos aqui mudança do LIMITE de parada (o slider previsto é o de sensibilidade);
//     o limite atual entra apenas como sinalização textual na UI (ex.: modo demo).
//  4. Sem células históricas para a área ⇒ status "no-data" ("sem dados suficientes").

import { type Dataset } from "./mock";
import { sensitivityFactor } from "../processors/atividade";

export type AlertPrediction =
  { status: "ok"; perDay: number; baselinePerDay: number; days: number } | { status: "no-data" };

// Sensibilidade assumida no histórico (default das zonas).
const BASELINE_SENSITIVITY = 5;

/** Estima alertas/dia da área `area` se a sensibilidade fosse `sensitivity` (1..10). */
export function predictAlertsPerDay(
  ds: Dataset,
  area: string,
  sensitivity: number,
): AlertPrediction {
  if (!ds || ds.days < 1) return { status: "no-data" };
  const cells = ds.cells.filter((c) => c.area === area);
  if (!cells.length) return { status: "no-data" };
  const totalAlerts = cells.reduce((a, c) => a + c.alerts, 0);
  const baselinePerDay = totalAlerts / ds.days;
  // alertas ∝ fator de limiar; baseline assumido em s=5 (fator 1.0).
  const scale = sensitivityFactor(sensitivity) / sensitivityFactor(BASELINE_SENSITIVITY);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    status: "ok",
    perDay: round1(Math.max(0, baselinePerDay * scale)),
    baselinePerDay: round1(baselinePerDay),
    days: ds.days,
  };
}
