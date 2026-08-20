// Stores do CADASTRO (partner/cliente/site/app_user/membership) — CRUD via pg (db.query).
//
// IMPORTANTE (spec §5): as tabelas de CADASTRO NÃO têm RLS de linha — o isolamento entre
// integradores/clientes é por canAccess() NO APP (control-plane/access.js), em TODO handler.
// Por isso aqui usamos db.query() normal (fora de withTenant): withTenant é só p/ alarm_event,
// a única tabela com RLS. Estas queries são todas parametrizadas ($1..$n) — nunca interpoladas.
const crypto = require("node:crypto");
const db = require("./db");
const dvrDom = require("./dvr"); // helpers PUROS (proximaPortaLivre) — sem ciclo (dvr.js não requer nada)

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

// ── PONTE DVR (Fase 2) ─────────────────────────────────────────────────────--
// coletor = o ENROLLMENT (empresa box3 ↔ cliente visão) + credencial site_key. Guarda SÓ o
// hash; a chave crua sai UMA vez no enrollment (padrão API key, como o site). getWithHash é
// uso INTERNO (authColetor) — o hash NUNCA sai em resposta pública.
const coletores = {
  async create({ cliente_id, empresa_id_box3, nome, coletorIdBox3, siteKeyHash }) {
    const id = genId("col");
    const ts = now();
    await db.query(
      "insert into coletor(id,cliente_id,empresa_id_box3,coletor_id_box3,nome,site_key_hash,revogado,criado_em) values ($1,$2,$3,$4,$5,$6,false,$7)",
      [id, cliente_id, empresa_id_box3, coletorIdBox3 ?? null, nome ?? null, siteKeyHash, ts],
    );
    return { id, cliente_id, empresa_id_box3, coletor_id_box3: coletorIdBox3 ?? null, nome: nome ?? null, revogado: false, revogado_em: null, criado_em: ts };
  },
  async list() {
    const r = await db.query(
      "select id,cliente_id,empresa_id_box3,coletor_id_box3,nome,revogado,revogado_em,criado_em from coletor order by criado_em asc",
    );
    return r.rows;
  },
  async get(id) {
    const r = await db.query(
      "select id,cliente_id,empresa_id_box3,coletor_id_box3,nome,revogado,revogado_em,criado_em from coletor where id=$1",
      [id],
    );
    return r.rows[0] || null;
  },
  // uso interno (authColetor): inclui site_key_hash + revogado. NÃO expor em resposta pública.
  async getWithHash(id) {
    const r = await db.query(
      "select id,cliente_id,empresa_id_box3,coletor_id_box3,nome,site_key_hash,revogado,criado_em from coletor where id=$1",
      [id],
    );
    return r.rows[0] || null;
  },
};

// dvr = o aparelho registrado pelo coletor. upsert idempotente por coletor_id (1 DVR/coletor,
// contratos §3) — devolve { dvr, inserido } p/ o handler auditar registrar × atualizar.
const dvrs = {
  async getByColetor(coletorId) {
    const r = await db.query(
      "select id,coletor_id,cliente_id,marca,modelo,ip,porta,consentimento_aceito,consentimento_em,consentimento_versao,criado_em,atualizado_em from dvr where coletor_id=$1",
      [coletorId],
    );
    return r.rows[0] || null;
  },
  async get(id) {
    const r = await db.query(
      "select id,coletor_id,cliente_id,marca,modelo,ip,porta,consentimento_aceito,consentimento_em,consentimento_versao,criado_em,atualizado_em from dvr where id=$1",
      [id],
    );
    return r.rows[0] || null;
  },
  async upsert({ coletor_id, cliente_id, marca, modelo, ip, porta, consentimento }) {
    const ts = now();
    const existing = await this.getByColetor(coletor_id);
    if (!existing) {
      const id = genId("dvr");
      await db.query(
        `insert into dvr(id,coletor_id,cliente_id,marca,modelo,ip,porta,consentimento_aceito,consentimento_em,consentimento_versao,criado_em,atualizado_em)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
        [id, coletor_id, cliente_id, marca ?? null, modelo ?? null, ip ?? null, porta ?? null, consentimento.aceito, consentimento.quando, consentimento.versaoTexto ?? null, ts],
      );
      return { dvr: await this.get(id), inserido: true };
    }
    await db.query(
      `update dvr set marca=$2, modelo=$3, ip=$4, porta=$5, consentimento_aceito=$6, consentimento_em=$7, consentimento_versao=$8, atualizado_em=$9 where coletor_id=$1`,
      [coletor_id, marca ?? null, modelo ?? null, ip ?? null, porta ?? null, consentimento.aceito, consentimento.quando, consentimento.versaoTexto ?? null, ts],
    );
    return { dvr: await this.getByColetor(coletor_id), inserido: false };
  },
};

// auditoria_dvr = quem/qual DVR/qual ação/quando (a auditoria que o control-plane não tinha).
const auditoriaDvr = {
  async registrar({ ator, dvr_id, coletor_id, acao, detalhe }) {
    const r = await db.query(
      "insert into auditoria_dvr(ator,dvr_id,coletor_id,acao,detalhe,em) values ($1,$2,$3,$4,$5,$6) returning id,ator,dvr_id,coletor_id,acao,em",
      [String(ator || ""), dvr_id ?? null, coletor_id ?? null, String(acao || ""), detalhe ? JSON.stringify(detalhe) : null, now()],
    );
    return r.rows[0];
  },
  async list(limit = 100) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
    const r = await db.query("select id,ator,dvr_id,coletor_id,acao,detalhe,em from auditoria_dvr order by em desc limit $1", [lim]);
    return r.rows;
  },
};

// sessao = o ciclo do acesso remoto (F3 backend, C-be-5). A linha ativa É o mapa de rota que o
// nginx (B-3) vai consumir (host_publico → remote_port → dvr). Faixa de portas via env (casa com
// o allowPorts do frps: relay/frps.toml, 20000..20099).
const PORTA_INICIO = Number(process.env.CP_DVR_PORT_START || 20000);
const PORTA_FIM = Number(process.env.CP_DVR_PORT_END || 20099);
const SESSAO_COLS =
  "id,dvr_id,coletor_id,cliente_id,ator,status,remote_port,host_publico,aberta_em,encerrada_em,ultima_atividade";

const sessoes = {
  async get(id) {
    const r = await db.query(`select ${SESSAO_COLS} from sessao where id=$1`, [id]);
    return r.rows[0] || null;
  },
  async ativaPorColetor(coletorId) {
    const r = await db.query(
      `select ${SESSAO_COLS} from sessao where coletor_id=$1 and status='ativa' order by aberta_em desc limit 1`,
      [coletorId],
    );
    return r.rows[0] || null;
  },
  // Sessão ativa por HOST público — o /_dvr_auth (C-be-6) descobre o DVR pelo Host do nginx e casa
  // com a sessão ativa (host_publico é único por DVR; a UNIQUE parcial garante ≤1 ativa por porta).
  async ativaPorHost(hostPublico) {
    const r = await db.query(
      `select ${SESSAO_COLS} from sessao where host_publico=$1 and status='ativa' order by aberta_em desc limit 1`,
      [String(hostPublico || "")],
    );
    return r.rows[0] || null;
  },
  async portasAtivas() {
    const r = await db.query("select remote_port from sessao where status='ativa'");
    return r.rows.map((x) => x.remote_port);
  },
  // Abre a sessão alocando um remote_port LIVRE. Corrida-safe pelas UNIQUE parciais do schema:
  //  • porta duplicada (23505 em sessao_remote_port_ativa_uidx) → recomputa e tenta outra;
  //  • coletor já com sessão ativa (23505 em sessao_coletor_ativa_uidx) → reusa a existente
  //    (abrir idempotente: 1 túnel por coletor). Devolve { sessao, reusada }.
  async abrir({ dvr_id, coletor_id, cliente_id, ator, host_publico }) {
    const ts = now();
    for (let tentativa = 0; tentativa < 25; tentativa++) {
      const porta = dvrDom.proximaPortaLivre(await this.portasAtivas(), PORTA_INICIO, PORTA_FIM);
      if (porta == null) {
        const e = new Error("faixa de portas de sessão esgotada");
        e.semPorta = true;
        throw e;
      }
      const id = genId("sess");
      try {
        await db.query(
          `insert into sessao(id,dvr_id,coletor_id,cliente_id,ator,status,remote_port,host_publico,aberta_em,ultima_atividade)
           values ($1,$2,$3,$4,$5,'ativa',$6,$7,$8,$8)`,
          [id, dvr_id, coletor_id, cliente_id, ator, porta, host_publico, ts],
        );
        return { sessao: await this.get(id), reusada: false };
      } catch (e) {
        if (e && e.code === "23505") {
          if (e.constraint === "sessao_coletor_ativa_uidx") {
            const existente = await this.ativaPorColetor(coletor_id);
            if (existente) return { sessao: existente, reusada: true };
          }
          continue; // corrida na porta (ou coletor sem linha ainda) → recomputa
        }
        throw e;
      }
    }
    const e = new Error("não foi possível alocar sessão (corrida nas portas)");
    e.semPorta = true;
    throw e;
  },
  // Encerra (idempotente): só afeta 'ativa'. Devolve a linha encerrada, ou null se já encerrada/inexistente.
  async encerrar(id, { encerradaEm } = {}) {
    const ts = encerradaEm || now();
    const r = await db.query(
      `update sessao set status='encerrada', encerrada_em=$2 where id=$1 and status='ativa' returning ${SESSAO_COLS}`,
      [id, ts],
    );
    return r.rows[0] || null;
  },
  // Renova a atividade (o /_dvr_auth chamará isto a cada acesso do técnico — F4, próxima onda).
  async tocarAtividade(id, ts) {
    const r = await db.query("update sessao set ultima_atividade=$2 where id=$1 and status='ativa' returning id", [id, ts || now()]);
    return r.rowCount > 0;
  },
  // Varredura do TIMEOUT (§4/§7): encerra em lote as sessões ativas ociosas há mais de idleMs.
  // Devolve as encerradas (p/ o chamador auditar 'sessao.timeout'). Base = ultima_atividade || aberta_em.
  async varrerOciosas({ idleMs, agora } = {}) {
    const nowTs = agora || now();
    const cutoff = nowTs - Number(idleMs);
    const r = await db.query(
      `update sessao set status='encerrada', encerrada_em=$2
       where status='ativa' and coalesce(ultima_atividade, aberta_em) < $1
       returning id,dvr_id,coletor_id,cliente_id,remote_port,host_publico`,
      [cutoff, nowTs],
    );
    return r.rows;
  },
  // O MAPA DE ROTA que o nginx (B-3) vai ler: host → porta → dvr das sessões ATIVAS.
  async rotasAtivas() {
    const r = await db.query(
      "select host_publico, remote_port, dvr_id, cliente_id, coletor_id from sessao where status='ativa' order by aberta_em asc",
    );
    return r.rows;
  },
};

module.exports = { genId, partners, clientes, sites, users, memberships, publicUser, coletores, dvrs, auditoriaDvr, sessoes };
