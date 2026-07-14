// ██ O GATE DE ISOLAMENTO ██ (spec §5 — o furo mortal do RLS). Prova que uma transação de
// um SITE NÃO enxerga a linha de alarm_event de outro site NO MESMO POOL, e que esquecer o
// tenant vê ZERO linhas (fail-closed), nunca as do vizinho.
//
// ⚠️ RLS é feature do POSTGRES REAL — pg-mem NÃO suporta. Este teste EXIGE um Postgres:
//   • Com CP_DATABASE_URL (ou CP_PGHOST+CP_PGDATABASE) apontando p/ um PG onde o schema
//     foi aplicado e o usuário conecta SEM BYPASSRLS → RODA de verdade.
//   • Sem essas envs → SKIP (padrão da casa, como src/fusion/distance-field.test.ts).
//     O relatório da Fase 0 DECLARA se rodou ou ficou skip — nunca vende verde o não-rodado.
// Suba um PG local com control-plane/docker-compose.yml (ou o setup do README) e reexecute.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const db = require("./db");

const HAVE_PG = db.configured();
const tag = `t${process.pid}`; // ids únicos por execução → sem teardown entre runs

describe.skipIf(!HAVE_PG)("RLS — isolamento por tenant (Postgres real)", () => {
  const P = `${tag}_P`;
  const C = `${tag}_C`;
  const SITE_A = `${tag}_SA`;
  const SITE_B = `${tag}_SB`;
  let idA = null;
  let idB = null;

  beforeAll(async () => {
    // schema idempotente — aplica se o usuário conectado puder (dev: é o dono). Se um admin
    // já aplicou e o app user é não-dono, o IF NOT EXISTS/guards podem falhar no ALTER: nesse
    // caso o schema JÁ está aplicado, então ignoramos (o teste real são as asserções abaixo).
    try {
      await db.init();
    } catch (e) {
      console.warn("[rls.test] db.init ignorado (schema provavelmente já aplicado por admin):", e.message);
    }
    // Cadastro (sem RLS) — insert direto. site_id do alarm exige a árvore existir.
    const now = Date.now();
    await db.query("insert into partner(id,nome,criado_em) values ($1,$2,$3) on conflict (id) do nothing", [P, "PtnTest", now]);
    await db.query("insert into cliente(id,partner_id,nome,criado_em) values ($1,$2,$3,$4) on conflict (id) do nothing", [C, P, "CliTest", now]);
    await db.query("insert into site(id,cliente_id,nome,criado_em) values ($1,$2,$3,$4) on conflict (id) do nothing", [SITE_A, C, "SiteA", now]);
    await db.query("insert into site(id,cliente_id,nome,criado_em) values ($1,$2,$3,$4) on conflict (id) do nothing", [SITE_B, C, "SiteB", now]);

    // alarm_event: FORCE RLS + WITH CHECK exige inserir DENTRO do tenant certo (prova de
    // que a policy também vale na ESCRITA — não só na leitura).
    idA = await db.withTenant(SITE_A, async (cl) => {
      const r = await cl.query("insert into alarm_event(site_id,tipo,ts,meta) values ($1,$2,$3,$4) returning id", [SITE_A, "queda", now, JSON.stringify({ zona: "z1" })]);
      return r.rows[0].id;
    });
    idB = await db.withTenant(SITE_B, async (cl) => {
      const r = await cl.query("insert into alarm_event(site_id,tipo,ts,meta) values ($1,$2,$3,$4) returning id", [SITE_B, "fumaca", now, JSON.stringify({ zona: "z9" })]);
      return r.rows[0].id;
    });
  });

  afterAll(async () => {
    await db.end();
  });

  it("tenant A vê a linha de A e NÃO a de B", async () => {
    const rows = await db.withTenant(SITE_A, async (cl) => {
      const r = await cl.query("select id, site_id from alarm_event where id = any($1)", [[idA, idB]]);
      return r.rows;
    });
    expect(rows.map((x) => x.id)).toContain(idA);
    expect(rows.map((x) => x.id)).not.toContain(idB);
    expect(rows.every((x) => x.site_id === SITE_A)).toBe(true);
  });

  it("tenant B vê a linha de B e NÃO a de A (simétrico)", async () => {
    const rows = await db.withTenant(SITE_B, async (cl) => {
      const r = await cl.query("select id, site_id from alarm_event where id = any($1)", [[idA, idB]]);
      return r.rows;
    });
    expect(rows.map((x) => x.id)).toContain(idB);
    expect(rows.map((x) => x.id)).not.toContain(idA);
    expect(rows.every((x) => x.site_id === SITE_B)).toBe(true);
  });

  it("concorrência: 2 tenants no MESMO pool não se cruzam", async () => {
    // dispara as duas leituras ~ao mesmo tempo (o cenário que só aparece sob concorrência).
    const [ra, rb] = await Promise.all([
      db.withTenant(SITE_A, async (cl) => (await cl.query("select id from alarm_event")).rows.map((x) => x.id)),
      db.withTenant(SITE_B, async (cl) => (await cl.query("select id from alarm_event")).rows.map((x) => x.id)),
    ]);
    expect(ra).toContain(idA);
    expect(ra).not.toContain(idB);
    expect(rb).toContain(idB);
    expect(rb).not.toContain(idA);
  });

  it("FAIL-CLOSED: tenant inexistente vê ZERO linhas (não as do vizinho)", async () => {
    const rows = await db.withTenant(`${tag}_GHOST`, async (cl) => {
      const r = await cl.query("select id from alarm_event where id = any($1)", [[idA, idB]]);
      return r.rows;
    });
    expect(rows.length).toBe(0);
  });

  it("FAIL-CLOSED: transação SEM set_config (tenant esquecido) vê ZERO linhas", async () => {
    // Prova direta da camada RLS: sem o GUC, current_setting(...,true)=NULL → site_id=NULL → 0.
    const client = await db.getPool().connect();
    try {
      await client.query("begin");
      const r = await client.query("select id from alarm_event where id = any($1)", [[idA, idB]]);
      await client.query("rollback");
      expect(r.rows.length).toBe(0);
    } finally {
      client.release();
    }
  });

  it("withTenant recusa tenant vazio (fail-closed na porta de entrada)", async () => {
    await expect(db.withTenant("", async () => 1)).rejects.toThrow();
    await expect(db.withTenant(null, async () => 1)).rejects.toThrow();
  });
});

// Quando NÃO há Postgres, deixa um rastro explícito no output (o skip do describe é silencioso).
describe.runIf(!HAVE_PG)("RLS — GATE NÃO EXECUTADO", () => {
  it("SKIP: sem Postgres (defina CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE)", () => {
    console.warn(
      "\n[rls.test] ⚠️  GATE DE RLS NÃO EXECUTADO — sem Postgres no ambiente.\n" +
        "  Rode: cd control-plane && docker compose up -d  (ou aponte CP_DATABASE_URL a um PG)\n" +
        "  e reexecute `npx vitest run control-plane/rls.test.js`.\n",
    );
    expect(HAVE_PG).toBe(false);
  });
});
