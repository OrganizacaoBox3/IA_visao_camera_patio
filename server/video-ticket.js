// Ticket HMAC de curta duração p/ o proxy /go2rtc/* (fecha o buraco "vídeo servido SEM auth").
//
// PROBLEMA: o reverse-proxy /go2rtc/* (server/go2rtc.js) encaminha p/ 127.0.0.1:1984 SEM nenhuma
// verificação — qualquer um que alcança o hub vê o vídeo ao vivo de TODAS as câmeras (contido só
// pela LAN). Este módulo emite/valida um TICKET assinado que o proxy passa a EXIGIR.
//
// ESQUEMA (o MESMO do token de sessão em server/users.js — não inventamos cripto nova):
//   token = base64url(JSON.stringify(payload)) + "." + hmacSHA256(body, AUTH_SECRET) em base64url
//   payload = { src?: string, exp: number }   // exp = epoch-ms
// A verificação é timing-safe (crypto.timingSafeEqual) e checa expiração. Um ticket COM `src` só
// vale p/ aquele stream; um ticket SEM `src` (GERAL) vale p/ paths sem stream (ex.: /api/streams).
//
// PONTO CEGO honesto: como QUALQUER usuário autenticado obtém um ticket (o gate fino por câmera/
// escopo é a fase do túnel), o `src` aqui é HIGIENE de binding, não fronteira de autorização entre
// usuários. O que este tijolo fecha é o "sem token nenhum".
const crypto = require("node:crypto");

// MESMO AUTH_SECRET do server/users.js (resolvido igual: env com o mesmo default inseguro de dev).
// A guarda de boot de users.js (bootAbort) já recusa o default em produção — o ticket herda essa
// proteção porque compartilha o segredo.
const DEFAULT_AUTH_SECRET = "dev-inseguro-troque-AUTH_SECRET-em-producao";
const AUTH_SECRET = process.env.AUTH_SECRET || DEFAULT_AUTH_SECRET;
// TTL curto por default: o front renova antes de expirar (o ticket não é sessão, é passe de vídeo).
const DEFAULT_TTL_MS = Number(process.env.VIDEO_TICKET_TTL_MS ?? 120_000);

function hmac(body) {
  return crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
}

/**
 * Assina um ticket de vídeo. `src` ausente/vazio ⇒ ticket GERAL (paths sem stream, ex. /api/streams).
 * @param {{ src?: string, ttlMs?: number }} [opts]
 * @returns {string} token `base64url(payload).hmac`
 */
function signTicket({ src, ttlMs } = {}) {
  const ttl = Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : DEFAULT_TTL_MS;
  const payload = { exp: Date.now() + ttl };
  if (src != null && String(src) !== "") payload.src = String(src);
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}

/**
 * Verifica um ticket. Confere assinatura (timing-safe) + expiração; se o payload TEM `src`, EXIGE
 * `src === wantSrc`. Ticket geral (sem `src` no payload) passa p/ qualquer `wantSrc`.
 * @param {string} token
 * @param {string} [wantSrc] o ?src= do request (ausente/"" p/ paths sem stream)
 * @returns {{ src?: string, exp: number } | null} payload se válido, senão null
 */
function verifyTicket(token, wantSrc) {
  try {
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expect = hmac(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p || typeof p.exp !== "number" || p.exp < Date.now()) return null;
    // Ticket com src é ESPECÍFICO: só abre aquele stream (e não abre paths sem src).
    if (p.src != null && String(p.src) !== String(wantSrc ?? "")) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * Gate PURO do proxy: extrai `ticket`/`src` da URL (crua, ex. "/api/ws?src=cam1&ticket=..") e
 * valida. Retorna o payload (válido) ou null (ausente/adulterado/expirado/src errado).
 * @param {string} rawUrl req.url já SEM o prefixo /go2rtc (ou com — parseamos só a query)
 * @returns {{ src?: string, exp: number } | null}
 */
function verifyRequestUrl(rawUrl) {
  let q;
  try {
    q = new URL(String(rawUrl), "http://localhost").searchParams;
  } catch {
    return null;
  }
  const ticket = q.get("ticket") || "";
  if (!ticket) return null;
  return verifyTicket(ticket, q.get("src") ?? undefined);
}

module.exports = { signTicket, verifyTicket, verifyRequestUrl, DEFAULT_TTL_MS };
