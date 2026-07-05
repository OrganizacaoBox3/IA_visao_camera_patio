// Publisher WHIP (WebRTC-HTTP Ingestion Protocol) do nó de webcam → go2rtc (Fase 5 do retrofit).
//
// POR QUÊ: o navegador NÃO estrangula uma conexão WebRTC em 2º plano (aba minimizada/oculta),
// diferente de rVFC/timers/canvas — que o Chrome/Edge estrangulam agressivamente. Publicar o vídeo
// por WHIP mata a "câmera lenta ao minimizar" sem o hack do oscilador de áudio inaudível.
//
// FLUXO (validado contra go2rtc 1.9.14):
//   1. GARANTE o stream nomeado no go2rtc (id da câmera). O publish exige o stream declarado:
//      `POST /api/webrtc?dst=<name>` num stream inexistente → 404. Criamos dinamicamente via
//      `PUT /api/streams?name=<name>&src=webrtc:` (produtor-placeholder inerte; some quando o
//      produtor WHIP real conecta — inofensivo). Idempotente: re-PUT no reconnect.
//   2. RTCPeerConnection com o track de vídeo (sendonly, bitrate/fps limitados), cria offer,
//      espera ICE gathering completar (offer NÃO-trickle: o go2rtc devolve a answer com TODAS as
//      candidates dele).
//   3. `POST /api/webrtc?dst=<name>` com `Content-Type: application/sdp`, corpo = SDP offer cru →
//      `201 Created`, corpo = SDP answer cru. Aplica como remoteDescription.
//   4. Monitora connectionState; reconnect com backoff em failed/disconnected/closed.
//
// MÍDIA (SRTP/ICE/DTLS) vai DIRETO à porta WebRTC do go2rtc (:8555 por default), fora do proxy —
// em LAN o go2rtc oferece candidates host alcançáveis (o mesmo caminho do consumidor da Fase 1).
// A SINALIZAÇÃO (este HTTP) é same-origin sob `${baseUrl}` (proxy → :1984), CSP intacto.
//
// LGPD/ADR-002: só relé/remux — sem gravação. O MediaStream é o mesmo já efêmero da webcam.

export type WhipState = RTCPeerConnectionState | "idle";

export interface WhipPublisher {
  /** Encerra a publicação: fecha o PC e (best-effort) remove o stream do go2rtc. Idempotente. */
  stop(): void;
}

export interface WhipOptions {
  /** MediaStream da webcam (getUserMedia). Usamos o 1º track de vídeo. */
  stream: MediaStream;
  /** Nome do stream publicado = id da câmera (contrato com o consumidor `/api/ws?src=<id>`). */
  streamName: string;
  /** Base do go2rtc (APP_CONFIG.go2rtc.baseUrl), ex.: "/go2rtc" (same-origin) ou "http://host:1984". */
  baseUrl: string;
  /** Teto de banda do encoder (kbps). Default 1500. */
  maxBitrateKbps?: number;
  /** Teto de fps do encoder. Default 15. */
  maxFramerate?: number;
  /** ICE servers (STUN/TURN). Vazio por default — em LAN não é preciso (go2rtc dá candidates host). */
  iceServers?: RTCIceServer[];
  /** Callback de estado da conexão (para status/badge na UI). */
  onState?: (state: WhipState) => void;
}

const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 15000;

/**
 * Inicia a publicação WHIP do track de vídeo ao go2rtc. Retorna um handle com `stop()`.
 * Reconecta sozinho (backoff) enquanto não for parado — cobre restart do go2rtc / queda de rede.
 */
export function publishWebcamWhip(opts: WhipOptions): WhipPublisher {
  const {
    stream,
    streamName,
    baseUrl,
    maxBitrateKbps = 1500,
    maxFramerate = 15,
    iceServers = [],
    onState,
  } = opts;

  const base = baseUrl.replace(/\/+$/, ""); // sem barra final
  const enc = encodeURIComponent(streamName);
  let pc: RTCPeerConnection | null = null;
  let stopped = false;
  let attempt = 0;
  let reconnectTimer: number | null = null;

  const setState = (s: WhipState) => {
    if (!stopped) onState?.(s);
  };

  /** Garante o stream declarado no go2rtc (dinâmico, idempotente). Não lança. */
  async function ensureStream(): Promise<void> {
    try {
      // src=webrtc: é um produtor-placeholder aceito pelo go2rtc (New()) e inerte até o WHIP entrar.
      await fetch(`${base}/api/streams?name=${enc}&src=webrtc:`, { method: "PUT" });
    } catch {
      // Stream pode já existir (declarado no yaml) ou o go2rtc estar reiniciando — segue p/ o WHIP,
      // que retorna 404 se o stream faltar e cai no reconnect.
    }
  }

  /** Espera o ICE gathering terminar (offer não-trickle) — com teto p/ não travar. */
  function waitIceGathering(peer: RTCPeerConnection): Promise<void> {
    return new Promise((resolve) => {
      if (peer.iceGatheringState === "complete") return resolve();
      const done = () => {
        if (peer.iceGatheringState === "complete") {
          peer.removeEventListener("icegatheringstatechange", done);
          window.clearTimeout(timer);
          resolve();
        }
      };
      const timer = window.setTimeout(() => {
        peer.removeEventListener("icegatheringstatechange", done);
        resolve();
      }, 3000);
      peer.addEventListener("icegatheringstatechange", done);
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
    attempt++;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function connect(): Promise<void> {
    if (stopped) return;
    const track = stream.getVideoTracks()[0];
    if (!track) {
      setState("idle");
      return; // sem vídeo não há o que publicar
    }

    // Baixa resolução/fps na fonte (best-effort) p/ conter banda; ignora se o device recusar.
    try {
      await track.applyConstraints({
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: maxFramerate, max: maxFramerate },
      });
    } catch {
      /* device sem suporte à constraint — segue com o que veio */
    }

    await ensureStream();
    if (stopped) return;

    const peer = new RTCPeerConnection({ iceServers });
    pc = peer;

    peer.addTransceiver(track, {
      direction: "sendonly",
      sendEncodings: [
        {
          maxBitrate: maxBitrateKbps * 1000, // kbps → bps
          maxFramerate,
        },
      ],
    });

    peer.addEventListener("connectionstatechange", () => {
      if (peer !== pc) return; // PC antigo (já substituído por um reconnect) — ignora
      const s = peer.connectionState;
      setState(s);
      if (s === "failed" || s === "disconnected" || s === "closed") {
        try {
          peer.close();
        } catch {
          /* já fechado */
        }
        if (peer === pc) pc = null;
        scheduleReconnect();
      } else if (s === "connected") {
        attempt = 0; // conexão boa → zera o backoff
      }
    });

    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitIceGathering(peer);
      if (stopped || peer !== pc) return;

      const resp = await fetch(`${base}/api/webrtc?dst=${enc}`, {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: peer.localDescription?.sdp ?? offer.sdp ?? "",
      });
      if (!resp.ok) throw new Error(`WHIP ${resp.status}`);
      const answerSdp = await resp.text();
      if (stopped || peer !== pc) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      // A partir daqui o connectionstatechange conduz (connected/failed → reconnect).
    } catch {
      // Handshake falhou (go2rtc reiniciando, 404 de stream, rede) → fecha e reconecta.
      try {
        peer.close();
      } catch {
        /* noop */
      }
      if (peer === pc) pc = null;
      scheduleReconnect();
    }
  }

  setState("connecting");
  void connect();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (pc) {
        try {
          pc.close();
        } catch {
          /* já fechado */
        }
        pc = null;
      }
      // Limpeza best-effort do stream dinâmico no go2rtc (não bloqueia; ignora erro).
      try {
        void fetch(`${base}/api/streams?src=${enc}`, { method: "DELETE" });
      } catch {
        /* go2rtc pode estar fora — sem problema */
      }
      setState("idle");
    },
  };
}
