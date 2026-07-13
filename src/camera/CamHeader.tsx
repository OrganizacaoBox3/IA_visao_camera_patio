// ── Cabeçalho da câmera ABERTA: identidade + BARRA DE FERRAMENTAS do palco ───────────────────
// Extraído do CameraWorkspace na varredura F3 (o ratchet de tamanho força decomposição, não
// teto maior). É JSX PURO controlado por props: não toca canvas/rAF/refs — a casca fullscreen e
// o laço de desenho continuam no pai (ADR-007: a casca NÃO vira Radix Dialog).
//
// Doutrina aplicada aqui (spec-padronizacao-interface §3 / 02-doutrina-casa regras 11 e 15):
// Lucide único (size 18/16 · stroke 1.75 · currentColor), ícone-só SEMPRE com Tooltip +
// aria-label estável, nenhum controle fora de src/ui (Radix), zero px/hex cru.
//
// NOME ACESSÍVEL LOAD-BEARING (e2e/app.spec.ts): "Zona" (exact), "Polígono", "Concluir polígono",
// "Fechar". Mudou o rótulo? Atualize o spec no MESMO diff (regra A18).
import {
  ArrowLeftRight,
  Brush,
  Check,
  Eraser,
  Lock,
  Pause,
  PenLine,
  Pentagon,
  Play,
  Ruler,
  Snowflake,
  Undo2,
  X,
} from "lucide-react";
import { Badge, Button, IconButton, Select, Toggle, Tooltip } from "../ui";
import { type ModeKey, type ModePreset } from "../config";
import { POLYGON_MIN_POINTS, type Zone } from "../zones";
import { MODE_TONE } from "./tabs/tone";

const BRUSH_OPTS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
];

/** Subconjunto do usePolygonEditor consumido pela barra (o editor em si vive no hook). */
export type PolyControls = {
  active: boolean;
  count: number;
  start: () => void;
  cancel: () => void;
  undo: () => void;
  close: () => void;
};

type Props = {
  label: string;
  zonesCount: number;
  canConfigure: boolean;
  activePreset: ModeKey | null;
  activePresetDef: ModePreset | null;
  presetDirty: boolean;
  /** zona em pintura (blueprint) — troca a barra inteira pelas ferramentas do pincel */
  paintZone: Zone | null;
  erase: boolean;
  setErase: (v: boolean) => void;
  brush: number;
  setBrush: (n: number) => void;
  clearActive: () => void;
  endPaint: () => void;
  review: boolean;
  enterReview: () => void;
  exitReview: () => void;
  paused: boolean;
  setPaused: (v: boolean) => void;
  drawMode: boolean;
  toggleDrawMode: () => void;
  tripwireMode: boolean;
  toggleTripwireMode: () => void;
  poly: PolyControls;
  /** modo CALIBRAR do palco (spec §1: a rota /calibracao virou este botão) */
  calActive: boolean;
  /** sub-modo corrente da calibração — o rótulo do botão CARREGA o estado (nunca só-por-cor) */
  calMode: "calibrar" | "medir";
  toggleCalibration: () => void;
  reviewTip: string | null;
  onClose?: () => void;
};

export function CamHeader({
  label,
  zonesCount,
  canConfigure,
  activePreset,
  activePresetDef,
  presetDirty,
  paintZone,
  erase,
  setErase,
  brush,
  setBrush,
  clearActive,
  endPaint,
  review,
  enterReview,
  exitReview,
  paused,
  setPaused,
  drawMode,
  toggleDrawMode,
  tripwireMode,
  toggleTripwireMode,
  poly,
  calActive,
  calMode,
  toggleCalibration,
  reviewTip,
  onClose,
}: Props) {
  // Um só motivo p/ desabilitar edição na barra (RBAC + revisão) — sem repetir a expressão.
  const editDisabled = review || !canConfigure;
  const editHint = canConfigure ? null : "Requer perfil de engenharia";
  return (
    <header className="cam-head">
      <div className="cam-title">
        <b>{label}</b>
        {paintZone ? (
          <span className="muted">pintando “{paintZone.label}”</span>
        ) : (
          <>
            <span className="muted">
              {zonesCount} {zonesCount === 1 ? "zona" : "zonas"}
            </span>
            {activePresetDef && activePreset && (
              <Tooltip
                content={`Preset ativo: ${activePresetDef.label} — ${activePresetDef.description}${presetDirty ? " (ajustado manualmente nesta sessão)" : ""}`}
              >
                <span>
                  <Badge tone={MODE_TONE[activePreset]}>
                    {activePresetDef.label}
                    {presetDirty ? " ·" : ""}
                  </Badge>
                </span>
              </Tooltip>
            )}
            {!canConfigure && (
              <Tooltip content="Edição de configuração requer perfil de engenharia">
                <span>
                  <Badge tone="info">
                    <Lock size={12} strokeWidth={1.75} aria-hidden /> Somente leitura
                  </Badge>
                </span>
              </Tooltip>
            )}
          </>
        )}
      </div>
      <div className="spacer" />
      {paintZone ? (
        <>
          <IconButton label="Pincel (pintar)" active={!erase} onClick={() => setErase(false)}>
            <Brush size={18} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <IconButton
            label="Borracha (Alt/botão-direito também apagam)"
            active={erase}
            onClick={() => setErase(true)}
          >
            <Eraser size={18} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <Select
            value={String(brush)}
            onChange={(v) => setBrush(Number(v))}
            options={BRUSH_OPTS}
            ariaLabel="Tamanho do pincel"
          />
          <Button onClick={clearActive}>Limpar</Button>
          <Button active onClick={endPaint}>
            <Check size={16} strokeWidth={1.75} aria-hidden /> Concluir
          </Button>
        </>
      ) : (
        <>
          <Tooltip content="Congela o palco e abre a revisão dos últimos ~10s (cine-loop). Buffer em memória, nunca enviado ao servidor.">
            <Toggle pressed={review} onPressedChange={(v) => (v ? enterReview() : exitReview())}>
              {review ? (
                <>
                  <Play size={16} strokeWidth={1.75} aria-hidden /> Ao vivo
                </>
              ) : (
                <>
                  <Snowflake size={16} strokeWidth={1.75} aria-hidden /> Congelar
                </>
              )}
            </Toggle>
          </Tooltip>
          <Tooltip content="Congela o frame e rotula quem está em cena">
            <Toggle pressed={paused} disabled={review} onPressedChange={(v) => setPaused(v)}>
              {paused ? (
                <>
                  <Play size={16} strokeWidth={1.75} aria-hidden /> Retomar
                </>
              ) : (
                <>
                  <Pause size={16} strokeWidth={1.75} aria-hidden /> Pausar
                </>
              )}
            </Toggle>
          </Tooltip>
          <Tooltip content={editHint ?? "Desenhar uma nova zona retangular sobre o vídeo"}>
            {/* Nome acessível "Zona" (o e2e clica getByRole button name "Zona", exact). */}
            <Toggle
              pressed={drawMode}
              disabled={editDisabled}
              onPressedChange={() => toggleDrawMode()}
            >
              {drawMode ? (
                "Desenhando…"
              ) : (
                <>
                  <PenLine size={16} strokeWidth={1.75} aria-hidden /> Zona
                </>
              )}
            </Toggle>
          </Tooltip>
          {/* POLÍGONO (spec-zonas-poligonais P1/P7): o editor (usePolygonEditor) existia sem
              NENHUM ponto de entrada na UI — o modo era inalcançável por mouse ou teclado. Aqui
              está o botão que a spec F2 pedia ("botão no palco"), com as duas ações do rascunho
              (Voltar/Concluir) visíveis enquanto ele existe. Teclado: Enter conclui, ESC cancela
              (atalhos do hook); os 3 controles são botões Radix — foco visível e operáveis sem
              mouse. Estado nunca só-por-cor: o contador de vértices é TEXTO. */}
          <Tooltip content={editHint ?? "Desenhar uma zona poligonal: clique para cada vértice; feche no 1º vértice, em “Concluir polígono” ou com Enter (ESC cancela)"}>
            <Toggle
              pressed={poly.active}
              disabled={editDisabled}
              onPressedChange={(v) => (v ? poly.start() : poly.cancel())}
            >
              {poly.active ? (
                `${poly.count} ${poly.count === 1 ? "vértice" : "vértices"}`
              ) : (
                <>
                  <Pentagon size={16} strokeWidth={1.75} aria-hidden /> Polígono
                </>
              )}
            </Toggle>
          </Tooltip>
          {poly.active && (
            <>
              <IconButton
                label="Voltar (remover último vértice)"
                disabled={poly.count === 0}
                onClick={poly.undo}
              >
                <Undo2 size={18} strokeWidth={1.75} aria-hidden />
              </IconButton>
              <Tooltip content={`Fecha o polígono (mínimo de ${POLYGON_MIN_POINTS} vértices). Atalho: Enter.`}>
                <Button
                  active
                  aria-label="Concluir polígono"
                  disabled={poly.count < POLYGON_MIN_POINTS}
                  onClick={poly.close}
                >
                  <Check size={16} strokeWidth={1.75} aria-hidden /> Concluir polígono
                </Button>
              </Tooltip>
            </>
          )}
          <Tooltip
            content={
              editHint ?? "Desenhar uma linha de contagem (clique em A e arraste até B)"
            }
          >
            <Toggle
              pressed={tripwireMode}
              disabled={editDisabled}
              onPressedChange={() => toggleTripwireMode()}
            >
              {tripwireMode ? (
                "Traçando…"
              ) : (
                <>
                  <ArrowLeftRight size={16} strokeWidth={1.75} aria-hidden /> Linha
                </>
              )}
            </Toggle>
          </Tooltip>
          {/* CALIBRAR — o 5º modo do palco (spec-arquitetura-informacao §1: "capacidade não é
              lugar"; a rota /calibracao morre). NÃO usa `editDisabled`: MEDIR distância é do
              OPERADOR (era o que a rota lhe dava). Quem barra o que ele pode MARCAR é o hook
              (useCalibrationEditor) + a ordem pura do stageTarget — não este botão. Em REVISÃO
              (cine-loop) fica desabilitado, como todo editor. Estado no TEXTO, nunca só-por-cor. */}
          <Tooltip
            content={
              review
                ? "Indisponível durante a revisão do cine-loop"
                : canConfigure
                  ? "Calibrar a distância no chão (4 cantos de um retângulo + Largura×Comprimento) e medir distâncias reais. Dica: Pausar o vídeo facilita clicar com precisão."
                  : "Medir distâncias reais no chão (a calibração em si requer perfil de engenharia)"
            }
          >
            <Toggle
              pressed={calActive}
              disabled={review}
              onPressedChange={() => toggleCalibration()}
            >
              {calActive ? (
                calMode === "medir" ? (
                  "Medindo…"
                ) : (
                  "Calibrando…"
                )
              ) : (
                <>
                  <Ruler size={16} strokeWidth={1.75} aria-hidden /> Calibrar
                </>
              )}
            </Toggle>
          </Tooltip>
          <IconButton label="Fechar" onClick={onClose}>
            <X size={18} strokeWidth={1.75} aria-hidden />
          </IconButton>
        </>
      )}
      {/* Aviso do cine-loop (buffer vazio): cor de estado por TOKEN (--state-warn-fg), nunca hex —
          e acompanhado de texto (going-gray: informação jamais só-por-cor). */}
      {reviewTip && (
        <span className="cam-head-tip" role="status">
          {reviewTip}
        </span>
      )}
    </header>
  );
}
