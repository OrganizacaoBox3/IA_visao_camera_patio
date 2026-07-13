// ── Cabeçalho da câmera ABERTA: identidade + BARRA DE FERRAMENTAS do palco ───────────────────
// Extraído do CameraWorkspace na varredura F3 (o ratchet de tamanho força decomposição, não
// teto maior). É JSX PURO controlado por props: não toca canvas/rAF/refs — a casca fullscreen e
// o laço de desenho continuam no pai (ADR-007: a casca NÃO vira Radix Dialog).
//
// Doutrina aplicada aqui (spec-padronizacao-interface §3 / 02-doutrina-casa regras 11 e 15):
// Lucide único (size 18/16 · stroke 1.75 · currentColor), ícone-só SEMPRE com Tooltip +
// aria-label estável, nenhum controle fora de src/ui (Radix), zero px/hex cru.
//
// NOME ACESSÍVEL LOAD-BEARING (e2e/app.spec.ts): "Área" (exact), "Concluir polígono", "Fechar".
// Mudou o rótulo? Atualize o spec no MESMO diff (regra A18).
//
// UM BOTÃO SÓ (área-um-botão): "Zona" (arraste→retângulo) e "Polígono" (clique a clique) eram DUAS
// portas para a MESMA tarefa — criar uma área. Viraram UM toggle "Área"; o GESTO decide a forma
// (arraste→retângulo · clique→polígono ponto a ponto), ensinado em TEXTO na dica. Enquanto o
// rascunho é um polígono aberto, "Voltar"/"Concluir polígono" aparecem (o retângulo fecha no soltar).
import {
  ArrowLeftRight,
  Check,
  Lock,
  Pause,
  Play,
  Ruler,
  Shapes,
  Snowflake,
  Undo2,
  X,
} from "lucide-react";
import { Badge, Button, IconButton, Toggle, Tooltip } from "../ui";
import { type ModeKey, type ModePreset } from "../config";
import { POLYGON_MIN_POINTS } from "../zones";
import { MODE_TONE } from "./tabs/tone";

/** Subconjunto do usePolygonEditor consumido pela barra (o editor em si vive no hook). */
export type PolyControls = {
  active: boolean; // modo ÁREA armado (o gesto decide: arraste→retângulo · clique→polígono)
  count: number; // vértices do rascunho polígono (0 = indeciso / retângulo em arraste)
  startArea: () => void;
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
  review: boolean;
  enterReview: () => void;
  exitReview: () => void;
  paused: boolean;
  setPaused: (v: boolean) => void;
  tripwireMode: boolean;
  toggleTripwireMode: () => void;
  poly: PolyControls;
  /** modo CALIBRAR do palco (spec §1: a rota /calibracao virou este botão) */
  calActive: boolean;
  /** sub-modo corrente da calibração — o rótulo do botão CARREGA o estado (nunca só-por-cor) */
  calMode: "calibrar" | "medir";
  toggleCalibration: () => void;
  reviewTip: string | null;
  /** dica do EDITOR de zona (vértice/zona selecionados) — a interação ENSINADA em texto. */
  editTip: string | null;
  onClose?: () => void;
};

export function CamHeader({
  label,
  zonesCount,
  canConfigure,
  activePreset,
  activePresetDef,
  presetDirty,
  review,
  enterReview,
  exitReview,
  paused,
  setPaused,
  tripwireMode,
  toggleTripwireMode,
  poly,
  calActive,
  calMode,
  toggleCalibration,
  reviewTip,
  editTip,
  onClose,
}: Props) {
  // Um só motivo p/ desabilitar edição na barra (RBAC + revisão) — sem repetir a expressão.
  const editDisabled = review || !canConfigure;
  const editHint = canConfigure ? null : "Requer perfil de engenharia";
  return (
    <header className="cam-head">
      <div className="cam-title">
        <b>{label}</b>
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
      </div>
      <div className="spacer" />
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
      {/* CALIBRAR reconfigura o chrome (spec §3.2 — o padrão Figma Dev Mode / NN/g "não misturar os
          vocabulários de dois modos"): os toggles de OPERAÇÃO (Área/Linha) SOMEM no modo calibrar.
          Já são mutuamente exclusivos na lógica (stageTarget) — aqui só somem da UI, para o operador
          não ver ferramentas que o palco ignora. O toggle "Calibrar" (abaixo) fica como a chave de
          saída do modo, com estado ATIVO claro. */}
      {!calActive && (
        <>
      {/* ÁREA (área-um-botão): UM toggle no lugar de "Zona"+"Polígono" — o GESTO decide a forma.
              Rascunho VAZIO: arraste → retângulo de 4 vértices (o caso comum, mesas); clique →
              polígono ponto a ponto. O que nasce é EDITÁVEL: clique na área para selecionar, arraste
              o interior para mover, um vértice para ajustar, o ponto claro da aresta para inserir,
              Delete/Alt+clique para remover. Estado nunca só-por-cor: o rótulo carrega o progresso
              ("N vértices" no polígono) e a dica ensina o gesto em TEXTO. */}
      <Tooltip
        content={
          editHint ??
          "Arraste um retângulo, ou clique para desenhar ponto a ponto. Depois: clique na área para selecionar — arraste o interior para mover, um vértice para ajustar, o ponto claro da aresta para inserir; Delete (ou Alt+clique) remove o vértice."
        }
      >
        {/* Nome acessível "Área" (o e2e clica getByRole button name "Área", exact) — vira
                "N vértices" só quando o polígono está em curso. */}
        <Toggle
          pressed={poly.active}
          disabled={editDisabled}
          onPressedChange={(v) => (v ? poly.startArea() : poly.cancel())}
        >
          {poly.active && poly.count > 0 ? (
            `${poly.count} ${poly.count === 1 ? "vértice" : "vértices"}`
          ) : (
            <>
              <Shapes size={16} strokeWidth={1.75} aria-hidden /> Área
            </>
          )}
        </Toggle>
      </Tooltip>
      {/* Rascunho POLÍGONO em curso (count>0): Voltar/Concluir. O retângulo fecha no soltar do
              arraste, então não tem esses controles. Enter conclui, ESC cancela (atalhos do hook);
              botões Radix — foco visível e operáveis sem mouse. */}
      {poly.active && poly.count > 0 && (
        <>
          <IconButton
            label="Voltar (remover último vértice)"
            disabled={poly.count === 0}
            onClick={poly.undo}
          >
            <Undo2 size={18} strokeWidth={1.75} aria-hidden />
          </IconButton>
          <Tooltip
            content={`Fecha o polígono (mínimo de ${POLYGON_MIN_POINTS} vértices). Atalho: Enter.`}
          >
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
      <Tooltip content={editHint ?? "Desenhar uma linha de contagem (clique em A e arraste até B)"}>
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
        </>
      )}
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
        <Toggle pressed={calActive} disabled={review} onPressedChange={() => toggleCalibration()}>
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
      {/* Aviso do cine-loop (buffer vazio) e DICA DO EDITOR de zona (vértice/zona selecionados):
          uma faixa só, cor de estado por TOKEN (--state-warn-fg), nunca hex — e sempre com TEXTO
          (going-gray: informação jamais só-por-cor). O cine-loop tem precedência (é o modo que
          suspende a edição). A dica é o que NENHUM VMS do mercado dá: a interação, ensinada. */}
      {(reviewTip ?? editTip) && (
        <span className="cam-head-tip" role="status">
          {reviewTip ?? editTip}
        </span>
      )}
    </header>
  );
}
