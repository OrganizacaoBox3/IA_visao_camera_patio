// ── PONTEIRO DO PALCO: o multiplexador dos modos de edição da câmera aberta ────────────────────
// Extraído do CameraWorkspace (ratchet anti-reengorda: o god-file cresce por DECISÃO, não por
// deriva — CameraWorkspace.size.test.ts). Responsabilidade ÚNICA: traduzir um evento de ponteiro do
// palco para O EDITOR ATIVO, na ordem certa, e ser dono do que nenhum outro editor tem dono —
// o rascunho do RETÂNGULO (drawRef) e o estado do PINCEL (pintando/apagando).
//
// Os editores COM dono próprio (linha → useTripwires · polígono → usePolygonEditor · calibração →
// useCalibrationEditor) só são DELEGADOS aqui: cada um devolve boolean ("consumi o evento").
//
// ── A ORDEM É A REGRA (e agora é PURA + testada: stageTarget) ─────────────────────────────────
// O corte de RBAC do palco vinha ANTES de tudo (`if (!canConfigure) return`), o que era certo
// enquanto todo modo do palco era de ENGENHARIA. Com a calibração virando modo (spec §1), deixou de
// ser: MEDIR distância é do OPERADOR (era o que a rota /calibracao lhe dava — "A calibração requer
// perfil de engenharia. Você pode usar o modo Medir."). Plugar a calibração ingenuamente MATARIA o
// medir para ele. Por isso a calibração é consultada ACIMA do corte, e o corte segue barrando o que
// sempre barrou (criar/editar/pintar zona e traçar linha). Regressão silenciosa nº 1 → vira teste
// (useStageModes.test.ts).
import { useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { type FrameSource } from "../frame";
import { getContentRect, type DragBox } from "./draw";
import { withDefaults, type Zone } from "../zones";
import type { useZoneMasks } from "./useZoneMasks";
import type { usePolygonEditor } from "./usePolygonEditor";
import type { CalibrationEditor } from "./useCalibrationEditor";

/** Quem recebe o pointer-down do palco. "none" = ninguém (grade, revisão, ou RBAC). */
export type StageTarget = "none" | "calibration" | "paint" | "tripwire" | "rect" | "polygon";

export type StageState = {
  mode: "tile" | "full";
  review: boolean;
  canConfigure: boolean;
  calActive: boolean;
  paintZoneId: string | null;
  tripwireMode: boolean;
  drawMode: boolean;
};

/**
 * PURA: a ordem de precedência dos modos do palco no pointer-down. É aqui que mora o invariante do
 * RBAC — a CALIBRAÇÃO é consultada ACIMA do corte `!canConfigure` (o operador MEDE; o hook da
 * calibração é que decide o que ele pode marcar), e o corte segue valendo para os demais editores.
 */
export function stageTarget(s: StageState): StageTarget {
  if (s.mode !== "full" || s.review) return "none"; // grade / revisão: o palco mostra o buffer
  if (s.calActive) return "calibration"; // ← ACIMA do RBAC de propósito (medir é de todos)
  if (!s.canConfigure) return "none"; // operador em SÓ-LEITURA: não cria/edita/pinta zona nem linha
  if (s.paintZoneId) return "paint";
  if (s.tripwireMode) return "tripwire";
  if (s.drawMode) return "rect";
  return "polygon"; // sem modo armado: o polígono ainda pega o ARRASTE de um vértice existente
}

type Opts = {
  cameraId: string;
  mode: "tile" | "full";
  canConfigure: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  /** fonte da GEOMETRIA do palco (WebRTC × MJPEG) */
  currentFrame: () => FrameSource | null;
  reviewRef: RefObject<boolean>;
  zonesRef: RefObject<Zone[]>;
  zm: ReturnType<typeof useZoneMasks>;
  poly: ReturnType<typeof usePolygonEditor>;
  cal: CalibrationEditor;
  paintZoneId: string | null;
  drawMode: boolean;
  tripwireMode: boolean;
  twDrawRef: RefObject<DragBox | null>;
  commitTripwire: () => void;
  onCreateZone: (z: Zone) => void;
  patchZone: (id: string, patch: Partial<Zone>) => void;
};

export function useStageModes(o: Opts) {
  const [brush, setBrush] = useState(2);
  const [erase, setErase] = useState(false);
  const drawRef = useRef<DragBox | null>(null); // rascunho do retângulo (lido pelo rAF/drawZoneDraft)
  const paintingRef = useRef(false);
  const eraseRef = useRef(false);

  function vpPoint(e: ReactMouseEvent) {
    const r = o.viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function normPoint(e: ReactMouseEvent): { nx: number; ny: number } | null {
    const f = o.currentFrame(),
      viewport = o.viewportRef.current;
    if (!f || !viewport) return null;
    const r = viewport.getBoundingClientRect();
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const nx = (e.clientX - r.left - cr.x) / cr.w,
      ny = (e.clientY - r.top - cr.y) / cr.h;
    return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { nx, ny };
  }
  function paintAt(e: ReactMouseEvent) {
    const z = o.zonesRef.current?.find((z) => z.id === o.paintZoneId);
    const p = z ? normPoint(e) : null;
    if (z && p) o.zm.paintAt(z, p.nx, p.ny, brush - 1, eraseRef.current);
  }
  /** commit da PINTURA (também usado pelo "Limpar" da barra) — write-through via patchZone. */
  function commitPaint() {
    const z = o.zonesRef.current?.find((zz) => zz.id === o.paintZoneId);
    const patch = z ? o.zm.commitPaint(z) : null;
    if (z && patch) o.patchZone(z.id, patch);
  }

  const target = (): StageTarget =>
    stageTarget({
      mode: o.mode,
      review: !!o.reviewRef.current,
      canConfigure: o.canConfigure,
      calActive: o.cal.active,
      paintZoneId: o.paintZoneId,
      tripwireMode: o.tripwireMode,
      drawMode: o.drawMode,
    });

  function onDown(e: ReactMouseEvent) {
    switch (target()) {
      case "none":
        return;
      case "calibration":
        o.cal.onDown(e);
        return;
      case "paint":
        paintingRef.current = true;
        eraseRef.current = e.altKey || e.button === 2 || erase;
        paintAt(e);
        return;
      case "tripwire": {
        const p = vpPoint(e);
        o.twDrawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
        return;
      }
      case "rect": {
        const p = vpPoint(e);
        drawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
        return;
      }
      case "polygon":
        o.poly.onDown(e); // vértice do rascunho OU início do arraste de um vértice (CA-7)
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
    if (paintingRef.current) {
      paintAt(e);
      return;
    }
    if (o.twDrawRef.current?.active) {
      const p = vpPoint(e);
      o.twDrawRef.current.cx = p.x;
      o.twDrawRef.current.cy = p.y;
      return;
    }
    if (drawRef.current?.active) {
      const p = vpPoint(e);
      drawRef.current.cx = p.x;
      drawRef.current.cy = p.y;
      return;
    }
    o.poly.onMove(e); // cursor do rascunho / arraste de vértice ao vivo
  }

  function onUp() {
    if (o.cal.onUp()) return; // fim do arraste de canto/estação/ref/medida
    if (paintingRef.current) {
      paintingRef.current = false;
      commitPaint();
      return;
    }
    if (o.twDrawRef.current?.active) {
      o.commitTripwire();
      return;
    }
    if (o.poly.onUp()) return; // fim do arraste de vértice (persiste points + bbox derivada)
    const d = drawRef.current;
    if (!d?.active) return;
    drawRef.current = null;
    const f = o.currentFrame(),
      viewport = o.viewportRef.current;
    if (!f || !viewport) return;
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const x0 = Math.min(d.sx, d.cx),
      y0 = Math.min(d.sy, d.cy),
      w = Math.abs(d.cx - d.sx),
      h = Math.abs(d.cy - d.sy);
    if (w < 16 || h < 16) return; // clique sem arraste: não vira zona
    // Defaults do modelo via withDefaults (fonte única) — mesmos valores do literal antigo.
    o.onCreateZone(
      withDefaults(
        {
          label: `Área ${(o.zonesRef.current?.length ?? 0) + 1}`,
          x: Math.max(0, (x0 - cr.x) / cr.w),
          y: Math.max(0, (y0 - cr.y) / cr.h),
          w: Math.min(1, w / cr.w),
          h: Math.min(1, h / cr.h),
        },
        o.cameraId,
      ),
    );
  }

  return { brush, setBrush, erase, setErase, drawRef, commitPaint, onDown, onMove, onUp };
}
