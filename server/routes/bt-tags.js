// Rotas de TAGS BLUETOOTH (perfil de configuração — engenharia/superadmin): cadastro/lista/edição
// das tags por nome do Bluetooth (definir QUEM é a tag). Coerente com câmeras/zonas.
// Espelha routes/notif.js (recipients). Leituras de RSSI NÃO passam por aqui (são efêmeras).
const btTags = require("../bt/bt-tags");

async function handle(req, res, ctx) {
  const { json, readBody, requireConfigurer } = ctx;

  if (req.url === "/api/bt-tags") {
    if (req.method === "GET") {
      if (!requireConfigurer(req, res)) return true;
      json(res, 200, btTags.all());
      return true;
    }
    if (req.method === "POST") {
      if (!requireConfigurer(req, res)) return true;
      const r = await btTags.create(JSON.parse((await readBody(req)) || "{}"));
      // r.status (503 na falha de persistência) tem prioridade; senão 400 (validação).
      if (r.error) json(res, r.status || 400, r);
      else json(res, 201, r.tag);
      return true;
    }
  }

  const m = req.url && req.url.match(/^\/api\/bt-tags\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      if (!requireConfigurer(req, res)) return true;
      const r = await btTags.update(id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, r.status || 400, r);
      else json(res, 200, r.tag);
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireConfigurer(req, res)) return true;
      // A falha de persistência não pode virar 200 silencioso (a tag seguiria na tela, mas voltaria
      // no restart) — surface o 503.
      const r = await btTags.remove(id);
      if (r.error) json(res, r.status || 500, r);
      else json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

module.exports = { handle };
