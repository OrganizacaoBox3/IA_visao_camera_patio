import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { APP_CONFIG } from "../config";
import { acquireCameraStream, isSecureCameraContext, CameraAcquireError } from "../camera/acquire";
import { Tooltip } from "../ui";

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

      // Perfil de captura — pode ser elevado pela central (modo leitura = alta resolução).
      let frameWidth: number = APP_CONFIG.net.frameWidth;
      let frameFps: number = APP_CONFIG.net.frameFps;
      let jpegQuality: number = APP_CONFIG.net.jpegQuality;

      let encoding = false; // descarta frame se o encode anterior ainda não terminou (evita backlog)
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
        const ctx = c.getContext("2d")!;
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
      const startTimer = () => {
        if (timer) clearInterval(timer);
        timer = window.setInterval(sendFrame, Math.round(1000 / frameFps));
      };
      startTimer();

      // A central pode pedir um perfil de captura (ex.: leitura de código → alta resolução).
      socket.on("capture", (cfg: { width?: number; quality?: number; fps?: number }) => {
        if (cfg?.width) frameWidth = cfg.width;
        if (cfg?.quality) jpegQuality = cfg.quality;
        if (cfg?.fps && cfg.fps !== frameFps) {
          frameFps = cfg.fps;
          startTimer();
        }
        setProfile(`${frameWidth}px · q${Math.round(jpegQuality * 100)}`);
      });
    })();

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      socketRef.current?.disconnect();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [name]);

  return (
    <div className="cam-node">
      <video ref={videoRef} playsInline muted />
      <canvas ref={canvasRef} style={{ display: "none" }} />
      <div className="cam-node-badge">
        <span
          className={`dot-status ${status === "on" ? (hubConnected ? "on" : "connecting") : status}`}
        />
        <b>{name}</b>
        <span className="muted">
          {status === "on"
            ? hubConnected
              ? "transmitindo ao hub"
              : "câmera ok · reconectando ao hub…"
            : status === "connecting"
              ? "conectando…"
              : status === "denied"
                ? "câmera negada"
                : "erro"}
        </span>
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
