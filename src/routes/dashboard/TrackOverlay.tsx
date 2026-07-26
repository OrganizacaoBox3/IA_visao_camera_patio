import { useEffect, useRef, type RefObject } from "react";
import type { VideoStreamElement } from "../../vendor/go2rtc/go2rtc";
import type { HubAnalysis } from "../../CameraWorkspace";
import { getContentRect, cssVar, personLabel } from "../../camera/draw";
import { TrackInterpolator } from "../../camera/interpolate";
import { HUB_TRACKS_STALE_MS } from "../../types/analysis";
import { APP_CONFIG } from "../../config";
import { applyPlayoutDelay } from "../../camera/playoutDelay";

// ── Overlay de caixas SOBRE o <video-stream> (tiles WebRTC/go2rtc) ────────────────────────────────
// Um <canvas> transparente exatamente sobre o vídeo do tile. Desenha as caixas de pessoa vindas do
// hub (`analysis-tracks`, ~1fps) INTERPOLADAS no tempo real (interpolate.ts) — a caixa ACOMPANHA a
// pessoa a ~30fps em vez de congelar+teleportar. Sem tracks (câmera sem análise) → não desenha, sem
// erro. rAF próprio; para ao desmontar (tile pausado/fora de tela desmonta o tile inteiro).

// STALE do payload do hub: FONTE ÚNICA em types/analysis.ts (o TODO antigo daqui fechou — Onda 4).

type TrackOverlayProps = {
  // Ref do <video-stream> do tile (Go2rtcVideoTile). Lemos `.video` (o <video> interno) p/ dimensões
  // reais (videoWidth/Height) e caixa renderizada (clientWidth/Height) — o mapeamento do letterbox.
  videoRef: RefObject<VideoStreamElement | null>;
  // Getter estável do último `analysis-tracks` da câmera (mesmo da central). Ausente → overlay vazio.
  getHubAnalysis?: () => HubAnalysis | null;
};

// Canvas transparente sobre o vídeo: pinta as caixas do hub interpoladas num rAF próprio.
export function TrackOverlay({ videoRef, getHubAnalysis }: TrackOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d"); // alpha:true (default) → overlay transparente
    if (!ctx) return;

    const interp = new TrackInterpolator();
    let raf = 0;
    let cancelled = false;

    // Hot-path: cores lidas 1× por mount (getComputedStyle é caro p/ rodar por frame; troca de
    // tema no meio da sessão só reflete ao remontar o tile — custo aceito, tema é quase-estático).
    // Going-gray: mesma paleta do overlay MJPEG (drawTracks) → pessoa = --state-info (advisory,
    // não-alarme); os tiles ficam consistentes entre transportes. Saturaria só se houvesse sinal
    // de anormalidade por track (o motor do hub não expõe um hoje).
    const stroke = cssVar("--state-info", "#38bdf8");
    const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.7)");
    const fg = cssVar("--state-info-fg", "#bae6fd");
    // Hot-path: measureText por track TODO frame é evitável — o rótulo (personLabel) é estável
    // por track e a fonte é fixa; cacheia a largura por rótulo (limpa se crescer demais: ids de
    // track crescem indefinidamente ao longo de horas).
    const labelWidth = new Map<string, number>();

    const tick = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(tick);
      const vs = videoRef.current;
      const video = vs?.video;
      // Sem <video> ainda (conectando) ou sem quadro decodificado → nada a sobrepor.
      if (!video || video.readyState < 2 || !video.videoWidth) return;

      const dpr = window.devicePixelRatio || 1;
      const cw = video.clientWidth,
        ch = video.clientHeight;
      if (!cw || !ch) return;
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cw, ch);

      // Letterbox: o <video> usa object-fit:contain; a caixa normalizada (0..1) é do FRAME, então
      // mapeia-se no retângulo de conteúdo (frame ajustado na caixa do vídeo), não na caixa toda.
      const cr = getContentRect(cw, ch, video.videoWidth, video.videoHeight);

      // Plano de controle: ingere o payload do hub (dedupe por ts dentro do interpolador). Payload
      // ausente/velho → não ingere; as caixas vivas fazem fade e somem (não congelam).
      const hd = getHubAnalysis?.() ?? null;
      if (hd && Date.now() - hd.ts <= HUB_TRACKS_STALE_MS) {
        interp.ingest(hd, performance.now());
      }
      // Onda 2/modo síncrono: amostra p/ o instante do QUADRO do <video> (atrasado quando
      // syncDelayMs>0 — o efeito abaixo aplica o hint no pc deste tile).
      const lag =
        APP_CONFIG.overlay.syncDelayMs > 0
          ? APP_CONFIG.overlay.syncDelayMs
          : APP_CONFIG.overlay.videoLagMs.webrtc;
      const drawn = interp.sample(performance.now(), lag);
      if (!drawn.length) return; // sem tracks → nada a sobrepor (sem erro)

      ctx.lineWidth = 1.5;
      ctx.font = "10px monospace";
      // PARIDADE COM O MJPEG (drawTracks): a incerteza da marcação sai em DOIS canais separados,
      // porque as duas causas pedem AÇÃO diferente do operador — contorno TRACEJADO = coasting
      // (o motor não reobservou nesta rodada: olhar rede/CPU/câmera) · OPACIDADE = confiança/fade
      // (ajustar "Exibição → Confiança mínima"). Antes os dois viviam na opacidade e a caixa a 45%
      // era ambígua. Este arquivo é o renderizador do tile WebRTC; a divergência "MJPEG consertado,
      // WebRTC esquecido" é a classe de bug que o invariante do draw.ts alerta — daí a paridade.
      for (const t of drawn) {
        ctx.globalAlpha = t.opacity;
        const x = cr.x + t.bbox[0] * cr.w,
          y = cr.y + t.bbox[1] * cr.h,
          w = t.bbox[2] * cr.w,
          h = t.bbox[3] * cr.h;
        ctx.strokeStyle = stroke;
        if (t.coasting) ctx.setLineDash([5, 4]); // mesmo padrão do drawTracks
        ctx.strokeRect(x, y, w, h);
        if (t.coasting) ctx.setLineDash([]); // scrim/rótulo abaixo nunca saem tracejados
        // Rótulo: o genérico "Pessoa" (personLabel — a MESMA fonte do drawTracks/MJPEG; a caixa
        // NUNCA exibe número, ver draw.ts). Sem labelFor: a fusão BLE migrou de repo (ADR-018).
        const tag = personLabel(undefined, t.id);
        let tw = labelWidth.get(tag);
        if (tw === undefined) {
          if (labelWidth.size > 512) labelWidth.clear();
          tw = ctx.measureText(tag).width + 8;
          labelWidth.set(tag, tw);
        }
        ctx.fillStyle = scrim;
        ctx.fillRect(x, y - 15, tw, 14);
        ctx.fillStyle = fg;
        ctx.fillText(tag, x + 4, y - 4);
      }
      ctx.globalAlpha = 1;
    };

    raf = requestAnimationFrame(tick);
    // MODO SÍNCRONO: atrasa a reprodução do <video> deste tile (o pc renasce a cada reconexão
    // interna do elemento → reaplica periodicamente; idempotente e barato).
    const syncMs = APP_CONFIG.overlay.syncDelayMs;
    const delayTimer =
      syncMs > 0 ? setInterval(() => applyPlayoutDelay(videoRef.current, syncMs), 2000) : null;
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (delayTimer) clearInterval(delayTimer);
    };
  }, [videoRef, getHubAnalysis]);

  return <canvas ref={canvasRef} className="rtc-overlay" aria-hidden="true" />;
}
