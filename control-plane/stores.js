// Stores do CADASTRO (partner/cliente/site/app_user/membership) — CRUD via pg (db.query).
//
// IMPORTANTE (spec §5): as tabelas de CADASTRO NÃO têm RLS de linha — o isolamento entre
// integradores/clientes é por canAccess() NO APP (control-plane/access.js), em TODO handler.
// Por isso aqui usamos db.query() normal (fora de withTenant): withTenant é só p/ alarm_event,
// a única tabela com RLS. Estas queries são todas parametrizadas ($1..$n) — nunca interpoladas.
const crypto = require("node:crypto");
const db = require("./db");

// ids text, com prefixo por entidade (mesmo idioma do genId do hub: prefixo + randomBytes hex).
function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString("hex");
}
const now = () => Date.now();

// ── partner ───────────────────────────────────────────────────────────────────
const partners = {
  async create({ nome }) {
    const id = genId("p");
    await db.query("insert into partner(id,nome,criado_em) values ($1,$2,$3)", [id, String(nome || ""), now()]);
    return { id, nome, criado_em: now() };
  },
  async list() {
    const r = await db.query("select id,nome,criado_em from partner order by criado_em asc");
    return r.rows;
  },
  async get(id) {
    const r = await db.query("select id,nome,criado_em from partner where id=$1", [id]);
    return r.rows[0] || null;
  },
  async update(id, { nome }) {
    const r = await db.query("update partner set nome=coalesce($2,nome) where id=$1 returning id,nome,criado_em", [id, nome ?? null]);
    return r.rows[0] || null;
  },
  async remove(id) {
    const r = await db.query("delete from partner where id=$1 returning id", [id]);
    return r.rowCount > 0;
  },
};

// ── cliente ─────────────────────────────────────────────────────────────────--
const clientes = {
  async create({ partner_id, nome }) {
    const id = genId("c");
    await db.query("insert into cliente(id,partner_id,nome,criado_em) values ($1,$2,$3,$4)", [id, partner_id, String(nome || ""), now()]);
    return { id, partner_id, nome, criado_em: now() };
  },
  async list() {
    const r = await db.query("select id,partner_id,nome,criado_em from cliente order by criado_em asc");
    return r.rows;
  },
  async get(id) {
    const r = await db.query("select id,partner_id,nome,criado_em from cliente where id=$1", [id]);
    return r.rows[0] || null;
  },
  async update(id, { nome }) {
    const r = await db.query("update cliente set nome=coalesce($2,nome) where id=$1 returning id,partner_id,nome,criado_em", [id, nome ?? null]);
    return r.rows[0] || null;
  },
  async remove(id) {
    const r = await db.query("delete from cliente where id=$1 returning id", [id]);
    return r.rowCount > 0;
  },
};

// ── site ────────────────────────────────────────────────────────────────────--
// create devolve TAMBÉM a site_key CRUA (uma única vez); o banco guarda só o hash.
const sites = {
  async create({ cliente_id, nome, siteKeyHash }) {
    const id = genId("s");
    await db.query(
      "insert into site(id,cliente_id,nome,site_key_hash,criado_em) values ($1,$2,$3,$4,$5)",
      [id, cliente_id, String(nome || ""), siteKeyHash, now()],
    );
    return { id, cliente_id, nome, criado_em: now() };
  },
  async list() {
    const r = await db.query("select id,cliente_id,nome,last_seen,criado_em from site order by criado_em asc");
    return r.rows;
  },
  async get(id) {
    const r = await db.query("select id,cliente_id,nome,last_seen,criado_em from site where id=$1", [id]);
    return r.rows[0] || null;
  },
  // uso interno (auth de ingest/heartbeat): inclui o hash, que NÃO sai em nenhuma resposta pública.
  async getWithHash(id) {
    const r = await db.query("select id,cliente_id,nome,site_key_hash,last_seen,criado_em from site where id=$1", [id]);
    return r.rows[0] || null;
  },
  async update(id, { nome }) {
    const r = await db.query("update site set nome=coalesce($2,nome) where id=$1 returning id,cliente_id,nome,last_seen,criado_em", [id, nome ?? null]);
    return r.rows[0] || null;
  },
  async touchLastSeen(id, ts) {
    const r = await db.query("update site set last_seen=$2 where id=$1 returning id", [id, ts]);
    return r.rowCount > 0;
  },
  async remove(id) {
    const r = await db.query("delete from site where id=$1 returning id", [id]);
    return r.rowCount > 0;
  },
};

// ── app_user ────────────────────────────────────────────────────────────────--
// senhaHash é sempre OMITIDA das respostas públicas (publicUser).
function publicUser(u) {
  if (!u) return null;
  const { senha_hash: _h, ...rest } = u;
  return rest;
}
const users = {
  async create({ email, senhaHash }) {
    const id = genId("u");
    await db.query("insert into app_user(id,email,senha_hash,ativo,criado_em) values ($1,$2,$3,true,$4)", [id, email, senhaHash, now()]);
    return { id, email, ativo: true, criado_em: now() };
  },
  async list() {
    const r = await db.query("select id,email,ativo,criado_em from app_user order by criado_em asc");
    return r.rows;
  },
  async get(id) {
    const r = await db.query("select id,email,ativo,criado_em from app_user where id=$1", [id]);
    return r.rows[0] || null;
  },
  // uso interno (login): inclui o hash da senha.
  async getByEmailWithHash(email) {
    const r = await db.query("select id,email,senha_hash,ativo,criado_em from app_user where lower(email)=lower($1)", [String(email || "")]);
    return r.rows[0] || null;
  },
  async update(id, { senhaHash, ativo }) {
    const r = await db.query(
      "update app_user set senha_hash=coalesce($2,senha_hash), ativo=coalesce($3,ativo) where id=$1 returning id,email,ativo,criado_em",
      [id, senhaHash ?? null, typeof ativo === "boolean" ? ativo : null],
    );
    return r.rows[0] || null;
  },
  async remove(id) {
    const r = await db.query("delete from app_user where id=$1 returning id", [id]);
    return r.rowCount > 0;
  },
};

// ── membership (o RBAC-com-escopo) ────────────────────────────────────────────
const memberships = {
  async create({ user_id, scope_type, scope_id, role }) {
    const id = genId("m");
    await db.query(
      "insert into membership(id,user_id,scope_type,scope_id,role,criado_em) values ($1,$2,$3,$4,$5,$6)",
      [id, user_id, scope_type, scope_id ?? null, role, now()],
    );
    return { id, user_id, scope_type, scope_id: scope_id ?? null, role, criado_em: now() };
  },
  async list() {
    const r = await db.query("select id,user_id,scope_type,scope_id,role,criado_em from membership order by criado_em asc");
    return r.rows;
  },
  async listByUser(userId) {
    const r = await db.query("select id,user_id,scope_type,scope_id,role,criado_em from membership where user_id=$1 order by criado_em asc", [userId]);
    return r.rows;
  },
  async get(id) {
    const r = await db.query("select id,user_id,scope_type,scope_id,role,criado_em from membership where id=$1", [id]);
    return r.rows[0] || null;
  },
  async remove(id) {
    const r = await db.query("delete from membership where id=$1 returning id", [id]);
    return r.rowCount > 0;
  },
};

module.exports = { genId, partners, clientes, sites, users, memberships, publicUser };
