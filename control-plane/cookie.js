// Cookie de sessão do técnico — helpers PUROS (sem rede/banco), testáveis offline, no molde de
// dvr.js/sitekey.js. Contexto (contratos §6b / C-be-7):
//
//   O portal autentica por Bearer (sessionStorage) HOJE. Mas o /_dvr_auth (C-be-6) é chamado pelo
//   nginx num SUBDOMÍNIO ≠ origem do portal (cliente-x.dvr.box3.software), então Bearer/sessionStorage
//   NÃO viaja para lá. A ponte é um COOKIE de sessão escopado ao DOMÍNIO PAI `.box3.software`, que o
//   subdomínio *.dvr.box3.software recebe. Reusamos o MESMO token/verifyToken (auth.js) — só
//   ADICIONAMOS o cookie no login; nada de nova credencial.
//
// Config de DOMÍNIO (documente no deploy):
//   • CP_COOKIE_DOMAIN   — domínio do cookie. Default `.box3.software` (o ponto inicial faz valer p/
//                          TODOS os subdomínios irmãos: coletor.box3.software E *.dvr.box3.software).
//                          Em dev/local (localhost) defina CP_COOKIE_DOMAIN= (vazio) → cookie host-only
//                          (o browser rejeita Domain=.box3.software fora desse domínio). O login segue
//                          devolvendo o token no corpo, então o portal local continua funcionando.
//   • CP_COOKIE_SECURE   — "false" desliga o atributo Secure (só p/ dev http). Default: Secure ligado.
//   • CP_COOKIE_SAMESITE — default "Lax" (a navegação do portal → URL do DVR é top-level GET; Lax deixa
//                          o cookie ir, e por serem o MESMO site registrável box3.software nem é cross-site).
//   • CP_COOKIE_NOME     — nome do cookie. Default "cp_session".

const NOME_COOKIE = process.env.CP_COOKIE_NOME || "cp_session";

// Parse do header Cookie ("a=1; b=2") → { a:"1", b:"2" }. Primeiro valor vence (defensivo).
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const parte of String(header).split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    const k = parte.slice(0, i).trim();
    if (!k || k in out) continue;
    out[k] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

// Lê o token da sessão do técnico no cookie do request (o /_dvr_auth usa isto).
function tokenDoCookie(req, nome = NOME_COOKIE) {
  const c = parseCookies(req && req.headers ? req.headers["cookie"] : "");
  return c[nome] || "";
}

// Monta o valor de Set-Cookie da sessão. opts sobrepõe as envs (usado nos testes p/ determinismo).
function montarSetCookie(token, opts = {}) {
  const nome = opts.nome || NOME_COOKIE;
  const dominio = opts.dominio !== undefined ? opts.dominio : (process.env.CP_COOKIE_DOMAIN ?? ".box3.software");
  const maxAgeMs = opts.maxAgeMs != null ? opts.maxAgeMs : Number(process.env.CP_AUTH_TTL_MS ?? 7 * 24 * 3600 * 1000);
  const secure = opts.secure !== undefined ? opts.secure : process.env.CP_COOKIE_SECURE !== "false";
  const sameSite = opts.sameSite || process.env.CP_COOKIE_SAMESITE || "Lax";
  const partes = [`${nome}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", `SameSite=${sameSite}`];
  if (dominio) partes.push(`Domain=${dominio}`);
  if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) partes.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (secure) partes.push("Secure");
  return partes.join("; ");
}

module.exports = { NOME_COOKIE, parseCookies, tokenDoCookie, montarSetCookie };
