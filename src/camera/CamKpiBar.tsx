// ── Barra de KPIs (rodapé) da câmera aberta ──────────────────────────────────────────────────
// Extraída do CameraWorkspace na varredura F3 (ratchet de tamanho). JSX PURO controlado por props.
// "A imagem é soberana" (ADR-003): NÚMERO vive aqui, no painel — nunca sobre o vídeo.
// Going-gray: tudo neutro; satura só a anormalidade (detecção em CPU = modo degradado), e nunca
// só-por-cor — o estado sempre vem com TEXTO + ícone.
//
// F3 (spec-tela-camera §3-C): os toggles de EXIBIÇÃO (HUD/Malha/Anéis) SAÍRAM daqui — eram a mesma
// natureza (config-de-exibição) que os da aba "Camadas", partida em dois lugares. Agora vivem todos
// no popover "Exibição" da toolbar (./ExibicaoPopover). Esta barra volta a ser só LEITURA de números.
import { Pause, Timer, TriangleAlert, Users } from "lucide-react";
import { Tooltip } from "../ui";
import { fmtDuration } from "../format";

type Props = {
  presence: { now: number; peak: number; dwell: number };
  fps: number;
  /** resumo textual das zonas ("Área 1:ATIVA · …") — truncado por CSS, sem px cru */
  summary: string;
  analysisEngine: "hub" | "local";
  /** backend do tfjs; null enquanto o worker não reportou */
  detBackend: string | null;
  paused: boolean;
};

export function CamKpiBar({ presence, fps, summary, analysisEngine, detBackend, paused }: Props) {
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
