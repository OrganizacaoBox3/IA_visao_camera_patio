// Integração da Fase 2 — EXIGE Postgres real (overview conta alarm_event via withTenant; o
// drill-down lê alarm_event sob RLS). Dirige routes.handle() com req/res mockados — o mesmo
// caminho do servidor. Sem PG → SKIP DECLARADO (padrão da casa, como cadastro.pg.test.js/rls.test.js).
//
// Prova: (1) OVERVIEW scoped — partner-admin de B NÃO vê site de A; platform vê ambos; alarms24h
// conta certo POR SITE e RESPEITA a janela de 24h (evento antigo NÃO conta). (2) DRILL-DOWN —
// 403 fora do escopo; withTenant isola A de B (o alarme de B nunca aparece no de A); limit/since.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const db = require("./db");
const stores = require("./stores");
const password = require("./password");
const routes = require("./routes");
const { ctx } = require("./index");

const HAVE_PG = db.configured();
const tag = `o${process.pid}`;

function makeReq(method, path, { token, headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [typeof body === "string" ? body : JSON.stringify(body)];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = path;
  req.headers = { ...headers };
  if (token) req.headers["authorization"] = `Bearer ${token}`;
  return req;
}
function makeRes() {
  const res = { statusCode: 0, body: undefined, jsonBody: undefined };
  res.writeHead = (code) => {
    res.statusCode = code;
    return res;
  };
  res.end = (s) => {
    res.body = s;
    try {
      res.jsonBody = s ? JSON.parse(s) : undefined;
    } catch {
      res.jsonBody = s;
    }
  };
  return res;
}
async function call(method, path, opts) {
  const req = makeReq(method, path, opts);
  const res = makeRes();
  const handled = await routes.handle(req, res, ctx);
  return { handled, status: res.statusCode, json: res.jsonBody };
}

// posta um alarme direto pelo ingest (autenticado por site-key) — exercita o caminho real de escrita.
async function ingest(siteId, siteKey, ev) {
  return call("POST", "/api/ingest/alarm", { headers: { "x-site-id": siteId, "x-site-key": siteKey }, body: ev });
}

describe.skipIf(!HAVE_PG)("Fase 2 — overview + alarms drill-down (Postgres real)", () => {
  const adminEmail = `${tag}_admin@x`;
  let platformToken = null;
  let partnerBToken = null;
  let pA = null;
  let pB = null;
  let cliA = null;
  let cliB = null;
  let siteA = null;
  let siteAKey = null;
  let siteB = null;
  let siteBKey = null;

  beforeAll(async () => {
    try {
      await db.init();
    } catch (e) {
      console.warn("[overview.pg.test] db.init ignorado:", e.message);
    }
    // platform-admin (o ovo-galinha, como o seed).
    const u = await stores.users.create({ email: adminEmail, senhaHash: password.hashPassword("segredo123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "platform", scope_id: null, role: "platform-admin" });
    const rl = await call("POST", "/api/login", { body: { email: adminEmail, senha: "segredo123" } });
    platformToken = rl.json.token;

    // Árvore: partner A (cliente A, site A) + partner B (cliente B, site B).
    pA = (await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnA` } })).json.id;
    pB = (await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnB` } })).json.id;
    cliA = (await call("POST", "/api/clientes", { token: platformToken, body: { partner_id: pA, nome: `${tag} CliA` } })).json.id;
    cliB = (await call("POST", "/api/clientes", { token: platformToken, body: { partner_id: pB, nome: `${tag} CliB` } })).json.id;
    const rsA = await call("POST", "/api/sites", { token: platformToken, body: { cliente_id: cliA, nome: `${tag} SiteA` } });
    const rsB = await call("POST", "/api/sites", { token: platformToken, body: { cliente_id: cliB, nome: `${tag} SiteB` } });
    siteA = rsA.json.id;
    siteAKey = rsA.json.site_key;
    siteB = rsB.json.id;
    siteBKey = rsB.json.site_key;

    // partner-admin de B (para provar o escopo).
    const ub = await stores.users.create({ email: `${tag}_padminB@x`, senhaHash: password.hashPassword("b123") });
    await stores.memberships.create({ user_id: ub.id, scope_type: "partner", scope_id: pB, role: "partner-admin" });
    partnerBToken = (await call("POST", "/api/login", { body: { email: `${tag}_padminB@x`, senha: "b123" } })).json.token;

    // Alarmes: site A recebe 2 DENTRO das 24h + 1 ANTIGO (25h atrás → não conta em alarms24h).
    // site B recebe 1 (para provar que NÃO vaza para o overview/alarms de A).
    const now = Date.now();
    await ingest(siteA, siteAKey, { id: "a1", ts: now - 1000, tipo: "queda", cameraLabel: "Doca 1" });
    await ingest(siteA, siteAKey, { id: "a2", ts: now - 2000, tipo: "fumaca", cameraLabel: "Doca 2" });
    await ingest(siteA, siteAKey, { id: "a3", ts: now - 25 * 3600 * 1000, tipo: "antigo", cameraLabel: "Doca 3" });
    await ingest(siteB, siteBKey, { id: "b1", ts: now - 1000, tipo: "invasao", cameraLabel: "Portao" });
  });

  afterAll(async () => {
    await db.end();
  });

  // ── OVERVIEW ────────────────────────────────────────────────────────────────
  it("overview (platform): vê partners/clientes/sites de A e B; alarms24h conta por site (janela 24h)", async () => {
    const r = await call("GET", "/api/overview", { token: platformToken });
    expect(r.status).toBe(200);
    expect(r.json.scope.scope_type).toBe("platform");
    const ids = r.json.sites.map((s) => s.id);
    expect(ids).toContain(siteA);
    expect(ids).toContain(siteB);
    const sA = r.json.sites.find((s) => s.id === siteA);
    const sB = r.json.sites.find((s) => s.id === siteB);
    // A tem 3 alarmes gravados mas só 2 nas últimas 24h (o de 25h atrás NÃO conta).
    expect(sA.alarms24h).toBe(2);
    expect(sB.alarms24h).toBe(1);
    expect(r.json.partners.map((p) => p.id)).toEqual(expect.arrayContaining([pA, pB]));
  });

  it("overview (partner-admin de B): NÃO vê nada de A — nem partner, nem cliente, nem site", async () => {
    const r = await call("GET", "/api/overview", { token: partnerBToken });
    expect(r.status).toBe(200);
    expect(r.json.scope.scope_type).toBe("partner");
    expect(r.json.partners.map((p) => p.id)).toEqual([pB]);
    expect(r.json.clientes.map((c) => c.id)).toEqual([cliB]);
    const siteIds = r.json.sites.map((s) => s.id);
    expect(siteIds).toContain(siteB);
    expect(siteIds).not.toContain(siteA);
    // e conta certo o que É seu.
    expect(r.json.sites.find((s) => s.id === siteB).alarms24h).toBe(1);
  });

  it("overview: online reflete last_seen (heartbeat recente = online; sem heartbeat = offline)", async () => {
    await call("POST", "/api/site/heartbeat", { headers: { "x-site-id": siteA, "x-site-key": siteAKey } });
    const r = await call("GET", "/api/overview", { token: platformToken });
    expect(r.json.sites.find((s) => s.id === siteA).online).toBe(true);
    expect(r.json.sites.find((s) => s.id === siteB).online).toBe(false); // nunca deu heartbeat
  });

  it("overview: sem token → 401", async () => {
    const r = await call("GET", "/api/overview", {});
    expect(r.status).toBe(401);
  });

  // ── DRILL-DOWN ──────────────────────────────────────────────────────────────
  it("alarms (platform em site A): lista desc por ts; withTenant isola — alarme de B NÃO aparece", async () => {
    const r = await call("GET", `/api/sites/${siteA}/alarms?since=0&limit=50`, { token: platformToken });
    expect(r.status).toBe(200);
    const tipos = r.json.alarms.map((a) => a.tipo);
    // since=0 pega os 3 (inclui o antigo); nenhum de B.
    expect(tipos).toContain("queda");
    expect(tipos).toContain("antigo");
    expect(tipos).not.toContain("invasao");
    // ordem desc por ts.
    const ts = r.json.alarms.map((a) => a.ts);
    expect(ts).toEqual([...ts].sort((x, y) => y - x));
  });

  it("alarms: since filtra pela janela (só os recentes)", async () => {
    const since = Date.now() - 24 * 3600 * 1000;
    const r = await call("GET", `/api/sites/${siteA}/alarms?since=${since}`, { token: platformToken });
    expect(r.json.alarms.map((a) => a.tipo)).not.toContain("antigo");
    expect(r.json.alarms.length).toBe(2);
  });

  it("alarms: limit é respeitado (teto de linhas)", async () => {
    const r = await call("GET", `/api/sites/${siteA}/alarms?since=0&limit=1`, { token: platformToken });
    expect(r.json.alarms.length).toBe(1);
  });

  it("alarms (partner-admin de B em site de A): 403 fora do escopo", async () => {
    const r = await call("GET", `/api/sites/${siteA}/alarms`, { token: partnerBToken });
    expect(r.status).toBe(403);
  });

  it("alarms (partner-admin de B no PRÓPRIO site B): 200 e vê só o seu", async () => {
    const r = await call("GET", `/api/sites/${siteB}/alarms?since=0`, { token: partnerBToken });
    expect(r.status).toBe(200);
    expect(r.json.alarms.map((a) => a.tipo)).toEqual(["invasao"]);
  });

  it("alarms: sem token → 401", async () => {
    const r = await call("GET", `/api/sites/${siteA}/alarms`, {});
    expect(r.status).toBe(401);
  });

  it("countAlarmsSince (unidade): lê SÓ o tenant pedido (RLS) — nunca soma o vizinho", async () => {
    const overview = require("./overview");
    const nA = await overview.countAlarmsSince(siteA, 0);
    const nB = await overview.countAlarmsSince(siteB, 0);
    expect(nA).toBe(3); // A: 3 no total (since=0)
    expect(nB).toBe(1); // B: 1 — isolado
  });
});

describe.runIf(!HAVE_PG)("Fase 2 — INTEGRAÇÃO NÃO EXECUTADA", () => {
  it("SKIP: sem Postgres (defina CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE)", () => {
    console.warn("\n[overview.pg.test] ⚠️  integração NÃO executada — sem Postgres. Suba um PG e reexecute.\n");
    expect(HAVE_PG).toBe(false);
  });
});
