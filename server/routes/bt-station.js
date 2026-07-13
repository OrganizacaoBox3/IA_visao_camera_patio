// Rota de INGEST da estação BLE (device-facing): o coletor (TC22) POSTa as leituras; o hub enriquece
// (bt-readings) e relaya aos dashboards. Auth de DEVICE por token (espelha o CAMERA_TOKEN), separada da
// CRUD de tags (superadmin, routes/bt-tags.js) — responsabilidade única. Leituras são efêmeras (LGPD).
const btReadings = require("../bt/bt-readings");
const btLocations = require("../bt/bt-locations");
const btTags = require("../bt/bt-tags");
const stations = require("../bt/stations");
const recorder = require("../bt/recorder");
const sessionRecorder = require("../bt/session-recorder"); // gravador OPT-IN (FUSION_RECORD) da sessão de fusão — no-op quando off
const users = require("../users");
const { bearer } = require("../http-auth");

// Header de device válido? (comparação em tempo ~constante; false quando não há token configurado)
function stationTokenOk(req) {
  const want = process.env.BT_STATION_TOKEN;
  return !!want && users.constantTimeEqual(String(req.headers["x-station-token"] || ""), want);
}

// Auth de DEVICE (espelha o CAMERA_TOKEN), fail-closed EM PRODUÇÃO (auditoria jul/12):
//  • BT_STATION_TOKEN definido → exige x-station-token válido, senão 401;
//  • sem token FORA de produção → aberto (MVP em LAN), com aviso no boot (index.js);
//  • sem token EM produção → 503 explicativo. NÃO derruba o boot: guard fail-closed não pode
//    deadlockar o serviço que protege (lição da casa) — fecha SÓ estes endpoints.
// Devolve true quando a requisição pode seguir; senão já respondeu (401/503).
function deviceAuth(req, res, json) {
  const want = process.env.BT_STATION_TOKEN;
  if (!want) {
    if (process.env.NODE_ENV === "production") {
      json(res, 503, {
        error:
          "endpoints da estação BLE desabilitados em produção: defina BT_STATION_TOKEN no ambiente do hub e reinicie",
      });
      return false;
    }
    return true;
  }
  if (!stationTokenOk(req)) {
    json(res, 401, { error: "token de estação inválido" });
    return false;
  }
  return true;
}

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, io } = ctx;

  // Estação → hub: leituras de RSSI (efêmeras). Relaya aos painéis; nunca persiste.
  if (req.url === "/api/bt/reading" && req.method === "POST") {
    if (!deviceAuth(req, res, json)) return true;
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      json(res, 400, { error: "json inválido" });
      return true;
    }
    // AUTO-DESCOBERTA da estação (bt/stations.js): o cadastro não é manual — a estação NASCE aqui,
    // no primeiro POST, como PENDENTE (nome = o próprio id) e o operador a batiza na tela /estacoes.
    // Se já existe, só carimba `ultimaVezEm` (o nome/ativo dele nunca são sobrescritos).
    // FAIL-SAFE: o registro é ACESSÓRIO — a LEITURA é o que importa. Falha no registry (Postgres
    // fora, disco cheio, id fora do formato) NUNCA derruba o POST; loga e segue.
    try {
      await stations.seen(body.stationId);
    } catch (e) {
      console.error("[bt-stations] auto-descoberta falhou (leitura segue):", e && e.message);
    }
    const enriched = btReadings.ingest(body.stationId, body.readings);
    io.to("dashboards").volatile.emit("bt-readings", {
      stationId: String(body.stationId || ""),
      ts: Date.now(),
      readings: enriched,
    });
    // Gravação OPT-IN da sessão de fusão indoor (FUSION_RECORD): SEMPRE — com ou sem lat/lon (indoor
    // não tem GPS; o recorder.record abaixo só cobre o modelo AirTag). Fail-safe: jamais lança.
    sessionRecorder.recordReadings(body.stationId, Date.now(), enriched);
    // Modelo AirTag: se o batch traz a posição do celular (lat/lon), toda tag vista AGORA está nela.
    // Guarda a última localização por tag (last-known); o mapa consome por POLLING do GET
    // /api/bt/locations (o emit socket "bt-locations" era órfão — jamais consumido — e foi
    // removido na faxina jul/12). LGPD: só metadado.
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const acc = Number(body.acc);
      for (const rec of enriched) btLocations.update(rec.mac, { lat, lon, acc });
      // Event-sourcing OPT-IN (BT_RECORD) p/ o harness de replay do motor de localização (ADR-012).
      // Aditivo, fail-safe, só metadados: não altera a resposta nem bloqueia se falhar. Só relatórios
      // COM posição (lat/lon) são úteis ao motor, então gravamos aqui, depois de persistir/relayar.
      recorder.record({ ts: Date.now(), lat, lon, acc, tags: enriched });
    }
    json(res, 200, { ok: true, n: enriched.length });
    return true;
  }

  // Dashboard que abre depois: snapshot do que está visível agora.
  // RETROCOMPAT (CA-3 da spec multi-antena): o DEFAULT colapsa por MAC (1 rec/MAC, o mais fresco)
  // — com uma estação é indistinguível do formato de sempre, e os consumidores existentes que fazem
  // merge por MAC (mapa de tags, fusão, TagPicker) seguem intactos com N estações. `?all=1`
  // (ADITIVO) devolve TODAS as fontes vivas (N estações × MAC) p/ saúde por estação e UI agrupada.
  if ((req.url || "").split("?")[0] === "/api/bt/readings" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    const all = new URL(req.url, "http://x").searchParams.get("all") === "1";
    json(res, 200, all ? btReadings.snapshot() : btReadings.snapshotLatestByMac());
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
    if (!deviceAuth(req, res, json)) return true;
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

  // App (TC22) → hub: PUXA os nomes cadastrados das tags (sync bidirecional). Auth DUPLA
  // (auditoria jul/12 — antes vazava o cadastro sem auth nenhuma): token de estação válido
  // (device) OU sessão autenticada (qualquer papel). Sem token configurado, espelha o
  // deviceAuth: aberto fora de produção (MVP em LAN), 503 explicativo em produção.
  // MAC MAIÚSCULO + rótulo; só tags ativas. LGPD: só metadado (cadastro).
  if (req.url === "/api/bt/tags" && req.method === "GET") {
    const want = process.env.BT_STATION_TOKEN;
    const authorized =
      stationTokenOk(req) ||
      !!users.verifyToken(bearer(req)) ||
      (!want && process.env.NODE_ENV !== "production");
    if (!authorized) {
      if (!want)
        json(res, 503, {
          error:
            "endpoints da estação BLE desabilitados em produção: defina BT_STATION_TOKEN no ambiente do hub e reinicie",
        });
      else json(res, 401, { error: "token de estação inválido ou sessão não autenticada" });
      return true;
    }
    json(res, 200, btTags.listForDevice());
    return true;
  }

  return false;
}

module.exports = { handle };
