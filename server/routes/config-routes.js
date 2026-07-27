// Rotas de configuração de câmera (store camcfg): tripwires/zones/camconfig por
// câmera. GET = qualquer autenticado; PUT = requireConfigurer (por câmera).
// Emite "camcfg-updated" aos painéis via io a cada gravação.
const camcfg = require("../camcfg");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireConfigurer, io } = ctx;
  const path0 = req.url ? req.url.split("?")[0] : "";

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
      // saveZones REJEITA regra de negócio violada (turnos sobrepostos na mesma zona — CA-4 da
      // spec-turnos-por-zona) com `badRequest`: erro do CLIENTE → 400 com a MENSAGEM do servidor
      // (a UI só exibe). Qualquer outro erro sobe p/ o catch global (500) como antes.
      let saved;
      try {
        saved = await camcfg.saveZones(cameraId, body && body.zones);
      } catch (e) {
        if (e && e.badRequest) {
          json(res, 400, { error: e.message });
          return true;
        }
        throw e;
      }
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
      // MESMO padrão do PUT de zonas: `saveCamConfig` REJEITA modo de câmera inválido com
      // `badRequest` (antes rebaixava calado para "atividade" — e uma câmera de FADIGA que
      // perdesse o modo voltava a ser analisada e contada como pátio, sem erro e sem log).
      // Sem este catch a rejeição saía como 500 "erro interno": o servidor recusava certo e
      // MENTIA sobre o porquê, deixando o operador sem a mensagem que diz o que corrigir.
      let saved;
      try {
        saved = await camcfg.saveCamConfig(cameraId, body && body.config);
      } catch (e) {
        if (e && e.badRequest) {
          json(res, 400, { error: e.message });
          return true;
        }
        throw e;
      }
      if (!saved) {
        json(res, 400, { error: "config inválida" });
        return true;
      }
      io.to("dashboards").emit("camcfg-updated", { kind: "camconfig", cameraId });
      json(res, 200, saved);
      return true;
    }
  }

  // ── CALIBRAÇÃO (homografia px↔metros) — COMPARTILHADA, por câmera ──────────
  // GET (qualquer autenticado) lê (null se nunca calibrada → front oculta a medição);
  // PUT exige perfil de configuração. Substitui a calibração da câmera e persiste.
  const mcal = path0.match(/^\/api\/calibration\/([\w-]+)$/);
  if (mcal) {
    const cameraId = decodeURIComponent(mcal[1]);
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, camcfg.getCalibration(cameraId));
      return true;
    }
    if (req.method === "PUT") {
      if (!requireConfigurer(req, res)) return true;
      const body = JSON.parse((await readBody(req, 200_000)) || "{}");
      const saved = await camcfg.saveCalibration(cameraId, body && body.calibration);
      if (!saved) {
        json(res, 400, { error: "calibração inválida (mín. 4 pontos e matriz H 3×3)" });
        return true;
      }
      // Novo kind ADITIVO: o engine ignora kinds desconhecidos (onCamcfgUpdated) — contrato intacto.
      io.to("dashboards").emit("camcfg-updated", { kind: "calibration", cameraId });
      json(res, 200, saved);
      return true;
    }
  }

  // (As rotas /api/floorplan e /api/fingerprints migraram com o BLE para o repo
  //  mvp_trilateracao_BLE — ADR-018.)

  return false;
}

module.exports = { handle };
