// Helpers HTTP de resposta e autenticação/RBAC do hub. CONTRATO: passadas aos grupos de
// rotas via `ctx` (json/requireAuth/requireSuper/requireConfigurer) — a forma do ctx não
// muda. `readBody` fica no index.js (é parte do servidor HTTP, não da auth).
const users = require("./users");

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function bearer(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// devolve o usuário autenticado (qualquer papel), ou responde 401 e devolve null
function requireAuth(req, res) {
  const u = users.verifyToken(bearer(req));
  if (!u) {
    json(res, 401, { error: "não autenticado" });
    return null;
  }
  return u;
}

// devolve o superadmin autenticado, ou responde 401/403 e devolve null
function requireSuper(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (u.papel !== "superadmin") {
    json(res, 403, { error: "acesso restrito ao superadmin" });
    return null;
  }
  return u;
}

// RBAC Setup × Live: devolve o usuário que PODE configurar (superadmin OU engenheiro),
// ou responde 401/403. Usado pelos endpoints de configuração (zonas/tripwires/shelves).
function requireConfigurer(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (!users.canConfigure(u.papel)) {
    json(res, 403, { error: "acesso restrito à equipe de configuração" });
    return null;
  }
  return u;
}

module.exports = { json, bearer, requireAuth, requireSuper, requireConfigurer };
