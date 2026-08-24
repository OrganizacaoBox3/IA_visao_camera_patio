// PONTE DVR (F4 backend) — /_dvr_auth + cookie de sessão (C-be-6/C-be-7). EXIGE Postgres real
// (grava sessao/auditoria, casa Host↔DVR↔técnico de verdade). Dirige routes.handle() com req/res
// mockados — o MESMO caminho do servidor. Sem PG → SKIP DECLARADO (padrão da casa).
//
// Prova (contratos §5):
//  • login SETA o cookie de sessão (HttpOnly/Secure/SameSite, domínio pai) — C-be-7.
//  • /_dvr_auth: 200 casando cookie(técnico) + X-Original-Host(DVR) + canAccess; devolve o header
//    X-Dvr-Upstream (loopback:remotePort) que alimenta o upstream dinâmico do nginx.
//  • 401 sem cookie / cookie inválido / host sem sessão ativa / sessão encerrada.
//  • 403 técnico autenticado SEM acesso ao cliente daquele DVR.
//  • renova ultima_atividade a cada acesso (tocarAtividade).
//  • timeout de inatividade: sessão ociosa ⇒ /_dvr_auth encerra + audita 'sessao.timeout' + 401.
//  • auditoria: 'acesso.tecnico' deixa rastro (quem/qual DVR/quando).
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
const tag = `a${process.pid}`;

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
  const res = { statusCode: 0, headers: {}, body: undefined, jsonBody: undefined };
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v;
  };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.writeHead = (code, hdrs) => {
    res.statusCode = code;
    if (hdrs) for (const [k, v] of Object.entries(hdrs)) res.headers[String(k).toLowerCase()] = v;
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
  return { handled, status: res.statusCode, json: res.jsonBody, headers: res.headers };
}
const colHeaders = (id, key) => ({ "x-coletor-id": id, "x-coletor-key": key });

// login e devolve { token, cookie } — cookie = o 1º segmento do Set-Cookie ("cp_session=<enc>").
async function login(email, senha) {
  const r = await call("POST", "/api/login", { body: { email, senha } });
  const sc = r.headers["set-cookie"];
  return { status: r.status, token: r.json && r.json.token, setCookie: sc, cookie: sc ? String(sc).split(";")[0] : "" };
}

async function enrolla(token, cliente_id, empresa, comDvr) {
  const en = await call("POST", "/api/dvr/coletores", { token, body: { cliente_id, empresa_id_box3: empresa } });
  const id = en.json.id;
  const key = en.json.site_key;
  if (comDvr) {
    const r = await call("POST", "/api/dvr/registrar", {
      headers: colHeaders(id, key),
      body: { dvr: { marca: "Intelbras", modelo: "MHDX 1108", ip: "192.168.1.108", porta: 80 }, consentimento: { aceito: true } },
    });
    expect(r.status).toBe(201);
  }
  return { id, key };
}

describe.skipIf(!HAVE_PG)("F4 backend — /_dvr_auth + cookie (Postgres real)", () => {
  let platform = null; // {token, cookie}
  let partnerB = null; // {token, cookie} — sem acesso ao cliente A
  let cliA = null;
  let colA = null;
  let colB = null;
  let hostA = null;
  let portA = null;

  beforeAll(async () => {
    process.env.CP_DVR_AUDIT_THROTTLE_MS = "0"; // audita CADA acesso (determinístico p/ o teste)
    try {
      await db.init();
    } catch (e) {
      console.warn("[dvrauth.pg.test] db.init ignorado:", e.message);
    }
    const u = await stores.users.create({ email: `${tag}_admin@x`, senhaHash: password.hashPassword("segredo123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "platform", scope_id: null, role: "platform-admin" });
    platform = await login(`${tag}_admin@x`, "segredo123");

    const rp = await call("POST", "/api/partners", { token: platform.token, body: { nome: `${tag} Ptn` } });
    const rc = await call("POST", "/api/clientes", { token: platform.token, body: { partner_id: rp.json.id, nome: `${tag} Cli Auth` } });
    cliA = rc.json.id;

    // partner-B: autenticado, mas SEM acesso ao cliente A → 403 no /_dvr_auth.
    const rpb = await call("POST", "/api/partners", { token: platform.token, body: { nome: `${tag} PtnB` } });
    const ub = await stores.users.create({ email: `${tag}_padminB@x`, senhaHash: password.hashPassword("b123") });
    await stores.memberships.create({ user_id: ub.id, scope_type: "partner", scope_id: rpb.json.id, role: "partner-admin" });
    partnerB = await login(`${tag}_padminB@x`, "b123");

    colA = await enrolla(platform.token, cliA, `${tag}_A`, true);
    colB = await enrolla(platform.token, cliA, `${tag}_B`, true);

    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colA.id, colA.key) });
    expect(ab.status).toBe(201);
    hostA = ab.json.hostPublico;
    portA = ab.json.remotePort;
  });

  afterAll(async () => {
    await db.end();
  });

  // ── C-be-7: o login seta o cookie ─────────────────────────────────────────────
  it("login SETA Set-Cookie (cp_session, HttpOnly, Secure, SameSite, Domain pai)", () => {
    expect(platform.setCookie).toBeTruthy();
    const sc = String(platform.setCookie);
    expect(sc).toContain("cp_session=");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("Secure");
    expect(sc).toMatch(/SameSite=/i);
    expect(sc).toContain("Domain=.box3.software");
  });

  // ── C-be-6: happy path ─────────────────────────────────────────────────────────
  it("200: cookie(técnico) + Host(DVR) + acesso → libera e devolve X-Dvr-Upstream", async () => {
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": hostA } });
    expect(r.status).toBe(200);
    expect(r.headers["x-dvr-upstream"]).toBe(`127.0.0.1:${portA}`);
    expect(r.headers["x-dvr-sessao"]).toBeTruthy();
    expect(r.json.remotePort).toBe(portA);
  });

  it("aceita o Host com porta e case-insensitive (X-Original-Host = HOSTA:443)", async () => {
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": `${hostA.toUpperCase()}:443` } });
    expect(r.status).toBe(200);
  });

  // ── 401 / 403 ──────────────────────────────────────────────────────────────────
  it("401 sem cookie", async () => {
    const r = await call("GET", "/_dvr_auth", { headers: { "x-original-host": hostA } });
    expect(r.status).toBe(401);
  });
  it("401 cookie inválido (token corrompido)", async () => {
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: "cp_session=nao.eh.token", "x-original-host": hostA } });
    expect(r.status).toBe(401);
  });
  it("401 host sem sessão ativa (subdomínio desconhecido)", async () => {
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": "fantasma-000000.dvr.box3.software" } });
    expect(r.status).toBe(401);
  });
  it("403 técnico autenticado SEM acesso ao cliente do DVR", async () => {
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: partnerB.cookie, "x-original-host": hostA } });
    expect(r.status).toBe(403);
  });

  // ── renovação do timeout ─────────────────────────────────────────────────────--
  it("renova ultima_atividade a cada acesso (tocarAtividade)", async () => {
    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colA.id, colA.key) }); // reusa a ativa
    const sid = ab.json.sessaoId;
    await db.query("update sessao set ultima_atividade=$2 where id=$1", [sid, Date.now() - 5000]);
    const antes = (await stores.sessoes.get(sid)).ultima_atividade;
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": hostA } });
    expect(r.status).toBe(200);
    const depois = (await stores.sessoes.get(sid)).ultima_atividade;
    expect(depois).toBeGreaterThan(antes);
  });

  // ── auditoria do acesso ──────────────────────────────────────────────────────--
  it("auditoria: 'acesso.tecnico' deixou rastro (quem/qual DVR/quando)", async () => {
    await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": hostA } });
    const rows = await stores.auditoriaDvr.list(1000);
    const acessos = rows.filter((x) => x.coletor_id === colA.id && x.acao === "acesso.tecnico");
    expect(acessos.length).toBeGreaterThan(0);
    expect(acessos.every((x) => x.em > 0)).toBe(true);
  });

  // ── sessão encerrada → 401 ─────────────────────────────────────────────────────
  it("401 quando a sessão do host foi ENCERRADA (túnel caiu)", async () => {
    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colB.id, colB.key) });
    const hostB = ab.json.hostPublico;
    const sidB = ab.json.sessaoId;
    // sanity: com sessão ativa, libera
    const ok = await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": hostB } });
    expect(ok.status).toBe(200);
    await call("POST", `/api/dvr/sessao/${sidB}/encerrar`, { headers: colHeaders(colB.id, colB.key) });
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": hostB } });
    expect(r.status).toBe(401);
  });

  // ── timeout de inatividade VIA /_dvr_auth (camada 1 do de-risking §5) ──────────--
  it("timeout: sessão ociosa ⇒ /_dvr_auth encerra + audita 'sessao.timeout' + 401", async () => {
    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colB.id, colB.key) }); // nova sessão ativa
    const hostB = ab.json.hostPublico;
    const sidB = ab.json.sessaoId;
    // backdata MUITO além do idle default (20min).
    await db.query("update sessao set ultima_atividade=$2 where id=$1", [sidB, Date.now() - 3_600_000]);
    const r = await call("GET", "/_dvr_auth", { headers: { cookie: platform.cookie, "x-original-host": hostB } });
    expect(r.status).toBe(401);
    const s = await stores.sessoes.get(sidB);
    expect(s.status).toBe("encerrada");
    const rows = await stores.auditoriaDvr.list(1000);
    const to = rows.filter((x) => x.coletor_id === colB.id && x.acao === "sessao.timeout");
    expect(to.length).toBeGreaterThan(0);
  });
});

describe.runIf(!HAVE_PG)("F4 backend — /_dvr_auth + cookie: INTEGRAÇÃO NÃO EXECUTADA", () => {
  it("SKIP: sem Postgres (defina CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE)", () => {
    console.warn("\n[dvrauth.pg.test] ⚠️  integração NÃO executada — sem Postgres. Suba um PG e reexecute.\n");
    expect(HAVE_PG).toBe(false);
  });
});
