import { memo, useCallback } from "react";
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
  // F1-C (ADR-009): fonte da análise da câmera. "hub" = motor server-side grava os indicadores
  // (o CameraWorkspace suprime os ingests locais). OPCIONAL/retrocompatível (default "local");
  // primitiva → amigável ao React.memo abaixo (só o tile da câmera afetada re-renderiza).
  analysisEngine?: "hub" | "local";
  // Callback ÚNICO e estável do dashboard (1.6): o tile chama com o próprio id. Assinatura por id
  // (em vez de closure por câmera) para o React.memo abaixo valer — todos os tiles recebem a
  // MESMA função e só re-renderizam quando os próprios dados mudam.
  onOpen: (id: string) => void;
  onAlert: (msg: string) => void;
};

// Renderiza um tile da grade: frame (fadiga/atividade) + pílula de status/fps sobreposta.
// React.memo (1.6): o `camera-status` (a cada ~5s POR câmera) troca só `statuses[id]` da câmera
// afetada; com memo + callbacks estáveis, apenas o tile daquela câmera re-renderiza (antes: a
// grade inteira ×N tiles). Demais props são primitivas ou estáveis (getFrame vem de cache por id).
export const CameraTile = memo(function CameraTile({
  camera,
  isOpen,
  isFadiga,
  getFrame,
  demoMode,
  tripwiresRev,
  status,
  analysisEngine,
  onOpen,
  onAlert,
}: CameraTileProps) {
  // Adapta onOpen(id) → onOpen() esperado por FadigaView/CameraWorkspace (usado só como onClick;
  // memoizado p/ manter a identidade entre re-renders do próprio tile).
  const openSelf = useCallback(() => onOpen(camera.id), [onOpen, camera.id]);
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
      onOpen={openSelf}
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
      analysisEngine={analysisEngine}
      onOpen={openSelf}
      onAlert={onAlert}
    />
  );
  return (
    <div className="relative grid min-h-0">
      {inner}
      <Tooltip content={status?.lastError || st.text}>
        {/* Pílula de status: estático em utilities; só a COR da borda é dinâmica (token por
            estado, going-gray) e fica no style. border-solid explícito: sem preflight, o
            border-style default do <span> é none. */}
        <span
          className="absolute top-1.5 left-1.5 z-[2] inline-flex items-center gap-[5px] [font-family:var(--mono)] text-[11px] bg-[var(--cam-overlay-scrim)] text-[var(--cam-overlay-fg)] border border-solid rounded-full px-[7px] py-[2px]"
          style={{ borderColor: st.border }}
        >
          {/* .dot-status dá o formato; cor vem do token de estado (going-gray) via inline. */}
          <span className="dot-status" aria-hidden="true" style={{ background: st.dot }} />
          {st.text}
          {st.fps != null ? ` · ${st.fps}fps` : ""}
        </span>
      </Tooltip>
    </div>
  );
});
