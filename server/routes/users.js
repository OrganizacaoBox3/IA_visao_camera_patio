// Rotas de gestão de usuários (somente superadmin): /api/users e /api/users/:id.
const users = require("../users");

async function handle(req, res, ctx) {
  const { json, readBody, requireSuper } = ctx;

  if (req.url === "/api/users") {
    if (req.method === "GET") {
      if (!requireSuper(req, res)) return true;
      json(res, 200, users.publicList());
      return true;
    }
    if (req.method === "POST") {
      if (!requireSuper(req, res)) return true;
      const r = await users.createUser(JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, 400, r);
      else json(res, 201, r.user);
      return true;
    }
  }
  const m = req.url && req.url.match(/^\/api\/users\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      if (!requireSuper(req, res)) return true;
      const r = await users.updateUser(id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, 400, r);
      else json(res, 200, r.user);
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireSuper(req, res)) return true;
      const r = await users.removeUser(id);
      if (r.error) json(res, 400, r);
      else json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

module.exports = { handle };
