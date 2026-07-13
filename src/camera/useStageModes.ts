// ── PONTEIRO DO PALCO: o multiplexador dos modos de edição da câmera aberta ────────────────────
// Extraído do CameraWorkspace (ratchet anti-reengorda: o god-file cresce por DECISÃO, não por
// deriva — CameraWorkspace.size.test.ts). Responsabilidade ÚNICA: traduzir um evento de ponteiro do
// palco para O EDITOR ATIVO, na ordem certa. Todo editor tem dono próprio (zona → usePolygonEditor
// · linha → useTripwires · calibração → useCalibrationEditor) e devolve boolean ("consumi o evento").
//
// ── A PODA (spec-zona-unificada F5) ───────────────────────────────────────────────────────────
// Este arquivo era dono de duas coisas que DEIXARAM DE EXISTIR:
//   • o rascunho do RETÂNGULO (drawRef) — o retângulo não é um TIPO, é o PRESET de 4 vértices do
//     polígono (a zona É um polígono). O arraste continua idêntico para o operador; quem o
//     recebe agora é o usePolygonEditor (modo Área, o gesto decide), e o que ele cria JÁ NASCE EDITÁVEL.
//   • o estado do PINCEL (pintando/apagando) — o pincel era um workaround do polígono que faltava
//     (o dado de produção provou: a única máscara pintada à mão era uma faixa diagonal em escada).
//     A MÁSCARA sobrevive só como RASTERIZAÇÃO INTERNA do polígono (zones.rasterizePolygonMask).
// Sobrou o que este módulo sempre deveria ser: a ORDEM, e nada mais.
//
// ── A ORDEM É A REGRA (e é PURA + testada: stageTarget) ───────────────────────────────────────
// O corte de RBAC do palco vinha ANTES de tudo (`if (!canConfigure) return`), o que era certo
// enquanto todo modo do palco era de ENGENHARIA. Com a calibração virando modo (spec §1), deixou de
// ser: MEDIR distância é do OPERADOR (era o que a rota /calibracao lhe dava — "A calibração requer
// perfil de engenharia. Você pode usar o modo Medir."). Plugar a calibração ingenuamente MATARIA o
// medir para ele. Por isso a calibração é consultada ACIMA do corte, e o corte segue barrando o que
// sempre barrou (criar/editar zona e traçar linha). Regressão silenciosa nº 1 → vira teste
// (useStageModes.test.ts).
import { type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { type DragBox } from "./draw";
import type { usePolygonEditor } from "./usePolygonEditor";
import type { CalibrationEditor } from "./useCalibrationEditor";

/** Quem recebe o pointer-down do palco. "none" = ninguém (grade, revisão, ou RBAC). */
export type StageTarget = "none" | "calibration" | "tripwire" | "polygon";

export type StageState = {
  mode: "tile" | "full";
  review: boolean;
  canConfigure: boolean;
  calActive: boolean;
  tripwireMode: boolean;
};

/**
 * PURA: a ordem de precedência dos modos do palco no pointer-down. É aqui que mora o invariante do
 * RBAC — a CALIBRAÇÃO é consultada ACIMA do corte `!canConfigure` (o operador MEDE; o hook da
 * calibração é que decide o que ele pode marcar), e o corte segue valendo para os demais editores.
 */
export function stageTarget(s: StageState): StageTarget {
  if (s.mode !== "full" || s.review) return "none"; // grade / revisão: o palco mostra o buffer
  if (s.calActive) return "calibration"; // ← ACIMA do RBAC de propósito (medir é de todos)
  if (!s.canConfigure) return "none"; // operador em SÓ-LEITURA: não cria/edita zona nem linha
  if (s.tripwireMode) return "tripwire";
  // O editor da ZONA é o default do palco: com o modo "Área" armado ele recebe o 1º gesto (arraste
  // → retângulo · clique → polígono ponto a ponto); sem modo armado, ele ainda seleciona/arrasta
  // vértice, insere pelo midpoint e move a forma (o `simple_select` do Mapbox).
  return "polygon";
}

// ── O GATE DE CAMADAS POR MODO (spec §3.1 — a causa-raiz do "totalmente sobreposto") ──────────────
// A queixa do dono NÃO era z-index: entrar em Calibrar não desligava NADA. O canvas seguia pintando
// tracks + zonas + tripwires + anéis + a MALHA SALVA, e o SVG da calibração empilhava a grade VIVA
// por cima — a malha salva (canvas) e a grade viva (SVG) são DUAS grades idênticas sobrepostas.
// Aqui mora a decisão "quais camadas de OPERAÇÃO neste modo", PURA e testada, num lugar só (não um
// if espalhado pelo drawScene). Em Calibrar todas caem: o palco fica só com o vídeo + a calibração
// VIVA (CalibrationLayer). Fora dele cada camada ainda respeita seu toggle a jusante
// (layersRef/floorOnRef/hudRef/calib.onRef) — este é o gate do MODO, acima dos toggles.
export type StageLayers = {
  heatmap: boolean;
  floorTags: boolean;
  tracks: boolean;
  zones: boolean;
  /** a MALHA de calibração SALVA (drawCalibrationOverlay) — a 2ª grade que empilhava sobre a viva */
  calibrationMesh: boolean;
  tripwires: boolean;
  hud: boolean;
};

// ── QUAL PAINEL CONTEXTUAL o drawer mostra (spec-tela-camera-arquitetura §3-A, a generalização do
// molde do Calibrar) ──────────────────────────────────────────────────────────────────────────
// A onda anterior fez Calibrar virar MODO: ao entrar, o painel deixa de ser as abas e vira SÓ o
// passo-a-passo daquele modo (não misturar dois vocabulários — NN/g). Aqui esse padrão vira UM
// mecanismo, não três casos especiais espalhados: dado o modo de edição ARMADO, diz que painel o
// drawer deve mostrar — Calibrar → passo-a-passo · Linha → linhas · Área → zonas — e, sem modo
// armado, `null` (→ as abas de OBSERVAÇÃO). A PRECEDÊNCIA é a MESMA do stageTarget (cal > linha >
// área), agora projetada para o CHROME do painel: os modos já são mutuamente exclusivos na lógica
// (stageTarget + onStart), então a ordem aqui é a rede de segurança, PURA e testada.
// `areaMode` = o editor da zona ARMADO pelo toggle "Área" (o gesto decide retângulo × polígono); é
// o análogo de `calActive`/`tripwireMode`. Editar uma zona já existente (selecionar/mover no palco)
// roda sem toggle — é o default do palco, não "estar no modo Área" para efeito de painel.
export type StageMode = "calibrar" | "linha" | "area" | null;

export function activeStageMode(s: {
  calActive: boolean;
  tripwireMode: boolean;
  areaMode: boolean;
}): StageMode {
  if (s.calActive) return "calibrar";
  if (s.tripwireMode) return "linha";
  if (s.areaMode) return "area";
  return null;
}

export function sceneLayers(s: { calActive: boolean }): StageLayers {
  const op = !s.calActive; // camadas de operação só existem FORA do modo calibrar
  return {
    heatmap: op,
    floorTags: op,
    tracks: op,
    zones: op,
    calibrationMesh: op,
    tripwires: op,
    hud: op,
  };
}

type Opts = {
  mode: "tile" | "full";
  canConfigure: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  reviewRef: RefObject<boolean>;
  poly: ReturnType<typeof usePolygonEditor>;
  cal: CalibrationEditor;
  tripwireMode: boolean;
  twDrawRef: RefObject<DragBox | null>;
  commitTripwire: () => void;
};

export function useStageModes(o: Opts) {
  function vpPoint(e: ReactMouseEvent) {
    const r = o.viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  const target = (): StageTarget =>
    stageTarget({
      mode: o.mode,
      review: !!o.reviewRef.current,
      canConfigure: o.canConfigure,
      calActive: o.cal.active,
      tripwireMode: o.tripwireMode,
    });

  function onDown(e: ReactMouseEvent) {
    switch (target()) {
      case "none":
        return;
      case "calibration":
        o.cal.onDown(e);
        return;
      case "tripwire": {
        const p = vpPoint(e);
        o.twDrawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
        return;
      }
      case "polygon":
        o.poly.onDown(e); // rascunho · preset retângulo · vértice/midpoint/forma de uma zona
        return;
    }
  }

  // onMove/onUp seguem o ARRASTE em curso (refs), não o modo — soltar o botão fora do palco não
  // pode deixar um rascunho pendurado (o palco chama onUp também no onMouseLeave).
  function onMove(e: ReactMouseEvent) {
    if (o.cal.active) {
      o.cal.onMove(e);
      return;
    }
    if (o.twDrawRef.current?.active) {
      const p = vpPoint(e);
      o.twDrawRef.current.cx = p.x;
      o.twDrawRef.current.cy = p.y;
      return;
    }
    o.poly.onMove(e); // cursor do rascunho / preset em arraste / vértice ou forma ao vivo
  }

  function onUp() {
    if (o.cal.onUp()) return; // fim do arraste de canto/estação/ref/medida
    if (o.twDrawRef.current?.active) {
      o.commitTripwire();
      return;
    }
    o.poly.onUp(); // fim do preset retângulo (cria) ou do arraste (persiste points + bbox derivada)
  }

  return { onDown, onMove, onUp };
}
