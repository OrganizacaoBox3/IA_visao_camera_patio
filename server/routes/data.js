// Rotas de histórico/indicadores (Postgres com fallback JSON): /api/ingest,
// /api/data/*, /api/data/status e /api/data/clear.
const pgstore = require("../pgstore");
const { canSeeCamera } = require("../users");

// RBAC com escopo (papel "cliente"): só "ativ" e "flow" carregam cameraId no bucket/evento
// (ver server/pgstore.js BUCKET_SQL/EVENT_SQL). "read"/"obj"/"fad" não têm câmera atribuível
// no schema atual — em vez de arriscar misturar dado de câmeras de outro cliente (ou vazar
// setor/posto sem dono claro), bloqueamos esses três kinds pro papel "cliente" (fail-closed;
// residual conhecido, não escondido).
const CAMERA_ATTRIBUTABLE_KINDS = new Set(["ativ", "flow"]);

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireSuper } = ctx;

  // Histórico/indicadores no Postgres (qualquer usuário autenticado)
  if (req.url === "/api/ingest" && req.method === "POST") {
    const me = requireAuth(req, res);
    if (!me) return true;
    if (me.papel === "cliente") {
      json(res, 403, { error: "acesso restrito à equipe" });
      return true;
    }
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

  const mb = req.url && req.url.match(/^\/api\/data\/(ativ|read|obj|fad|flow)\/(buckets|events)$/);
  if (mb && req.method === "GET") {
    const me = requireAuth(req, res);
    if (!me) return true;
    const kind = mb[1];
    if (me.papel === "cliente" && !CAMERA_ATTRIBUTABLE_KINDS.has(kind)) {
      json(res, 403, { error: "acesso restrito à equipe" });
      return true;
    }
    const rows = mb[2] === "buckets" ? await pgstore.buckets(kind) : await pgstore.events(kind);
    json(res, 200, me.papel === "cliente" ? rows.filter((r) => canSeeCamera(me, r.cameraId)) : rows);
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
