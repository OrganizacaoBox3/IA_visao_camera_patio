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

// COERÊNCIA INSERT × SCHEMA — gate estático (mesmo espírito do resto do arquivo: sem banco,
// mede o que dá para medir sem ele). Duas classes de regressão que a edição À MÃO de um upsert
// produz e que nenhum outro sensor pega antes da produção:
//   1. coluna a mais/a menos que placeholders ⇒ o PG recusa o bind em runtime ("supplies N
//      parameters"), e o ingest cai no fallback JSON SILENCIOSAMENTE (warnPgDown) — o histórico
//      para de ir ao banco e ninguém vê.
//   2. coluna que não existe na tabela ⇒ mesma falha silenciosa. Aconteceu de perto ao somar
//      active_ms/observed_ms (2026-09-04): 11 colunas → 15 params, tudo escrito à mão.
describe("pgstore × schema.sql — todo INSERT bate com a tabela", () => {
  // Colunas conhecidas por tabela: corpo do CREATE TABLE + os ALTER ... ADD COLUMN aditivos.
  // Recorte por índice (não por RegExp montada por string): o schema é CRLF e uma regex montada
  // erraria calada — e um sensor estático que não casa nada é um no-op VERDE, a pior falha
  // possível aqui. Por isso cada teste exige explicitamente ter encontrado o que audita.
  const colunasDe = (tabela) => {
    const cols = new Set();
    const inicio = SCHEMA.toLowerCase().indexOf(`create table if not exists ${tabela} (`);
    if (inicio >= 0) {
      const abre = SCHEMA.indexOf("(", inicio);
      const corpo = SCHEMA.slice(abre + 1, SCHEMA.indexOf("\n);", abre)).replace(/--[^\n]*/g, "");
      for (const campo of corpo.split(",")) {
        const m = campo.trim().match(/^([a-z_][a-z0-9_]*)/i);
        if (m && !/^(primary|unique|foreign|constraint|check)$/i.test(m[1])) cols.add(m[1]);
      }
    }
    for (const linha of SCHEMA.split("\n")) {
      const m = linha.match(
        /^alter table\s+([a-z_0-9]+)\s+add column if not exists\s+([a-z_0-9]+)/i,
      );
      if (m && m[1].toLowerCase() === tabela) cols.add(m[2]);
    }
    return cols;
  };

  // Parser ciente de parênteses: `read_buckets` escreve jsonb_build_object(...) como VALOR, com
  // vírgulas dentro. Split ingênuo por "," contaria 11 valores para 7 colunas e o gate mentiria.
  const grupo = (txt, abre) => {
    let d = 0;
    for (let i = abre; i < txt.length; i++) {
      if (txt[i] === "(") d++;
      else if (txt[i] === ")" && --d === 0) return { conteudo: txt.slice(abre + 1, i), fim: i };
    }
    return null;
  };
  const partesTopo = (txt) => {
    const out = [];
    let d = 0;
    let atual = "";
    for (const ch of txt) {
      if (ch === "(" || ch === "[") d++;
      else if (ch === ")" || ch === "]") d--;
      if (ch === "," && d === 0) {
        out.push(atual.trim());
        atual = "";
      } else atual += ch;
    }
    if (atual.trim()) out.push(atual.trim());
    return out;
  };

  // Cada SQL vive num template literal próprio ⇒ fatiar por backtick mantém cada INSERT (e o SEU
  // `do update set`) isolado. Sem isso, um `[\s\S]*?` cruzaria statements e atribuiria a coluna
  // de um upsert à tabela de outro.
  const inserts = PGSTORE.split("`")
    .filter((c) => /^\s*insert into /i.test(c))
    .map((sql) => {
      const tabela = sql.match(/insert into ([a-z_0-9]+)/i)[1];
      const gCols = grupo(sql, sql.indexOf("(", sql.toLowerCase().indexOf(tabela)));
      const iVals = sql.toLowerCase().indexOf("values", gCols.fim);
      const gVals = grupo(sql, sql.indexOf("(", iVals));
      const iSet = sql.toLowerCase().indexOf("do update set");
      return {
        tabela,
        sql,
        cols: partesTopo(gCols.conteudo),
        vals: partesTopo(gVals.conteudo),
        sets: iSet < 0 ? [] : partesTopo(sql.slice(iSet + "do update set".length)),
      };
    });

  it("encontrou os INSERTs para auditar (formatação nova não pode silenciar o gate)", () => {
    expect(inserts.length).toBeGreaterThanOrEqual(8);
    expect(inserts.map((i) => i.tabela)).toContain("ativ_buckets");
  });

  it("nº de colunas == nº de valores em todo INSERT", () => {
    for (const { tabela, cols, vals } of inserts) {
      expect(vals, `${tabela}: ${cols.length} colunas × ${vals.length} valores`).toHaveLength(
        cols.length,
      );
    }
  });

  it("os $n de cada statement formam 1..N sem furo (bind completo)", () => {
    for (const { tabela, sql } of inserts) {
      const ns = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
      expect(ns.length, `${tabela}: statement sem nenhum parâmetro`).toBeGreaterThan(0);
      expect([...new Set(ns)].sort((a, b) => a - b), `${tabela}: $n com furo`).toEqual(
        Array.from({ length: Math.max(...ns) }, (_, i) => i + 1),
      );
    }
  });

  it("toda coluna escrita existe na tabela (CREATE TABLE ou ALTER aditivo)", () => {
    for (const { tabela, cols } of inserts) {
      const conhecidas = colunasDe(tabela);
      expect(conhecidas.size, `${tabela}: tabela não encontrada no schema.sql`).toBeGreaterThan(0);
      expect(
        cols.filter((c) => !conhecidas.has(c)),
        `${tabela}: coluna(s) fora do schema`,
      ).toEqual([]);
    }
  });

  it("toda coluna do `do update set` existe na tabela do PRÓPRIO statement", () => {
    const comSet = inserts.filter((i) => i.sets.length);
    expect(comSet.length, "nenhum upsert encontrado — o gate ficaria vazio").toBeGreaterThan(0);
    for (const { tabela, sets } of comSet) {
      const conhecidas = colunasDe(tabela);
      const alvos = sets.map((s) => (s.match(/^([a-z_0-9]+)\s*=/i) || [])[1]).filter(Boolean);
      expect(alvos.length, `${tabela}: SET sem alvo reconhecido`).toBe(sets.length);
      expect(
        alvos.filter((c) => !conhecidas.has(c)),
        `${tabela}: SET em coluna inexistente`,
      ).toEqual([]);
    }
  });
});
