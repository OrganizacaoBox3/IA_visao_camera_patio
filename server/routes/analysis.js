// Rota do motor de análise no hub (ADR-009): GET /api/analysis/status —
// { enabled, model, worker:{ready,pid,respawns,cpuPct}, perCamera:{fps,queue,lastMs,dets1m} }.
// Aditivo: observabilidade do motor sem tocar em nenhum contrato existente.
const engine = require("../analysis/engine");
const { scopeAnalysisStatus } = require("../socket-scope");

async function handle(req, res, ctx) {
  const { json, requireAuth } = ctx;

  if (req.url === "/api/analysis/status" && req.method === "GET") {
    const me = requireAuth(req, res);
    if (!me) return true;
    json(res, 200, scopeAnalysisStatus(engine.status(), me));
    return true;
  }

  return false;
}

module.exports = { handle };
