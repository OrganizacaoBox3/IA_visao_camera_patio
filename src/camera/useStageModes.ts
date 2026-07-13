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
//     recebe agora é o usePolygonEditor (startRect), e o que ele cria JÁ NASCE EDITÁVEL.
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
  // O editor da ZONA é o default do palco: com "Zona" armado ele recebe o arraste do PRESET
  // retângulo; com "Polígono", o clique do rascunho; sem modo armado, ele ainda seleciona/arrasta
  // vértice, insere pelo midpoint e move a forma (o `simple_select` do Mapbox).
  return "polygon";
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
