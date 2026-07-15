// FloorplanCanvas — o <canvas> responsivo da Planta BLE. Espelha camera/TopdownCanvas.tsx: redesenha
// quando a `view` muda (BLE ~2 s, já suavizada por EMA no hook) e no resize do contêiner
// (ResizeObserver); SEM rAF (dado BLE é lento). Só pintura — o cálculo de mundo vive em
// fusion/floorplan.ts, o desenho em drawFloorplan.ts. O contêiner define o TAMANHO (a página dá
// flex-1 = ocupa o máximo; a caixa é dominante na tela).
import { useEffect, useRef } from "react";
import { worldToCanvas } from "../fusion/topdown";
import type { FloorplanView } from "../fusion/floorplan";
import { drawFloorplan, floorplanBounds } from "./drawFloorplan";

export function FloorplanCanvas({
  view,
  className,
  ariaLabel,
}: {
  view: FloorplanView;
  /** Classes do CONTÊINER (o layout da página decide a altura: flex-1 = dominante). */
  className?: string;
  ariaLabel: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
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
      drawFloorplan(ctx, view, worldToCanvas(floorplanBounds(view), { w, h }, 28), { w, h });
    };
    render();
    const ro = new ResizeObserver(render);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [view]);

  return (
    <div ref={wrapRef} className={className}>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label={ariaLabel} />
    </div>
  );
}
