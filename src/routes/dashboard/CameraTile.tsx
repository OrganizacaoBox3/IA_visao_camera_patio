import { type FrameSource } from "../../frame";
import { CameraWorkspace } from "../../CameraWorkspace";
import { FadigaView } from "../../FadigaView";
import { recordFadigaSamples, recordFadigaEvent } from "../../report/store";
import { Tooltip } from "../../ui";
import { type Camera, type CameraStatus } from "./types";

// Estado de conexão por câmera (contrato A4). Sem evento `camera-status` → assume "online".
// "Going gray" (Onda A): base neutra/cinza; cor saturada SÓ para anormalidade. Mapa de tokens
// (src/index.css · estado→token): online→neutral (operação normal, evita "árvore de natal");
// connecting→info (azul, advisory não-crítico); error→critical (vermelho); stopped→neutral-dim
// (cinza apagado). dot = realce; border = borda discreta por estado (glanceable à distância).
function statusInfo(s: CameraStatus | undefined): {
  text: string;
  dot: string;
  border: string;
  fps?: number;
} {
  const state = s?.state ?? "online";
  const text =
    state === "online"
      ? "online"
      : state === "connecting"
        ? "conectando…"
        : state === "stopped"
          ? "parada"
          : "erro";
  const dot =
    state === "connecting"
      ? "var(--state-info)"
      : state === "error"
        ? "var(--state-critical)"
        : state === "stopped"
          ? "var(--state-neutral-dim)"
          : "var(--state-neutral)"; // online (normal) → neutro, sem cor de alarme
  const border =
    state === "connecting"
      ? "var(--state-info-border)"
      : state === "error"
        ? "var(--state-critical-border)"
        : state === "stopped"
          ? "var(--state-neutral-border)"
          : "var(--state-neutral-border)";
  return { text, dot, border, fps: s?.fps };
}

type CameraTileProps = {
  camera: Camera;
  isOpen: boolean; // câmera já aberta no painel (overlay full)
  isFadiga: boolean;
  getFrame: () => FrameSource | null;
  demoMode: boolean;
  tripwiresRev: number;
  status: CameraStatus | undefined;
  onOpen: () => void;
  onAlert: (msg: string) => void;
};

// Renderiza um tile da grade: frame (fadiga/atividade) + pílula de status/fps sobreposta.
export function CameraTile({
  camera,
  isOpen,
  isFadiga,
  getFrame,
  demoMode,
  tripwiresRev,
  status,
  onOpen,
  onAlert,
}: CameraTileProps) {
  const st = statusInfo(status);
  const inner = isOpen ? (
    <div className="tile tile-open">aberta no painel</div>
  ) : isFadiga ? (
    <FadigaView
      key={`fad-${camera.id}`}
      cameraId={camera.id}
      label={camera.label}
      getFrame={getFrame}
      mode="tile"
      onOpen={onOpen}
      onAlert={onAlert}
      onSample={recordFadigaSamples}
      onEvent={recordFadigaEvent}
    />
  ) : (
    <CameraWorkspace
      key={`ws-${camera.id}`}
      cameraId={camera.id}
      label={camera.label}
      getFrame={getFrame}
      mode="tile"
      demoMode={demoMode}
      tripwiresRev={tripwiresRev}
      onOpen={onOpen}
      onAlert={onAlert}
    />
  );
  return (
    <div key={`wrap-${camera.id}`} style={{ position: "relative", display: "grid", minHeight: 0 }}>
      {inner}
      <Tooltip content={status?.lastError || st.text}>
        <span
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            zIndex: 2,
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontFamily: "var(--mono)",
            fontSize: 11,
            background: "var(--cam-overlay-scrim)",
            color: "var(--cam-overlay-fg)",
            border: `1px solid ${st.border}`,
            padding: "2px 7px",
            borderRadius: 999,
          }}
        >
          {/* .dot-status dá o formato; cor vem do token de estado (going-gray) via inline. */}
          <span className="dot-status" style={{ background: st.dot }} />
          {st.text}
          {st.fps != null ? ` · ${st.fps}fps` : ""}
        </span>
      </Tooltip>
    </div>
  );
}
