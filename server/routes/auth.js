// Rotas de autenticação/perfil: login (público) e /api/me (perfil do próprio usuário).
// handle(req,res,ctx) → true se a requisição foi tratada (resposta enviada), senão false.
const users = require("../users");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth } = ctx;

  // Login (público)
  if (req.method === "POST" && req.url === "/api/login") {
    const { usuario, senha } = JSON.parse((await readBody(req)) || "{}");
    const r = users.authenticate(usuario, senha);
    if (r) json(res, 200, r);
    else json(res, 401, { error: "credenciais inválidas" });
    return true;
  }

  // Perfil do próprio usuário (qualquer papel) — WhatsApp + preferências + opt-in
  if (req.url === "/api/me") {
    const me = requireAuth(req, res);
    if (!me) return true;
    if (req.method === "GET") {
      json(res, 200, users.getProfile(me.id));
      return true;
    }
    if (req.method === "PATCH" || req.method === "PUT") {
      const r = await users.updateProfile(me.id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, 400, r);
      else json(res, 200, r.user);
      return true;
    }
  }

  return false;
}

module.exports = { handle };
