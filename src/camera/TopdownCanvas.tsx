// TopdownCanvas — o <canvas> responsivo da vista de topo, compartilhado pela aba pequena e pela tela
// cheia. Redesenha quando a `view` muda (BLE ~2 s) e no resize do contêiner (ResizeObserver); sem rAF
// (dado BLE é lento). Só pintura — o cálculo de mundo vive em fusion/topdown.ts, o desenho em
// drawTopdown.ts. O contêiner define o TAMANHO (a aba dá um alto fixo; o palco dá flex-1 = tela cheia).
import { useEffect, useRef } from "react";
import { topdownBounds, worldToCanvas, type TopdownView } from "../fusion/topdown";
import { drawTopdown } from "./drawTopdown";

export function TopdownCanvas({
  view,
  className,
  ariaLabel,
}: {
  view: TopdownView;
  /** Classes do CONTÊINER (o layout da página decide a altura: flex-1 = tela cheia, min-h = aba). */
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
      drawTopdown(ctx, view, worldToCanvas(topdownBounds(view), { w, h }, 24), { w, h });
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
