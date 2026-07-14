// ── Barra do CINE-LOOP (revisão dos últimos ~10s) do palco da câmera aberta ──────────────────
// Extraída do CameraWorkspace na varredura F3 (ratchet de tamanho). JSX PURO: o buffer, o rAF e
// o canvas continuam no pai — aqui só os CONTROLES (Radix), todos operáveis por teclado.
// LGPD (ADR-002): o buffer é EFÊMERO, em memória; "Snapshot"/"Exportar clipe" são DOWNLOAD LOCAL
// — nada sobe ao servidor. Renderiza dentro do .cam-stage (irmão do <canvas>, nunca ancestral:
// remontar o canvas mataria o rAF).
import { type RefObject } from "react";
import { ChevronLeft, ChevronRight, Download, ImageDown, Pause, Play } from "lucide-react";
import { Button, IconButton, Slider, StatusDot, Toggle, Tooltip } from "../ui";
import { type CineBuffer } from "./cineBuffer";

type Props = {
  cineRef: RefObject<CineBuffer | null>;
  cineSize: number;
  scrubIndex: number;
  setScrubIndex: (i: number) => void;
  cinePlaying: boolean;
  setCinePlaying: (v: boolean) => void;
  scrubBy: (d: number) => void;
  downloadSnapshot: () => void;
  exportClip: () => void;
  clipState: "idle" | "working" | "error";
  clipPct: number;
  exitReview: () => void;
};

export function CineBar({
  cineRef,
  cineSize,
  scrubIndex,
  setScrubIndex,
  cinePlaying,
  setCinePlaying,
  scrubBy,
  downloadSnapshot,
  exportClip,
  clipState,
  clipPct,
  exitReview,
}: Props) {
  const working = clipState === "working";
  return (
    <>
      {/* Selo de REVISÃO: o ponto é decoração — quem informa é o TEXTO (going-gray). */}
      <div className="cine-flag" role="status">
        <StatusDot tone="warn" label="em revisão" /> REVISÃO · cine-loop (buffer em memória)
      </div>
      <div className="cine-bar" role="group" aria-label="Revisão do cine-loop">
        <IconButton label="Quadro anterior" onClick={() => scrubBy(-1)}>
          <ChevronLeft size={18} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <Tooltip content={cinePlaying ? "Pausar reprodução" : "Reproduzir cine-loop"}>
          <Toggle
            aria-label={cinePlaying ? "Pausar reprodução" : "Reproduzir cine-loop"}
            pressed={cinePlaying}
            onPressedChange={(v) => setCinePlaying(v)}
          >
            {cinePlaying ? (
              <Pause size={16} strokeWidth={1.75} aria-hidden />
            ) : (
              <Play size={16} strokeWidth={1.75} aria-hidden />
            )}
          </Toggle>
        </Tooltip>
        <IconButton label="Próximo quadro" onClick={() => scrubBy(1)}>
          <ChevronRight size={18} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <div className="cine-slider">
          <Slider
            value={scrubIndex}
            min={0}
            max={Math.max(0, cineSize - 1)}
            step={1}
            onChange={(v) => {
              setCinePlaying(false);
              setScrubIndex(v);
            }}
            ariaLabel="Posição no cine-loop"
          />
        </div>
        <span className="cine-time">
          {cineRef.current ? `${cineRef.current.relativeSeconds(scrubIndex).toFixed(1)}s` : "0.0s"}
        </span>
        <span className="cine-count">
          {cineSize ? scrubIndex + 1 : 0}/{cineSize}
        </span>
        <span className="cine-spacer" aria-hidden />
        <Tooltip content="Baixar este quadro como PNG (download local — nunca enviado ao servidor)">
          <Button onClick={downloadSnapshot} disabled={working}>
            <ImageDown size={16} strokeWidth={1.75} aria-hidden /> Snapshot
          </Button>
        </Tooltip>
        <Tooltip content="Exporta a janela do cine-loop como clipe (WebM) — download local, nunca enviado ao servidor. Fallback: montagem PNG se o navegador não suportar.">
          {/* Progresso em TEXTO (não só barra/cor) e anunciado ao leitor de tela. */}
          <Button onClick={exportClip} disabled={working} aria-live="polite">
            <Download size={16} strokeWidth={1.75} aria-hidden />
            {working ? `Gravando… ${clipPct}%` : "Exportar clipe"}
          </Button>
        </Tooltip>
        <Button active onClick={exitReview}>
          <Play size={16} strokeWidth={1.75} aria-hidden /> Ao vivo
        </Button>
      </div>
    </>
  );
}
