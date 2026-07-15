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
import { worldToCanvas, type TopdownTransform } from "../fusion/topdown";
import type { FloorplanView } from "../fusion/floorplan";
import { drawFloorplan, floorplanBounds } from "./drawFloorplan";

// A margem do fit — a MESMA constante para desenho e para o transform publicado (senão os handles
// não casariam com o retângulo desenhado). 28 px: o valor histórico do canvas.
const MARGIN_PX = 28;

export function FloorplanCanvas({
  view,
  className,
  ariaLabel,
  containerRef,
  children,
  onTransform,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerLeave,
}: {
  view: FloorplanView;
  /** Classes do CONTÊINER (o layout da página decide a altura: flex-1 = dominante). */
  className?: string;
  ariaLabel: string;
  /** Se dado, é usado como contêiner (o hook de edição lê o rect dele). Senão, um interno. */
  containerRef?: RefObject<HTMLDivElement | null>;
  /** Sobreposto ao canvas dentro do contêiner (a camada de edição). */
  children?: ReactNode;
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
    const render = () => {
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
      drawFloorplan(ctx, view, tf, { w, h });
      onTransformRef.current?.(tf, { w, h }); // MESMO tf do desenho → a SVG casa ao pixel
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [view, wrapRef]);

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
