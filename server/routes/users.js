// Rotas de gestão de usuários (somente superadmin): /api/users e /api/users/:id.
const users = require("../users");

// Derruba os sockets ATIVOS deste usuário (RBAC com escopo): ao trocar papel/cameraIds, o
// socket já conectado ficaria com o ESCOPO ANTIGO até o dashboard reconectar por conta própria
// (refresh, queda de rede) — sem isso, revogar acesso de um cliente não teria efeito imediato.
// Reconecta sozinho (socket.io) e refaz `io.use` com os dados frescos de users.js.
function disconnectSocketsOf(io, userId) {
  for (const s of io.of("/").sockets.values())
    if (s.data.user && s.data.user.id === userId) s.disconnect(true);
}

async function handle(req, res, ctx) {
  const { json, readBody, requireSuper, io } = ctx;

  if (req.url === "/api/users") {
    if (req.method === "GET") {
      if (!requireSuper(req, res)) return true;
      json(res, 200, users.publicList());
      return true;
    }
    if (req.method === "POST") {
      if (!requireSuper(req, res)) return true;
      const r = await users.createUser(JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, r.status || 400, r); // r.status (503) tem prioridade sobre o 400
      else json(res, 201, r.user);
      return true;
    }
  }
  const m = req.url && req.url.match(/^\/api\/users\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      if (!requireSuper(req, res)) return true;
      const patch = JSON.parse((await readBody(req)) || "{}");
      const r = await users.updateUser(id, patch);
      if (r.error) json(res, r.status || 400, r);
      else {
        if ("papel" in patch || "cameraIds" in patch || patch.ativo === false)
          disconnectSocketsOf(io, id);
        json(res, 200, r.user);
      }
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireSuper(req, res)) return true;
      const r = await users.removeUser(id);
      if (r.error) json(res, r.status || 400, r);
      else {
        disconnectSocketsOf(io, id);
        json(res, 200, { ok: true });
      }
      return true;
    }
  }

  return false;
}

module.exports = { handle };
