// ── TELEMETRIA "NUNCA NÚMERO CRU" (Onda B item 10) ───────────────────────────
// Extraído do CameraWorkspace.tsx (R2.1) SEM mudança de comportamento. Cada indicador
// numérico do painel lateral vira valor + sparkline + FAIXA-ALVO (banda verde/aceitável),
// com realce quando fora da faixa (tokens --state-warn / --state-critical). As faixas-alvo
// DERIVAM dos thresholds já existentes; premissas documentadas abaixo:
//
//  • Movimento (atividade): unidades de view.motion (= min(1, motionEMA/(motionActiveRatio·6))).
//    A zona vira ATIVA quando motionEMA > motionActiveRatio·sf, i.e. view.motion > sf/6.
//    Faixa-alvo = [sf/6, 1] (movimento saudável). Abaixo = LENTA/parada → warn/critical (estado).
//  • Ocupação (atividade): faixa-alvo = [1, OCC_HI] pessoas (zona guarnecida, sem superlotar).
//    Acima de OCC_HI = warn. OCC_HI é heurístico (não há ocupação-alvo por zona ainda) — A CONFIRMAR.
//  • Taxa de leitura: faixa-alvo = [95, 100]% (via rateToMetric: ≥95 ok, ≥80 warn, abaixo
//    critical — alinhado a reading.rateAlertPct=80).
//  • No-reads: faixa-alvo = [0, 0] (ideal é zero). >0 = warn, ≥NOREAD_CRIT = critical.
//  • Lidas/min e Total de objetos: SEM faixa-alvo fixa (depende da linha/cena) → só valor +
//    tendência. A CONFIRMAR se houver meta de throughput por ponto/cena.
//  • EAR (fadiga): faixa-alvo = [eyesClosedEarThreshold, EAR_HI] (olhos abertos). Abaixo do
//    limiar de olhos fechados = sinal de fadiga → realce conforme o RISCO da zona.
import { useRef } from "react";
import { type MetricState, type Band } from "../components/Sparkline";
import { type ZoneState } from "../processors/atividade";
import { type RiskState } from "../fadiga/landmarks";

export const HIST_LEN = 32; // tamanho do ring buffer por indicador (sparkline)
export const OCC_HI = 8; // teto heurístico de ocupação por zona — A CONFIRMAR
export const EAR_HI = 0.45; // teto de escala do EAR p/ a sparkline
export const NOREAD_CRIT = 3; // no-reads: ≥ isto vira critical (1..2 = warn)

// estado da zona/risco/taxa → estado da MÉTRICA (cor da telemetria, tokens --state-*)
export function stateToMetric(s: ZoneState): MetricState {
  return s === "ALERTA" ? "critical" : s === "ATIVA" ? "ok" : "warn";
}
export function riskToMetric(r: RiskState): MetricState {
  return r === "ALERTA_DUPLO" ? "critical" : r === "OK" ? "ok" : "warn";
}
export function rateToMetric(pct: number): MetricState {
  return pct >= 95 ? "ok" : pct >= 80 ? "warn" : "critical";
}
export function noReadMetric(n: number): MetricState {
  return n >= NOREAD_CRIT ? "critical" : n > 0 ? "warn" : "ok";
}
export function occMetric(n: number): MetricState {
  return n > OCC_HI ? "warn" : "ok";
} // baixa ocupação não "grita" (zona pode estar legitimamente vazia)
export const NOREAD_BAND: Band = { lo: 0, hi: 0 };
export const RATE_BAND: Band = { lo: 95, hi: 100 };
export const OCC_BAND: Band = { lo: 1, hi: OCC_HI };

// Ring buffer leve por zona/indicador, alimentado pelo loop já existente na cadência de UI
// (sem custo extra de inferência). Map<zoneId, {key: série}>. Funções estáveis (refs internos).
export function useTelemetry() {
  const histRef = useRef<Map<string, Record<string, number[]>>>(new Map());
  // Empurra uma amostra no ring buffer do indicador (mantém só HIST_LEN pontos).
  const pushHist = (zoneId: string, key: string, val: number) => {
    let m = histRef.current.get(zoneId);
    if (!m) {
      m = {};
      histRef.current.set(zoneId, m);
    }
    const arr = m[key] ?? (m[key] = []);
    arr.push(val);
    if (arr.length > HIST_LEN) arr.shift();
  };
  // Série recente de um indicador (vazio se ainda não houver amostras).
  const hist = (zoneId: string, key: string): number[] => histRef.current.get(zoneId)?.[key] ?? [];
  // Descarta a série de uma zona (ao remover a zona).
  const clearZone = (zoneId: string) => {
    histRef.current.delete(zoneId);
  };
  return { pushHist, hist, clearZone };
}
