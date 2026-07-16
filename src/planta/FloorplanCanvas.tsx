// FloorplanCanvas — o <canvas> responsivo da Planta BLE, e o PALCO da edição. Espelha
// camera/TopdownCanvas.tsx: redesenha quando a `view` muda (BLE ~2 s, já suavizada por EMA no hook) e
// no resize do contêiner (ResizeObserver); SEM rAF (dado BLE é lento). Só pintura — o cálculo de
// mundo vive em fusion/floorplan.ts, o desenho em drawFloorplan.ts. O contêiner define o TAMANHO (a
// página dá flex-1 = ocupa o máximo; a caixa é dominante na tela).
//
// É TAMBÉM O PALCO: publica o `transform` atual (o MESMO que desenha o canvas — mesma bbox/margem) e
// aceita `children` sobrepostos (a FloorplanEditLayer) + handlers de ponteiro no contêiner. Assim a
// SVG de edição casa handle↔desenho ao pixel, e o gesto de arraste chega ao hook. Fora do modo de
// edição, não recebe children nem handlers — segue o mapa read-only de sempre.
import { useEffect, useRef, type PointerEvent, type ReactNode, type RefObject } from "react";
import { drawPolygonEditor } from "../camera/draw";
import { worldToCanvas, type TopdownTransform } from "../fusion/topdown";
import type { FloorplanView } from "../fusion/floorplan";
import type { EditablePolygon, EditorOverlay, PolygonDraft } from "../spatial/usePolygonEditor";
import {
  drawFloorplan,
  floorplanBounds,
  type WorkAreaMarker,
  type ZoneMarker,
} from "./drawFloorplan";

// A margem do fit — a MESMA constante para desenho e para o transform publicado (senão os handles
// não casariam com o retângulo desenhado). 28 px: o valor histórico do canvas.
const MARGIN_PX = 28;

export function FloorplanCanvas({
  view,
  zones,
  workAreas,
  className,
  ariaLabel,
  containerRef,
  children,
  editing = false,
  polygonEditor,
  onTransform,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
}: {
  view: FloorplanView;
  /** Zonas de trabalho (survey com coordenada) + ocupantes — ADITIVO: ausente = mapa de sempre. */
  zones?: readonly ZoneMarker[];
  /** Geometria física independente das zonas/fingerprints; nunca reposiciona uma tag. */
  workAreas?: readonly WorkAreaMarker[];
  /** Classes do CONTÊINER (o layout da página decide a altura: flex-1 = dominante). */
  className?: string;
  ariaLabel: string;
  /** Se dado, é usado como contêiner (o hook de edição lê o rect dele). Senão, um interno. */
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Sobreposto ao canvas dentro do contêiner (a camada de edição). */
  children?: ReactNode;
  /** Configuração: reduz rótulos do canvas; a camada SVG já identifica as antenas editáveis. */
  editing?: boolean;
  /** Overlay do motor poligonal compartilhado; presente somente na aba Áreas. */
  polygonEditor?: {
    items: readonly EditablePolygon[];
    draftRef: RefObject<PolygonDraft | null>;
    overlayRef: RefObject<EditorOverlay>;
  };
  /** Publica o transform ATUAL + tamanho a cada render/resize — a página o repassa à SVG e ao hook. */
  onTransform?: (tf: TopdownTransform, size: { w: number; h: number }) => void;
  onPointerDown?: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (e: PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLDivElement>) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const internalWrap = useRef<HTMLDivElement | null>(null);
  const wrapRef = containerRef ?? internalWrap;
  // Ref estável do callback: entra no render() sem re-armar o efeito (que só depende de `view`).
  const onTransformRef = useRef(onTransform);
  onTransformRef.current = onTransform;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const render = (publishTransform = false) => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const tf = worldToCanvas(floorplanBounds(view), { w, h }, MARGIN_PX);
      drawFloorplan(ctx, view, tf, { w, h }, zones, { editing, workAreas });
      if (polygonEditor && view.widthM > 0 && view.heightM > 0) {
        const topLeft = tf.project({ x: 0, y: 0 });
        const bottomRight = tf.project({ x: view.widthM, y: view.heightM });
        drawPolygonEditor(
          ctx,
          {
            x: topLeft.x,
            y: topLeft.y,
            w: bottomRight.x - topLeft.x,
            h: bottomRight.y - topLeft.y,
          },
          polygonEditor.items,
          polygonEditor.draftRef.current,
          polygonEditor.overlayRef.current,
        );
      }
      if (publishTransform) onTransformRef.current?.(tf, { w, h });
    };
    render(true);
    const ro = new ResizeObserver(() => render(true));
    ro.observe(wrap);
    let frame = 0;
    if (polygonEditor) {
      const animate = () => {
        render(false);
        frame = window.requestAnimationFrame(animate);
      };
      frame = window.requestAnimationFrame(animate);
    }
    return () => {
      ro.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [view, zones, workAreas, wrapRef, editing, polygonEditor]);

  return (
    <div
      ref={wrapRef}
      className={className}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label={ariaLabel} />
      {children}
    </div>
  );
}
