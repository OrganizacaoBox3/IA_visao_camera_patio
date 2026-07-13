// Rotas do REGISTRO de estações BLE (os celulares/coletores que postam leituras). Leitura para
// QUALQUER autenticado (a saúde/calibração precisam do NOME amigável em vez do id técnico);
// escrita restrita ao perfil de configuração — coerente com câmeras/zonas/turnos.
// Espelha routes/bt-tags.js. NÃO existe POST: a estação NASCE ao postar a primeira leitura
// (auto-descoberta em routes/bt-station.js → stations.seen). Aqui só se BATIZA, (des)ativa e remove.
// A validação de negócio (id/nome) mora no store (bt/stations.js) — aqui só transporte e RBAC.
const stations = require("../bt/stations");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireConfigurer } = ctx;

  if (req.url === "/api/bt-stations" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(res, 200, stations.all());
    return true;
  }

  // id da estação = o que o app manda no stationId ([a-zA-Z0-9_-]{1,32} — bt/stations.js ID_RE).
  const m = req.url && req.url.match(/^\/api\/bt-stations\/([\w-]{1,32})$/);
  if (m) {
    const id = m[1];
    if (req.method === "PATCH") {
      if (!requireConfigurer(req, res)) return true;
      const r = await stations.update(id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) json(res, r.error === "estação não encontrada" ? 404 : 400, r);
      else json(res, 200, r.station);
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireConfigurer(req, res)) return true;
      await stations.remove(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

module.exports = { handle };
