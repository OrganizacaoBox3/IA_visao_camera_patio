// Store do domínio PONTE DVR — feature aditiva do hub (contratos.md §3/§4/§5/§8).
// 4 entidades num só store, no MOLDE de shifts.js/events.js: cache em memória + Postgres se
// configurado, senão arquivo JSON (server/dvr.json) — com escrita DURÁVEL-PRIMEIRO e ROLLBACK
// (a defesa contra "persistência falsa": o que aparece na tela e some no restart). Exporta
// persistence() para o guardião de boot (persistence-health.js).
//
//   • coletores (dvr_coletor) — o ENROLLMENT (empresa box3 ↔ cliente visão) + credencial site_key.
//     Fluxo QR: criar emite um enrollment_token (uso único, expira); trocarEnrollment o troca por
//     uma site_key durável (crua sai UMA vez). Guardamos SÓ os hashes (dvr-sitekey.js).
//   • dvrs (dvr)             — o aparelho registrado pelo coletor (marca/modelo/ip/porta + aceite).
//     UNIQUE por coletor ⇒ upsert idempotente (contratos §3). SEM credencial do DVR.
//   • sessoes (dvr_sessao)   — ciclo ativa→encerrada do acesso remoto; a linha ativa É o mapa de rota.
//   • auditoria (dvr_audit)  — append-only (quem/qual DVR/ação/quando).
//
// MODELO-TAG (decisão do dono): cliente_id/empresa_id_box3 são CAMPOS-TEXTO (tags), SEM FK — o
// hub não tem o multi-tenant do control-plane; o suporte é um superadmin que vê tudo/filtra por tag.
// LGPD/sigilo (invariantes do CLAUDE.md): nenhum segredo do DVR aqui; hashes nunca saem em resposta.
const fs = require("node:fs");
const { statePath } = require("./state-dir");
const crypto = require("node:crypto");
const db = require("./db");
const sitekey = require("./dvr-sitekey");
const logic = require("./dvr-logic");

const FILE = statePath("dvr.json");

// Faixa de portas de sessão — casa com o allowPorts do frps (relay). Env sem segredo.
const PORTA_INICIO = Number(process.env.CP_DVR_PORT_START || 20000);
const PORTA_FIM = Number(process.env.CP_DVR_PORT_END || 20099);
// TTL do token de enrollment (uso único + curta validade — contratos §8). Default 15 min.
const ENROLLMENT_TTL_MS = Math.max(1000, Number(process.env.CP_DVR_ENROLLMENT_TTL_MS || 15 * 60 * 1000));

// ── Caches em memória (fonte de verdade para leituras sync) + flag de backend ────────────────
let coletores = []; // { id, cliente_id, empresa_id_box3, coletor_id_box3, nome, site_key_hash, revogado, revogado_em, enrollment_token_hash, enrollment_expira, enrollment_usado, criado_em }
let dvrs = []; // { id, coletor_id, cliente_id, marca, modelo, ip, porta, consentimento_aceito, consentimento_em, consentimento_versao, criado_em, atualizado_em }
let sessoes = []; // { id, dvr_id, coletor_id, cliente_id, ator, status, remote_port, host_publico, aberta_em, encerrada_em, ultima_atividade }
let auditoria = []; // { id, ator, dvr_id, coletor_id, acao, detalhe, em } — SEMPRE em desc (mais recente 1º)
let usingPg = false;

function genId(prefix) {
  return prefix + crypto.randomBytes(8).toString("hex");
}
const now = () => Date.now();

// O hash da site_key e o do token NUNCA saem em resposta pública.
function publicColetor(c) {
  if (!c) return null;
  const { site_key_hash: _s, enrollment_token_hash: _t, ...rest } = c;
  return { ...rest };
}

// ── Persistência ─────────────────────────────────────────────────────────────────────────────
// saveFile LANÇA em falha — de propósito: cada op trata e FAZ ROLLBACK da memória (molde shifts.js).
// No fallback JSON o arquivo inteiro é reescrito (baixo volume); no PG, cada entidade tem seu upsert.
function saveFile() {
  fs.writeFileSync(FILE, JSON.stringify({ coletores, dvrs, sessoes, auditoria }, null, 2));
}
async function persistColetor(c) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into dvr_coletor
       (id,cliente_id,empresa_id_box3,coletor_id_box3,nome,site_key_hash,revogado,revogado_em,
        enrollment_token_hash,enrollment_expira,enrollment_usado,criado_em)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (id) do update set
       nome=excluded.nome, site_key_hash=excluded.site_key_hash, revogado=excluded.revogado,
       revogado_em=excluded.revogado_em, coletor_id_box3=excluded.coletor_id_box3,
       enrollment_token_hash=excluded.enrollment_token_hash, enrollment_expira=excluded.enrollment_expira,
       enrollment_usado=excluded.enrollment_usado`,
    [
      c.id, c.cliente_id, c.empresa_id_box3, c.coletor_id_box3 ?? null, c.nome ?? null,
      c.site_key_hash ?? null, c.revogado, c.revogado_em ?? null,
      c.enrollment_token_hash ?? null, c.enrollment_expira ?? null, c.enrollment_usado, c.criado_em,
    ],
  );
}
async function persistDvr(d) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into dvr
       (id,coletor_id,cliente_id,marca,modelo,ip,porta,consentimento_aceito,consentimento_em,
        consentimento_versao,criado_em,atualizado_em)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (coletor_id) do update set
       marca=excluded.marca, modelo=excluded.modelo, ip=excluded.ip, porta=excluded.porta,
       consentimento_aceito=excluded.consentimento_aceito, consentimento_em=excluded.consentimento_em,
       consentimento_versao=excluded.consentimento_versao, atualizado_em=excluded.atualizado_em`,
    [
      d.id, d.coletor_id, d.cliente_id, d.marca ?? null, d.modelo ?? null, d.ip ?? null, d.porta ?? null,
      d.consentimento_aceito, d.consentimento_em ?? null, d.consentimento_versao ?? null,
      d.criado_em, d.atualizado_em ?? null,
    ],
  );
}
async function persistSessao(s) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into dvr_sessao
       (id,dvr_id,coletor_id,cliente_id,ator,status,remote_port,host_publico,aberta_em,encerrada_em,ultima_atividade)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update set
       status=excluded.status, encerrada_em=excluded.encerrada_em, ultima_atividade=excluded.ultima_atividade`,
    [
      s.id, s.dvr_id, s.coletor_id, s.cliente_id, s.ator, s.status, s.remote_port, s.host_publico,
      s.aberta_em, s.encerrada_em ?? null, s.ultima_atividade ?? null,
    ],
  );
}
async function persistAudit(a) {
  if (!usingPg) return saveFile();
  await db.query(
    "insert into dvr_audit (id,ator,dvr_id,coletor_id,acao,detalhe,em) values ($1,$2,$3,$4,$5,$6,$7)",
    [a.id, a.ator, a.dvr_id ?? null, a.coletor_id ?? null, a.acao, a.detalhe ? JSON.stringify(a.detalhe) : null, a.em],
  );
}

const PERSIST_ERROR = (acao) => ({
  error: `falha ao ${acao} — a persistência está indisponível; tente novamente`,
  status: 503,
});

async function init() {
  if (db.configured()) {
    try {
      const [c, d, s, a] = await Promise.all([
        db.query(
          `select id, cliente_id, empresa_id_box3, coletor_id_box3, nome, site_key_hash, revogado,
                  revogado_em, enrollment_token_hash, enrollment_expira, enrollment_usado, criado_em
           from dvr_coletor order by criado_em asc nulls first`,
        ),
        db.query(
          `select id, coletor_id, cliente_id, marca, modelo, ip, porta, consentimento_aceito,
                  consentimento_em, consentimento_versao, criado_em, atualizado_em
           from dvr order by criado_em asc nulls first`,
        ),
        db.query(
          `select id, dvr_id, coletor_id, cliente_id, ator, status, remote_port, host_publico,
                  aberta_em, encerrada_em, ultima_atividade
           from dvr_sessao order by aberta_em asc nulls first`,
        ),
        db.query(
          "select id, ator, dvr_id, coletor_id, acao, detalhe, em from dvr_audit order by em desc",
        ),
      ]);
      coletores = c.rows;
      dvrs = d.rows;
      sessoes = s.rows;
      auditoria = a.rows;
      usingPg = true;
      console.log(
        `[dvr] Postgres ok — coletores=${coletores.length} dvrs=${dvrs.length} sessoes=${sessoes.length} audit=${auditoria.length}`,
      );
      return;
    } catch (e) {
      console.error("[dvr] Postgres indisponível, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    coletores = Array.isArray(raw.coletores) ? raw.coletores : [];
    dvrs = Array.isArray(raw.dvrs) ? raw.dvrs : [];
    sessoes = Array.isArray(raw.sessoes) ? raw.sessoes : [];
    auditoria = Array.isArray(raw.auditoria) ? raw.auditoria.slice().sort((x, y) => y.em - x.em) : [];
  } catch {
    coletores = [];
    dvrs = [];
    sessoes = [];
    auditoria = [];
  }
}

// ════════════════════════════════════════════════════════════════════════════
// coletores — ENROLLMENT + credencial site_key (contratos §3/§8)
// ════════════════════════════════════════════════════════════════════════════
const coletoresApi = {
  // Cria o coletor (liga cliente↔empresa) e EMITE um enrollment_token (uso único, expira). O
  // token cru sai UMA vez (vai no QR). A site_key só nasce na troca (trocarEnrollment). Valida
  // cliente_id/empresa_id_box3 pela lógica pura (dvr-logic.validateEnrollment).
  async criar({ cliente_id, empresa_id_box3, nome, coletor_id_box3 } = {}) {
    const v = logic.validateEnrollment({ cliente_id, empresa_id_box3, nome, coletor_id_box3 });
    if (!v.ok) return { error: v.error, status: 400 };
    const ts = now();
    const rawToken = crypto.randomBytes(24).toString("base64url");
    const c = {
      id: genId("col"),
      cliente_id: v.value.cliente_id,
      empresa_id_box3: v.value.empresa_id_box3,
      coletor_id_box3: v.value.coletor_id_box3,
      nome: v.value.nome,
      site_key_hash: null,
      revogado: false,
      revogado_em: null,
      enrollment_token_hash: sitekey.hashSiteKey(rawToken),
      enrollment_expira: ts + ENROLLMENT_TTL_MS,
      enrollment_usado: false,
      criado_em: ts,
    };
    coletores.push(c);
    try {
      await persistColetor(c);
    } catch (e) {
      coletores = coletores.filter((x) => x !== c);
      console.error("[dvr] FALHA ao criar coletor (persistência):", e.message);
      return PERSIST_ERROR("criar o coletor");
    }
    return { coletor: publicColetor(c), enrollmentToken: rawToken, expira: c.enrollment_expira };
  },

  // Troca o enrollment_token (uso único) por uma site_key durável — a chave crua sai UMA vez aqui
  // (o hub guarda só o hash). Token inválido/inexistente ⇒ 401; usado ou expirado ⇒ 410 (contratos §8).
  async trocarEnrollment(rawToken) {
    const tok = String(rawToken || "");
    if (!tok) return { error: "enrollmentToken ausente", status: 401 };
    const c = coletores.find(
      (x) => x.enrollment_token_hash && sitekey.verifySiteKey(tok, x.enrollment_token_hash),
    );
    if (!c) return { error: "enrollmentToken inválido", status: 401 };
    if (c.enrollment_usado) return { error: "enrollmentToken já utilizado", status: 410 };
    if (c.enrollment_expira && now() > c.enrollment_expira)
      return { error: "enrollmentToken expirado", status: 410 };
    const rawKey = sitekey.generateSiteKey();
    const before = { ...c };
    c.enrollment_usado = true;
    c.site_key_hash = sitekey.hashSiteKey(rawKey);
    try {
      await persistColetor(c);
    } catch (e) {
      Object.assign(c, before);
      console.error("[dvr] FALHA ao trocar enrollment (persistência):", e.message);
      return PERSIST_ERROR("trocar o enrollment");
    }
    return { coletorId: c.id, siteKey: rawKey };
  },

  // Auth do coletor (authColetor timing-safe): site_key válida contra o hash. coletor inexistente
  // ⇒ 404; revogado ⇒ 403; chave errada/ausente (ou ainda sem site_key) ⇒ 401. Não expõe o hash.
  verify(coletorId, key) {
    const c = coletorId ? coletores.find((x) => x.id === String(coletorId)) : null;
    if (!c) return { code: 404, error: "coletor inexistente" };
    if (c.revogado) return { code: 403, error: "coletor revogado (enrollment obsoleto)" };
    if (!c.site_key_hash || !sitekey.verifySiteKey(String(key || ""), c.site_key_hash))
      return { code: 401, error: "site_key inválida" };
    return { coletor: publicColetor(c), coletorId: c.id, clienteId: c.cliente_id };
  },

  get(id) {
    return publicColetor(coletores.find((x) => x.id === id) || null);
  },
  list() {
    return coletores.map(publicColetor);
  },

  async revogar(id) {
    const c = coletores.find((x) => x.id === id);
    if (!c) return { error: "coletor não encontrado", status: 404 };
    if (c.revogado) return { ok: true, coletor: publicColetor(c) }; // idempotente
    const before = { ...c };
    c.revogado = true;
    c.revogado_em = now();
    try {
      await persistColetor(c);
    } catch (e) {
      Object.assign(c, before);
      console.error("[dvr] FALHA ao revogar coletor (persistência):", e.message);
      return PERSIST_ERROR("revogar o coletor");
    }
    return { ok: true, coletor: publicColetor(c) };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// dvrs — cadastro do aparelho (upsert idempotente por coletor — contratos §3)
// ════════════════════════════════════════════════════════════════════════════
const dvrsApi = {
  getByColetor(coletorId) {
    return dvrs.find((d) => d.coletor_id === coletorId) || null;
  },
  get(id) {
    return dvrs.find((d) => d.id === id) || null;
  },
  // Leitura da UI do suporte: DVR + contexto do coletor (nome/empresa/revogado). No modelo-tag não
  // há tabela cliente, então cliente_nome não existe — a UI usa o cliente_id (tag). Sem credencial.
  listComContexto() {
    return dvrs.map((d) => {
      const col = coletores.find((c) => c.id === d.coletor_id) || null;
      return {
        ...d,
        coletor_nome: col ? col.nome : null,
        empresa_id_box3: col ? col.empresa_id_box3 : null,
        coletor_id_box3: col ? col.coletor_id_box3 : null,
        coletor_revogado: col ? col.revogado : null,
      };
    });
  },
  // Upsert idempotente por coletor (1 DVR/coletor). Devolve { dvr, inserido } p/ auditar registrar×atualizar.
  async upsert({ coletor_id, cliente_id, marca, modelo, ip, porta, consentimento }) {
    const ts = now();
    const existing = dvrs.find((d) => d.coletor_id === coletor_id);
    if (!existing) {
      const d = {
        id: genId("dvr"),
        coletor_id,
        cliente_id,
        marca: marca ?? null,
        modelo: modelo ?? null,
        ip: ip ?? null,
        porta: porta ?? null,
        consentimento_aceito: consentimento.aceito,
        consentimento_em: consentimento.quando,
        consentimento_versao: consentimento.versaoTexto ?? null,
        criado_em: ts,
        atualizado_em: ts,
      };
      dvrs.push(d);
      try {
        await persistDvr(d);
      } catch (e) {
        dvrs = dvrs.filter((x) => x !== d);
        console.error("[dvr] FALHA ao registrar DVR (persistência):", e.message);
        return PERSIST_ERROR("registrar o DVR");
      }
      return { dvr: d, inserido: true };
    }
    const before = { ...existing };
    Object.assign(existing, {
      marca: marca ?? null,
      modelo: modelo ?? null,
      ip: ip ?? null,
      porta: porta ?? null,
      consentimento_aceito: consentimento.aceito,
      consentimento_em: consentimento.quando,
      consentimento_versao: consentimento.versaoTexto ?? null,
      atualizado_em: ts,
    });
    try {
      await persistDvr(existing);
    } catch (e) {
      Object.assign(existing, before);
      console.error("[dvr] FALHA ao atualizar DVR (persistência):", e.message);
      return PERSIST_ERROR("atualizar o DVR");
    }
    return { dvr: existing, inserido: false };
  },
};

// ════════════════════════════════════════════════════════════════════════════
// sessoes — ciclo do acesso remoto (contratos §4); a linha ativa É o mapa de rota
// ════════════════════════════════════════════════════════════════════════════
// A idempotência-por-coletor e a alocação de porta são resolvidas EM MEMÓRIA (molde memory-first
// do hub; determinístico num processo). As UNIQUE parciais do schema (dvr_sessao_*_ativa_uidx) são
// o backstop de corrida MULTI-INSTÂNCIA — um 23505 no persist faz rollback + 503 (nunca porta dupla).
const sessoesApi = {
  get(id) {
    return sessoes.find((s) => s.id === id) || null;
  },
  ativaPorColetor(coletorId) {
    return sessoes.find((s) => s.coletor_id === coletorId && s.status === "ativa") || null;
  },
  ativaPorHost(hostPublico) {
    return sessoes.find((s) => s.host_publico === String(hostPublico || "") && s.status === "ativa") || null;
  },
  portasAtivas() {
    return sessoes.filter((s) => s.status === "ativa").map((s) => s.remote_port);
  },
  listAtivas() {
    return sessoes
      .filter((s) => s.status === "ativa")
      .slice()
      .sort((a, b) => b.aberta_em - a.aberta_em);
  },
  // O MAPA DE ROTA que o nginx (relay) consome: host → porta → dvr das sessões ATIVAS.
  rotasAtivas() {
    return sessoes
      .filter((s) => s.status === "ativa")
      .slice()
      .sort((a, b) => a.aberta_em - b.aberta_em)
      .map((s) => ({
        host_publico: s.host_publico,
        remote_port: s.remote_port,
        dvr_id: s.dvr_id,
        cliente_id: s.cliente_id,
        coletor_id: s.coletor_id,
      }));
  },
  // Abre alocando um remote_port LIVRE. Idempotente por coletor (reusa a sessão ativa — 1 túnel/coletor).
  // Faixa esgotada ⇒ { error, status:503 } (não é bug — é capacidade). Devolve { sessao, reusada }.
  async abrir({ dvr_id, coletor_id, cliente_id, ator, host_publico }) {
    const existente = this.ativaPorColetor(coletor_id);
    if (existente) return { sessao: existente, reusada: true };
    const porta = logic.proximaPortaLivre(this.portasAtivas(), PORTA_INICIO, PORTA_FIM);
    if (porta == null) return { error: "faixa de portas de sessão esgotada", status: 503 };
    const ts = now();
    const s = {
      id: genId("sess"),
      dvr_id,
      coletor_id,
      cliente_id,
      ator,
      status: "ativa",
      remote_port: porta,
      host_publico,
      aberta_em: ts,
      encerrada_em: null,
      ultima_atividade: ts,
    };
    sessoes.push(s);
    try {
      await persistSessao(s);
    } catch (e) {
      sessoes = sessoes.filter((x) => x !== s);
      // 23505 = corrida multi-instância nas UNIQUE parciais (porta/coletor). Rollback + 503.
      console.error("[dvr] FALHA ao abrir sessão (persistência):", e.message);
      return PERSIST_ERROR("abrir a sessão");
    }
    return { sessao: s, reusada: false };
  },
  // Encerra (idempotente): só afeta 'ativa'. { encerrada } (linha) ou { encerrada: null } se já fechada.
  async encerrar(id, { encerradaEm } = {}) {
    const s = sessoes.find((x) => x.id === id && x.status === "ativa");
    if (!s) return { encerrada: null };
    const before = { ...s };
    s.status = "encerrada";
    s.encerrada_em = encerradaEm || now();
    try {
      await persistSessao(s);
    } catch (e) {
      Object.assign(s, before);
      console.error("[dvr] FALHA ao encerrar sessão (persistência):", e.message);
      return PERSIST_ERROR("encerrar a sessão");
    }
    return { encerrada: s };
  },
  // Renova a atividade (o /_dvr_auth chama a cada acesso do técnico). Best-effort: false se falhar.
  async tocarAtividade(id, ts) {
    const s = sessoes.find((x) => x.id === id && x.status === "ativa");
    if (!s) return false;
    const before = s.ultima_atividade;
    s.ultima_atividade = ts || now();
    try {
      await persistSessao(s);
    } catch (e) {
      s.ultima_atividade = before;
      console.error("[dvr] FALHA ao renovar atividade (persistência):", e.message);
      return false;
    }
    return true;
  },
  // Varredura do TIMEOUT (§4/§7): encerra as sessões ativas ociosas há mais de idleMs. Devolve as
  // encerradas (p/ o chamador auditar 'sessao.timeout'). Base = ultima_atividade || aberta_em.
  async varrerOciosas({ idleMs, agora } = {}) {
    const nowTs = agora || now();
    const encerradas = [];
    for (const s of sessoes) {
      if (s.status !== "ativa" || !logic.sessaoOciosa(s, nowTs, idleMs)) continue;
      const before = { ...s };
      s.status = "encerrada";
      s.encerrada_em = nowTs;
      try {
        await persistSessao(s);
        encerradas.push(s);
      } catch (e) {
        Object.assign(s, before);
        console.error("[dvr] FALHA ao encerrar sessão ociosa (persistência):", e.message);
      }
    }
    return encerradas;
  },
};

// ════════════════════════════════════════════════════════════════════════════
// auditoria — append-only (quem/qual DVR/ação/quando)
// ════════════════════════════════════════════════════════════════════════════
const auditoriaApi = {
  async registrar({ ator, dvr_id, coletor_id, acao, detalhe }) {
    const a = {
      id: genId("aud"),
      ator: String(ator || ""),
      dvr_id: dvr_id ?? null,
      coletor_id: coletor_id ?? null,
      acao: String(acao || ""),
      detalhe: detalhe ?? null,
      em: now(),
    };
    auditoria.unshift(a); // otimista, mais recente 1º
    try {
      await persistAudit(a);
    } catch (e) {
      auditoria = auditoria.filter((x) => x !== a);
      console.error("[dvr] FALHA ao gravar auditoria (persistência):", e.message);
      return PERSIST_ERROR("registrar a auditoria");
    }
    return { audit: a };
  },
  // Lista (mais recente 1º) com filtros opcionais por coletor e por cliente (tag). Enriquece com o
  // cliente_id/coletor_nome do coletor (join em memória) p/ a UI do suporte casar DVR↔auditoria.
  list({ limit = 200, coletorId = null, clienteId = null } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
    let out = auditoria;
    if (coletorId) out = out.filter((a) => a.coletor_id === String(coletorId));
    if (clienteId) {
      const colIds = new Set(coletores.filter((c) => c.cliente_id === String(clienteId)).map((c) => c.id));
      out = out.filter((a) => a.coletor_id && colIds.has(a.coletor_id));
    }
    return out.slice(0, lim).map((a) => {
      const col = a.coletor_id ? coletores.find((c) => c.id === a.coletor_id) : null;
      return { ...a, cliente_id: col ? col.cliente_id : null, coletor_nome: col ? col.nome : null };
    });
  },
};

module.exports = {
  init,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
  coletores: coletoresApi,
  dvrs: dvrsApi,
  sessoes: sessoesApi,
  auditoria: auditoriaApi,
};
