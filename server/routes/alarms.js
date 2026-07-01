// Rotas de alarmes — fila acionável (events) + saúde/shelving (alarmPolicy, em memória).
// SÓ METADADOS (LGPD). Emite "alarm-update" aos painéis via io no ack/forward.
const events = require("../events");
const alarmPolicy = require("../alarmPolicy");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireConfigurer, io } = ctx;
  const path0 = req.url ? req.url.split("?")[0] : "";

  // Fila acionável (Onda B). Qualquer usuário autenticado lê/opera.
  if (path0 === "/api/alarms" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    const q = new URL(req.url, "http://x").searchParams;
    json(
      res,
      200,
      events.query({
        limit: q.get("limit"),
        since: q.get("since"),
        state: q.get("state"),
        priority: q.get("priority"),
      }),
    );
    return true;
  }

  const mAck = path0.match(/^\/api\/alarms\/([\w-]+)\/ack$/);
  if (mAck && req.method === "POST") {
    const me = requireAuth(req, res);
    if (!me) return true;
    const body = JSON.parse((await readBody(req)) || "{}");
    const r = await events.ack(mAck[1], body.by || me.usuario || me.id);
    if (r.error) {
      json(res, 404, r);
      return true;
    }
    io.to("dashboards").emit("alarm-update", r.event);
    json(res, 200, r.event);
    return true;
  }

  const mFwd = path0.match(/^\/api\/alarms\/([\w-]+)\/forward$/);
  if (mFwd && req.method === "POST") {
    const me = requireAuth(req, res);
    if (!me) return true;
    const body = JSON.parse((await readBody(req)) || "{}");
    const r = await events.forward(mFwd[1], body.by || me.usuario || me.id);
    if (r.error) {
      json(res, 404, r);
      return true;
    }
    io.to("dashboards").emit("alarm-update", r.event);
    json(res, 200, r.event);
    return true;
  }

  // Saúde de alarmes (Onda C, item 14) — lógica EM MEMÓRIA de alarmPolicy.js.
  // metrics()/listShelved() são leitura; shelve/unshelve são configuração (requireConfigurer).
  // Estas rotas vêm ANTES das de :id (ack/forward usam [\w-]+ e não casam "metrics"/"shelves").
  if (path0 === "/api/alarms/metrics" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    json(res, 200, alarmPolicy.metrics());
    return true;
  }

  if (path0 === "/api/alarms/shelves") {
    if (req.method === "GET") {
      if (!requireAuth(req, res)) return true;
      json(res, 200, alarmPolicy.listShelved());
      return true;
    }
    if (req.method === "POST") {
      const me = requireConfigurer(req, res);
      if (!me) return true;
      const body = JSON.parse((await readBody(req)) || "{}");
      const key = typeof body.key === "string" ? body.key.trim() : "";
      if (!key) {
        json(res, 400, { error: "key é obrigatória (string não vazia)" });
        return true;
      }
      const by = me.usuario || me.id;
      const shelf = alarmPolicy.shelve(key, body.ms, { reason: body.reason, by });
      json(res, 201, shelf);
      return true;
    }
  }

  const mShelf = path0.match(/^\/api\/alarms\/shelves\/(.+)$/);
  if (mShelf && req.method === "DELETE") {
    if (!requireConfigurer(req, res)) return true;
    const ok = alarmPolicy.unshelve(decodeURIComponent(mShelf[1]));
    json(res, 200, { ok });
    return true;
  }

  return false;
}

module.exports = { handle };
