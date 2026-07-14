// Control-plane — servidor node:http MÍNIMO (Fase 0). Só a FUNDAÇÃO: sobe, /health, e o
// esqueleto do ctx (json/readBody/requireScope) no molde de server/index.js. Os routes de
// cadastro (partner/cliente/site/user/membership) são a Fase 1 — NÃO estão aqui.
//
// Processo SEPARADO do hub (spec §6). Porta própria (CP_PORT, default 4100) p/ não colidir.
const { createServer } = require("node:http");
const db = require("./db");
const auth = require("./auth");
const routes = require("./routes");

const PORT = Number(process.env.CP_PORT ?? 4100);
const HOST = process.env.CP_HOST ?? "0.0.0.0";

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Lê o corpo com teto (molde do index.js do hub: a Promise SEMPRE resolve/rejeita;
// overflow → rejeita com .tooLarge p/ o dispatch responder 413).
function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let b = "";
    let done = false;
    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      req.removeListener("data", onData);
      fn(arg);
    };
    const onData = (c) => {
      b += c;
      if (b.length > limit) {
        const err = new Error("corpo excede o limite");
        err.tooLarge = true;
        settle(reject, err);
      }
    };
    req.on("data", onData);
    req.on("end", () => settle(resolve, b));
    req.on("close", () => settle(resolve, b));
    req.on("error", (e) => settle(reject, e));
  });
}

function bearer(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

// requireScope: valida o token e devolve os claims (com escopo), ou responde 401 e null.
// A autorização POR RECURSO (canAccess) fica em cada route da Fase 1 — este só prova
// autenticação. Fica no ctx desde já para os handlers futuros usarem o mesmo contrato.
function requireScope(req, res) {
  const claims = auth.verifyToken(bearer(req));
  if (!claims) {
    json(res, 401, { error: "não autenticado" });
    return null;
  }
  return claims;
}

const ctx = { json, readBody, requireScope };

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  try {
    // /health: prova que o serviço SOBE (não toca banco — responde mesmo com PG off).
    if (req.url === "/health" && req.method === "GET") {
      return json(res, 200, { ok: true, service: "control-plane", db: db.configured() });
    }
    // Fase 1: login + CRUD do cadastro + ingest/heartbeat (cada um com seu guard em routes.js).
    if (await routes.handle(req, res, ctx)) return;
  } catch (err) {
    if (err && err.tooLarge) return json(res, 413, { error: "corpo grande demais" });
    if (err instanceof SyntaxError) return json(res, 400, { error: "requisição inválida" });
    console.error(`[cp] erro ao processar ${req.method} ${req.url}:`, err && err.stack ? err.stack : err);
    return json(res, 500, { error: "erro interno" });
  }

  res.writeHead(404);
  res.end();
});

async function start() {
  await db.init(); // aditivo: PG ausente → inerte (log e segue), o /health continua de pé
  httpServer.listen(PORT, HOST, () => {
    console.log(`[cp] control-plane no ar em http://${HOST}:${PORT} (/health)`);
  });
}

// Só sobe quando executado direto (`node control-plane/index.js`); sob require (teste) fica inerte.
if (require.main === module) {
  start().catch((e) => {
    console.error("[cp] falha no boot:", e);
    process.exit(1);
  });
}

module.exports = { httpServer, start, ctx, json, readBody, requireScope };
