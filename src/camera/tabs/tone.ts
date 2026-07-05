// Mapa modo/risco → Tone (Radix Badge) compartilhado pelo drawer e o cabeçalho da câmera.
// Vive perto das abas que o consomem; importado também pelo CameraWorkspace (header).
import { type ZoneMode } from "../../zones";
import { type RiskState } from "../../fadiga/landmarks";
import { type Tone } from "../../ui";

// taxa de leitura → cor (verde ≥95 · âmbar ≥80 · vermelho abaixo). Espelha a semântica do relatório.
export const MODE_TONE: Record<ZoneMode, Tone> = {
  atividade: "ok",
  leitura: "info",
  objetos: "warn",
  fadiga: "info",
  exclusao: "info", // supressão (going-gray); Tone não tem neutro, "info" é o mais discreto
};

export const RISK_TONE: Record<RiskState, Tone> = {
  OK: "ok",
  ALERTA_FADIGA: "warn",
  ALERTA_CELULAR: "warn",
  ALERTA_DUPLO: "alert",
};
