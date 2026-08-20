// PONTE DVR — integração da Fase 2 (enrollment + registro). EXIGE Postgres real (grava coletor/
// dvr/auditoria de verdade). Dirige routes.handle() com req/res mockados — o mesmo caminho do
// servidor. Sem PG → SKIP DECLARADO (padrão da casa, como cadastro.pg.test.js/rls.test.js).
//
// Prova: enrollment emite site_key CRUA 1x e nunca a reexpõe · canAccess barra enrollment
// cross-cliente (com DENTE: platform vê) · registro por site_key grava DVR + consentimento ·
// idempotência por coletor (2ª chamada atualiza, mesmo id) · site_key errada 401 / coletor
// inexistente 404 / revogado 403 / sem consentimento 400 · auditoria registra enrollment+registro.
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

describe.skipIf(!HAVE_PG)("Fase 2 — Ponte DVR: enrollment + registro (Postgres real)", () => {
  const adminEmail = `${tag}_dvradmin@x`;
  let platformToken = null;
  let partnerBToken = null;
  let cliA = null;
  let coletorId = null;
  let coletorKey = null;
  let dvrId = null;

  beforeAll(async () => {
    try {
      await db.init();
    } catch (e) {
      console.warn("[dvr.pg.test] db.init ignorado:", e.message);
    }
    const u = await stores.users.create({ email: adminEmail, senhaHash: password.hashPassword("segredo123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "platform", scope_id: null, role: "platform-admin" });
    const rl = await call("POST", "/api/login", { body: { email: adminEmail, senha: "segredo123" } });
    platformToken = rl.json.token;
    // uma árvore partner→cliente p/ pendurar o coletor.
    const rp = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnDVR` } });
    const rc = await call("POST", "/api/clientes", { token: platformToken, body: { partner_id: rp.json.id, nome: `${tag} CliDVR` } });
    cliA = rc.json.id;
  });

  afterAll(async () => {
    await db.end();
  });

  it("enrollment: liga empresa(box3)↔cliente e emite site_key CRUA uma vez", async () => {
    const r = await call("POST", "/api/dvr/coletores", {
      token: platformToken,
      body: { cliente_id: cliA, empresa_id_box3: `${tag}_EMP`, nome: "Coletor Doca 1" },
    });
    expect(r.status).toBe(201);
    expect(r.json.id).toBeTruthy();
    expect(r.json.site_key).toBeTruthy(); // chave crua devolvida UMA vez
    expect(r.json.empresa_id_box3).toBe(`${tag}_EMP`);
    coletorId = r.json.id;
    coletorKey = r.json.site_key;
  });

  it("enrollment sem cliente_id/empresa_id_box3 → 400", async () => {
    const r1 = await call("POST", "/api/dvr/coletores", { token: platformToken, body: { empresa_id_box3: "x" } });
    expect(r1.status).toBe(400);
    const r2 = await call("POST", "/api/dvr/coletores", { token: platformToken, body: { cliente_id: cliA } });
    expect(r2.status).toBe(400);
  });

  it("enrollment em cliente inexistente → 404", async () => {
    const r = await call("POST", "/api/dvr/coletores", { token: platformToken, body: { cliente_id: "c_fantasma", empresa_id_box3: "x" } });
    expect(r.status).toBe(404);
  });

  it("site_key/hash do coletor NÃO é reexposta em GET (list)", async () => {
    const g = await call("GET", "/api/dvr/coletores", { token: platformToken });
    expect(g.status).toBe(200);
    const mine = g.json.find((k) => k.id === coletorId);
    expect(mine).toBeTruthy();
    expect(mine.site_key).toBeUndefined();
    expect(mine.site_key_hash).toBeUndefined();
  });

  it("NEGAÇÃO cross-cliente: partner-admin de OUTRO partner não enrolla no cliente A; platform sim (dente)", async () => {
    const rp = await call("POST", "/api/partners", { token: platformToken, body: { nome: `${tag} PtnB` } });
    const u = await stores.users.create({ email: `${tag}_padminB@x`, senhaHash: password.hashPassword("b123") });
    await stores.memberships.create({ user_id: u.id, scope_type: "partner", scope_id: rp.json.id, role: "partner-admin" });
    const rl = await call("POST", "/api/login", { body: { email: `${tag}_padminB@x`, senha: "b123" } });
    partnerBToken = rl.json.token;

    const denied = await call("POST", "/api/dvr/coletores", { token: partnerBToken, body: { cliente_id: cliA, empresa_id_box3: "hack" } });
    expect(denied.status).toBe(403);

    const list = await call("GET", "/api/dvr/coletores", { token: partnerBToken });
    expect(list.status).toBe(200);
    expect(list.json.map((k) => k.id)).not.toContain(coletorId);

    // DENTE: platform enxerga o coletor de A (prova que o 403 é do guard, não erro genérico).
    const seen = await call("GET", "/api/dvr/coletores", { token: platformToken });
    expect(seen.json.map((k) => k.id)).toContain(coletorId);
  });

  it("registro: site_key CORRETA grava o DVR + consentimento (201)", async () => {
    const r = await call("POST", "/api/dvr/registrar", {
      headers: { "x-coletor-id": coletorId, "x-coletor-key": coletorKey },
      body: {
        dvr: { marca: "Intelbras", modelo: "MHDX 1108", ip: "192.168.1.108", porta: 80, senha: "NAO-DEVE-PERSISTIR" },
        consentimento: { aceito: true, quando: Date.now(), versaoTexto: "consent-v1" },
      },
    });
    expect(r.status).toBe(201);
    expect(r.json.dvr.marca).toBe("Intelbras");
    expect(r.json.dvr.consentimento_aceito).toBe(true);
    dvrId = r.json.dvr.id;
    // a credencial do DVR NUNCA trafega/persiste: nada de "senha" no que voltou nem na linha.
    expect(JSON.stringify(r.json)).not.toContain("NAO-DEVE-PERSISTIR");
    const row = await stores.dvrs.get(dvrId);
    expect(Object.keys(row)).not.toContain("senha");
    expect(JSON.stringify(row)).not.toContain("NAO-DEVE-PERSISTIR");
  });

  it("registro é IDEMPOTENTE por coletor (2ª chamada atualiza, mesmo id, 200)", async () => {
    const r = await call("POST", "/api/dvr/registrar", {
      headers: { "x-coletor-id": coletorId, "x-coletor-key": coletorKey },
      body: { dvr: { marca: "Dahua", modelo: "XVR", ip: "192.168.1.200", porta: 8000 }, consentimento: { aceito: true } },
    });
    expect(r.status).toBe(200);
    expect(r.json.dvr.id).toBe(dvrId); // mesmo DVR (1 por coletor)
    expect(r.json.dvr.marca).toBe("Dahua"); // atualizado
    expect(r.json.dvr.porta).toBe(8000);
  });

  it("registro sem consentimento → 400", async () => {
    const r = await call("POST", "/api/dvr/registrar", {
      headers: { "x-coletor-id": coletorId, "x-coletor-key": coletorKey },
      body: { dvr: { marca: "x" } },
    });
    expect(r.status).toBe(400);
  });

  it("registro com site_key ERRADA → 401", async () => {
    const r = await call("POST", "/api/dvr/registrar", {
      headers: { "x-coletor-id": coletorId, "x-coletor-key": "chave-errada" },
      body: { dvr: { marca: "x" }, consentimento: { aceito: true } },
    });
    expect(r.status).toBe(401);
  });

  it("registro com coletor inexistente → 404", async () => {
    const r = await call("POST", "/api/dvr/registrar", {
      headers: { "x-coletor-id": "col_fantasma", "x-coletor-key": coletorKey },
      body: { dvr: { marca: "x" }, consentimento: { aceito: true } },
    });
    expect(r.status).toBe(404);
  });

  it("registro com coletor REVOGADO → 403 (drift/enrollment obsoleto)", async () => {
    // emite um 2º coletor e o revoga direto no banco (a rota de revogação é onda futura).
    const en = await call("POST", "/api/dvr/coletores", { token: platformToken, body: { cliente_id: cliA, empresa_id_box3: `${tag}_EMP2` } });
    await db.query("update coletor set revogado=true, revogado_em=$2 where id=$1", [en.json.id, Date.now()]);
    const r = await call("POST", "/api/dvr/registrar", {
      headers: { "x-coletor-id": en.json.id, "x-coletor-key": en.json.site_key },
      body: { dvr: { marca: "x" }, consentimento: { aceito: true } },
    });
    expect(r.status).toBe(403);
  });

  it("auditoria: enrollment + registro deixaram rastro (quem/qual/quando)", async () => {
    const rows = await stores.auditoriaDvr.list(500);
    const doColetor = rows.filter((x) => x.coletor_id === coletorId);
    expect(doColetor.some((x) => x.acao === "enrollment")).toBe(true);
    expect(doColetor.some((x) => x.acao === "dvr.registrar")).toBe(true);
    expect(doColetor.some((x) => x.acao === "dvr.atualizar")).toBe(true);
    expect(doColetor.every((x) => x.em > 0)).toBe(true);
  });
});

describe.runIf(!HAVE_PG)("Fase 2 — Ponte DVR: INTEGRAÇÃO NÃO EXECUTADA", () => {
  it("SKIP: sem Postgres (defina CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE)", () => {
    console.warn("\n[dvr.pg.test] ⚠️  integração NÃO executada — sem Postgres. Suba um PG e reexecute.\n");
    expect(HAVE_PG).toBe(false);
  });
});
