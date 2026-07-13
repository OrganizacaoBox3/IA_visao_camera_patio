// ── Barra de KPIs (rodapé) da câmera aberta ──────────────────────────────────────────────────
// Extraída do CameraWorkspace na varredura F3 (ratchet de tamanho). JSX PURO controlado por props.
// "A imagem é soberana" (ADR-003): NÚMERO vive aqui, no painel — nunca sobre o vídeo.
// Going-gray: tudo neutro; satura só a anormalidade (detecção em CPU = modo degradado), e nunca
// só-por-cor — o estado sempre vem com TEXTO + ícone.
import { Gauge, Grid3x3, Pause, Radar, Timer, TriangleAlert, Users } from "lucide-react";
import { Toggle, Tooltip } from "../ui";
import { fmtDuration } from "../format";

type Props = {
  presence: { now: number; peak: number; dwell: number };
  fps: number;
  /** resumo textual das zonas ("Área 1:ATIVA · …") — truncado por CSS, sem px cru */
  summary: string;
  hud: boolean;
  setHud: (v: boolean) => void;
  /** malha da calibração: só existe quando a câmera foi calibrada */
  calibAvailable: boolean;
  calibOn: boolean;
  setCalibOn: (v: boolean) => void;
  /** tags no chão: só existe quando há calibração + leituras BLE */
  floorAvailable: boolean;
  floorOn: boolean;
  setFloorOn: (v: boolean) => void;
  analysisEngine: "hub" | "local";
  /** backend do tfjs; null enquanto o worker não reportou */
  detBackend: string | null;
  paused: boolean;
};

export function CamKpiBar({
  presence,
  fps,
  summary,
  hud,
  setHud,
  calibAvailable,
  calibOn,
  setCalibOn,
  floorAvailable,
  floorOn,
  setFloorOn,
  analysisEngine,
  detBackend,
  paused,
}: Props) {
  return (
    <div className="cam-kpibar">
      <span className="kb">
        <Users size={14} strokeWidth={1.75} aria-hidden /> <b>{presence.now}</b> pessoas
      </span>
      <span className="kb">
        <Timer size={14} strokeWidth={1.75} aria-hidden /> <b>{fmtDuration(presence.dwell)}</b>{" "}
        permanência
      </span>
      <span className="kb muted">pico {presence.peak}</span>
      <span className="kb muted kb-summary">{summary || "sem zonas"}</span>
      <span className="kb muted">FPS {fps}</span>
      {/* Toggle do HUD (going-gray: régua de medição, não anormalidade). O rAF lê o ref espelho. */}
      <Tooltip content="HUD de telemetria sobre o vídeo: FPS exibido, ms/frame na main-thread, pipeline (hub/local), idade do overlay e latência por estágio (OWL-ViT/ZXing/MediaPipe) + fila de inferência">
        <Toggle aria-label="HUD de telemetria" pressed={hud} onPressedChange={setHud}>
          <Gauge size={16} strokeWidth={1.75} aria-hidden /> HUD
        </Toggle>
      </Tooltip>
      {/* Malha da calibração: grade do chão (homografia) + pontos cadastrados. Some quando a
          câmera nunca foi calibrada. Going-gray: conferência de posicionamento, não anormalidade. */}
      {calibAvailable && (
        <Tooltip content="Mostrar a malha da calibração sobre o vídeo: grade do chão (via homografia) + os pontos cadastrados — confere o posicionamento da pessoa no piso">
          <Toggle aria-label="Malha da calibração" pressed={calibOn} onPressedChange={setCalibOn}>
            <Grid3x3 size={16} strokeWidth={1.75} aria-hidden /> Malha
          </Toggle>
        </Tooltip>
      )}
      {/* Tags no chão: âncoras (posição exata) + estação + anéis de distância BLE. Default LIGADO;
          some quando não há calibração/leituras. Cores VIVAS (exceção declarada ao going-gray —
          overlay sobre vídeo; ver drawFloorTags); o anel tracejado comunica incerteza (é
          distância, não posição); vermelho só p/ âncora calada (anomalia). */}
      {floorAvailable && (
        <Tooltip content="Tags no chão: âncoras dos cantos (posição exata), a estação BLE e um anel tracejado de distância p/ cada tag visível ainda não associada a uma pessoa — o anel é DISTÂNCIA (RSSI), não posição">
          <Toggle aria-label="Tags no chão" pressed={floorOn} onPressedChange={setFloorOn}>
            <Radar size={16} strokeWidth={1.75} aria-hidden /> Tags
          </Toggle>
        </Tooltip>
      )}
      {/* Fonte da análise (ADR-009): NEUTRO e só no modo hub; local = nada. No modo hub o worker
          tfjs nem sobe p/ pessoas — o badge de detecção abaixo só aparece se um consumidor local
          (fadiga/celular, engine local) o iniciou. */}
      {analysisEngine === "hub" && (
        <Tooltip content="indicadores gravados pelo servidor — D-FINE">
          <span className="kb muted">análise: hub</span>
        </Tooltip>
      )}
      {/* Backend de detecção — going-gray: neutro em GPU; satura (warn, via TOKEN --state-warn-fg,
          nunca hex) SÓ em CPU, o modo degradado (~10× mais lento), e com ícone + texto junto da
          cor. null = worker ainda não reportou → não exibe. */}
      {detBackend != null &&
        (detBackend === "cpu" ? (
          <Tooltip content="Detecção degradada: WebGL indisponível — tfjs rodando em CPU (~10× mais lento)">
            <span className="kb kb-warn">
              detecção: CPU <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
            </span>
          </Tooltip>
        ) : (
          <Tooltip content={`Backend de detecção (tfjs): ${detBackend}`}>
            <span className="kb muted">
              detecção: {detBackend === "webgl" || detBackend === "webgpu" ? "GPU" : detBackend}
            </span>
          </Tooltip>
        ))}
      {paused && (
        <span className="kb muted">
          <Pause size={14} strokeWidth={1.75} aria-hidden /> inspecionando
        </span>
      )}
    </div>
  );
}
