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
const overview = require("./overview");
const dvr = require("./dvr");
const cookie = require("./cookie");
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

// ── verificação da credencial do COLETOR (a site_key da Opção A, contratos §8) ──
// A MESMA site_key emitida no enrollment autentica a API DVR, o login-plugin do frps (F3) e a
// sessão. Por isso a lógica é UMA só (aqui), consumida por: authColetor (headers x-coletor-*),
// pelo login-plugin (metas do frp) e pelas rotas de sessão. coletor inexistente → 404; revogado
// (enrollment obsoleto/drift) → 403; chave errada/ausente → 401.
async function verifyColetor(coletorId, key) {
  const c = coletorId ? await stores.coletores.getWithHash(String(coletorId)) : null;
  if (!c) return { code: 404, error: "coletor inexistente" };
  if (c.revogado) return { code: 403, error: "coletor revogado (enrollment obsoleto)" };
  if (!c.site_key_hash || !sitekey.verifySiteKey(String(key || ""), c.site_key_hash)) {
    return { code: 401, error: "site_key inválida" };
  }
  return { coletor: c, coletorId: c.id, clienteId: c.cliente_id };
}

// autenticação do COLETOR por header (ingest-style): x-coletor-id + x-coletor-key.
async function authColetor(req) {
  return verifyColetor(req.headers["x-coletor-id"], req.headers["x-coletor-key"]);
}

async function handle(req, res, ctx) {
  const { json, requireScope } = ctx;
  const path = new URL(req.url, "http://x").pathname;
  const seg = path.split("/").filter(Boolean); // ['api','partners','p1']
  const method = req.method;

  // ── /_dvr_auth — SUBREQUISIÇÃO de auth do nginx (C-be-6, Ponte DVR / contratos §5) ───────────
  // NÃO é /api/ de propósito: o nginx (B-3) faz auth_request AQUI num subdomínio *.dvr.box3.software
  // (≠ origem do portal), então o técnico chega pelo COOKIE de sessão no domínio pai .box3.software
  // (C-be-7). Por isso resolvemos ANTES do guard `seg[0]==='api'`. auth_request usa a subrequisição
  // como porteiro: 2xx libera o proxy; 401 → o nginx redireciona ao login; 403 → página de negado.
  // Casa Host↔DVR↔técnico (contratos §5):
  //   1) sessão do técnico pelo COOKIE (mesmo verifyToken do Bearer)      → 401 se ausente/inválida
  //   2) DVR pelo Host (X-Original-Host que o nginx repassa) → sessão ATIVA → 401 se não há túnel
  //   3) autorização do técnico no cliente daquele DVR (canAccess)        → 403 se sem acesso
  //   4) timeout de inatividade (§7, camada 1): ociosa ⇒ encerra + audita + 401
  //   5) renova ultima_atividade (tocarAtividade) + AUDITA o acesso (com throttle — ver nota abaixo)
  //   6) 200 + headers úteis ao nginx: X-Dvr-Upstream=<loopback>:<remotePort> alimenta o UPSTREAM
  //      DINÂMICO do proxy (auth_request_set no nginx) — a rota vem do rotasAtivas() lido aqui,
  //      sem map file nem reload (fonte única = a linha de sessão ativa).
  // NOTA/divergência (auditoria): o de-risking pede auditar "cada acesso", mas o auth_request dispara
  // por asset — auditar tudo inundaria a auditoria_dvr. Aplicamos um throttle por sessão
  // (CP_DVR_AUDIT_THROTTLE_MS, default 60s; 0 = cada acesso). Ver dvr.deveAuditarAcesso.
  // auth_request IGNORA o corpo; devolvemos JSON só p/ teste/observabilidade direto.
  if (path === "/_dvr_auth") {
    const claims = auth.verifyToken(cookie.tokenDoCookie(req));
    if (!claims) {
      json(res, 401, { error: "sessão do técnico ausente/inválida (faça login no portal)" });
      return true;
    }
    const host = String(req.headers["x-original-host"] || req.headers["host"] || "")
      .split(":")[0]
      .toLowerCase();
    const sess = host ? await stores.sessoes.ativaPorHost(host) : null;
    if (!sess) {
      json(res, 401, { error: "sem sessão ativa para este host (túnel caiu ou foi encerrado)" });
      return true;
    }
    if (!(await access.guardAccess(claims, { type: "cliente", id: sess.cliente_id }))) {
      json(res, 403, { error: "técnico sem acesso a este DVR" });
      return true;
    }
    const agora = Date.now();
    const idleMs = Number(process.env.CP_DVR_IDLE_MS ?? 20 * 60 * 1000);
    if (dvr.sessaoOciosa(sess, agora, idleMs)) {
      const enc = await stores.sessoes.encerrar(sess.id, { encerradaEm: agora });
      if (enc) {
        await stores.auditoriaDvr.registrar({
          ator: "sistema",
          dvr_id: sess.dvr_id,
          coletor_id: sess.coletor_id,
          acao: "sessao.timeout",
          detalhe: { sessaoId: sess.id, via: "_dvr_auth" },
        });
      }
      json(res, 401, { error: "sessão expirada por inatividade" });
      return true;
    }
    const throttleMs = Number(process.env.CP_DVR_AUDIT_THROTTLE_MS ?? 60 * 1000);
    if (dvr.deveAuditarAcesso(sess, agora, throttleMs)) {
      await stores.auditoriaDvr.registrar({
        ator: claims.id,
        dvr_id: sess.dvr_id,
        coletor_id: sess.coletor_id,
        acao: "acesso.tecnico",
        detalhe: { sessaoId: sess.id, host, uri: req.headers["x-original-uri"] || null },
      });
    }
    await stores.sessoes.tocarAtividade(sess.id, agora);
    if (typeof res.setHeader === "function") {
      // headers que o nginx copia de volta (auth_request_set): upstream dinâmico + rastros.
      const loopback = process.env.CP_DVR_UPSTREAM_HOST || "127.0.0.1";
      res.setHeader("X-Dvr-Upstream", `${loopback}:${sess.remote_port}`);
      res.setHeader("X-Dvr-Sessao", sess.id);
      res.setHeader("X-Dvr-Tecnico", String(claims.id));
    }
    json(res, 200, { ok: true, sessaoId: sess.id, remotePort: sess.remote_port, host });
    return true;
  }

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
    // C-be-7: ADICIONA um cookie de sessão (HttpOnly+Secure+SameSite, domínio pai .box3.software) —
    // o MESMO token do Bearer, só para o /_dvr_auth num subdomínio o enxergar (contratos §6b). O
    // corpo continua devolvendo o token (o portal segue usando Bearer/sessionStorage). O guard de
    // setHeader é só p/ mocks de teste sem headers; o res real (node http) sempre tem setHeader.
    if (typeof res.setHeader === "function") {
      res.setHeader("Set-Cookie", cookie.montarSetCookie(token));
    }
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

  // ═══ GET /api/overview — a FROTA do escopo do chamador (Fase 2) ════════════════
  // Uma chamada: partners/clientes/sites ACESSÍVEIS (mesmo filtro canAccess do CRUD) +
  // online (now-last_seen<10min) + alarms24h por site (contado via withTenant, RLS-safe).
  if (collection === "overview" && !id && method === "GET") {
    const claims = requireScope(req, res);
    if (!claims) return true;
    json(res, 200, await overview.buildOverview(claims));
    return true;
  }

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

    // ── GET /api/sites/:id/alarms?limit=&since=&before= — drill-down dos alarmes (Fase 2) ──
    // canAccess(site) decide o QUÊ; withTenant(site) isola a LEITURA (RLS). Precede o
    // handler de site singular abaixo (que também casaria id+GET). limit default 50, teto 500.
    // Cursor: `since` é o PISO (ts >= since); `before` é o cursor p/ TRÁS (ts < before), correto no
    // order by ts desc — a SPA passa before = ts do ÚLTIMO alarme carregado p/ pedir a próxima página.
    if (id && seg[3] === "alarms" && method === "GET") {
      if (!(await access.guardAccess(claims, { type: "site", id }))) {
        json(res, 403, { error: "sem acesso a este site" });
        return true;
      }
      const q = new URL(req.url, "http://x").searchParams;
      const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 500);
      const since = Number(q.get("since")) || 0;
      const beforeRaw = q.get("before");
      const before = beforeRaw !== null && beforeRaw !== "" && Number.isFinite(Number(beforeRaw)) ? Number(beforeRaw) : null;
      // where parametrizado (SQL-injection: valores só por $n). `before` só entra se veio válido.
      const conds = ["ts >= $1"];
      const params = [since];
      if (before !== null) {
        params.push(before);
        conds.push(`ts < $${params.length}`);
      }
      params.push(limit);
      const sql = `select id, tipo, ts, meta from alarm_event where ${conds.join(" and ")} order by ts desc limit $${params.length}`;
      const alarms = await db.withTenant(id, async (cl) => {
        const r = await cl.query(sql, params);
        return r.rows;
      });
      json(res, 200, { alarms });
      return true;
    }

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

  // ═══ /api/dvr — PONTE DVR (Fase 2: enrollment + registro) ══════════════════════
  // Aditivo, no mesmo molde de overview/site-link (contratos.md §6). Duas superfícies de auth:
  // enrollment = token de usuário + canAccess (integrador); registro = site_key do coletor.
  if (collection === "dvr") {
    const action = id; // seg[2]: 'coletores' | 'registrar' | 'frp-login' | 'sessao'

    // ── POST /api/dvr/frp-login — LOGIN-PLUGIN do frps (C-be-4) ──────────────────
    // Protocolo de server-plugin do frp: body { version, op, content }; a DECISÃO vai no CORPO
    // e o HTTP é SEMPRE 200 (reject:true no corpo barra a conexão; unchange:true aceita). Ops que
    // não gerenciamos (Ping, NewWorkConn, …) → aceita sem mudança.
    //   • Login    → valida site_key + coletorId (em content.metas) contra a tabela `coletor`
    //                (mesma verificação do enrollment/authColetor; revogado ⇒ reject).
    //   • NewProxy → menor privilégio (contratos §2): só proxy TCP, coletor válido, e a porta
    //                pedida = a porta ALOCADA à sessão ativa do coletor (o coletor só expõe o DVR dele).
    // Trava opcional de rede: se CP_FRP_PLUGIN_TOKEN estiver setado, exige x-frp-plugin-token
    // (o relay injeta; sem env, aberto — o de-risking prevê o plugin em loopback na VPS).
    if (action === "frp-login" && method === "POST") {
      const guard = process.env.CP_FRP_PLUGIN_TOKEN;
      if (guard && req.headers["x-frp-plugin-token"] !== guard) {
        json(res, 401, { error: "plugin token inválido" });
        return true;
      }
      const body = await readJson(req, ctx);
      const op = body && body.op ? String(body.op) : new URL(req.url, "http://x").searchParams.get("op") || "";
      const content = (body && body.content) || {};
      if (op !== "Login" && op !== "NewProxy") {
        json(res, 200, dvr.frpAccept());
        return true;
      }
      if (op === "NewProxy") {
        const perm = dvr.frpProxyPermitido(content); // só tcp (puro)
        if (!perm.ok) {
          json(res, 200, dvr.frpReject(perm.error));
          return true;
        }
      }
      const { coletorId, siteKey } = dvr.frpIdentidade(op, content);
      const v = await verifyColetor(coletorId, siteKey);
      if (v.error) {
        json(res, 200, dvr.frpReject(v.error)); // 404/403/401 → reject no corpo (HTTP 200)
        return true;
      }
      if (op === "NewProxy") {
        // amarra o túnel à sessão: sem sessão ativa não há porta; e a porta pedida tem de ser a alocada.
        const sess = await stores.sessoes.ativaPorColetor(v.coletorId);
        if (!sess) {
          json(res, 200, dvr.frpReject("sem sessão ativa para este coletor"));
          return true;
        }
        const pedido = Number(content.remote_port ?? content.remotePort);
        if (Number.isFinite(pedido) && pedido !== sess.remote_port) {
          json(res, 200, dvr.frpReject(`remote_port ${pedido} != porta alocada ${sess.remote_port}`));
          return true;
        }
      }
      json(res, 200, dvr.frpAccept());
      return true;
    }

    // ── /api/dvr/sessao — SESSÃO do acesso remoto (C-be-5) ───────────────────────
    if (action === "sessao") {
      const sub = seg[3]; // 'abrir' | <sessaoId>

      // POST /api/dvr/sessao/abrir — o COLETOR (app) abre (§4: pessoa no site libera acesso).
      // Autentica por site_key (authColetor). Aloca remotePort, persiste a sessão (= mapa de rota
      // que o nginx/B-3 vai ler) e devolve { sessaoId, relay, remotePort, hostPublico }. Idempotente:
      // sessão ativa existente é reusada (1 túnel por coletor). Audita a abertura.
      if (sub === "abrir" && method === "POST") {
        const a = await authColetor(req);
        if (a.error) {
          json(res, a.code, { error: a.error });
          return true;
        }
        const dvrRow = await stores.dvrs.getByColetor(a.coletorId);
        if (!dvrRow) {
          json(res, 409, { error: "coletor sem DVR registrado (registre o DVR antes de abrir sessão)" });
          return true;
        }
        let sessao = await stores.sessoes.ativaPorColetor(a.coletorId);
        let criada = false;
        if (!sessao) {
          const cli = await stores.clientes.get(a.clienteId);
          const host = dvr.hostPublico(cli ? cli.nome : a.clienteId, dvrRow.id);
          const r = await stores.sessoes.abrir({
            dvr_id: dvrRow.id,
            coletor_id: a.coletorId,
            cliente_id: a.clienteId,
            ator: a.coletorId, // quem abriu = o coletor (app)
            host_publico: host,
          });
          sessao = r.sessao;
          criada = !r.reusada;
          if (criada) {
            await stores.auditoriaDvr.registrar({
              ator: a.coletorId,
              dvr_id: dvrRow.id,
              coletor_id: a.coletorId,
              acao: "sessao.abrir",
              detalhe: { sessaoId: sessao.id, remotePort: sessao.remote_port, hostPublico: sessao.host_publico },
            });
          }
        }
        json(res, criada ? 201 : 200, {
          sessaoId: sessao.id,
          relay: dvr.relayConfig(),
          remotePort: sessao.remote_port,
          hostPublico: sessao.host_publico,
        });
        return true;
      }

      const sessaoId = sub;

      // GET /api/dvr/sessao/:id — ESTADO (o app faz poll; autentica como o coletor DONO da sessão).
      if (sessaoId && !seg[4] && method === "GET") {
        const a = await authColetor(req);
        if (a.error) {
          json(res, a.code, { error: a.error });
          return true;
        }
        const s = await stores.sessoes.get(sessaoId);
        if (!s || s.coletor_id !== a.coletorId) {
          json(res, 404, { error: "sessão não encontrada" });
          return true;
        }
        json(res, 200, {
          sessaoId: s.id,
          status: s.status,
          remotePort: s.remote_port,
          hostPublico: s.host_publico,
          aberta_em: s.aberta_em,
          ultima_atividade: s.ultima_atividade,
          encerrada_em: s.encerrada_em,
        });
        return true;
      }

      // POST /api/dvr/sessao/:id/encerrar — §4: pessoa no APP (coletor) OU técnico no BO (token).
      // Marca encerrada (libera o mapa de rota) e audita. Idempotente (2ª chamada não re-audita).
      if (sessaoId && seg[4] === "encerrar" && method === "POST") {
        const s = await stores.sessoes.get(sessaoId);
        if (!s) {
          json(res, 404, { error: "sessão não encontrada" });
          return true;
        }
        let ator;
        if (req.headers["x-coletor-id"] != null) {
          const a = await authColetor(req);
          if (a.error) {
            json(res, a.code, { error: a.error });
            return true;
          }
          if (s.coletor_id !== a.coletorId) {
            json(res, 403, { error: "sessão de outro coletor" });
            return true;
          }
          ator = a.coletorId;
        } else {
          const claims = requireScope(req, res);
          if (!claims) return true;
          if (!(await access.guardAccess(claims, { type: "cliente", id: s.cliente_id }))) {
            json(res, 403, { error: "sem acesso a este cliente" });
            return true;
          }
          ator = claims.id;
        }
        const encerrada = await stores.sessoes.encerrar(sessaoId);
        if (encerrada) {
          await stores.auditoriaDvr.registrar({
            ator,
            dvr_id: s.dvr_id,
            coletor_id: s.coletor_id,
            acao: "sessao.encerrar",
            detalhe: { sessaoId },
          });
        }
        json(res, 200, { ok: true, sessaoId, status: "encerrada" });
        return true;
      }
    }

    // ── POST /api/dvr/registrar — DEVICE (auth por site_key do coletor) ──
    // Grava/atualiza o DVR (marca/modelo/ip/porta) + consentimento; IDEMPOTENTE por coletor
    // (1 DVR/coletor); AUDITA. A credencial do DVR NUNCA trafega (contratos §3): o corpo só
    // traz o que o app validou localmente (marca/modelo/ip/porta) + o aceite do consentimento.
    if (action === "registrar" && method === "POST") {
      const a = await authColetor(req);
      if (a.error) {
        json(res, a.code, { error: a.error });
        return true;
      }
      const parsed = dvr.normalizeRegistro(await readJson(req, ctx));
      if (!parsed.ok) {
        json(res, 400, { error: parsed.error });
        return true;
      }
      const v = parsed.value;
      const { dvr: row, inserido } = await stores.dvrs.upsert({
        coletor_id: a.coletorId,
        cliente_id: a.clienteId, // derivado do coletor autenticado (não confia em corpo)
        marca: v.marca,
        modelo: v.modelo,
        ip: v.ip,
        porta: v.porta,
        consentimento: v.consentimento,
      });
      await stores.auditoriaDvr.registrar({
        ator: a.coletorId,
        dvr_id: row.id,
        coletor_id: a.coletorId,
        acao: inserido ? "dvr.registrar" : "dvr.atualizar",
        detalhe: { marca: v.marca, modelo: v.modelo, consentimentoVersao: v.consentimento.versaoTexto },
      });
      json(res, inserido ? 201 : 200, { ok: true, dvr: row });
      return true;
    }

    // ── /api/dvr/coletores — ENROLLMENT (integrador/técnico: token + canAccess no cliente) ──
    if (action === "coletores") {
      const claims = requireScope(req, res);
      if (!claims) return true;
      const coletorId = seg[3];

      // GET — lista os coletores no ESCOPO do chamador (mesmo filtro canAccess do CRUD).
      if (!coletorId && method === "GET") {
        const tree = await access.buildFullTree();
        const rows = (await stores.coletores.list()).filter((k) => auth.canAccess(claims, { type: "cliente", id: k.cliente_id }, tree));
        json(res, 200, rows);
        return true;
      }

      // POST — o ENROLLMENT: liga empresa(box3) ↔ cliente(visão) e EMITE a site_key crua (1x).
      if (!coletorId && method === "POST") {
        const parsed = dvr.validateEnrollment(await readJson(req, ctx));
        if (!parsed.ok) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        const v = parsed.value;
        if (!(await access.guardAccess(claims, { type: "cliente", id: v.cliente_id }))) {
          json(res, 403, { error: "sem acesso a este cliente" });
          return true;
        }
        if (!(await stores.clientes.get(v.cliente_id))) {
          json(res, 404, { error: "cliente inexistente" });
          return true;
        }
        // site_key: nasce aqui, guardamos SÓ o hash, devolvemos a chave CRUA UMA vez (como o site).
        const rawKey = sitekey.generateSiteKey();
        const k = await stores.coletores.create({
          cliente_id: v.cliente_id,
          empresa_id_box3: v.empresa_id_box3,
          nome: v.nome,
          coletorIdBox3: v.coletor_id_box3,
          siteKeyHash: sitekey.hashSiteKey(rawKey),
        });
        await stores.auditoriaDvr.registrar({
          ator: claims.id,
          dvr_id: null,
          coletor_id: k.id,
          acao: "enrollment",
          detalhe: { cliente_id: v.cliente_id, empresa_id_box3: v.empresa_id_box3 },
        });
        json(res, 201, { ...k, site_key: rawKey });
        return true;
      }
    }
  }

  return false; // nenhuma rota casou → o index responde 404
}

module.exports = { handle, authSite, authColetor };
