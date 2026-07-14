// Integração da Fase 1 — EXIGE Postgres real (CRUD grava de verdade, ingest escreve alarm_event
// via withTenant, heartbeat carimba last_seen). Dirige routes.handle() com req/res mockados, o
// mesmo caminho do servidor. Sem PG → SKIP DECLARADO (padrão da casa, como rls.test.js).
//
// Prova: login (escopo maior privilégio) · CRUD sob canAccess · NEGAÇÃO cross-partner (com DENTE:
// platform ainda vê) · site_key crua devolvida 1x e nunca reexposta · ingest 202/401/404 ·
// heartbeat 200 + last_seen. Reaproveita db.configured()/db.init() da Fase 0.
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
const tag = `t${process.pid}`;

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

describe.skipIf(!HAVE_PG)("Fase 1 — cadastro/login/ingest (Postgres real)", () => {
  const adminEmail = `${tag}_admin@x`;
  let platformToken = null;
  let partnerBToken = null;
  let pA = null;
  let pB = null;
  let cliA = null;
  let siteA = null;
  let siteAKey = null;

  beforeAll(async () => {
    try {
      await db.init();
    } catch (e) {
      console.warn("[cadastro.pg.test] db.init ignorado:", e.message);
    }
    // platform-admin direto no store (o ovo-galinha; o seed faz o mesmo).
    const u = await stores.users.create({ email: adminEmail, senhaHash: password.hashPassword("segredo123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "platform", scope_id: null, role: "platform-admin" });
  });

  afterAll(async () => {
    await db.end();
  });

  it("login: platform-admin autentica e recebe token de escopo platform", async () => {
    const r = await call("POST", "/api/login", { body: { email: adminEmail, senha: "segredo123" } });
    expect(r.status).toBe(200);
    expect(r.json.token).toBeTruthy();
    expect(r.json.scope.scope_type).toBe("platform");
    platformToken = r.json.token;
  });

  it("login: senha errada → 401", async () => {
    const r = await call("POST", "/api/login", { body: { email: adminEmail, senha: "errada" } });
    expect(r.status).toBe(401);
  });

  it("platform cria partner A e partner B", async () => {
    const ra = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnA` } });
    const rb = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnB` } });
    expect(ra.status).toBe(201);
    expect(rb.status).toBe(201);
    pA = ra.json.id;
    pB = rb.json.id;
  });

  it("não-platform NÃO cria partner (403)", async () => {
    // um token de site-operator forjado só p/ o teste (assinado pelo próprio auth do plane).
    const auth = require("./auth");
    const opToken = auth.signToken({ id: "x", papel: "site-operator", scope_type: "site", scope_id: "sZ" });
    const r = await call("POST", "/api/partners", { token: opToken, body: { nome: "hack" } });
    expect(r.status).toBe(403);
  });

  it("platform cria cliente sob A e site (recebe site_key CRUA uma vez)", async () => {
    const rc = await call("POST", "/api/clientes", { token: platformToken, body: { partner_id: pA, nome: `${tag} CliA` } });
    expect(rc.status).toBe(201);
    cliA = rc.json.id;
    const rs = await call("POST", "/api/sites", { token: platformToken, body: { cliente_id: cliA, nome: `${tag} SiteA` } });
    expect(rs.status).toBe(201);
    expect(rs.json.site_key).toBeTruthy(); // chave crua devolvida UMA vez
    siteA = rs.json.id;
    siteAKey = rs.json.site_key;
  });

  it("site_key NÃO é reexposta em GET/list (só o hash vive no banco)", async () => {
    const g = await call("GET", `/api/sites/${siteA}`, { token: platformToken });
    expect(g.status).toBe(200);
    expect(g.json.site_key).toBeUndefined();
    expect(g.json.site_key_hash).toBeUndefined();
  });

  it("cliente inexistente ao criar site → 404", async () => {
    const r = await call("POST", "/api/sites", { token: platformToken, body: { cliente_id: "c_nao_existe", nome: "x" } });
    expect(r.status).toBe(404);
  });

  it("NEGAÇÃO cross-partner: partner-admin de B não vê o site de A; platform vê (dente)", async () => {
    // cria um partner-admin de B e loga.
    const u = await stores.users.create({ email: `${tag}_padminB@x`, senhaHash: password.hashPassword("b123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "partner", scope_id: pB, role: "partner-admin" });
    const rl = await call("POST", "/api/login", { body: { email: `${tag}_padminB@x`, senha: "b123" } });
    expect(rl.json.scope.scope_type).toBe("partner");
    partnerBToken = rl.json.token;

    const denied = await call("GET", `/api/sites/${siteA}`, { token: partnerBToken });
    expect(denied.status).toBe(403);

    const list = await call("GET", "/api/sites", { token: partnerBToken });
    expect(list.status).toBe(200);
    expect(list.json.map((s) => s.id)).not.toContain(siteA);

    // DENTE: o platform enxerga o mesmo site (prova que 403 acima é do guard, não erro genérico).
    const seen = await call("GET", `/api/sites/${siteA}`, { token: platformToken });
    expect(seen.status).toBe(200);
    expect(seen.json.id).toBe(siteA);
  });

  it("membership: partner-admin de B NÃO concede papel em site de A (403)", async () => {
    const uv = await stores.users.create({ email: `${tag}_victim@x`, senhaHash: password.hashPassword("v") });
    const r = await call("POST", "/api/memberships", {
      token: partnerBToken,
      body: { user_id: uv.id, scope_type: "site", scope_id: siteA, role: "site-operator" },
    });
    expect(r.status).toBe(403);
  });

  it("ingest: site_key CORRETA grava alarm_event (202)", async () => {
    const ev = { id: "a1", ts: Date.now(), cameraId: "cam1", cameraLabel: "Doca 1", zona: "z1", tipo: "queda", priority: "critical", text: "queda detectada", state: "new" };
    const r = await call("POST", "/api/ingest/alarm", { headers: { "x-site-id": siteA, "x-site-key": siteAKey }, body: ev });
    expect(r.status).toBe(202);
    // confirma a linha via withTenant (exercita o gate RLS: só o tenant do site A a enxerga).
    const rows = await db.withTenant(siteA, async (cl) => (await cl.query("select tipo, meta from alarm_event where site_id=$1", [siteA])).rows);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((x) => x.tipo === "queda")).toBe(true);
    expect(rows.some((x) => x.meta && x.meta.cameraLabel === "Doca 1")).toBe(true);
  });

  it("ingest: site_key ERRADA → 401", async () => {
    const r = await call("POST", "/api/ingest/alarm", { headers: { "x-site-id": siteA, "x-site-key": "chave-errada" }, body: { tipo: "x", ts: 1 } });
    expect(r.status).toBe(401);
  });

  it("ingest: site inexistente → 404", async () => {
    const r = await call("POST", "/api/ingest/alarm", { headers: { "x-site-id": "s_fantasma", "x-site-key": siteAKey }, body: { tipo: "x", ts: 1 } });
    expect(r.status).toBe(404);
  });

  it("heartbeat: correta atualiza last_seen (200)", async () => {
    const r = await call("POST", "/api/site/heartbeat", { headers: { "x-site-id": siteA, "x-site-key": siteAKey } });
    expect(r.status).toBe(200);
    const g = await call("GET", `/api/sites/${siteA}`, { token: platformToken });
    expect(g.json.last_seen).toBeTruthy();
  });

  it("heartbeat: site_key errada → 401", async () => {
    const r = await call("POST", "/api/site/heartbeat", { headers: { "x-site-id": siteA, "x-site-key": "nope" } });
    expect(r.status).toBe(401);
  });
});

describe.runIf(!HAVE_PG)("Fase 1 — INTEGRAÇÃO NÃO EXECUTADA", () => {
  it("SKIP: sem Postgres (defina CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE)", () => {
    console.warn("\n[cadastro.pg.test] ⚠️  integração NÃO executada — sem Postgres. Suba um PG e reexecute.\n");
    expect(HAVE_PG).toBe(false);
  });
});
