// Rotas de TAGS BLUETOOTH (superadmin): cadastro/lista/edição das tags por nome do Bluetooth.
// Espelha routes/notif.js (recipients). Leituras de RSSI NÃO passam por aqui (são efêmeras).
const btTags = require("../bt-tags");

async function handle(req, res, ctx) {
  const { json, readBody, requireSuper } = ctx;

  if (req.url === "/api/bt-tags") {
    if (req.method === "GET") {
      if (!requireSuper(req, res)) return true;
      json(res, 200, btTags.all());
      return true;
    }
    if (req.method === "POST") {
      if (!requireSuper(req, res)) return true;
      const r = await btTags.create(JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, 400, r);
      else json(res, 201, r.tag);
      return true;
    }
  }

  const m = req.url && req.url.match(/^\/api\/bt-tags\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      if (!requireSuper(req, res)) return true;
      const r = await btTags.update(id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, 400, r);
      else json(res, 200, r.tag);
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireSuper(req, res)) return true;
      await btTags.remove(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

module.exports = { handle };
