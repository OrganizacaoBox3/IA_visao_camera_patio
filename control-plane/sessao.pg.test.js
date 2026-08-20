// PONTE DVR (F3 backend) — integração da SESSÃO (C-be-5) + LOGIN-PLUGIN do frps (C-be-4).
// EXIGE Postgres real (grava sessao/auditoria de verdade). Dirige routes.handle() com req/res
// mockados — o mesmo caminho do servidor. Sem PG → SKIP DECLARADO (padrão da casa).
//
// Prova:
//  • abrir (COLETOR/app, §4): aloca remotePort na faixa, devolve {sessaoId,relay,remotePort,hostPublico},
//    persiste o mapa de rota (rotasAtivas), audita · idempotente (reusa sessão ativa) · 409 sem DVR ·
//    401/404/403 (key errada/coletor inexistente/revogado).
//  • estado (poll do app): dono vê; coletor alheio → 404.
//  • encerrar: pelo coletor (app) e pelo técnico (token+canAccess); 403 sem acesso; idempotente;
//    some do mapa de rota; audita.
//  • login-plugin do frps: Login valida site_key (accept/reject no corpo, HTTP 200); NewProxy impõe
//    menor privilégio (só tcp, sessão ativa, porta = a alocada).
//  • timeout de inatividade: varrerOciosas encerra a sessão ociosa e a tira do mapa de rota.
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
const tag = `s${process.pid}`;

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
const colHeaders = (id, key) => ({ "x-coletor-id": id, "x-coletor-key": key });

// enrolla um coletor (emite site_key) e devolve {id,key}. Opcionalmente registra um DVR nele.
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

describe.skipIf(!HAVE_PG)("F3 backend — Sessão + login-plugin (Postgres real)", () => {
  let platformToken = null;
  let partnerBToken = null;
  let cliA = null;
  let colA = null; // com DVR
  let colB = null; // com DVR
  let colC = null; // SEM DVR
  let colR = null; // revogado
  let sessaoA = null;
  let remotePortA = null;

  beforeAll(async () => {
    try {
      await db.init();
    } catch (e) {
      console.warn("[sessao.pg.test] db.init ignorado:", e.message);
    }
    const u = await stores.users.create({ email: `${tag}_admin@x`, senhaHash: password.hashPassword("segredo123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "platform", scope_id: null, role: "platform-admin" });
    platformToken = (await call("POST", "/api/login", { body: { email: `${tag}_admin@x`, senha: "segredo123" } })).json.token;

    const rp = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} Ptn` } });
    const rc = await call("POST", "/api/clientes", { token: platformToken, body: { partner_id: rp.json.id, nome: `${tag} Cli Sessão` } });
    cliA = rc.json.id;

    // partner-B (sem acesso ao cliente A) — para o 403 do encerrar via técnico.
    const rpb = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnB` } });
    const ub = await stores.users.create({ email: `${tag}_padminB@x`, senhaHash: password.hashPassword("b123") });
    await stores.memberships.create({ user_id: ub.id, scope_type: "partner", scope_id: rpb.json.id, role: "partner-admin" });
    partnerBToken = (await call("POST", "/api/login", { body: { email: `${tag}_padminB@x`, senha: "b123" } })).json.token;

    colA = await enrolla(platformToken, cliA, `${tag}_A`, true);
    colB = await enrolla(platformToken, cliA, `${tag}_B`, true);
    colC = await enrolla(platformToken, cliA, `${tag}_C`, false);
    colR = await enrolla(platformToken, cliA, `${tag}_R`, false);
    await db.query("update coletor set revogado=true, revogado_em=$2 where id=$1", [colR.id, Date.now()]);
  });

  afterAll(async () => {
    await db.end();
  });

  // ── abrir ────────────────────────────────────────────────────────────────────
  it("abrir (coletor/app): 201 + {sessaoId, relay, remotePort∈faixa, hostPublico}", async () => {
    const r = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colA.id, colA.key) });
    expect(r.status).toBe(201);
    expect(r.json.sessaoId).toBeTruthy();
    expect(r.json.relay).toMatchObject({ serverAddr: expect.any(String), serverPort: expect.any(Number) });
    expect(r.json.remotePort).toBeGreaterThanOrEqual(20000);
    expect(r.json.remotePort).toBeLessThanOrEqual(20099);
    expect(r.json.hostPublico).toMatch(/\.dvr\.box3\.software$/);
    sessaoA = r.json.sessaoId;
    remotePortA = r.json.remotePort;
  });

  it("abrir é IDEMPOTENTE por coletor: 2ª chamada reusa a sessão ativa (200, mesmo id/porta)", async () => {
    const r = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colA.id, colA.key) });
    expect(r.status).toBe(200);
    expect(r.json.sessaoId).toBe(sessaoA);
    expect(r.json.remotePort).toBe(remotePortA);
  });

  it("abrir sem DVR registrado → 409", async () => {
    const r = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colC.id, colC.key) });
    expect(r.status).toBe(409);
  });

  it("abrir com key errada → 401 · coletor inexistente → 404 · revogado → 403", async () => {
    expect((await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colA.id, "errada") })).status).toBe(401);
    expect((await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders("col_fantasma", "x") })).status).toBe(404);
    expect((await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colR.id, colR.key) })).status).toBe(403);
  });

  // ── estado (poll) ──────────────────────────────────────────────────────────--
  it("estado: o dono vê 'ativa'; coletor ALHEIO → 404", async () => {
    const own = await call("GET", `/api/dvr/sessao/${sessaoA}`, { headers: colHeaders(colA.id, colA.key) });
    expect(own.status).toBe(200);
    expect(own.json.status).toBe("ativa");
    const alheio = await call("GET", `/api/dvr/sessao/${sessaoA}`, { headers: colHeaders(colB.id, colB.key) });
    expect(alheio.status).toBe(404);
  });

  // ── mapa de rota (o que o nginx/B-3 vai ler) ──────────────────────────────────
  it("a sessão ativa aparece no MAPA DE ROTA (rotasAtivas: host→porta→dvr)", async () => {
    const rotas = await stores.sessoes.rotasAtivas();
    const minha = rotas.find((x) => x.remote_port === remotePortA);
    expect(minha).toBeTruthy();
    expect(minha.host_publico).toMatch(/\.dvr\.box3\.software$/);
    expect(minha.dvr_id).toBeTruthy();
  });

  // ── login-plugin do frps: Login ───────────────────────────────────────────────
  it("frp-login Login: site_key correta → aceita (reject:false, unchange:true, HTTP 200)", async () => {
    const r = await call("POST", "/api/dvr/frp-login", {
      body: { op: "Login", content: { user: colA.id, metas: { coletorId: colA.id, siteKey: colA.key } } },
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ reject: false, unchange: true });
  });

  it("frp-login Login: site_key errada / revogado / inexistente → reject (no corpo, HTTP 200)", async () => {
    const errada = await call("POST", "/api/dvr/frp-login", { body: { op: "Login", content: { metas: { coletorId: colA.id, siteKey: "x" } } } });
    expect(errada.status).toBe(200);
    expect(errada.json.reject).toBe(true);

    const rev = await call("POST", "/api/dvr/frp-login", { body: { op: "Login", content: { metas: { coletorId: colR.id, siteKey: colR.key } } } });
    expect(rev.json.reject).toBe(true);
    expect(rev.json.reject_reason).toMatch(/revogado/);

    const nao = await call("POST", "/api/dvr/frp-login", { body: { op: "Login", content: { metas: { coletorId: "col_x", siteKey: "y" } } } });
    expect(nao.json.reject).toBe(true);
  });

  it("frp-login op não gerenciada (Ping) → aceita sem mudança", async () => {
    const r = await call("POST", "/api/dvr/frp-login", { body: { op: "Ping", content: {} } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ reject: false, unchange: true });
  });

  // ── login-plugin do frps: NewProxy (menor privilégio, contratos §2) ────────────
  it("frp-login NewProxy: tcp + sessão ativa + porta alocada → aceita", async () => {
    const r = await call("POST", "/api/dvr/frp-login", {
      body: { op: "NewProxy", content: { proxy_type: "tcp", remote_port: remotePortA, user: { user: colA.id, metas: { coletorId: colA.id, siteKey: colA.key } } } },
    });
    expect(r.json).toEqual({ reject: false, unchange: true });
  });

  it("frp-login NewProxy: porta != alocada → reject", async () => {
    const outra = remotePortA === 20099 ? 20098 : remotePortA + 1;
    const r = await call("POST", "/api/dvr/frp-login", {
      body: { op: "NewProxy", content: { proxy_type: "tcp", remote_port: outra, user: { user: colA.id, metas: { coletorId: colA.id, siteKey: colA.key } } } },
    });
    expect(r.json.reject).toBe(true);
    expect(r.json.reject_reason).toMatch(/porta alocada/);
  });

  it("frp-login NewProxy: tipo != tcp → reject (menor privilégio)", async () => {
    const r = await call("POST", "/api/dvr/frp-login", {
      body: { op: "NewProxy", content: { proxy_type: "http", user: { metas: { coletorId: colA.id, siteKey: colA.key } } } },
    });
    expect(r.json.reject).toBe(true);
    expect(r.json.reject_reason).toMatch(/tcp/);
  });

  it("frp-login NewProxy: coletor SEM sessão ativa → reject", async () => {
    const r = await call("POST", "/api/dvr/frp-login", {
      body: { op: "NewProxy", content: { proxy_type: "tcp", remote_port: 20050, user: { metas: { coletorId: colC.id, siteKey: colC.key } } } },
    });
    expect(r.json.reject).toBe(true);
    expect(r.json.reject_reason).toMatch(/sem sessão ativa/);
  });

  // ── encerrar (coletor) ─────────────────────────────────────────────────────────
  it("encerrar pelo COLETOR (app): 200 → estado vira 'encerrada' e some do mapa de rota", async () => {
    const r = await call("POST", `/api/dvr/sessao/${sessaoA}/encerrar`, { headers: colHeaders(colA.id, colA.key) });
    expect(r.status).toBe(200);
    const est = await call("GET", `/api/dvr/sessao/${sessaoA}`, { headers: colHeaders(colA.id, colA.key) });
    expect(est.json.status).toBe("encerrada");
    const rotas = await stores.sessoes.rotasAtivas();
    expect(rotas.find((x) => x.remote_port === remotePortA)).toBeUndefined();
  });

  it("encerrar é idempotente (2ª chamada ainda 200)", async () => {
    const r = await call("POST", `/api/dvr/sessao/${sessaoA}/encerrar`, { headers: colHeaders(colA.id, colA.key) });
    expect(r.status).toBe(200);
  });

  // ── encerrar (técnico via token) ────────────────────────────────────────────--
  it("encerrar pelo TÉCNICO (token + canAccess): 200; sem acesso → 403", async () => {
    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colB.id, colB.key) });
    expect([200, 201]).toContain(ab.status);
    const sessaoB = ab.json.sessaoId;

    const negado = await call("POST", `/api/dvr/sessao/${sessaoB}/encerrar`, { token: partnerBToken });
    expect(negado.status).toBe(403);

    const ok = await call("POST", `/api/dvr/sessao/${sessaoB}/encerrar`, { token: platformToken });
    expect(ok.status).toBe(200);
    const est = await call("GET", `/api/dvr/sessao/${sessaoB}`, { headers: colHeaders(colB.id, colB.key) });
    expect(est.json.status).toBe("encerrada");
  });

  // ── timeout de inatividade ─────────────────────────────────────────────────────
  it("timeout: varrerOciosas encerra a sessão ociosa e a tira do mapa de rota", async () => {
    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: colHeaders(colA.id, colA.key) });
    const idOcioso = ab.json.sessaoId;
    const portaOciosa = ab.json.remotePort;
    // backdata a última atividade para MUITO antes do idle.
    await db.query("update sessao set ultima_atividade=$2 where id=$1", [idOcioso, Date.now() - 60_000]);
    const encerradas = await stores.sessoes.varrerOciosas({ idleMs: 1000, agora: Date.now() });
    expect(encerradas.map((x) => x.id)).toContain(idOcioso);
    const s = await stores.sessoes.get(idOcioso);
    expect(s.status).toBe("encerrada");
    const rotas = await stores.sessoes.rotasAtivas();
    expect(rotas.find((x) => x.remote_port === portaOciosa)).toBeUndefined();
  });

  // ── auditoria ──────────────────────────────────────────────────────────────────
  it("auditoria: sessao.abrir e sessao.encerrar deixaram rastro (quem/qual/quando)", async () => {
    const rows = await stores.auditoriaDvr.list(1000);
    const doColA = rows.filter((x) => x.coletor_id === colA.id);
    expect(doColA.some((x) => x.acao === "sessao.abrir")).toBe(true);
    expect(doColA.some((x) => x.acao === "sessao.encerrar")).toBe(true);
    expect(doColA.every((x) => x.em > 0)).toBe(true);
  });
});

describe.runIf(!HAVE_PG)("F3 backend — Sessão + login-plugin: INTEGRAÇÃO NÃO EXECUTADA", () => {
  it("SKIP: sem Postgres (defina CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE)", () => {
    console.warn("\n[sessao.pg.test] ⚠️  integração NÃO executada — sem Postgres. Suba um PG e reexecute.\n");
    expect(HAVE_PG).toBe(false);
  });
});
