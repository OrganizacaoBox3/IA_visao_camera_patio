// Calibração dos limiares de fadiga — persistida (global, vale p/ câmera dedicada e zonas de fadiga).
// Default = APP_CONFIG.fadiga; a UI ajusta e o FadigaProcessor.setThresholds aplica em runtime.
import { APP_CONFIG } from "../config";
import type { FadigaThresholds } from "../processors/fadiga";

const KEY = "vp-fadiga-thresholds";
const F = APP_CONFIG.fadiga;

export const FADIGA_DEFAULT_THRESHOLDS: FadigaThresholds = {
  earClosed: F.eyesClosedEarThreshold,
  marYawn: F.yawnMarThreshold,
  phoneScore: F.phoneAdjustedScoreThreshold,
  fatigueMs: F.fatigueConfirmationMs,
};

// Faixas dos sliders (min/max/step) + rótulo + dica de direção. Mantém a UI declarativa.
export const FADIGA_THRESHOLD_FIELDS: {
  key: keyof FadigaThresholds;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt: (v: number) => string;
  hint: string;
}[] = [
  {
    key: "earClosed",
    label: "Olho fechado (EAR)",
    min: 0.12,
    max: 0.32,
    step: 0.01,
    fmt: (v) => v.toFixed(2),
    hint: "menor = mais rígido (precisa fechar mais o olho)",
  },
  {
    key: "marYawn",
    label: "Bocejo (MAR)",
    min: 0.03,
    // 0.2→0.6 (2026-07-22): o teto antigo não deixava calibrar ACIMA da faixa da fala —
    // bocejo real sustenta MAR >0.4; agora dá para exigir boca escancarada de verdade.
    max: 0.6,
    step: 0.005,
    fmt: (v) => v.toFixed(3),
    hint: "maior = mais rígido (boca mais aberta)",
  },
  {
    key: "phoneScore",
    label: "Confiança celular",
    min: 0.2,
    max: 0.85,
    step: 0.02,
    fmt: (v) => v.toFixed(2),
    hint: "maior = menos falso-positivo",
  },
  {
    key: "fatigueMs",
    label: "Confirmação de fadiga",
    min: 500,
    max: 4000,
    step: 100,
    fmt: (v) => `${(v / 1000).toFixed(1)}s`,
    hint: "tempo de olho fechado até alertar",
  },
];

export function loadFadigaThresholds(): FadigaThresholds {
  try {
    const s = localStorage.getItem(KEY);
    if (s) return { ...FADIGA_DEFAULT_THRESHOLDS, ...JSON.parse(s) };
  } catch {
    /* no-op */
  }
  return { ...FADIGA_DEFAULT_THRESHOLDS };
}
export function saveFadigaThresholds(t: FadigaThresholds): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    /* no-op */
  }
}
