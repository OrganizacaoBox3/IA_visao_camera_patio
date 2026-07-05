import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../config";
import { acquireCameraStream, isSecureCameraContext, CameraAcquireError } from "../camera/acquire";
import { publishWebcamWhip, type WhipPublisher, type WhipState } from "../camera/whip";
import { Tooltip } from "../ui";

// Fase 5 (plano-retrofit-performance.md §Fase 5 + plano-fase1-go2rtc.md): transmite o vídeo do nó
// por WebRTC/WHIP ao go2rtc em vez do loop JPEG→socket. Onda 1 da simplificação de config: a decisão
// é em RUNTIME por PROBE (não mais um gate build-time). Por default o nó TENTA WHIP; se não
// estabelecer dentro do probe (go2rtc ausente/timeout/erro), CAI SOZINHO p/ o JPEG-socket legado —
// fallback automático, sem flag. VITE_WEBCAM_WHIP=0 é o único escape hatch (força JPEG, sem probe).
const WHIP_ATTEMPT = APP_CONFIG.webcam.whip.enabled; // default true; só "0" desliga
const WHIP_PROBE_TIMEOUT_MS = APP_CONFIG.webcam.whip.probeTimeoutMs;

// Caminho de vídeo ATIVO do nó (reflete no badge). "probing": tentando WHIP, ainda sem decidir;
// "webrtc": WHIP estabelecido; "jpeg": loop JPEG-socket legado (default sem go2rtc ou pós-fallback).
type Transport = "probing" | "webrtc" | "jpeg";

// Token do nó de câmera: ?key=<CAMERA_TOKEN> (enrolamento de dispositivo) ou, em fallback,
// a sessão de um humano logado no mesmo navegador. Câmera não exige login humano.
function cameraToken(): string | null {
  const key = new URLSearchParams(location.search).get("key");
  if (key) return key;
  try {
    return JSON.parse(localStorage.getItem("vp-auth") || "null")?.token ?? null;
  } catch {
    return null;
  }
}

// Nó de câmera: apresenta APENAS o feed (sem controles) e envia frames ao hub.
type Status = "connecting" | "on" | "denied" | "error";

export function CameraPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [status, setStatus] = useState<Status>("connecting");
  const [hubConnected, setHubConnected] = useState(false); // estado REAL do socket (transmissão ao hub)
  const [whipState, setWhipState] = useState<WhipState>("idle"); // estado da publicação WebRTC (Fase 5)
  // Caminho de vídeo resolvido em runtime pelo probe: começa "probing" se vamos tentar WHIP,
  // senão já "jpeg" (escape hatch VITE_WEBCAM_WHIP=0). Só um dos pipelines roda (nunca os dois).
  const [transport, setTransport] = useState<Transport>(WHIP_ATTEMPT ? "probing" : "jpeg");
  const [error, setError] = useState("");
  const [profile, setProfile] = useState("");

  const idRef = useRef<string>("");
  if (!idRef.current) {
    const saved = sessionStorage.getItem("camId");
    idRef.current = saved || (crypto.randomUUID ? crypto.randomUUID() : `cam-${Date.now()}`);
    sessionStorage.setItem("camId", idRef.current);
  }
  const name =
    new URLSearchParams(location.search).get("name") || `Câmera ${idRef.current.slice(0, 4)}`;

  useEffect(() => {
    let alive = true;
    let timer: number | null = null;
    let rvfcHandle: number | null = null;
    let rvfcVideo: HTMLVideoElement | null = null; // elemento onde o rVFC foi registrado (p/ cancelar no cleanup)
    let audioCtx: AudioContext | null = null; // keep-alive de 2º plano (ver ensureKeepAlive)
    let onVisibility: (() => void) | null = null;
    let unlockAudio: (() => void) | null = null; // destrava o AudioContext no 1º gesto (autoplay policy)
    let whipPublisher: WhipPublisher | null = null; // publicação WebRTC/WHIP (Fase 5; null se OFF)

    (async () => {
      try {
        const stream = await acquireCameraStream(); // contexto seguro + escada de constraints + erros granulares
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        setStatus("on");
      } catch (e) {
        const kind = e instanceof CameraAcquireError ? e.kind : "error";
        setStatus(kind === "denied" ? "denied" : "error");
        setError(e instanceof Error ? e.message : "Falha na câmera.");
        return;
      }

      const socket = io(APP_CONFIG.net.serverUrl, {
        transports: ["websocket"],
        auth: { token: cameraToken() },
        query: { role: "camera", id: idRef.current, label: name },
      });
      socketRef.current = socket;
      // Status do nó reflete o socket REAL: só "transmitindo" quando conectado; senão "reconectando".
      socket.on("connect", () => setHubConnected(true));
      socket.on("disconnect", () => setHubConnected(false));
      socket.on("connect_error", (err) => {
        setHubConnected(false);
        if (err.message === "unauthorized") {
          setStatus("error");
          setError(
            "Dispositivo não autorizado. Abra pelo link de enrolamento (com a chave) ou faça login no painel.",
          );
        }
      });

      // ── Fase 5: PROBE de runtime — tenta WHIP; cai p/ JPEG sozinho se não estabelecer ──────────
      // Publica o vídeo direto ao go2rtc por RTCPeerConnection (não estrangula em 2º plano → some a
      // "câmera lenta ao minimizar"). O socket ACIMA segue vivo só como REGISTRO/controle (o hub
      // sabe que a câmera existe, status/camcfg). Nome do stream = id da câmera (contrato com o
      // consumidor `/api/ws?src=<id>` do dashboard). A decisão WHIP×JPEG é ASSÍNCRONA (o handshake
      // WebRTC leva tempo): o probe resolve `true` (WHIP estabeleceu → segue WebRTC, sem JPEG) ou
      // `false` (timeout / estado terminal negativo / go2rtc ausente → cai p/ o JPEG-socket abaixo).
      // Fallback AUTOMÁTICO, sem flag. NUNCA os dois pipelines juntos (só um instala captura/relé).
      const probeWhip = () =>
        new Promise<boolean>((resolve) => {
          let settled = false;
          let timer = 0;
          const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            if (!ok && whipPublisher) {
              whipPublisher.stop(); // encerra a tentativa (idempotente) antes de entregar ao JPEG
              whipPublisher = null;
            }
            resolve(ok);
          };
          // Backstop: sem "connected" até aqui → go2rtc indisponível/lento → cai p/ JPEG.
          timer = window.setTimeout(() => finish(false), WHIP_PROBE_TIMEOUT_MS);
          whipPublisher = publishWebcamWhip({
            stream: streamRef.current!,
            streamName: idRef.current,
            baseUrl: APP_CONFIG.go2rtc.baseUrl,
            maxBitrateKbps: APP_CONFIG.webcam.whip.maxBitrateKbps,
            maxFramerate: APP_CONFIG.webcam.whip.maxFramerate,
            onState: (s) => {
              if (!alive) return;
              setWhipState(s); // badge acompanha (no probe E depois, no reconnect do publisher)
              if (s === "connected") finish(true);
              // Estado terminal negativo ANTES de estabelecer (fetch erro/404/ICE) → fallback já.
              else if (s === "failed" || s === "closed" || s === "disconnected") finish(false);
            },
          });
        });

      if (WHIP_ATTEMPT && (await probeWhip())) {
        if (!alive) return; // desmontou durante o probe — cleanup já parou publisher/socket
        setTransport("webrtc");
        setProfile(`WebRTC · ${APP_CONFIG.webcam.whip.maxFramerate}fps`);
        return; // WebRTC vivo (o publisher reconecta sozinho) — NÃO instala o pipeline JPEG abaixo
      }
      if (!alive) return; // idem: não instala o JPEG num componente já desmontado
      setTransport("jpeg"); // escape hatch (=0) ou fallback do probe: segue no caminho legado

      // Perfil de captura — pode ser elevado pela central (modo leitura = alta resolução).
      let frameWidth: number = APP_CONFIG.net.frameWidth;
      let frameFps: number = APP_CONFIG.net.frameFps;
      let jpegQuality: number = APP_CONFIG.net.jpegQuality;

      let encoding = false; // descarta frame se o encode anterior ainda não terminou (evita backlog)
      // Contexto 2D hoisted (criado 1×): alpha:false — JPEG não tem alfa; canvas opaco evita
      // composição/limpeza de canal alfa a cada drawImage.
      let ctx: CanvasRenderingContext2D | null = null;
      const sendFrame = () => {
        const v = videoRef.current,
          c = canvasRef.current;
        if (!v || !c || v.readyState < 2 || !v.videoWidth || encoding) return;
        const w = frameWidth,
          h = Math.round((frameWidth * v.videoHeight) / v.videoWidth);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        ctx ??= c.getContext("2d", { alpha: false })!;
        ctx.drawImage(v, 0, 0, w, h);
        encoding = true;
        // JPEG BINÁRIO (não base64): ~⅓ menor e sem custo de string no transporte.
        c.toBlob(
          (blob) => {
            if (!blob) {
              encoding = false;
              return;
            }
            blob
              .arrayBuffer()
              .then((buf) => {
                // VOLATILE: o socket.io-client bufferiza emits enquanto offline (sendBuffer) e
                // despeja TUDO no reconnect — frames velhos não interessam; volatile descarta
                // quando o transporte não está pronto (semântica "último-vence" do vídeo).
                socket.volatile.emit("frame", { buf, w, h, ts: Date.now() });
              })
              .finally(() => {
                encoding = false;
              });
          },
          "image/jpeg",
          jpegQuality,
        );
      };
      // Captura alinhada a frames REAIS da câmera: requestVideoFrameCallback dispara só quando
      // o vídeo entrega um frame novo — webcam a 8fps em cena escura/estática deixa de ser
      // re-encodada 12×/s. O gate de fps alvo lê `frameFps` (mutável) a cada callback, então o
      // evento `capture` (presets de leitura E o shed a 2fps) muda a cadência sem re-registrar nada.
      // rVFC é one-shot: re-agendamos a cada callback. Honestidade: com a aba em segundo plano o
      // browser estrangula tanto rVFC quanto timers — o requisito operacional segue sendo aba
      // visível (limitação de plataforma, igual ao setInterval anterior).
      const video = videoRef.current!;
      const useRvfc = typeof video.requestVideoFrameCallback === "function"; // feature-detect 1×
      // Modo de captura: "rvfc" (aba VISÍVEL — alinhado a frames reais, eficiente) ou "timer"
      // (aba OCULTA/minimizada — o rVFC PARA em 2º plano; o timer segue enviando p/ a câmera não morrer).
      let mode: "rvfc" | "timer" = useRvfc ? "rvfc" : "timer";
      let lastSent = 0;
      const rvfcLoop = (now: DOMHighResTimeStamp) => {
        if (!alive || mode !== "rvfc") return; // deixa de re-armar quando trocamos p/ timer (2º plano)
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
      // ~5min) e PARAM o rVFC — a webcam "morre" ao minimizar. Uma aba que está TOCANDO ÁUDIO é
      // isenta desse estrangulamento; então mantemos um oscilador INAUDÍVEL (ganho ~0) tocando
      // enquanto a captura roda. Efeito: minimizar mantém a câmera online e perto da taxa normal.
      // Sem WebAudio (ou bloqueado): degrada p/ o timer estrangulado — câmera ~1fps, mas não morre.
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
      if (useRvfc) {
        rvfcVideo = video;
        rvfcHandle = video.requestVideoFrameCallback(rvfcLoop);
      } else startTimer(); // sem rVFC: timer é o único caminho

      // Inicia o keep-alive JÁ (não só ao minimizar): o AudioContext precisa estar RODANDO antes
      // de a aba ficar oculta — criá-lo no visibilitychange nasce suspenso (sem gesto) e não isenta.
      // Se a política de autoplay o deixar suspenso, destrava no 1º gesto do usuário na página.
      ensureKeepAlive();
      unlockAudio = () => ensureKeepAlive();
      window.addEventListener("pointerdown", unlockAudio);
      window.addEventListener("keydown", unlockAudio);

      // Alterna rVFC↔timer pela visibilidade e liga o keep-alive quando a aba/janela some de vista.
      onVisibility = () => {
        if (document.hidden) {
          ensureKeepAlive(); // isenta o timer do estrangulamento agressivo
          if (mode !== "timer") {
            mode = "timer";
            if (rvfcHandle !== null) {
              rvfcVideo?.cancelVideoFrameCallback(rvfcHandle);
              rvfcHandle = null;
            }
            startTimer(); // envia frames mesmo minimizada
          }
        } else if (useRvfc && mode !== "rvfc") {
          stopTimer(); // voltou a ficar visível: retoma o rVFC (mais eficiente/alinhado ao frame real)
          mode = "rvfc";
          lastSent = 0;
          rvfcVideo = video;
          rvfcHandle = video.requestVideoFrameCallback(rvfcLoop);
        }
      };
      document.addEventListener("visibilitychange", onVisibility);
      if (document.hidden) onVisibility(); // já abriu em 2º plano? entra em modo timer na hora

      // A central pode pedir um perfil de captura (ex.: leitura de código → alta resolução).
      socket.on("capture", (cfg: { width?: number; quality?: number; fps?: number }) => {
        if (cfg?.width) frameWidth = cfg.width;
        if (cfg?.quality) jpegQuality = cfg.quality;
        if (cfg?.fps && cfg.fps !== frameFps) {
          frameFps = cfg.fps;
          if (mode === "timer") startTimer(); // rVFC lê frameFps a cada callback; no timer, re-cria com o novo fps
        }
        setProfile(`${frameWidth}px · q${Math.round(jpegQuality * 100)}`);
      });
    })();

    return () => {
      alive = false;
      if (onVisibility) document.removeEventListener("visibilitychange", onVisibility);
      if (unlockAudio) {
        window.removeEventListener("pointerdown", unlockAudio);
        window.removeEventListener("keydown", unlockAudio);
      }
      if (timer) clearInterval(timer);
      if (rvfcHandle !== null) rvfcVideo?.cancelVideoFrameCallback(rvfcHandle);
      audioCtx?.close().catch(() => {});
      whipPublisher?.stop(); // encerra a publicação WebRTC (no-op se OFF)
      socketRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [name]);

  // "Transmitindo": no caminho WebRTC/WHIP o vídeo vai pela conexão WebRTC, então depende dela (e do
  // socket, que registra a câmera no hub); no caminho JPEG-socket depende só do socket. Enquanto o
  // probe ainda decide ("probing"), nada transmite (nenhum pipeline instalado ainda).
  const transmitting =
    transport === "webrtc"
      ? hubConnected && whipState === "connected"
      : transport === "jpeg"
        ? hubConnected
        : false;
  // Texto do badge — reflete o caminho de vídeo ATIVO resolvido em runtime pelo probe.
  const statusLabel =
    status === "connecting"
      ? "conectando…"
      : status === "denied"
        ? "câmera negada"
        : status === "error"
          ? "erro"
          : transport === "probing"
            ? "câmera ok · testando WebRTC…"
            : transport === "webrtc"
              ? transmitting
                ? "transmitindo ao hub (WebRTC)"
                : "câmera ok · conectando vídeo (WebRTC)…"
              : transmitting
                ? "transmitindo ao hub"
                : "câmera ok · reconectando ao hub…";
  return (
    <div className="cam-node">
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} className="hidden" />
      <div className="cam-node-badge">
        <span
          className={`dot-status ${status === "on" ? (transmitting ? "on" : "connecting") : status}`}
        />
        <b>{name}</b>
        <span className="muted">{statusLabel}</span>
        {profile && (
          <Tooltip content="Perfil de captura definido pela central">
            <span className="muted">· {profile}</span>
          </Tooltip>
        )}
      </div>
      <div className="cam-node-hint">Nó de câmera · processamento e controles ficam na central</div>
      {!isSecureCameraContext() && (
        <div className="cam-node-err">
          Sem HTTPS: a câmera pode ser bloqueada fora de localhost. Use HTTPS para acesso externo.
        </div>
      )}
      {error && <div className="cam-node-err">{error}</div>}
    </div>
  );
}
