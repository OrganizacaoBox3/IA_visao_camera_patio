// Rotas de configuração de câmera (store camcfg): tripwires/zones/camconfig por
// câmera. GET = qualquer autenticado; PUT = requireConfigurer (por câmera).
// Emite "camcfg-updated" aos painéis via io a cada gravação.
const camcfg = require("../camcfg");
// PLANTA BAIXA (floorplan): config GLOBAL do local (não por câmera) — dimensões em metros +
// posição das estações BLE. Emite "floorplan-updated" (evento NOVO, aditivo) aos painéis.
const floorplan = require("../bt/floorplan");
// FINGERPRINTS de RSSI (survey de localização indoor): LISTA de assinaturas RSSI por ponto conhecido.
// GET = qualquer autenticado; POST/DELETE = requireConfigurer. Emite "fingerprints-updated" (aditivo).
const fingerprints = require("../bt/fingerprints");

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

  // ── PLANTA BAIXA (floorplan) — config GLOBAL do local (NÃO por câmera) ─────
  // GET (qualquer autenticado) lê a planta (vazio { widthM:0,... } se nunca salva → front usa
  // defaults); PUT exige perfil de configuração. Dimensões inválidas → 400 (badRequest); falha de
  // persistência → 503 (o save faz rollback e propaga).
  if (path0 === "/api/floorplan") {
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, floorplan.get());
      return true;
    }
    if (req.method === "PUT") {
      if (!requireConfigurer(req, res)) return true;
      const body = JSON.parse((await readBody(req, 200_000)) || "{}");
      let saved;
      try {
        saved = await floorplan.save(body && body.floorplan);
      } catch (e) {
        if (e && e.badRequest) {
          json(res, 400, { error: e.message });
          return true;
        }
        if (e && e.status === 503) {
          json(res, 503, { error: e.message });
          return true;
        }
        throw e;
      }
      io.to("dashboards").emit("floorplan-updated", {});
      json(res, 200, saved);
      return true;
    }
  }

  // ── FINGERPRINTS de RSSI (survey de localização) — LISTA global (NÃO por câmera) ─────
  // GET (qualquer autenticado) lê a lista; POST/DELETE exigem perfil de configuração. Validação
  // inválida → 400 (badRequest); falha de persistência → 503 (add/remove fazem rollback e propagam).
  if (path0 === "/api/fingerprints") {
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, fingerprints.list());
      return true;
    }
    if (req.method === "POST") {
      if (!requireConfigurer(req, res)) return true;
      const body = JSON.parse((await readBody(req, 200_000)) || "{}");
      let saved;
      try {
        saved = await fingerprints.add(body && body.fingerprint);
      } catch (e) {
        if (e && e.badRequest) {
          json(res, 400, { error: e.message });
          return true;
        }
        if (e && e.status === 503) {
          json(res, 503, { error: e.message });
          return true;
        }
        throw e;
      }
      io.to("dashboards").emit("fingerprints-updated", {});
      json(res, 200, saved);
      return true;
    }
  }

  // DELETE /api/fingerprints/:id — id gerado pelo server (ex.: "fp-<uuid>").
  const fpMatch = path0.match(/^\/api\/fingerprints\/([\w-]+)$/);
  if (fpMatch && req.method === "DELETE") {
    if (!requireConfigurer(req, res)) return true;
    let r;
    try {
      r = await fingerprints.remove(fpMatch[1]);
    } catch (e) {
      if (e && e.status === 503) {
        json(res, 503, { error: e.message });
        return true;
      }
      throw e;
    }
    io.to("dashboards").emit("fingerprints-updated", {});
    json(res, 200, r);
    return true;
  }

  return false;
}

module.exports = { handle };
