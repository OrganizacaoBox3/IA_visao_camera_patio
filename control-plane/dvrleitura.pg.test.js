// PONTE DVR — LEITURA da UI do técnico (C-fe): GET /api/dvr/dvrs + GET /api/dvr/auditoria.
// EXIGE Postgres real (lê dvr/coletor/cliente/sessao/auditoria de verdade). Dirige routes.handle()
// com req/res mockados — o mesmo caminho do servidor. Sem PG → SKIP DECLARADO (padrão da casa).
//
// Prova:
//  • /api/dvr/dvrs (token+canAccess): lista o DVR com contexto (cliente_nome/coletor_nome/marca/
//    modelo/ip) e sessao=null quando não há túnel · reflete a sessão ATIVA (hostPublico/remotePort/
//    sessaoId) depois do abrir · volta a null depois do encerrar · NÃO vaza site_key/hash ·
//    canAccess barra cross-cliente (com DENTE: platform vê) · sem token → 401.
//  • /api/dvr/auditoria (token+canAccess): registra enrollment/registro/sessão (abrir/encerrar) ·
//    filtro ?coletor= restringe · canAccess barra cross-cliente (dente: platform vê) · sem token → 401.
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
const tag = `lei${process.pid}`;

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

describe.skipIf(!HAVE_PG)("Ponte DVR — leitura da UI do técnico (Postgres real)", () => {
  const adminEmail = `${tag}_dvradmin@x`;
  let platformToken = null;
  let partnerBToken = null;
  let cliA = null;
  let coletorId = null;
  let coletorKey = null;
  let dvrId = null;
  let sessaoId = null;
  let hostPublico = null;

  beforeAll(async () => {
    try {
      await db.init();
    } catch (e) {
      console.warn("[dvrleitura.pg.test] db.init ignorado:", e.message);
    }
    const u = await stores.users.create({ email: adminEmail, senhaHash: password.hashPassword("segredo123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "platform", scope_id: null, role: "platform-admin" });
    const rl = await call("POST", "/api/login", { body: { email: adminEmail, senha: "segredo123" } });
    platformToken = rl.json.token;
    // árvore partner→cliente A p/ pendurar o coletor/DVR.
    const rp = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnA` } });
    const rc = await call("POST", "/api/clientes", { token: platformToken, body: { partner_id: rp.json.id, nome: `${tag} CliA` } });
    cliA = rc.json.id;
    // enrollment + registro do DVR (o alvo da UI do técnico).
    const en = await call("POST", "/api/dvr/coletores", {
      token: platformToken,
      body: { cliente_id: cliA, empresa_id_box3: `${tag}_EMP`, nome: "Coletor Doca 1" },
    });
    coletorId = en.json.id;
    coletorKey = en.json.site_key;
    const reg = await call("POST", "/api/dvr/registrar", {
      headers: { "x-coletor-id": coletorId, "x-coletor-key": coletorKey },
      body: {
        dvr: { marca: "Intelbras", modelo: "MHDX 1108", ip: "192.168.1.108", porta: 80 },
        consentimento: { aceito: true, quando: Date.now(), versaoTexto: "consent-v1" },
      },
    });
    dvrId = reg.json.dvr.id;
  });

  afterAll(async () => {
    await db.end();
  });

  it("GET /api/dvr/dvrs: lista o DVR com contexto e sessao=null (sem túnel); não vaza site_key", async () => {
    const g = await call("GET", "/api/dvr/dvrs", { token: platformToken });
    expect(g.status).toBe(200);
    const mine = g.json.find((d) => d.id === dvrId);
    expect(mine).toBeTruthy();
    expect(mine.cliente_id).toBe(cliA);
    expect(mine.cliente_nome).toBe(`${tag} CliA`);
    expect(mine.coletor_nome).toBe("Coletor Doca 1");
    expect(mine.empresa_id_box3).toBe(`${tag}_EMP`);
    expect(mine.marca).toBe("Intelbras");
    expect(mine.modelo).toBe("MHDX 1108");
    expect(mine.ip).toBe("192.168.1.108");
    expect(mine.porta).toBe(80);
    expect(mine.sessao).toBeNull(); // sem sessão ativa ainda
    // NENHUMA credencial trafega na leitura.
    expect(mine.site_key).toBeUndefined();
    expect(mine.site_key_hash).toBeUndefined();
    expect(JSON.stringify(mine)).not.toContain("site_key");
  });

  it("GET /api/dvr/dvrs SEM token → 401", async () => {
    const g = await call("GET", "/api/dvr/dvrs", {});
    expect(g.status).toBe(401);
  });

  it("abrir a sessão (coletor) faz o DVR aparecer com sessão ATIVA (hostPublico/remotePort/sessaoId)", async () => {
    const ab = await call("POST", "/api/dvr/sessao/abrir", {
      headers: { "x-coletor-id": coletorId, "x-coletor-key": coletorKey },
    });
    expect([200, 201]).toContain(ab.status);
    sessaoId = ab.json.sessaoId;
    hostPublico = ab.json.hostPublico;
    expect(sessaoId).toBeTruthy();
    expect(hostPublico).toBeTruthy();

    const g = await call("GET", "/api/dvr/dvrs", { token: platformToken });
    const mine = g.json.find((d) => d.id === dvrId);
    expect(mine.sessao).toBeTruthy();
    expect(mine.sessao.status).toBe("ativa");
    expect(mine.sessao.sessaoId).toBe(sessaoId);
    expect(mine.sessao.hostPublico).toBe(hostPublico);
    expect(mine.sessao.remotePort).toBe(ab.json.remotePort);
  });

  it("canAccess barra a lista cross-cliente (partner B não vê o DVR de A; platform vê — dente)", async () => {
    const rp = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnB` } });
    const u = await stores.users.create({ email: `${tag}_padminB@x`, senhaHash: password.hashPassword("b123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "partner", scope_id: rp.json.id, role: "partner-admin" });
    const rl = await call("POST", "/api/login", { body: { email: `${tag}_padminB@x`, senha: "b123" } });
    partnerBToken = rl.json.token;

    const other = await call("GET", "/api/dvr/dvrs", { token: partnerBToken });
    expect(other.status).toBe(200);
    expect(other.json.map((d) => d.id)).not.toContain(dvrId);

    const seen = await call("GET", "/api/dvr/dvrs", { token: platformToken });
    expect(seen.json.map((d) => d.id)).toContain(dvrId);
  });

  it("encerrar pelo TÉCNICO: 403 sem acesso (partner B), 200 com acesso (platform) e some da lista", async () => {
    const denied = await call("POST", `/api/dvr/sessao/${sessaoId}/encerrar`, { token: partnerBToken });
    expect(denied.status).toBe(403);

    const ok = await call("POST", `/api/dvr/sessao/${sessaoId}/encerrar`, { token: platformToken });
    expect(ok.status).toBe(200);

    const g = await call("GET", "/api/dvr/dvrs", { token: platformToken });
    const mine = g.json.find((d) => d.id === dvrId);
    expect(mine.sessao).toBeNull(); // sessão encerrada some do mapa da UI
  });

  it("GET /api/dvr/auditoria: rastro de enrollment/registro/sessão; ?coletor= filtra", async () => {
    const g = await call("GET", "/api/dvr/auditoria", { token: platformToken });
    expect(g.status).toBe(200);
    const meus = g.json.filter((a) => a.coletor_id === coletorId);
    const acoes = meus.map((a) => a.acao);
    expect(acoes).toContain("enrollment");
    expect(acoes).toContain("dvr.registrar");
    expect(acoes).toContain("sessao.abrir");
    expect(acoes).toContain("sessao.encerrar");
    expect(meus.every((a) => a.em > 0)).toBe(true);
    expect(meus.every((a) => a.cliente_id === cliA)).toBe(true);

    const filtrado = await call("GET", `/api/dvr/auditoria?coletor=${encodeURIComponent(coletorId)}`, { token: platformToken });
    expect(filtrado.status).toBe(200);
    expect(filtrado.json.every((a) => a.coletor_id === coletorId)).toBe(true);
  });

  it("auditoria: canAccess barra cross-cliente (partner B não vê o rastro de A); sem token → 401", async () => {
    const other = await call("GET", "/api/dvr/auditoria", { token: partnerBToken });
    expect(other.status).toBe(200);
    expect(other.json.some((a) => a.coletor_id === coletorId)).toBe(false);

    const anon = await call("GET", "/api/dvr/auditoria", {});
    expect(anon.status).toBe(401);
  });
});

describe.runIf(!HAVE_PG)("Ponte DVR — leitura da UI do técnico: INTEGRAÇÃO NÃO EXECUTADA", () => {
  it("SKIP: sem Postgres (defina CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE)", () => {
    console.warn("\n[dvrleitura.pg.test] ⚠️  integração NÃO executada — sem Postgres. Suba um PG e reexecute.\n");
    expect(HAVE_PG).toBe(false);
  });
});
