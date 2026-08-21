// PONTE DVR — integração com Postgres REAL (grava dvr_coletor/dvr/dvr_sessao/dvr_audit de verdade).
// Sem PG → SKIP DECLARADO (padrão da casa, como sessao.pg.test.js do control-plane / pgstore.test).
// Prova que o MESMO store (memória + PG) persiste no backend certo: enrollment/troca uso-único,
// registro idempotente por coletor, sessão abrir/encerrar, authColetor e persistence()==="pg".
import { describe, it, expect, beforeAll } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("./db");
const dvr = require("./dvr");

const HAVE_PG = db.configured();
const tag = `t${process.pid}`;

describe.skipIf(!HAVE_PG)("Ponte DVR — store no Postgres real", () => {
  beforeAll(async () => {
    await db.init(); // aplica server/schema.sql (cria as tabelas dvr_* se faltarem)
    await dvr.init(); // carrega os caches do PG e liga usingPg
  });

  it("usa o backend Postgres", () => {
    expect(dvr.persistence()).toBe("pg");
  });

  it("enrollment → troca (uso único) → site_key durável", async () => {
    const c = await dvr.coletores.criar({ cliente_id: `${tag}_cli`, empresa_id_box3: `${tag}_emp`, nome: "PG" });
    expect(c.enrollmentToken).toBeTruthy();
    const t1 = await dvr.coletores.trocarEnrollment(c.enrollmentToken);
    expect(t1.coletorId).toBe(c.coletor.id);
    expect(t1.siteKey).toBeTruthy();
    // uso único: 2ª troca recusa
    expect((await dvr.coletores.trocarEnrollment(c.enrollmentToken)).status).toBe(410);
    // authColetor timing-safe
    expect(dvr.coletores.verify(t1.coletorId, t1.siteKey).clienteId).toBe(`${tag}_cli`);
    expect(dvr.coletores.verify(t1.coletorId, "errada").code).toBe(401);
  });

  it("registro idempotente por coletor + sessão abrir/encerrar (persistidos no PG)", async () => {
    const c = await dvr.coletores.criar({ cliente_id: `${tag}_cli2`, empresa_id_box3: `${tag}_emp2` });
    const t = await dvr.coletores.trocarEnrollment(c.enrollmentToken);
    const up1 = await dvr.dvrs.upsert({ coletor_id: t.coletorId, cliente_id: `${tag}_cli2`, marca: "Intelbras", modelo: "MHDX", ip: "10.0.0.9", porta: 80, consentimento: { aceito: true, quando: Date.now(), versaoTexto: "v1" } });
    expect(up1.inserido).toBe(true);
    const up2 = await dvr.dvrs.upsert({ coletor_id: t.coletorId, cliente_id: `${tag}_cli2`, marca: "Intelbras", modelo: "MHDX-1108", consentimento: { aceito: true, quando: Date.now() } });
    expect(up2.inserido).toBe(false);
    expect(up2.dvr.id).toBe(up1.dvr.id);

    const ab = await dvr.sessoes.abrir({ dvr_id: up1.dvr.id, coletor_id: t.coletorId, cliente_id: `${tag}_cli2`, ator: t.coletorId, host_publico: `${tag}.dvr.box3.software` });
    expect(ab.reusada).toBe(false);
    expect(ab.sessao.remote_port).toBeGreaterThanOrEqual(20000);
    // idempotente: reabrir reusa a ativa
    const ab2 = await dvr.sessoes.abrir({ dvr_id: up1.dvr.id, coletor_id: t.coletorId, cliente_id: `${tag}_cli2`, ator: t.coletorId, host_publico: `${tag}.dvr.box3.software` });
    expect(ab2.reusada).toBe(true);
    expect(ab2.sessao.id).toBe(ab.sessao.id);
    const enc = await dvr.sessoes.encerrar(ab.sessao.id);
    expect(enc.encerrada.status).toBe("encerrada");
    expect(dvr.sessoes.get(ab.sessao.id).status).toBe("encerrada");

    // auditoria persistida e filtrável por coletor
    await dvr.auditoria.registrar({ ator: t.coletorId, dvr_id: up1.dvr.id, coletor_id: t.coletorId, acao: "dvr.registrar", detalhe: { marca: "Intelbras" } });
    const trilha = dvr.auditoria.list({ coletorId: t.coletorId });
    expect(trilha.some((a) => a.acao === "dvr.registrar")).toBe(true);
  });
});
