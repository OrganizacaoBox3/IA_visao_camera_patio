// Conexão Postgres do hub. Reusa as credenciais do ecossistema (PGHOST/PGPORT/PGUSER/PGPASSWORD)
// + um BANCO específico do Visão de Pátio em PGDATABASE (ou DATABASE_URL como override).
// Sem PG configurado, `configured()` é false e o hub segue de pé (histórico fica indisponível).
const { Pool, types } = require("pg");
const fs = require("node:fs");
const path = require("node:path");

// bigint (int8, OID 20) volta como STRING por padrão no node-pg. Nossos valores são epoch-ms
// (cabem no número seguro do JS), então parseamos p/ Number — senão o front quebra com strings.
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

const DBNAME = process.env.PGDATABASE || process.env.VISAO_DB || "";
let pool = null;

function configured() {
  return !!(process.env.DATABASE_URL || (process.env.PGHOST && DBNAME));
}

function getPool() {
  if (!pool) {
    pool = process.env.DATABASE_URL
      ? new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })
      : new Pool({
          host: process.env.PGHOST,
          port: Number(process.env.PGPORT ?? 5432),
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          database: DBNAME,
          max: 5,
        });
    pool.on("error", (e) => console.error("[db] erro no pool:", e.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function transaction(run) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await run(client);
    await client.query("commit");
    return result;
  } catch (e) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      console.error("[db] falha no rollback:", rollbackError.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

// Esquema completo vem de server/schema.sql (fonte única; idempotente). LGPD: só indicadores.
const SCHEMA = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

async function init() {
  if (!configured()) {
    console.log("[db] Postgres NÃO configurado (defina PGDATABASE + PG* ou DATABASE_URL)");
    return false;
  }
  try {
    await query(SCHEMA);
    console.log(`[db] Postgres ok (schema garantido) · db=${DBNAME || "via DATABASE_URL"}`);
    return true;
  } catch (e) {
    console.error("[db] falha ao conectar/inicializar:", e.message);
    return false;
  }
}

module.exports = { configured, getPool, query, transaction, init };
