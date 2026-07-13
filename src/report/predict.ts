// Estimativa de ALERTAS/DIA de uma zona de ATIVIDADE a partir do HISTÓRICO (report/store).
// Função PURA e read-only — não faz IO nem toca em React. Consumida pela Onda 2
// (CameraWorkspace) ao lado do slider de sensibilidade, para PREVER o volume de alertas
// que uma configuração geraria ANTES de aplicá-la (padrão "preview de impacto" do benchmark
// VMS/Cognex — docs/analises/benchmark-interfaces/00-sintese-recomendacoes.md, Onda A #3).
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
//  5. TURNO (armadilha 10 da spec-turnos-por-zona): o preview SUPERESTIMAVA porque somava
//     alertas nascidos FORA do turno — que o gate de ociosidade do hub SUPRIME (spec §4.1).
//     Correção: quando o histórico da área vem CARIMBADO pelo hub, só os alertas DENTRO do
//     turno entram na linha de base; os de fora viram `outOfShiftPerDay` (o que o gate poupa).
//     Dado ANTIGO (sem carimbo) não dá para separar — entra na base, e `shiftAware` diz isso.

import { shiftStateOf, type Dataset, type Cell } from "./calc";
import { sensitivityFactor } from "../processors/atividade";

export type AlertPrediction =
  | {
      status: "ok";
      perDay: number;
      baselinePerDay: number;
      days: number;
      /** true = a linha de base já exclui os alertas fora de turno (histórico carimbado). */
      shiftAware: boolean;
      /** alertas/dia que nasciam FORA do turno — o gate de turno os suprime (0 se não carimbado). */
      outOfShiftPerDay: number;
    }
  | { status: "no-data" };

// Sensibilidade assumida no histórico (default das zonas).
const BASELINE_SENSITIVITY = 5;

/** Estima alertas/dia da área `area` se a sensibilidade fosse `sensitivity` (1..10).
 *  `opts.shiftIds` = turnos ATRIBUÍDOS à zona: com eles, "dentro do turno" é restrito a esses
 *  turnos (uma célula carimbada com o turno de OUTRA zona não conta como janela desta). */
export function predictAlertsPerDay(
  ds: Dataset,
  area: string,
  sensitivity: number,
  opts?: { shiftIds?: string[] },
): AlertPrediction {
  if (!ds || ds.days < 1) return { status: "no-data" };
  const cells = ds.cells.filter((c) => c.area === area);
  if (!cells.length) return { status: "no-data" };

  const zoneShifts = opts?.shiftIds?.length ? new Set(opts.shiftIds) : null;
  let inShiftAlerts = 0, // dentro do turno (o que o gate DEIXA passar)
    outOfShiftAlerts = 0, // fora do turno (o que o gate SUPRIME)
    unknownAlerts = 0, // dado antigo, sem carimbo: indivisível — fica na base
    stampedCells = 0;
  for (const c of cells) {
    const state = shiftStateOf(c);
    if (state === "sem-carimbo") {
      unknownAlerts += c.alerts;
      continue;
    }
    stampedCells++;
    if (isInsideZoneShift(c, state, zoneShifts)) inShiftAlerts += c.alerts;
    else outOfShiftAlerts += c.alerts;
  }

  const shiftAware = stampedCells > 0;
  // Sem carimbo, tudo entra (comportamento anterior, 24/7). Com carimbo, o que fica fora do
  // turno sai da base — é exatamente o que o gate de ociosidade não vai mais gerar.
  const totalAlerts = shiftAware
    ? inShiftAlerts + unknownAlerts
    : cells.reduce((a, c) => a + c.alerts, 0);
  const baselinePerDay = totalAlerts / ds.days;
  // alertas ∝ fator de limiar; baseline assumido em s=5 (fator 1.0).
  const scale = sensitivityFactor(sensitivity) / sensitivityFactor(BASELINE_SENSITIVITY);
  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    status: "ok",
    perDay: round1(Math.max(0, baselinePerDay * scale)),
    baselinePerDay: round1(baselinePerDay),
    days: ds.days,
    shiftAware,
    outOfShiftPerDay: shiftAware ? round1(outOfShiftAlerts / ds.days) : 0,
  };
}

// "Dentro do turno DESTA zona": carimbado como dentro E — quando a zona declara seus turnos —
// carimbado com um turno que é DELA. Sem `shiftIds`, qualquer turno carimbado serve.
function isInsideZoneShift(
  c: Cell,
  state: ReturnType<typeof shiftStateOf>,
  zoneShifts: Set<string> | null,
): boolean {
  if (state !== "dentro") return false;
  return !zoneShifts || zoneShifts.has(c.shiftId as string);
}
