// Helpers HTTP de resposta e autenticação/RBAC do hub.
// Extraído de index.js (Onda C do retrofit): index.js vira composição/bootstrap.
// Contrato: estas funções são passadas aos grupos de rotas via `ctx` (json/bearer/requireAuth/
// requireSuper/requireConfigurer) — a forma do ctx NÃO muda, então nenhuma rota precisa saber
// de onde vêm. `readBody` fica no index.js (é parte do servidor HTTP, não da auth).
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

// RBAC Setup × Live (Onda C item 12): devolve o usuário que PODE configurar (superadmin OU
// engenheiro), ou responde 401/403. Usado pelos endpoints de saúde de alarmes (shelve/unshelve).
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
