// Rotas de configuração de câmera (store camcfg): views (layouts) + tripwires/zones/camconfig por
// câmera. GET = qualquer autenticado; PUT = autenticado (views) ou requireConfigurer (por câmera).
// Emite "camcfg-updated" aos painéis via io a cada gravação.
const camcfg = require("../camcfg");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireConfigurer, io } = ctx;
  const path0 = req.url ? req.url.split("?")[0] : "";

  // ── VIEWS (layouts do dashboard) — COMPARTILHADAS, lista global ───────────
  // GET (qualquer autenticado) lê; PUT (qualquer autenticado) substitui a lista inteira e persiste.
  if (path0 === "/api/views") {
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, camcfg.allViews());
      return true;
    }
    if (req.method === "PUT") {
      if (!requireAuth(req, res)) return true;
      const body = JSON.parse((await readBody(req, 200_000)) || "{}");
      const saved = await camcfg.saveViews(body && body.views);
      io.to("dashboards").emit("camcfg-updated", { kind: "views" });
      json(res, 200, saved);
      return true;
    }
  }

  // ── TRIPWIRES (linhas de contagem) — COMPARTILHADAS, por câmera ───────────
  // GET (qualquer autenticado) lê; PUT exige perfil de configuração (engenharia).
  const mtw = path0.match(/^\/api\/tripwires\/([\w-]+)$/);
  if (mtw) {
    const cameraId = decodeURIComponent(mtw[1]);
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, camcfg.getTripwires(cameraId));
      return true;
    }
    if (req.method === "PUT") {
      if (!requireConfigurer(req, res)) return true;
      const body = JSON.parse((await readBody(req, 200_000)) || "{}");
      const saved = await camcfg.saveTripwires(cameraId, body && body.tripwires);
      io.to("dashboards").emit("camcfg-updated", { kind: "tripwires", cameraId });
      json(res, 200, saved);
      return true;
    }
  }

  // ── ZONES (ROIs + modo/config) — COMPARTILHADAS, por câmera ───────────────
  // GET (qualquer autenticado) lê; PUT exige perfil de configuração (engenharia).
  const mzn = path0.match(/^\/api\/zones\/([\w-]+)$/);
  if (mzn) {
    const cameraId = decodeURIComponent(mzn[1]);
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, camcfg.getZones(cameraId));
      return true;
    }
    if (req.method === "PUT") {
      if (!requireConfigurer(req, res)) return true;
      const body = JSON.parse((await readBody(req, 200_000)) || "{}");
      const saved = await camcfg.saveZones(cameraId, body && body.zones);
      io.to("dashboards").emit("camcfg-updated", { kind: "zones", cameraId });
      json(res, 200, saved);
      return true;
    }
  }

  // ── CAMCONFIG (config de câmera) — COMPARTILHADA, por câmera ───────────────
  // GET (qualquer autenticado) lê (null se nunca salva → front usa defaults);
  // PUT exige perfil de configuração. Substitui a config da câmera e persiste.
  const mcc = path0.match(/^\/api\/camconfig\/([\w-]+)$/);
  if (mcc) {
    const cameraId = decodeURIComponent(mcc[1]);
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, camcfg.getCamConfig(cameraId));
      return true;
    }
    if (req.method === "PUT") {
      if (!requireConfigurer(req, res)) return true;
      const body = JSON.parse((await readBody(req, 200_000)) || "{}");
      const saved = await camcfg.saveCamConfig(cameraId, body && body.config);
      if (!saved) {
        json(res, 400, { error: "config inválida" });
        return true;
      }
      io.to("dashboards").emit("camcfg-updated", { kind: "camconfig", cameraId });
      json(res, 200, saved);
      return true;
    }
  }

  return false;
}

module.exports = { handle };
