// Auth do CONTROL-PLANE: token HMAC (mesmo esquema de server/users.js) + canAccess PURO
// (o RBAC-com-escopo, spec §3). SEM banco aqui — signToken/verifyToken são cripto pura e
// canAccess é uma função de árvore pura (a árvore entra por argumento). Testável 100% offline.
const crypto = require("node:crypto");

// Segredo com prefixo CP_ (não colide com o AUTH_SECRET do hub). Default INSEGURO só p/ dev.
const DEFAULT_AUTH_SECRET = "dev-inseguro-troque-CP_AUTH_SECRET-em-producao";
const AUTH_SECRET = process.env.CP_AUTH_SECRET || DEFAULT_AUTH_SECRET;
const TOKEN_TTL_MS = Number(process.env.CP_AUTH_TTL_MS ?? 7 * 24 * 3600 * 1000);

// Os 4 escopos (spec §3). platform = topo (scope_id NULL/irrelevante → vê tudo).
const SCOPE_TYPES = ["platform", "partner", "cliente", "site"];

// ── token HMAC (molde de users.js:44-65, payload GANHA escopo) ────────────────
// payload: { id, papel, scope_type, scope_id, exp }. Assinatura HMAC-SHA256 sobre o
// corpo base64url. verifyToken NÃO consulta banco (diferente do hub): valida
// assinatura + exp e devolve os claims — o canAccess de cada handler faz o resto.
function signToken(claims, ttlMs = TOKEN_TTL_MS) {
  const payload = {
    id: claims.id,
    papel: claims.papel,
    scope_type: claims.scope_type,
    scope_id: claims.scope_id ?? null,
    exp: Date.now() + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verifyToken(token) {
  try {
    const [body, sig] = String(token).split(".");
    if (!body || !sig) return null;
    const expect = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p.exp || p.exp < Date.now()) return null;
    if (!SCOPE_TYPES.includes(p.scope_type)) return null;
    return { id: p.id, papel: p.papel, scope_type: p.scope_type, scope_id: p.scope_id ?? null, exp: p.exp };
  } catch {
    return null;
  }
}

// ── canAccess — o RBAC-com-escopo, PURO (spec §3) ─────────────────────────────
// A árvore (partner→cliente→site) entra por argumento — nada de banco. Forma:
//   tree = {
//     partner: { [partnerId]: true },
//     cliente: { [clienteId]: { partnerId } },
//     site:    { [siteId]:    { clienteId, partnerId } },
//   }
// `resource` = { type: 'partner'|'cliente'|'site', id }.
//
// Regra (spec §3): acesso concedido SSE o recurso está na SUBÁRVORE do escopo do token.
// Equivale a: o nó do escopo é ANCESTRAL-OU-O-PRÓPRIO do recurso. Resolvemos a cadeia de
// ancestrais do recurso e checamos se (scope_type, scope_id) está nela. platform → tudo.

// cadeia [recurso, ...ancestrais até o partner]. Recurso desconhecido → cadeia vazia
// (fail-closed p/ escopos: nada casa → negado).
function ancestorsOf(tree, resource) {
  const chain = [];
  if (!resource || !resource.type || resource.id == null) return chain;
  const t = tree || {};
  if (resource.type === "site") {
    const s = t.site && t.site[resource.id];
    if (!s) return chain;
    chain.push({ type: "site", id: resource.id });
    if (s.clienteId != null) chain.push({ type: "cliente", id: s.clienteId });
    if (s.partnerId != null) chain.push({ type: "partner", id: s.partnerId });
  } else if (resource.type === "cliente") {
    const c = t.cliente && t.cliente[resource.id];
    if (!c) return chain;
    chain.push({ type: "cliente", id: resource.id });
    if (c.partnerId != null) chain.push({ type: "partner", id: c.partnerId });
  } else if (resource.type === "partner") {
    if (!(t.partner && t.partner[resource.id])) return chain;
    chain.push({ type: "partner", id: resource.id });
  }
  return chain;
}

function canAccess(claims, resource, tree) {
  if (!claims || !claims.scope_type) return false;
  // platform: o dono do portal vê tudo (spec §3, tabela).
  if (claims.scope_type === "platform") return true;
  if (claims.scope_id == null) return false; // escopo não-platform SEM alvo → nada
  const chain = ancestorsOf(tree, resource);
  return chain.some((n) => n.type === claims.scope_type && String(n.id) === String(claims.scope_id));
}

module.exports = {
  signToken,
  verifyToken,
  canAccess,
  ancestorsOf,
  SCOPE_TYPES,
  DEFAULT_AUTH_SECRET,
};
