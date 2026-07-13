import { useEffect, useRef, type RefObject } from "react";
import type { VideoStreamElement } from "../../vendor/go2rtc/go2rtc";
import type { HubAnalysis } from "../../CameraWorkspace";
import { getContentRect, cssVar, drawFloorTags, personLabel } from "../../camera/draw";
import { TrackInterpolator } from "../../camera/interpolate";
import type { FloorTagsView } from "../../fusion/useFloorTags";

// ── Overlay de caixas SOBRE o <video-stream> (tiles WebRTC/go2rtc) ────────────────────────────────
// Um <canvas> transparente exatamente sobre o vídeo do tile. Desenha as caixas de pessoa vindas do
// hub (`analysis-tracks`, ~1fps) INTERPOLADAS no tempo real (interpolate.ts) — a caixa ACOMPANHA a
// pessoa a ~30fps em vez de congelar+teleportar. Sem tracks (câmera sem análise) → não desenha, sem
// erro. rAF próprio; para ao desmontar (tile pausado/fora de tela desmonta o tile inteiro).

// Payload do hub mais velho que isto = motor reiniciando/rede caída: deixa a caixa expirar (fade)
// em vez de ancorar keyframe em dado morto. Valor duplicado do HUB_TRACKS_STALE_MS do
// CameraWorkspace (dono do gate) — unificar quando o contrato migrar p/ types/analysis.ts (F4).
const HUB_TRACKS_STALE_MS = 5000;

type TrackOverlayProps = {
  // Ref do <video-stream> do tile (Go2rtcVideoTile). Lemos `.video` (o <video> interno) p/ dimensões
  // reais (videoWidth/Height) e caixa renderizada (clientWidth/Height) — o mapeamento do letterbox.
  videoRef: RefObject<VideoStreamElement | null>;
  // Getter estável do último `analysis-tracks` da câmera (mesmo da central). Ausente → overlay vazio.
  getHubAnalysis?: () => HubAnalysis | null;
  // Rótulo da TAG BLE associada a esta pessoa (fusão, caminho C). Devolve o rótulo quando a associação
  // tem confiança; null = "não sei" → cai no genérico "Pessoa". Ausente = feature desligada.
  labelFor?: (trackId: number) => string | null;
  // TAGS NO CHÃO (fusion/useFloorTags): âncoras/estação/anéis de distância, desenhados SOB as
  // caixas de pessoa. Getter estável lendo o ref do hook; null/ausente → camada não desenha.
  getFloorTags?: () => FloorTagsView | null;
};

// Canvas transparente sobre o vídeo: pinta as caixas do hub interpoladas num rAF próprio.
export function TrackOverlay({ videoRef, getHubAnalysis, labelFor, getFloorTags }: TrackOverlayProps) {
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

      // TAGS NO CHÃO — camada de FUNDO, sob as caixas de pessoa. Independe de haver tracks na
      // cena (âncoras/anéis existem mesmo com o pátio vazio). Ligada por padrão quando o hook
      // tem calibração + leituras (getter devolve a visão); sem dados devolve null e nada pinta.
      const ft = getFloorTags?.() ?? null;
      if (ft) drawFloorTags(ctx, cr, ft);

      // Plano de controle: ingere o payload do hub (dedupe por ts dentro do interpolador). Payload
      // ausente/velho → não ingere; as caixas vivas fazem fade e somem (não congelam).
      const hd = getHubAnalysis?.() ?? null;
      if (hd && Date.now() - hd.ts <= HUB_TRACKS_STALE_MS) {
        interp.ingest(hd, performance.now());
      }
      const drawn = interp.sample(performance.now());
      if (!drawn.length) return; // sem tracks → só a camada de chão (sem erro)

      ctx.lineWidth = 1.5;
      ctx.font = "10px monospace";
      for (const t of drawn) {
        ctx.globalAlpha = t.opacity;
        const x = cr.x + t.bbox[0] * cr.w,
          y = cr.y + t.bbox[1] * cr.h,
          w = t.bbox[2] * cr.w,
          h = t.bbox[3] * cr.h;
        ctx.strokeStyle = stroke;
        ctx.strokeRect(x, y, w, h);
        // Rótulo: a TAG BLE associada (fusão) quando há; senão o genérico "Pessoa" (personLabel — a
        // MESMA fonte do drawTracks/MJPEG; a caixa NUNCA exibe número, ver draw.ts). A associação é
        // "não sei"-honesta (associate.ts) → só rotula quem o RSSI×distância casou com confiança.
        const tag = personLabel(labelFor, t.id);
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
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [videoRef, getHubAnalysis, labelFor, getFloorTags]);

  return <canvas ref={canvasRef} className="rtc-overlay" aria-hidden="true" />;
}
