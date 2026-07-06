// Relé JPEG do NÓ DE CÂMERA (caminho legado/fallback do WHIP): captura frames do <video>,
// encoda JPEG no <canvas> e entrega via `send` — com keep-alive de 2º plano. É o dono do
// hot-path do nó (fps/width/quality); a página (CameraPage) fica com socket/estado/badge.
//
// Contrato: startNodeRelay(...) → { stop, setProfile }. `setProfile` aplica o perfil pedido
// pela central (evento socket `capture`) e devolve o perfil efetivo (p/ o badge).
// LGPD: frames são efêmeros — encode → send → descarte; nada é retido aqui (ADR-002).

/** Perfil de captura efetivo (defaults de APP_CONFIG.net; a central pode elevar p/ leitura). */
export type CaptureProfile = { width: number; fps: number; quality: number };

/** Payload de frame enviado ao hub (contrato do evento socket `frame` do nó). */
export type NodeFramePayload = { buf: ArrayBuffer; w: number; h: number; ts: number };

export type NodeRelay = {
  stop(): void;
  setProfile(cfg: { width?: number; quality?: number; fps?: number }): CaptureProfile;
};

export function startNodeRelay(opts: {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  profile: CaptureProfile;
  send: (frame: NodeFramePayload) => void;
}): NodeRelay {
  const { video, canvas, send } = opts;
  let { width: frameWidth, fps: frameFps, quality: jpegQuality } = opts.profile;

  let stopped = false;
  let timer: number | null = null;
  let rvfcHandle: number | null = null;
  let audioCtx: AudioContext | null = null; // keep-alive de 2º plano (ver ensureKeepAlive)

  let encoding = false; // descarta frame se o encode anterior ainda não terminou (evita backlog)
  // Contexto 2D hoisted (criado 1×): alpha:false — JPEG não tem alfa; canvas opaco evita
  // composição/limpeza de canal alfa a cada drawImage.
  let ctx: CanvasRenderingContext2D | null = null;
  const sendFrame = () => {
    if (video.readyState < 2 || !video.videoWidth || encoding) return;
    const w = frameWidth,
      h = Math.round((frameWidth * video.videoHeight) / video.videoWidth);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx ??= canvas.getContext("2d", { alpha: false })!;
    ctx.drawImage(video, 0, 0, w, h);
    encoding = true;
    // JPEG BINÁRIO (não base64): ~⅓ menor e sem custo de string no transporte.
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          encoding = false;
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => {
            send({ buf, w, h, ts: Date.now() });
          })
          .finally(() => {
            encoding = false;
          });
      },
      "image/jpeg",
      jpegQuality,
    );
  };

  // Captura alinhada a frames REAIS da câmera: requestVideoFrameCallback dispara só quando o
  // vídeo entrega frame novo — webcam a 8fps em cena escura/estática não é re-encodada 12×/s.
  // O gate de fps alvo lê `frameFps` (mutável) a cada callback, então setProfile muda a cadência
  // sem re-registrar nada. rVFC é one-shot: re-agendamos a cada callback. Honestidade: em 2º
  // plano o browser estrangula rVFC E timers — o requisito operacional é aba visível (limitação
  // de plataforma); o keep-alive abaixo mitiga.
  const useRvfc = typeof video.requestVideoFrameCallback === "function"; // feature-detect 1×
  // Modo de captura: "rvfc" (aba VISÍVEL — alinhado a frames reais) ou "timer" (aba OCULTA —
  // o rVFC PARA em 2º plano; o timer segue enviando p/ a câmera não morrer).
  let mode: "rvfc" | "timer" = useRvfc ? "rvfc" : "timer";
  let lastSent = 0;
  const rvfcLoop = (now: DOMHighResTimeStamp) => {
    if (stopped || mode !== "rvfc") return; // deixa de re-armar quando trocamos p/ timer (2º plano)
    rvfcHandle = video.requestVideoFrameCallback(rvfcLoop); // re-agenda ANTES de processar
    const interval = 1000 / frameFps;
    if (now - lastSent >= interval - 1) {
      // -1ms de folga: absorve jitter do timestamp p/ não pular frames no fps alvo exato
      lastSent = now;
      sendFrame();
    }
  };
  const startTimer = () => {
    if (timer) clearInterval(timer);
    timer = window.setInterval(sendFrame, Math.round(1000 / frameFps));
  };
  const stopTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  // KEEP-ALIVE de 2º plano: Chrome/Edge estrangulam timers de aba oculta (1/s, e 1/min após
  // ~5min) e PARAM o rVFC — a webcam "morre" ao minimizar. Uma aba TOCANDO ÁUDIO é isenta desse
  // estrangulamento; mantemos um oscilador INAUDÍVEL (ganho ~0) tocando enquanto a captura roda.
  // Efeito: minimizar mantém a câmera online perto da taxa normal. Sem WebAudio (ou bloqueado):
  // degrada p/ o timer estrangulado — câmera ~1fps, mas não morre.
  const ensureKeepAlive = () => {
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) {
        audioCtx = new Ctx();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        gain.gain.value = 0.0001; // > 0 (conta como "tocando"), muito abaixo do audível
        osc.connect(gain).connect(audioCtx.destination);
        osc.start();
      }
      if (audioCtx.state === "suspended") void audioCtx.resume();
    } catch {
      /* WebAudio indisponível/bloqueado — segue só com o timer */
    }
  };

  if (useRvfc) rvfcHandle = video.requestVideoFrameCallback(rvfcLoop);
  else startTimer(); // sem rVFC: timer é o único caminho

  // Inicia o keep-alive JÁ (não só ao minimizar): o AudioContext precisa estar RODANDO antes de
  // a aba ficar oculta — criá-lo no visibilitychange nasce suspenso (sem gesto) e não isenta.
  // Se a política de autoplay o deixar suspenso, destrava no 1º gesto do usuário na página.
  ensureKeepAlive();
  const unlockAudio = () => ensureKeepAlive();
  window.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);

  // Alterna rVFC↔timer pela visibilidade e liga o keep-alive quando a aba some de vista.
  const onVisibility = () => {
    if (document.hidden) {
      ensureKeepAlive(); // isenta o timer do estrangulamento agressivo
      if (mode !== "timer") {
        mode = "timer";
        if (rvfcHandle !== null) {
          video.cancelVideoFrameCallback(rvfcHandle);
          rvfcHandle = null;
        }
        startTimer(); // envia frames mesmo minimizada
      }
    } else if (useRvfc && mode !== "rvfc") {
      stopTimer(); // voltou a ficar visível: retoma o rVFC (alinhado ao frame real)
      mode = "rvfc";
      lastSent = 0;
      rvfcHandle = video.requestVideoFrameCallback(rvfcLoop);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  if (document.hidden) onVisibility(); // já abriu em 2º plano? entra em modo timer na hora

  return {
    stop() {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      stopTimer();
      if (rvfcHandle !== null) video.cancelVideoFrameCallback(rvfcHandle);
      audioCtx?.close().catch(() => {});
    },
    setProfile(cfg) {
      if (cfg?.width) frameWidth = cfg.width;
      if (cfg?.quality) jpegQuality = cfg.quality;
      if (cfg?.fps && cfg.fps !== frameFps) {
        frameFps = cfg.fps;
        if (mode === "timer") startTimer(); // rVFC lê frameFps a cada callback; timer re-cria com o novo fps
      }
      return { width: frameWidth, fps: frameFps, quality: jpegQuality };
    },
  };
}
