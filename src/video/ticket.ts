// Passe de vídeo p/ o proxy /go2rtc/* (fecha o buraco "vídeo servido SEM auth" — item #66).
//
// O hub passou a EXIGIR um ticket HMAC de curta duração (?ticket=) em TODO /go2rtc/* (streams, WS de
// sinalização, WHIP). Este helper OBTÉM o ticket em GET /api/video-ticket (autenticado por Bearer) e
// o CACHEIA por `src`, renovando ANTES de expirar. O front injeta o ticket nas URLs de vídeo.
//
// GERAL vs ESPECÍFICO: sem `src` = ticket GERAL (serve /api/streams e — por colisão do param `src`
// do go2rtc no WHIP — o publish do nó de câmera). Com `src` = ticket ESPECÍFICO daquele stream (o WS
// /api/ws?src=<camId> do dashboard, onde `src` é de fato a câmera).
import { APP_CONFIG } from "../config";

type Cached = { token: string; exp: number };
// Renova este tanto ANTES do exp (o TTL do servidor é ~120s; a margem cobre latência + clock skew).
const REFRESH_MARGIN_MS = 20_000;
const cache = new Map<string, Cached>();

// Token de sessão do usuário logado (mesmo esquema do api.ts). O nó de câmera passa o SEU token
// (cameraToken) explicitamente — por isso é override, não fonte única.
function sessionToken(): string | null {
  try {
    return JSON.parse(localStorage.getItem("vp-auth") || "null")?.token ?? null;
  } catch {
    return null;
  }
}

// Lê o `exp` do payload (base64url, NÃO é segredo — só assinado) p/ saber quando renovar.
function ticketExp(token: string): number {
  try {
    const body = token.split(".")[0];
    const b64 = body.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const json = JSON.parse(atob(b64 + pad)) as { exp?: number };
    return typeof json.exp === "number" ? json.exp : 0;
  } catch {
    return 0;
  }
}

/**
 * Obtém (com cache/renovação) um ticket de vídeo. Lança se a rede/hub falhar OU o usuário não
 * estiver autenticado (401) — o chamador trata caindo p/ MJPEG (mesmo comportamento de go2rtc fora).
 * @param src id da câmera p/ ticket ESPECÍFICO; ausente = ticket GERAL.
 * @param authToken override do Bearer (o nó de câmera usa o cameraToken); default = sessão do usuário.
 */
export async function getVideoTicket(src?: string, authToken?: string | null): Promise<string> {
  const key = src ?? "";
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp - REFRESH_MARGIN_MS > now) return hit.token;

  const auth = authToken ?? sessionToken();
  const qs = src ? `?src=${encodeURIComponent(src)}` : "";
  const res = await fetch(`${APP_CONFIG.net.serverUrl}/api/video-ticket${qs}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`video-ticket ${res.status}`);
  const data = (await res.json()) as { ticket?: string };
  const token = String(data.ticket || "");
  if (!token) throw new Error("video-ticket vazio");
  cache.set(key, { token, exp: ticketExp(token) || now + 60_000 });
  return token;
}
