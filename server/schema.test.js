// Gate ESTÁTICO do server/schema.sql — invariante do CLAUDE.md §3: "schema.sql idempotente
// (aditivo, sem alterar tabelas existentes)".
//
// ⚠ O QUE ESTE TESTE **NÃO** FAZ (honestidade técnica — CLAUDE.md §2.5): ele NÃO aplica o schema
// num Postgres, nem uma nem duas vezes. Não existe harness para isso neste repo — o único caminho
// que executa o DDL é `server/db.js:init()` contra um banco REAL no boot, e não há pg-mem /
// testcontainers / pglite nas devDependencies nem serviço de Postgres no CI. Criar essa
// infraestrutura seria inventar dependência, então aqui se mede o que dá para medir SEM banco:
// idempotência POR CONSTRUÇÃO (todo DDL é `... if not exists`) e ausência de statement destrutivo.
// Isso é uma condição SUFICIENTE para "aplicar 2× não quebra" no conjunto de statements que usamos
// — não é a execução. O residual (erro de sintaxe, dependência entre statements) continua sendo
// pego só pelo boot real; este gate pega a classe de regressão que um humano introduz editando.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(here, "schema.sql"), "utf8");
const PGSTORE = readFileSync(path.join(here, "pgstore.js"), "utf8");

// Statements SEM comentário: `--` até o fim da linha some, depois quebra em `;`.
// (schema.sql não tem literal de string com `;` nem com `--` — checado; se algum dia tiver, este
//  parser ingênuo precisa evoluir junto.)
const statements = SCHEMA.replace(/--[^\n]*/g, "")
  .split(";")
  .map((s) => s.replace(/\s+/g, " ").trim())
  .filter(Boolean);

describe("schema.sql — idempotência por construção (aplicar 2× não pode quebrar)", () => {
  it("todo CREATE TABLE é `if not exists`", () => {
    const bad = statements.filter(
      (s) => /^create table\b/i.test(s) && !/^create table if not exists\b/i.test(s),
    );
    expect(bad).toEqual([]);
  });

  it("todo CREATE INDEX é `if not exists`", () => {
    const bad = statements.filter(
      (s) =>
        /^create (unique )?index\b/i.test(s) && !/^create (unique )?index if not exists\b/i.test(s),
    );
    expect(bad).toEqual([]);
  });

  it("todo ALTER TABLE é ADD COLUMN IF NOT EXISTS (aditivo — nunca altera coluna existente)", () => {
    const alters = statements.filter((s) => /^alter table\b/i.test(s));
    expect(alters.length).toBeGreaterThan(0); // sanidade: o bloco de CARIMBO existe
    const bad = alters.filter((s) => !/^alter table \w+ add column if not exists \w+ /i.test(s));
    expect(bad).toEqual([]);
  });

  it("nenhum statement destrutivo (o schema roda em banco de CLIENTE no boot)", () => {
    // DROP/TRUNCATE/DELETE/RENAME/ALTER COLUMN apagam ou reescrevem dado já gravado. O schema é
    // aplicado a CADA boot do hub: um só destes aqui destruiria histórico a cada restart.
    const destrutivo =
      /\b(drop\s+(table|column|index|database)|truncate|delete\s+from|rename\s+to|alter\s+column)\b/i;
    expect(statements.filter((s) => destrutivo.test(s))).toEqual([]);
  });

  it("cada statement é CREATE ou ALTER (nada mais entra neste arquivo)", () => {
    const bad = statements.filter((s) => !/^(create|alter)\b/i.test(s));
    expect(bad).toEqual([]);
  });
});

describe("schema.sql — faxina de 2026-07-26 (regressões que não podem voltar)", () => {
  it("app_views NÃO é recriada — e também NÃO é dropada (tabela órfã em base antiga é inofensiva)", () => {
    // Removeu-se só o CREATE. Um `drop table app_views` aqui seria irreversível numa base de
    // cliente; o custo de deixar a tabela órfã é zero. Este teste barra os DOIS retornos.
    expect(statements.some((s) => /\bapp_views\b/i.test(s))).toBe(false);
  });

  it("flow_events CONTINUA no schema (parece morta, mas carrega o carimbo de turno cru)", () => {
    // O front só lê flow_buckets hoje ⇒ um grep superficial acusa órfã. É o único lugar com
    // shift_id/business_date por cruzamento — é por ela que o filtro de turno do Fluxo se conserta.
    expect(statements.some((s) => /^create table if not exists flow_events\b/i.test(s))).toBe(true);
    for (const col of ["shift_id", "in_pause", "business_date"]) {
      expect(statements.some((s) => /alter table flow_events/i.test(s) && s.includes(col))).toBe(
        true,
      );
    }
  });

  it("read_events.cameras (OBSOLETA) permanece DECLARADA — dropar reescreveria a tabela", () => {
    const t = statements.find((s) => /^create table if not exists read_events\b/i.test(s));
    expect(t).toBeDefined();
    expect(t).toMatch(/\bcameras int\b/i);
  });
});

describe("pgstore.js — read_events.cameras não é mais FABRICADA (auditoria A7)", () => {
  // O caminho SQL não tem como ser exercitado sem Postgres (ver cabeçalho), então o sensor aqui é
  // textual — é exatamente o critério de saída da auditoria: "o grep da coluna vai a 0" na ESCRITA.
  // O round-trip observável (cameras === null) está no pgstore.fallback.test.js.
  it("o INSERT em read_events não nomeia a coluna `cameras`", () => {
    const insert = PGSTORE.match(/insert into read_events[^`]*/i);
    expect(insert).not.toBeNull();
    expect(insert[0]).not.toMatch(/\bcameras\b/i);
  });

  it("nenhum literal `1` é gravado no lugar dela (o valor não existe — não se inventa)", () => {
    expect(PGSTORE).not.toMatch(/insert into read_events \(ts,ponto,code,cameras,shift\)/i);
    expect(PGSTORE).not.toMatch(/cameras:\s*1\b/);
  });

  it("o SELECT mantém `cameras` — histórico antigo tem o 1 legado e não pode sumir da resposta", () => {
    expect(PGSTORE).toMatch(/select ts, ponto, code, cameras, shift from read_events/i);
  });
});
