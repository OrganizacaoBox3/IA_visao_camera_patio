// Rota de INGEST da estação BLE (device-facing): o coletor (TC22) POSTa as leituras; o hub enriquece
// (bt-readings) e relaya aos dashboards. Auth de DEVICE por token (espelha o CAMERA_TOKEN), separada da
// CRUD de tags (superadmin, routes/bt-tags.js) — responsabilidade única. Leituras são efêmeras (LGPD).
const btReadings = require("../bt-readings");
const users = require("../users");

// Token opcional (como o CAMERA_TOKEN): se BT_STATION_TOKEN estiver definido, exige o header; senão aceita
// (MVP em LAN). Comparação em tempo ~constante.
function tokenOk(req) {
  const want = process.env.BT_STATION_TOKEN;
  if (!want) return true;
  return users.constantTimeEqual(String(req.headers["x-station-token"] || ""), want);
}

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, io } = ctx;

  // Estação → hub: leituras de RSSI (efêmeras). Relaya aos painéis; nunca persiste.
  if (req.url === "/api/bt/reading" && req.method === "POST") {
    if (!tokenOk(req)) {
      json(res, 401, { error: "token de estação inválido" });
      return true;
    }
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "json inválido" });
      return true;
    }
    const enriched = btReadings.ingest(body.stationId, body.readings);
    io.to("dashboards").volatile.emit("bt-readings", {
      stationId: String(body.stationId || ""),
      ts: Date.now(),
      readings: enriched,
    });
    json(res, 200, { ok: true, n: enriched.length });
    return true;
  }

  // Dashboard que abre depois: snapshot do que está visível agora.
  if (req.url === "/api/bt/readings" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(res, 200, btReadings.snapshot());
    return true;
  }

  return false;
}

module.exports = { handle };
