import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../config";
import { acquireCameraStream, isSecureCameraContext, CameraAcquireError } from "../camera/acquire";
import { publishWebcamWhip, type WhipPublisher, type WhipState } from "../camera/whip";
import { startNodeRelay, type NodeRelay } from "./camera/nodeRelay";
import { Tooltip, Alert } from "../ui";

// O nó transmite vídeo por WebRTC/WHIP ao go2rtc quando disponível; a decisão é em RUNTIME por
// PROBE. Se o WHIP não estabelecer dentro da janela (go2rtc ausente/timeout/erro), CAI SOZINHO
// p/ o relé JPEG-socket (nodeRelay) — fallback automático, sem flag. VITE_WEBCAM_WHIP=0 é o
// único escape hatch (força JPEG, sem probe).
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
  const [whipState, setWhipState] = useState<WhipState>("idle"); // estado da publicação WebRTC/WHIP
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
    let relay: NodeRelay | null = null; // relé JPEG (nodeRelay.ts; null enquanto WHIP/probe)
    let whipPublisher: WhipPublisher | null = null; // publicação WebRTC/WHIP (null se OFF)

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

      // ── PROBE de runtime — tenta WHIP; cai p/ JPEG sozinho se não estabelecer ──────────────────
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

      // Relé JPEG (hot-path do nó): captura+encode+keep-alive vivem em ./camera/nodeRelay.ts.
      relay = startNodeRelay({
        video: videoRef.current!,
        canvas: canvasRef.current!,
        // Perfil de captura — pode ser elevado pela central (modo leitura = alta resolução).
        profile: {
          width: APP_CONFIG.net.frameWidth,
          fps: APP_CONFIG.net.frameFps,
          quality: APP_CONFIG.net.jpegQuality,
        },
        // VOLATILE: o socket.io-client bufferiza emits enquanto offline (sendBuffer) e despeja
        // TUDO no reconnect — frames velhos não interessam; volatile descarta quando o transporte
        // não está pronto (semântica "último-vence" do vídeo).
        send: (frame) => socket.volatile.emit("frame", frame),
      });

      // A central pode pedir um perfil de captura (ex.: leitura de código → alta resolução).
      socket.on("capture", (cfg: { width?: number; quality?: number; fps?: number }) => {
        const p = relay?.setProfile(cfg ?? {});
        if (p) setProfile(`${p.width}px · q${Math.round(p.quality * 100)}`);
      });
    })();

    return () => {
      alive = false;
      relay?.stop(); // encerra captura/keep-alive do relé JPEG (no-op no caminho WebRTC)
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
      {error && <Alert tone="alert">{error}</Alert>}
    </div>
  );
}
