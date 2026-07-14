// Conexão Postgres do CONTROL-PLANE (Pool multi-cliente). Mesmo idioma de server/db.js
// (pg.Pool nativo, sem ORM), mas com a peça que o hub NÃO tem: withTenant() — o
// middleware transaction-scoped que mata o furo mortal do RLS (spec §5).
//
// Envs (prefixo CP_ para NÃO colidir com as do hub): CP_DATABASE_URL, ou
// CP_PGHOST/CP_PGPORT/CP_PGUSER/CP_PGPASSWORD/CP_PGDATABASE.
//
// INVARIANTE (§5, camada 3): o usuário destas envs DEVE ser não-dono e SEM BYPASSRLS —
// senão a RLS é fantasia. Ver o cabeçalho de schema.sql (setup do usuário cp_app).
const { Pool, types } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

// bigint (int8, OID 20) volta como STRING por padrão no node-pg. Nossos ts são epoch-ms
// (cabem no número seguro do JS) → parseia p/ Number (mesma decisão do server/db.js).
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const DBNAME = process.env.CP_PGDATABASE || "";
let pool = null;

function configured() {
  return !!(process.env.CP_DATABASE_URL || (process.env.CP_PGHOST && DBNAME));
}

function getPool() {
  if (!pool) {
    pool = process.env.CP_DATABASE_URL
      ? new Pool({ connectionString: process.env.CP_DATABASE_URL, max: 5 })
      : new Pool({
          host: process.env.CP_PGHOST,
          port: Number(process.env.CP_PGPORT ?? 5432),
          user: process.env.CP_PGUSER,
          password: process.env.CP_PGPASSWORD,
          database: DBNAME,
          max: 5,
        });
    pool.on("error", (e) => console.error("[cp/db] erro no pool:", e.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

// ── withTenant — o CORAÇÃO do isolamento (spec §5, camada 1) ──────────────────
// Abre UMA transação, fixa o tenant com set_config(..., true) [o `true` = LOCAL à
// transação], roda fn(client), e COMMIT (ou ROLLBACK em erro). O tenant reverte no
// fim da transação — a conexão volta ao pool LIMPA (nunca carrega o tenant do request
// anterior, que é o furo mortal do SET session-scoped).
//
// FAIL-CLOSED por construção: se o siteId for null/undefined/"" a policy do RLS casa
// site_id contra NULL → ZERO linhas (nunca as do vizinho). Ainda assim recusamos o
// tenant vazio explicitamente — um withTenant sem tenant é BUG de chamada, não um
// caminho válido; melhor estourar do que rodar uma query "cega".
async function withTenant(siteId, fn) {
  if (siteId == null || siteId === "") {
    throw new Error("[cp/db] withTenant exige um siteId (tenant) — fail-closed");
  }
  const client = await getPool().connect();
  try {
    await client.query("begin");
    // set_config($1,$2,true): parametrizado (nunca interpolado) + LOCAL (o 3º arg true).
    // NUNCA `SET app.current_tenant = ...` (session-scoped): vazaria pela conexão poolada.
    await client.query("select set_config('app.current_tenant', $1, true)", [String(siteId)]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch {
      /* rollback best-effort; o release devolve a conexão de todo jeito */
    }
    throw e;
  } finally {
    client.release();
  }
}

// Esquema (fonte única; idempotente). O init roda no boot do plane (se configurado).
const SCHEMA = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

async function init() {
  if (!configured()) {
    console.log("[cp/db] Postgres NÃO configurado (defina CP_PGDATABASE + CP_PG* ou CP_DATABASE_URL)");
    return false;
  }
  try {
    await query(SCHEMA);
    console.log(`[cp/db] Postgres ok (schema garantido) · db=${DBNAME || "via CP_DATABASE_URL"}`);
    return true;
  } catch (e) {
    console.error("[cp/db] falha ao conectar/inicializar:", e.message);
    return false;
  }
}

async function end() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { configured, getPool, query, withTenant, init, end };
