// Rotas de histórico/indicadores (Postgres com fallback JSON): /api/ingest,
// /api/data/*, /api/data/status e /api/data/clear.
const pgstore = require("../pgstore");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireSuper } = ctx;

  // Histórico/indicadores no Postgres (qualquer usuário autenticado)
  if (req.url === "/api/ingest" && req.method === "POST") {
    if (!requireAuth(req, res)) return true;
    const { kind, op, payload } = JSON.parse((await readBody(req, 200_000)) || "{}");
    await pgstore.ingest(kind, op, payload);
    json(res, 200, { ok: true });
    return true;
  }

  // Status da persistência do histórico (aditivo): "pg" ou "json" (fallback ativo).
  if (req.url === "/api/data/status" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(res, 200, await pgstore.status());
    return true;
  }

  const mb = req.url && req.url.match(/^\/api\/data\/(ativ|read|obj|fad)\/(buckets|events)$/);
  if (mb && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(
      res,
      200,
      mb[2] === "buckets" ? await pgstore.buckets(mb[1]) : await pgstore.events(mb[1]),
    );
    return true;
  }

  if (req.url === "/api/data/clear" && req.method === "POST") {
    if (!requireSuper(req, res)) return true;
    await pgstore.clear();
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handle };
