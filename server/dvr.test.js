// Testes do domínio PONTE DVR — SEM Postgres (fallback JSON). Cobrem o que o contrato exige:
// enrollment/troca (uso único), registro idempotente por coletor, sessão (abrir/encerrar/timeout),
// frp-login (aceita/reject) e authColetor (site_key timing-safe) — direto na store e pelas rotas
// (mock de req/res, o MESMO caminho do servidor). Efeito colateral: escreve server/dvr.json
// (runtime) → limpo no afterAll. A persistência durável-primeiro (rollback) é JSON-only (skipIf PG).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const db = require("./db");
const dvr = require("./dvr");
const routes = require("./routes/dvr");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "dvr.json");

// ctx do hub p/ as rotas: json/readBody/requireSuper. requireSuper devolve um superadmin fake — o
// RBAC em si é do http-auth (testado à parte); aqui provamos a LÓGICA DE DOMÍNIO do DVR.
function makeCtx() {
  const superUser = { id: "u_test", usuario: "suporte", papel: "superadmin" };
  return {
    json: (res, code, obj) => {
      res.writeHead(code);
      res.end(JSON.stringify(obj));
    },
    readBody: (req) =>
      new Promise((resolve) => {
        let b = "";
        req.on("data", (c) => (b += c));
        req.on("end", () => resolve(b));
        req.on("close", () => resolve(b));
      }),
    requireSuper: () => superUser,
  };
}
function makeReq(method, url, { headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [typeof body === "string" ? body : JSON.stringify(body)];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  return req;
}
function makeRes() {
  const res = { statusCode: 0, jsonBody: undefined, headers: {} };
  res.setHeader = (k, v) => (res.headers[k.toLowerCase()] = v);
  res.writeHead = (c) => {
    res.statusCode = c;
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
async function call(method, url, opts) {
  const req = makeReq(method, url, opts);
  const res = makeRes();
  const handled = await routes.handle(req, res, makeCtx());
  return { handled, status: res.statusCode, json: res.jsonBody, headers: res.headers };
}
// Enrola um coletor fresco (criar + troca) e devolve as credenciais do device.
async function enroll(tag) {
  const c = await dvr.coletores.criar({ cliente_id: tag, empresa_id_box3: "emp_" + tag, nome: "Portaria " + tag });
  const t = await dvr.coletores.trocarEnrollment(c.enrollmentToken);
  return { coletorId: t.coletorId, siteKey: t.siteKey, clienteId: tag };
}
const dev = (coletorId, siteKey, extra = {}) => ({ "x-coletor-id": coletorId, "x-coletor-key": siteKey, ...extra });

beforeAll(async () => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
  await dvr.init(); // sem PG → começa vazio (JSON)
});
afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

describe("dvr — enrollment/troca (uso único) + authColetor", () => {
  let coletorId;
  let enrollmentToken;
  let siteKey;

  it("criar coletor emite enrollmentToken e NÃO expõe hashes", async () => {
    const r = await dvr.coletores.criar({ cliente_id: "cliA", empresa_id_box3: "empX", nome: "P" });
    expect(r.error).toBeUndefined();
    expect(r.enrollmentToken).toBeTruthy();
    expect(r.coletor.id).toMatch(/^col/);
    expect(r.coletor.site_key_hash).toBeUndefined();
    expect(r.coletor.enrollment_token_hash).toBeUndefined();
    coletorId = r.coletor.id;
    enrollmentToken = r.enrollmentToken;
  });

  it("criar sem cliente_id ou empresa_id_box3 → 400", async () => {
    expect((await dvr.coletores.criar({ empresa_id_box3: "e" })).status).toBe(400);
    expect((await dvr.coletores.criar({ cliente_id: "c" })).status).toBe(400);
  });

  it("trocarEnrollment devolve a site_key CRUA (1x)", async () => {
    const r = await dvr.coletores.trocarEnrollment(enrollmentToken);
    expect(r.coletorId).toBe(coletorId);
    expect(r.siteKey).toBeTruthy();
    siteKey = r.siteKey;
  });

  it("token é USO ÚNICO — 2ª troca → 410; inválido/vazio → 401", async () => {
    expect((await dvr.coletores.trocarEnrollment(enrollmentToken)).status).toBe(410);
    expect((await dvr.coletores.trocarEnrollment("nao-existe")).status).toBe(401);
    expect((await dvr.coletores.trocarEnrollment("")).status).toBe(401);
  });

  it("authColetor: chave certa OK; errada 401; inexistente 404; revogado 403", async () => {
    const ok = dvr.coletores.verify(coletorId, siteKey);
    expect(ok.error).toBeUndefined();
    expect(ok.clienteId).toBe("cliA");
    expect(dvr.coletores.verify(coletorId, "chave-errada").code).toBe(401);
    expect(dvr.coletores.verify("col-nao-existe", siteKey).code).toBe(404);
    await dvr.coletores.revogar(coletorId); // por último (invalida o coletor)
    expect(dvr.coletores.verify(coletorId, siteKey).code).toBe(403);
  });

  it("token de coletor NÃO enrolado não autentica (site_key nula) → 401", async () => {
    const c = await dvr.coletores.criar({ cliente_id: "cliNoKey", empresa_id_box3: "e" });
    expect(dvr.coletores.verify(c.coletor.id, "qualquer").code).toBe(401);
  });
});

describe("dvr — registro idempotente + sessão (rotas, device via site_key)", () => {
  let coletorId;
  let siteKey;
  beforeAll(async () => {
    ({ coletorId, siteKey } = await enroll("cliReg"));
  });

  it("registrar exige consentimento (sem aceite → 400)", async () => {
    const r = await call("POST", "/api/dvr/registrar", { headers: dev(coletorId, siteKey), body: { dvr: { marca: "Intelbras" } } });
    expect(r.status).toBe(400);
  });

  it("registrar cria (201) e é IDEMPOTENTE por coletor (2ª → 200, mesmo id)", async () => {
    const body = { dvr: { marca: "Intelbras", modelo: "MHDX", ip: "192.168.0.10", porta: 80 }, consentimento: { aceito: true, versaoTexto: "v1" } };
    const r1 = await call("POST", "/api/dvr/registrar", { headers: dev(coletorId, siteKey), body });
    expect(r1.status).toBe(201);
    const id = r1.json.dvr.id;
    const r2 = await call("POST", "/api/dvr/registrar", { headers: dev(coletorId, siteKey), body: { ...body, dvr: { ...body.dvr, modelo: "MHDX-1108" } } });
    expect(r2.status).toBe(200);
    expect(r2.json.dvr.id).toBe(id);
    expect(r2.json.dvr.modelo).toBe("MHDX-1108");
  });

  it("registrar com site_key errada → 401; coletor inexistente → 404", async () => {
    expect((await call("POST", "/api/dvr/registrar", { headers: dev(coletorId, "x"), body: { consentimento: { aceito: true } } })).status).toBe(401);
    expect((await call("POST", "/api/dvr/registrar", { headers: dev("nope", "x"), body: { consentimento: { aceito: true } } })).status).toBe(404);
  });

  it("sessão: abrir (201) idempotente (200 reusa) · GET status · encerrar (encerrada)", async () => {
    const a1 = await call("POST", "/api/dvr/sessao/abrir", { headers: dev(coletorId, siteKey) });
    expect(a1.status).toBe(201);
    const sid = a1.json.sessaoId;
    expect(a1.json.remotePort).toBeGreaterThanOrEqual(20000);
    expect(a1.json.hostPublico).toContain("dvr");
    expect(a1.json.relay).toBeTruthy();
    const a2 = await call("POST", "/api/dvr/sessao/abrir", { headers: dev(coletorId, siteKey) });
    expect(a2.status).toBe(200);
    expect(a2.json.sessaoId).toBe(sid);
    const g = await call("GET", `/api/dvr/sessao/${sid}`, { headers: dev(coletorId, siteKey) });
    expect(g.json.status).toBe("ativa");
    const e = await call("POST", `/api/dvr/sessao/${sid}/encerrar`, { headers: dev(coletorId, siteKey) });
    expect(e.status).toBe(200);
    const g2 = await call("GET", `/api/dvr/sessao/${sid}`, { headers: dev(coletorId, siteKey) });
    expect(g2.json.status).toBe("encerrada");
  });

  it("GET sessão de OUTRO coletor → 404 (não-dono)", async () => {
    const outro = await enroll("cliOutro");
    await call("POST", "/api/dvr/registrar", { headers: dev(coletorId, siteKey), body: { dvr: { marca: "X" }, consentimento: { aceito: true } } });
    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: dev(coletorId, siteKey) });
    const r = await call("GET", `/api/dvr/sessao/${ab.json.sessaoId}`, { headers: dev(outro.coletorId, outro.siteKey) });
    expect(r.status).toBe(404);
  });

  it("abrir sem DVR registrado → 409", async () => {
    const semDvr = await enroll("cliSemDvr");
    const r = await call("POST", "/api/dvr/sessao/abrir", { headers: dev(semDvr.coletorId, semDvr.siteKey) });
    expect(r.status).toBe(409);
  });
});

describe("dvr — frp-login (aceita/reject)", () => {
  let coletorId;
  let siteKey;
  beforeAll(async () => {
    ({ coletorId, siteKey } = await enroll("cliFrp"));
    await call("POST", "/api/dvr/registrar", { headers: dev(coletorId, siteKey), body: { dvr: { marca: "Dahua", ip: "10.0.0.2", porta: 80 }, consentimento: { aceito: true } } });
  });

  it("op não gerenciada (Ping) → aceita", async () => {
    const r = await call("POST", "/api/dvr/frp-login", { body: { op: "Ping", content: {} } });
    expect(r.json.reject).toBe(false);
  });

  it("Login: site_key válida → aceita; inválida → reject", async () => {
    const ok = await call("POST", "/api/dvr/frp-login", { body: { op: "Login", content: { user: coletorId, metas: { coletorId, siteKey } } } });
    expect(ok.json.reject).toBe(false);
    const bad = await call("POST", "/api/dvr/frp-login", { body: { op: "Login", content: { metas: { coletorId, siteKey: "errada" } } } });
    expect(bad.json.reject).toBe(true);
  });

  it("NewProxy: não-tcp → reject; sem sessão → reject; com sessão + porta certa → aceita; porta errada → reject", async () => {
    const naotcp = await call("POST", "/api/dvr/frp-login", { body: { op: "NewProxy", content: { proxy_type: "http", user: { metas: { coletorId, siteKey } } } } });
    expect(naotcp.json.reject).toBe(true);
    const semSessao = await call("POST", "/api/dvr/frp-login", { body: { op: "NewProxy", content: { proxy_type: "tcp", user: { metas: { coletorId, siteKey } } } } });
    expect(semSessao.json.reject).toBe(true);
    const ab = await call("POST", "/api/dvr/sessao/abrir", { headers: dev(coletorId, siteKey) });
    const porta = ab.json.remotePort;
    const okProxy = await call("POST", "/api/dvr/frp-login", { body: { op: "NewProxy", content: { proxy_type: "tcp", remote_port: porta, user: { metas: { coletorId, siteKey } } } } });
    expect(okProxy.json.reject).toBe(false);
    const errada = await call("POST", "/api/dvr/frp-login", { body: { op: "NewProxy", content: { proxy_type: "tcp", remote_port: porta + 1, user: { metas: { coletorId, siteKey } } } } });
    expect(errada.json.reject).toBe(true);
  });
});

describe("dvr — timeout de sessão (varredura)", () => {
  it("sessão ociosa é encerrada pela varredura (base = ultima_atividade)", async () => {
    const c = await enroll("cliTO");
    await dvr.dvrs.upsert({ coletor_id: c.coletorId, cliente_id: c.clienteId, marca: "X", consentimento: { aceito: true, quando: Date.now() } });
    const dvrId = dvr.dvrs.getByColetor(c.coletorId).id;
    const ab = await dvr.sessoes.abrir({ dvr_id: dvrId, coletor_id: c.coletorId, cliente_id: c.clienteId, ator: c.coletorId, host_publico: "h.dvr.box3.software" });
    const sid = ab.sessao.id;
    const encerradas = await dvr.sessoes.varrerOciosas({ idleMs: 1000, agora: Date.now() + 10_000 });
    expect(encerradas.some((s) => s.id === sid)).toBe(true);
    expect(dvr.sessoes.get(sid).status).toBe("encerrada");
  });
});

describe("dvr — auditoria (append-only) + rotas de suporte", () => {
  it("enrollment/registro/sessão deixam trilha; suporte lista DVRs e auditoria", async () => {
    const cr = await call("POST", "/api/dvr/coletores", { body: { cliente_id: "cliAud", empresa_id_box3: "empAud", nome: "Aud" } });
    expect(cr.status).toBe(201);
    expect(cr.json.enrollmentToken).toBeTruthy();
    const t = await dvr.coletores.trocarEnrollment(cr.json.enrollmentToken);
    await call("POST", "/api/dvr/registrar", { headers: dev(t.coletorId, t.siteKey), body: { dvr: { marca: "Aud" }, consentimento: { aceito: true } } });
    const dvrs = await call("GET", "/api/dvr/dvrs?cliente=cliAud", {});
    expect(dvrs.status).toBe(200);
    expect(dvrs.json.some((d) => d.cliente_id === "cliAud")).toBe(true);
    const aud = await call("GET", `/api/dvr/auditoria?coletor=${t.coletorId}`, {});
    expect(aud.status).toBe(200);
    expect(aud.json.some((a) => a.acao === "dvr.registrar")).toBe(true);
    expect(aud.json.some((a) => a.acao === "enrollment")).toBe(true);
  });
});

// GATE ANTI-"PERSISTÊNCIA FALSA": se a escrita durável falha (disco/PG fora), o dado NÃO pode
// aparecer na memória para sumir no restart. JSON-only (o mock é sobre writeFileSync) → skip com PG.
describe.skipIf(db.configured())("dvr — persistência durável-primeiro (rollback JSON)", () => {
  it("criar coletor: escrita falha → memória INTOCADA + erro 503", async () => {
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });
    const r = await dvr.coletores.criar({ cliente_id: "cliRollback", empresa_id_box3: "e" });
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect(dvr.coletores.list().some((c) => c.cliente_id === "cliRollback")).toBe(false);
  });
});
