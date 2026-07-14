// Rotas da API do control-plane (Fase 1): login + CRUD do cadastro + ingest/heartbeat.
// Cada handler de CRUD passa por verifyToken (ctx.requireScope) + canAccess (access.js) no
// recurso ALVO — o isolamento das tabelas de cadastro é no APP (spec §5). Ingest/heartbeat NÃO
// usam token de usuário: autenticam por x-site-id/x-site-key (a credencial do hub silo).
//
// handle() devolve true se PRODUZIU a resposta (rota casada); false → o index responde 404.
// Erros lançados (JSON inválido, tooLarge, PG) sobem para o try/catch do index (400/413/500).
const auth = require("./auth");
const access = require("./access");
const stores = require("./stores");
const password = require("./password");
const sitekey = require("./sitekey");
const login = require("./login");
const db = require("./db");

async function readJson(req, ctx) {
  const raw = await ctx.readBody(req);
  if (!raw) return {};
  return JSON.parse(raw); // SyntaxError → 400 no dispatch do index
}

// ── autenticação de SITE (ingest/heartbeat), por header — NÃO por token de usuário ──
// Contrato: x-site-id + x-site-key (chave em texto). O plane compara com o HASH guardado,
// timing-safe (sitekey.verifySiteKey). site inexistente → 404; chave errada/ausente → 401.
async function authSite(req) {
  const siteId = req.headers["x-site-id"];
  const siteKey = req.headers["x-site-key"];
  const s = siteId ? await stores.sites.getWithHash(String(siteId)) : null;
  if (!s) return { code: 404, error: "site inexistente" };
  if (!s.site_key_hash || !sitekey.verifySiteKey(String(siteKey || ""), s.site_key_hash)) {
    return { code: 401, error: "site_key inválida" };
  }
  return { site: s, siteId: s.id };
}

async function handle(req, res, ctx) {
  const { json, requireScope } = ctx;
  const path = new URL(req.url, "http://x").pathname;
  const seg = path.split("/").filter(Boolean); // ['api','partners','p1']
  const method = req.method;
  if (seg[0] !== "api") return false;

  // ── POST /api/login ─────────────────────────────────────────────────────────
  if (path === "/api/login" && method === "POST") {
    const { email, senha } = await readJson(req, ctx);
    const u = await stores.users.getByEmailWithHash(email);
    if (!u || !u.ativo || !password.verifyPassword(u.senha_hash, senha)) {
      json(res, 401, { error: "credenciais inválidas" });
      return true;
    }
    const m = login.selectScope(await stores.memberships.listByUser(u.id));
    if (!m) {
      json(res, 403, { error: "usuário sem acesso (nenhuma membership)" });
      return true;
    }
    const token = auth.signToken({ id: u.id, papel: m.role, scope_type: m.scope_type, scope_id: m.scope_id });
    json(res, 200, {
      token,
      user: { id: u.id, email: u.email },
      scope: { scope_type: m.scope_type, scope_id: m.scope_id, role: m.role },
    });
    return true;
  }

  // ── POST /api/ingest/alarm ────────────────────────────────────────────────────
  // Grava alarm_event via withTenant(site_id) — exercita o gate RLS da Fase 0.
  if (path === "/api/ingest/alarm" && method === "POST") {
    const a = await authSite(req);
    if (a.error) {
      json(res, a.code, { error: a.error });
      return true;
    }
    const b = await readJson(req, ctx);
    // meta = tudo do evento MENOS tipo/ts (que viram colunas). LGPD: só metadados.
    const meta = {
      id: b.id ?? null,
      cameraId: b.cameraId ?? null,
      cameraLabel: b.cameraLabel ?? null,
      zona: b.zona ?? null,
      priority: b.priority ?? null,
      text: b.text ?? null,
      state: b.state ?? null,
    };
    await db.withTenant(a.siteId, async (cl) => {
      await cl.query("insert into alarm_event(site_id,tipo,ts,meta) values ($1,$2,$3,$4)", [
        a.siteId,
        String(b.tipo || "atividade"),
        Number(b.ts) || Date.now(),
        JSON.stringify(meta),
      ]);
    });
    json(res, 202, { ok: true });
    return true;
  }

  // ── POST /api/site/heartbeat ──────────────────────────────────────────────────
  if (path === "/api/site/heartbeat" && method === "POST") {
    const a = await authSite(req);
    if (a.error) {
      json(res, a.code, { error: a.error });
      return true;
    }
    await stores.sites.touchLastSeen(a.siteId, Date.now());
    json(res, 200, { ok: true });
    return true;
  }

  // ── daqui p/ baixo: tudo exige token de usuário (verifyToken) ─────────────────
  const collection = seg[1];
  const id = seg[2];

  // ═══ /api/partners ════════════════════════════════════════════════════════════
  if (collection === "partners") {
    const claims = requireScope(req, res);
    if (!claims) return true;

    if (!id && method === "GET") {
      const tree = await access.buildFullTree();
      const rows = (await stores.partners.list()).filter((p) => auth.canAccess(claims, { type: "partner", id: p.id }, tree));
      json(res, 200, rows);
      return true;
    }
    if (!id && method === "POST") {
      // Criar partner é ato de plataforma (um partner novo não tem pai na árvore).
      if (claims.scope_type !== "platform") {
        json(res, 403, { error: "apenas platform-admin cria partner" });
        return true;
      }
      const { nome } = await readJson(req, ctx);
      if (!nome) {
        json(res, 400, { error: "nome é obrigatório" });
        return true;
      }
      json(res, 201, await stores.partners.create({ nome }));
      return true;
    }
    if (id && (method === "GET" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
      if (!(await access.guardAccess(claims, { type: "partner", id }))) {
        json(res, 403, { error: "sem acesso a este partner" });
        return true;
      }
      if (method === "GET") {
        const p = await stores.partners.get(id);
        return p ? (json(res, 200, p), true) : (json(res, 404, { error: "não encontrado" }), true);
      }
      if (method === "DELETE") {
        const ok = await stores.partners.remove(id);
        json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "não encontrado" });
        return true;
      }
      const { nome } = await readJson(req, ctx);
      const p = await stores.partners.update(id, { nome });
      json(res, p ? 200 : 404, p || { error: "não encontrado" });
      return true;
    }
  }

  // ═══ /api/clientes ════════════════════════════════════════════════════════════
  if (collection === "clientes") {
    const claims = requireScope(req, res);
    if (!claims) return true;

    if (!id && method === "GET") {
      const tree = await access.buildFullTree();
      const rows = (await stores.clientes.list()).filter((c) => auth.canAccess(claims, { type: "cliente", id: c.id }, tree));
      json(res, 200, rows);
      return true;
    }
    if (!id && method === "POST") {
      const { partner_id, nome } = await readJson(req, ctx);
      if (!partner_id || !nome) {
        json(res, 400, { error: "partner_id e nome são obrigatórios" });
        return true;
      }
      if (!(await access.guardAccess(claims, { type: "partner", id: partner_id }))) {
        json(res, 403, { error: "sem acesso a este partner" });
        return true;
      }
      if (!(await stores.partners.get(partner_id))) {
        json(res, 404, { error: "partner inexistente" });
        return true;
      }
      json(res, 201, await stores.clientes.create({ partner_id, nome }));
      return true;
    }
    if (id && (method === "GET" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
      if (!(await access.guardAccess(claims, { type: "cliente", id }))) {
        json(res, 403, { error: "sem acesso a este cliente" });
        return true;
      }
      if (method === "GET") {
        const c = await stores.clientes.get(id);
        json(res, c ? 200 : 404, c || { error: "não encontrado" });
        return true;
      }
      if (method === "DELETE") {
        const ok = await stores.clientes.remove(id);
        json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "não encontrado" });
        return true;
      }
      const { nome } = await readJson(req, ctx);
      const c = await stores.clientes.update(id, { nome });
      json(res, c ? 200 : 404, c || { error: "não encontrado" });
      return true;
    }
  }

  // ═══ /api/sites ═══════════════════════════════════════════════════════════════
  if (collection === "sites") {
    const claims = requireScope(req, res);
    if (!claims) return true;

    if (!id && method === "GET") {
      const tree = await access.buildFullTree();
      const rows = (await stores.sites.list()).filter((s) => auth.canAccess(claims, { type: "site", id: s.id }, tree));
      json(res, 200, rows);
      return true;
    }
    if (!id && method === "POST") {
      const { cliente_id, nome } = await readJson(req, ctx);
      if (!cliente_id || !nome) {
        json(res, 400, { error: "cliente_id e nome são obrigatórios" });
        return true;
      }
      if (!(await access.guardAccess(claims, { type: "cliente", id: cliente_id }))) {
        json(res, 403, { error: "sem acesso a este cliente" });
        return true;
      }
      if (!(await stores.clientes.get(cliente_id))) {
        json(res, 404, { error: "cliente inexistente" });
        return true;
      }
      // site_key: nasce aqui, guardamos SÓ o hash, devolvemos a chave CRUA UMA vez (padrão API key).
      const rawKey = sitekey.generateSiteKey();
      const s = await stores.sites.create({ cliente_id, nome, siteKeyHash: sitekey.hashSiteKey(rawKey) });
      json(res, 201, { ...s, site_key: rawKey });
      return true;
    }
    if (id && (method === "GET" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
      if (!(await access.guardAccess(claims, { type: "site", id }))) {
        json(res, 403, { error: "sem acesso a este site" });
        return true;
      }
      if (method === "GET") {
        const s = await stores.sites.get(id);
        json(res, s ? 200 : 404, s || { error: "não encontrado" });
        return true;
      }
      if (method === "DELETE") {
        const ok = await stores.sites.remove(id);
        json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "não encontrado" });
        return true;
      }
      const { nome } = await readJson(req, ctx);
      const s = await stores.sites.update(id, { nome });
      json(res, s ? 200 : 404, s || { error: "não encontrado" });
      return true;
    }
  }

  // ═══ /api/users ═══════════════════════════════════════════════════════════════
  // app_user é global (sem escopo próprio); a visibilidade vem das memberships. Um usuário é
  // visível/editável se compartilha uma membership dentro da subárvore do escopo do chamador.
  // (Seleção de "dono" fina do usuário fica p/ depois — como a multi-membership do login.)
  if (collection === "users") {
    const claims = requireScope(req, res);
    if (!claims) return true;
    const canManageUsers = ["platform", "partner", "cliente"].includes(claims.scope_type);

    if (!id && method === "GET") {
      const all = await stores.users.list();
      if (claims.scope_type === "platform") {
        json(res, 200, all);
        return true;
      }
      const tree = await access.buildFullTree();
      const out = [];
      for (const u of all) {
        const ms = await stores.memberships.listByUser(u.id);
        if (ms.some((m) => access.scopeInTree(claims, m.scope_type, m.scope_id, tree))) out.push(u);
      }
      json(res, 200, out);
      return true;
    }
    if (!id && method === "POST") {
      if (!canManageUsers) {
        json(res, 403, { error: "sem permissão para criar usuários" });
        return true;
      }
      const { email, senha } = await readJson(req, ctx);
      if (!email || !senha) {
        json(res, 400, { error: "email e senha são obrigatórios" });
        return true;
      }
      if (await stores.users.getByEmailWithHash(email)) {
        json(res, 409, { error: "email já cadastrado" });
        return true;
      }
      json(res, 201, await stores.users.create({ email, senhaHash: password.hashPassword(senha) }));
      return true;
    }
    if (id && (method === "GET" || method === "PUT" || method === "PATCH" || method === "DELETE")) {
      // acesso ao usuário-alvo: platform sempre; senão precisa compartilhar membership acessível.
      let allowed = claims.scope_type === "platform";
      if (!allowed) {
        const tree = await access.buildFullTree();
        const ms = await stores.memberships.listByUser(id);
        allowed = ms.some((m) => access.scopeInTree(claims, m.scope_type, m.scope_id, tree));
      }
      if (!allowed) {
        json(res, 403, { error: "sem acesso a este usuário" });
        return true;
      }
      if (method === "GET") {
        const u = await stores.users.get(id);
        json(res, u ? 200 : 404, u || { error: "não encontrado" });
        return true;
      }
      if (method === "DELETE") {
        const ok = await stores.users.remove(id);
        json(res, ok ? 200 : 404, ok ? { ok: true } : { error: "não encontrado" });
        return true;
      }
      const b = await readJson(req, ctx);
      const patch = {};
      if (b.senha) patch.senhaHash = password.hashPassword(b.senha);
      if (typeof b.ativo === "boolean") patch.ativo = b.ativo;
      const u = await stores.users.update(id, patch);
      json(res, u ? 200 : 404, u || { error: "não encontrado" });
      return true;
    }
  }

  // ═══ /api/memberships ═════════════════════════════════════════════════════════
  // O ato de RBAC: conceder/revogar um papel num escopo. Guard = acesso ao ESCOPO-alvo
  // (guardScope): p/ dar site-operator em S1, o chamador precisa ter acesso a S1; etc.
  if (collection === "memberships") {
    const claims = requireScope(req, res);
    if (!claims) return true;

    if (!id && method === "GET") {
      const tree = await access.buildFullTree();
      const rows = (await stores.memberships.list()).filter((m) => access.scopeInTree(claims, m.scope_type, m.scope_id, tree));
      json(res, 200, rows);
      return true;
    }
    if (!id && method === "POST") {
      const { user_id, scope_type, scope_id, role } = await readJson(req, ctx);
      if (!user_id || !scope_type || !role) {
        json(res, 400, { error: "user_id, scope_type e role são obrigatórios" });
        return true;
      }
      if (!auth.SCOPE_TYPES.includes(scope_type)) {
        json(res, 400, { error: "scope_type inválido" });
        return true;
      }
      if (scope_type !== "platform" && !scope_id) {
        json(res, 400, { error: "scope_id é obrigatório fora de platform" });
        return true;
      }
      if (!(await access.guardScope(claims, scope_type, scope_id))) {
        json(res, 403, { error: "sem acesso ao escopo alvo" });
        return true;
      }
      if (!(await stores.users.get(user_id))) {
        json(res, 404, { error: "usuário inexistente" });
        return true;
      }
      // valida que o alvo do escopo existe (evita membership órfã) — platform não tem alvo.
      if (scope_type === "partner" && !(await stores.partners.get(scope_id))) {
        json(res, 404, { error: "partner inexistente" });
        return true;
      }
      if (scope_type === "cliente" && !(await stores.clientes.get(scope_id))) {
        json(res, 404, { error: "cliente inexistente" });
        return true;
      }
      if (scope_type === "site" && !(await stores.sites.get(scope_id))) {
        json(res, 404, { error: "site inexistente" });
        return true;
      }
      json(res, 201, await stores.memberships.create({ user_id, scope_type, scope_id, role }));
      return true;
    }
    if (id && (method === "GET" || method === "DELETE")) {
      const m = await stores.memberships.get(id);
      if (!m) {
        json(res, 404, { error: "não encontrado" });
        return true;
      }
      if (!(await access.guardScope(claims, m.scope_type, m.scope_id))) {
        json(res, 403, { error: "sem acesso ao escopo desta membership" });
        return true;
      }
      if (method === "GET") {
        json(res, 200, m);
        return true;
      }
      await stores.memberships.remove(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  return false; // nenhuma rota casou → o index responde 404
}

module.exports = { handle, authSite };
