// ── Fase 1 (go2rtc): transporte de VÍDEO da câmera aberta (tela cheia) ──────────────────────────
// Extraído do CameraWorkspace (Onda C) SEM mudança de comportamento. OPT-IN por câmera
// (transport:"webrtc"; default "mjpeg" = caminho atual byte-a-byte). Quando ligado, o vídeo vem de
// `<video-stream>` (WebRTC/MSE/HLS/MJPEG auto-negociado, decode por HW fora da main-thread) ATRÁS do
// canvas; o canvas de zonas/tracks/editor fica TRANSPARENTE por cima. Espelha o CameraTile
// (Go2rtcVideoTile) — por PROPRIEDADE DE ARQUIVO não editamos o CameraTile: duplicamos aqui o
// registro do custom element (vendorizado/self-host, importado DINAMICAMENTE 1× — câmeras "mjpeg"
// nunca baixam o JS).
import { useEffect, useRef } from "react";
import { APP_CONFIG } from "../config";
import { type FrameSource } from "../frame";
import { getVideoTicket } from "../video/ticket";
import type { VideoStreamElement } from "../vendor/go2rtc/go2rtc";

let videoStreamModule: Promise<unknown> | null = null;
function ensureVideoStreamRegistered(): Promise<unknown> {
  if (!videoStreamModule) videoStreamModule = import("../vendor/go2rtc/video-stream.js");
  return videoStreamModule;
}

// Janela p/ o WebRTC da TELA CHEIA estabelecer vídeo. Após pedir o src, damos este prazo p/ o
// <video> decodificar o 1º quadro (videoWidth>0). Esgotado sem vídeo (fonte caída no go2rtc, sem
// peer, sem quadro), reportamos a falha 1× → o pai remonta a câmera aberta em MJPEG. ~7s cobre
// negociação WebRTC + fallback interno (mse/hls/mjpeg) do componente sem punir uma fonte lenta.
const WEBRTC_FAIL_MS = 7000;

type Params = {
  transport: "mjpeg" | "webrtc";
  mode: "tile" | "full";
  cameraId: string;
  // Fonte MJPEG (relé socket.io) — o caminho atual, usado quando webrtc está desligado.
  getFrame: () => FrameSource | null;
  onWebrtcFail?: (cameraId: string) => void;
  // ⏸ Pausar / ❄ Congelar precisam CONGELAR o <video> nativo (que roda ATRÁS do canvas congelado).
  paused: boolean;
  review: boolean;
};

export type WebrtcTransport = {
  // Transporte WebRTC ativo? Só no mode "full" (a grade webrtc é do CameraTile). Governa o RENDER.
  webrtc: boolean;
  // Espelho lido DENTRO do rAF/drawScene (o loop é criado 1× por câmera e a prop pode trocar em runtime).
  webrtcRef: React.MutableRefObject<boolean>;
  videoStreamRef: React.MutableRefObject<VideoStreamElement | null>;
  // Frame CORRENTE p/ a GEOMETRIA do editor/tripwire. WebRTC → <video> nativo; MJPEG → getFrame().
  currentFrame: () => FrameSource | null;
};

export function useWebrtcTransport({
  transport,
  mode,
  cameraId,
  getFrame,
  onWebrtcFail,
  paused,
  review,
}: Params): WebrtcTransport {
  const webrtc = transport === "webrtc" && mode === "full";
  const webrtcRef = useRef(webrtc);
  const videoStreamRef = useRef<VideoStreamElement | null>(null);
  useEffect(() => {
    webrtcRef.current = webrtc;
  }, [webrtc]);
  // Espelho estável do callback de fallback (lido dentro do efeito assíncrono/timer sem re-armar a
  // fiação a cada re-render que troca a identidade da prop — mesmo padrão de onAlertRef).
  const onWebrtcFailRef = useRef(onWebrtcFail);
  useEffect(() => {
    onWebrtcFailRef.current = onWebrtcFail;
  }, [onWebrtcFail]);

  // Registra o custom element e aplica src/mode/media/background IMPERATIVAMENTE via ref (as props
  // do <video-stream> são SETTERS JS, não atributos), APÓS o define — mesmo padrão do CameraTile.
  // mjpeg/ausente → efeito INERTE (nem importa o JS): caminho atual byte-a-byte.
  useEffect(() => {
    if (!webrtc) return;
    let cancelled = false;
    // Guard: onWebrtcFail dispara NO MÁXIMO 1× por (câmera, montagem). Como o efeito re-arma em
    // [webrtc, cameraId], a flag reseta ao trocar de câmera/entrar em cena → 1 reporte por tentativa.
    let reported = false;
    let failTimer: ReturnType<typeof setTimeout> | null = null;
    const node = videoStreamRef.current; // estável por toda a vida do elemento (captura p/ cleanup)
    const failNow = () => {
      if (reported || cancelled) return;
      reported = true;
      onWebrtcFailRef.current?.(cameraId);
    };
    ensureVideoStreamRegistered()
      .then(() => customElements.whenDefined("video-stream"))
      .then(async () => {
        if (cancelled || !node) return;
        const el = node;
        el.mode = "webrtc,mse,hls,mjpeg"; // ordem importa: config ANTES de src (o setter de src conecta)
        el.media = "video"; // vigilância silenciosa: sem áudio
        el.background = false; // solta o stream quando a aba/tela sai de vista
        if (el.video) el.video.controls = false; // sem controles nativos (o palco trata a interação)
        // O proxy /go2rtc/* exige ticket: passe ESPECÍFICO desta câmera na URL do WS de sinalização.
        // Falha ao obter (deslogado/hub fora) → cai p/ MJPEG, como uma fonte inalcançável.
        const ticket = await getVideoTicket(cameraId).catch(() => null);
        if (cancelled) return;
        if (!ticket) {
          failNow();
          return;
        }
        el.src = `${APP_CONFIG.go2rtc.baseUrl}/api/ws?src=${encodeURIComponent(cameraId)}&ticket=${encodeURIComponent(ticket)}`;
        // Reforço: erro nativo do <video> interno derruba pro MJPEG já (não espera o prazo). O timer
        // continua sendo o mecanismo primário — o <video> pode nem existir/emitir erro numa fonte caída.
        el.video?.addEventListener("error", failNow);
        // Timer primário: ao fim de WEBRTC_FAIL_MS, se o <video> não decodificou quadro (videoWidth
        // 0/undefined) → falha. videoWidth>0 = vídeo estabelecido → NÃO chama.
        failTimer = setTimeout(() => {
          failTimer = null;
          if (!videoStreamRef.current?.video?.videoWidth) failNow();
        }, WEBRTC_FAIL_MS);
      })
      .catch(() => {
        // go2rtc indisponível (JS não registrou / whenDefined rejeitou) → WebRTC não vai subir: cai
        // pro MJPEG já, em vez de deixar a tela cheia sem vídeo.
        failNow();
      });
    return () => {
      cancelled = true;
      if (failTimer) clearTimeout(failTimer); // limpa o prazo ao desmontar/trocar de câmera
      node?.video?.removeEventListener("error", failNow);
      try {
        node?.ondisconnect?.(); // solta ws/pc JÁ ao desmontar/trocar (não espera o timeout interno)
      } catch {
        /* no-op */
      }
    };
  }, [webrtc, cameraId]);

  // ⏸ Pausar / ❄ Congelar: no WebRTC o vídeo é nativo ATRÁS do canvas, então pausamos o <video>
  // (senão ele seguiria correndo sob o overlay congelado). Ao retomar, volta ao vivo. Inerte no MJPEG.
  useEffect(() => {
    if (!webrtc) return;
    const v = videoStreamRef.current?.video;
    if (!v) return;
    if (paused || review) v.pause();
    else void v.play().catch(() => {});
  }, [webrtc, paused, review]);

  // Frame CORRENTE p/ a GEOMETRIA do editor (letterbox → coords normalizadas). No WebRTC vem do
  // <video> nativo (mesmas dimensões que o drawScene usa p/ o content-rect); o getFrame() do relé
  // MJPEG pode estar ausente/em outra resolução p/ uma câmera webrtc. No MJPEG é o getFrame() de sempre.
  function currentFrame(): FrameSource | null {
    if (webrtcRef.current) {
      const video = videoStreamRef.current?.video;
      if (!video || !video.videoWidth || !video.videoHeight) return null;
      return { el: video, w: video.videoWidth, h: video.videoHeight };
    }
    return getFrame();
  }

  return { webrtc, webrtcRef, videoStreamRef, currentFrame };
}
