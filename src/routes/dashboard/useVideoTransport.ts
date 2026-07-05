// Transporte de vídeo no painel (extraído do god-component DashboardPage — auditoria §S1/§S2).
// Encapsula o "smell do tick": a descoberta periódica dos streams do go2rtc, os cooldowns de falha
// de WebRTC (webrtcFailRef) e o contador que força o re-render de transportOf na TRANSIÇÃO
// (entrar/expirar cooldown). A decisão em si é PURA e testada em transport.ts. Comportamento
// byte-a-byte do original.
import { useCallback, useEffect, useRef, useState } from "react";
import { APP_CONFIG } from "../../config";
import { type CameraCfg } from "../../cameraConfig";
import { transportOf as resolveTransport } from "./transport";

// Auto-fallback WebRTC→MJPEG (transportOf): quando um tile/full REPORTA que o <video-stream> não
// estabeleceu vídeo, a câmera fica em cooldown no relé MJPEG por este período. Ao expirar, transportOf
// volta a TENTAR WebRTC (a fonte pode ter voltado); se falhar de novo, re-marca — retry periódico, sem
// flicker rápido. Curto o bastante p/ recuperar cedo; longo p/ não piscar.
const WEBRTC_FAIL_COOLDOWN_MS = 30_000;

export type VideoTransport = {
  transportOf: (id: string) => "mjpeg" | "webrtc";
  handleWebrtcFail: (cameraId: string) => void;
};

export function useVideoTransport(cfgOf: (id: string) => CameraCfg): VideoTransport {
  // ── Onda 2 (simplificação de config): STREAMS que o go2rtc conhece agora ──
  // Alimenta o transporte "auto" (melhor disponível): um id neste Set = o go2rtc serve a câmera →
  // "auto" resolve WebRTC; ausente / Set vazio (go2rtc fora) → "auto" resolve MJPEG.
  const [go2rtcStreams, setGo2rtcStreams] = useState<Set<string>>(() => new Set());
  // ── Auto-fallback WebRTC→MJPEG: cooldowns de FALHA de WebRTC por câmera ──
  // O bug: `transportOf` resolve WebRTC quando o go2rtc REGISTRA o stream — não quando ele tem
  // FRAMES. Fonte caída → stream órfão → o <video-stream> quebra. Quando um tile/full reporta a
  // falha (handleWebrtcFail), guardamos aqui id → TIMESTAMP DE EXPIRAÇÃO (ms). Ref (não state) p/
  // não re-render por escrita; o re-render vem do tick abaixo, que só bumpa na TRANSIÇÃO.
  const webrtcFailRef = useRef<Map<string, number>>(new Map());
  // Contador que força o re-render de `transportOf` quando um cooldown entra/expira (ver acima).
  const [, setWebrtcFailTick] = useState(0);

  // ── Descoberta de streams do go2rtc (transporte "auto") ──
  // GET /go2rtc/api/streams (proxy same-origin) → objeto { <id>: {...} }; as CHAVES são os ids que
  // o gateway serve. Refresca no mount + a cada 5s. Se a chamada FALHAR (go2rtc desligado/subindo,
  // timeout, 502 do proxy) → Set VAZIO → todo "auto" cai para MJPEG. Sem flag: go2rtc no ar +
  // câmera conhecida = WebRTC automático.
  useEffect(() => {
    let alive = true;
    const url = `${APP_CONFIG.go2rtc.baseUrl}/api/streams`;
    async function refresh() {
      let ids: string[] = [];
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (res.ok) {
          const data: unknown = await res.json();
          if (data && typeof data === "object")
            ids = Object.keys(data as Record<string, unknown>);
        }
      } catch {
        ids = []; // go2rtc fora/subindo → sem streams → "auto" resolve MJPEG (fallback automático)
      }
      if (!alive) return;
      setGo2rtcStreams((prev) => {
        // Só re-renderiza se o conjunto mudou (evita re-render a cada 5s sem motivo).
        if (prev.size === ids.length && ids.every((id) => prev.has(id))) return prev;
        return new Set(ids);
      });
      // Expira cooldowns de falha de WebRTC vencidos (auto-fallback). Ao remover, força re-render:
      // transportOf re-resolve e a câmera TORNA A TENTAR WebRTC (a fonte pode ter voltado). Se
      // falhar de novo, o tile re-reporta e re-entra em cooldown — retry periódico, sem flicker.
      const now = Date.now();
      let anyExpired = false;
      for (const [cid, until] of webrtcFailRef.current) {
        if (until <= now) {
          webrtcFailRef.current.delete(cid);
          anyExpired = true;
        }
      }
      if (anyExpired) setWebrtcFailTick((n) => n + 1);
    }
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Transporte de VÍDEO NO PAINEL por câmera → decide o render do CameraTile. A decisão é pura
  // (transport.ts); aqui só injetamos o estado ao vivo (preferência do camcfg, streams, cooldowns).
  const transportOf = useCallback(
    (id: string): "mjpeg" | "webrtc" =>
      resolveTransport(cfgOf(id).transport, id, go2rtcStreams, webrtcFailRef.current, Date.now()),
    [cfgOf, go2rtcStreams],
  );

  // Auto-fallback WebRTC→MJPEG (CONTRATO com CameraTile/CameraWorkspace): a câmera aberta ou um
  // tile chama isto quando o <video-stream> não estabelece vídeo (sem videoWidth em ~7s) ou erra.
  // Marca a câmera em cooldown (agora + COOLDOWN) e força re-render → transportOf re-resolve p/
  // MJPEG só naquela câmera. Identidade estável (useCallback []): não quebra o React.memo do tile.
  const handleWebrtcFail = useCallback((cameraId: string) => {
    const now = Date.now();
    const prevUntil = webrtcFailRef.current.get(cameraId);
    webrtcFailRef.current.set(cameraId, now + WEBRTC_FAIL_COOLDOWN_MS);
    // Só re-renderiza na TRANSIÇÃO p/ cooldown (câmera ainda não estava em MJPEG por falha). Um
    // re-report enquanto já em cooldown apenas ESTENDE o prazo, sem re-render — evita flood.
    if (prevUntil == null || prevUntil <= now) setWebrtcFailTick((n) => n + 1);
  }, []);

  return { transportOf, handleWebrtcFail };
}
