// Rota de INGEST da estação BLE (device-facing): o coletor (TC22) POSTa as leituras; o hub enriquece
// (bt-readings) e relaya aos dashboards. Auth de DEVICE por token (espelha o CAMERA_TOKEN), separada da
// CRUD de tags (superadmin, routes/bt-tags.js) — responsabilidade única. Leituras são efêmeras (LGPD).
const btReadings = require("../bt-readings");
const btLocations = require("../bt-locations");
const btTags = require("../bt-tags");
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
    // Modelo AirTag: se o batch traz a posição do celular (lat/lon), toda tag vista AGORA está nela.
    // Guarda a última localização por tag (last-known) e relaya o snapshot ao mapa. LGPD: só metadado.
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const acc = Number(body.acc);
      for (const rec of enriched) btLocations.update(rec.mac, { lat, lon, acc });
      io.to("dashboards").volatile.emit("bt-locations", {
        ts: Date.now(),
        phone: { lat, lon, acc: Number.isFinite(acc) ? acc : null },
        tags: btLocations.snapshot(),
      });
    }
    json(res, 200, { ok: true, n: enriched.length });
    return true;
  }

  // Dashboard que abre depois: snapshot do que está visível agora.
  if (req.url === "/api/bt/readings" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(res, 200, btReadings.snapshot());
    return true;
  }

  // Mapa: última localização conhecida por tag (last-known, persistida). Só metadados (LGPD).
  if (req.url === "/api/bt/locations" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(res, 200, btLocations.snapshot());
    return true;
  }

  // Estação/app (TC22) → hub: NOMEIA uma tag pelo app (UPSERT por MAC). Mesma auth de device do /reading.
  // Enriquece bt-readings/mapa via bt-tags.match(mac). LGPD: só cadastro (metadado) é persistido.
  if (req.url === "/api/bt/tag-name" && req.method === "POST") {
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
    if (typeof body.mac !== "string" || !body.mac.trim() || typeof body.name !== "string" || !body.name.trim()) {
      json(res, 400, { error: "mac e name obrigatórios" });
      return true;
    }
    const r = await btTags.upsertByMac(body.mac, body.name);
    if (r.error) {
      json(res, 400, { error: r.error });
      return true;
    }
    json(res, 200, { ok: true, tag: r.tag });
    return true;
  }

  return false;
}

module.exports = { handle };
