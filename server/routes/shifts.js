// Rotas de TURNOS de trabalho (spec-turnos-por-zona F1). Leitura para QUALQUER autenticado
// (relatório/overlay consomem o cadastro); escrita restrita ao perfil de configuração —
// coerente com câmeras/zonas. Espelha routes/bt-tags.js. A validação de negócio (duração,
// dias, pausas) mora no store (shifts.js) — aqui só o transporte e o RBAC.
const shifts = require("../shifts");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireConfigurer } = ctx;

  if (req.url === "/api/shifts") {
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, shifts.all());
      return true;
    }
    if (req.method === "POST") {
      if (!requireConfigurer(req, res)) return true;
      const r = await shifts.create(JSON.parse((await readBody(req)) || "{}"));
      // r.status (ex.: 503 na falha de persistência) tem prioridade; senão 400 (validação).
      if (r.error) json(res, r.status || 400, r);
      else json(res, 201, r.shift);
      return true;
    }
  }

  const m = req.url && req.url.match(/^\/api\/shifts\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      if (!requireConfigurer(req, res)) return true;
      const r = await shifts.update(id, JSON.parse((await readBody(req)) || "{}"));
      // r.status (503 na falha de persistência) tem prioridade; senão 404 (inexistente) ou 400.
      if (r.error) json(res, r.status || (r.error === "turno não encontrado" ? 404 : 400), r);
      else json(res, 200, r.shift);
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireConfigurer(req, res)) return true;
      const r = await shifts.remove(id);
      // A falha de persistência não pode virar 200 silencioso (o turno seguiria na tela do próximo
      // que abrir, mas voltaria no restart) — surface o 503.
      if (r.error) json(res, r.status || 500, r);
      else json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

module.exports = { handle };
