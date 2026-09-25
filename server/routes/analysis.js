// Rota do motor de análise no hub (ADR-009): GET /api/analysis/status —
// { enabled, model, worker:{ready,pid,respawns,cpuPct}, perCamera:{fps,queue,lastMs,dets1m} }.
// Aditivo: observabilidade do motor sem tocar em nenhum contrato existente.
//
// + AUTO-MÁSCARA (correção do operador, 2026-09-24): GET /api/automask/:cameraId lê as
// sugestões atuais (automask.js já aprende sozinho; isto só EXPÕE p/ revisão); PUT grava a
// decisão ("correto"/"falsoPositivo" — ver automask.js e automask-store.js). Mesmo padrão de
// RBAC do resto da config de câmera (config-routes.js): GET = qualquer autenticado com acesso
// À câmera; PUT = requireConfigurer (é decisão que muda o que a câmera detecta).
const engine = require("../analysis/engine");
const automask = require("../analysis/automask");
const { scopeAnalysisStatus } = require("../socket-scope");
const { canSeeCamera } = require("../users");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireConfigurer } = ctx;

  if (req.url === "/api/analysis/status" && req.method === "GET") {
    const me = requireAuth(req, res);
    if (!me) return true;
    json(res, 200, scopeAnalysisStatus(engine.status(), me));
    return true;
  }

  const path0 = req.url ? req.url.split("?")[0] : "";
  const m = path0.match(/^\/api\/automask\/([\w-]+)$/);
  if (m) {
    const cameraId = decodeURIComponent(m[1]);
    if (req.method === "GET") {
      const me = requireAuth(req, res);
      if (!me) return true;
      if (!canSeeCamera(me, cameraId)) return json(res, 403, { error: "sem acesso a esta câmera" }), true;
      // Lê do status VIVO da câmera (engine.status().perCamera[id].autoMask) — é o mesmo dado
      // que telemetry.js já expõe; sem estado vivo (motor desligado/câmera nova) cai no default
      // "sem sugestão ainda", o que é verdade e não um erro.
      const s = engine.status();
      const cam = s && s.perCamera && s.perCamera[cameraId];
      json(res, 200, (cam && cam.autoMask) || { mode: automask.AUTOMASK_MODE, suppressed: 0, suggestions: [] });
      return true;
    }
    if (req.method === "PUT") {
      if (!requireConfigurer(req, res)) return true;
      const body = JSON.parse((await readBody(req, 2_000)) || "{}");
      const r = engine.setAutomaskDecision(cameraId, body && body.cell, body && body.decision);
      if (r.error) {
        json(res, 400, { error: r.error });
        return true;
      }
      json(res, 200, r);
      return true;
    }
  }

  return false;
}

module.exports = { handle };
