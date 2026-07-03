// Rota do motor de análise no hub (F1/ADR-009): GET /api/analysis/status —
// { enabled, model, worker:{ready,pid,respawns,cpuPct}, perCamera:{fps,queue,lastMs,dets1m} }.
// Aditivo: observabilidade do motor sem tocar em nenhum contrato existente.
const engine = require("../analysis/engine");

async function handle(req, res, ctx) {
  const { json, requireAuth } = ctx;

  if (req.url === "/api/analysis/status" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(res, 200, engine.status());
    return true;
  }

  return false;
}

module.exports = { handle };
