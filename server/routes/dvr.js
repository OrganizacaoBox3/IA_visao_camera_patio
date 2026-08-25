// Rotas do domínio PONTE DVR — feature aditiva do hub (contratos.md §2..§8). Molde do hub:
// handle(req,res,ctx) → boolean (true = tratou). DUAS superfícies de auth:
//   • DEVICE (o app/coletor): site_key via headers x-coletor-id / x-coletor-key (authColetor
//     timing-safe, na store) — registrar/sessão/frp-login/enrollment.trocar.
//   • SUPORTE (técnico): usuário superadmin do hub (ctx.requireSuper, Bearer) — no MODELO-TAG o
//     suporte vê tudo e filtra por tag (cliente_id/empresa_id_box3). Exceção: /_dvr_auth chega por
//     COOKIE (nginx auth_request num subdomínio ≠ origem do portal — contratos §5/§6b).
//
// A validação/normalização de payload é PURA (server/dvr-logic.js) e a persistência é da store
// (server/dvr.js) — aqui só transporte + RBAC. A credencial do DVR NUNCA trafega (contratos §3).
const dvr = require("../dvr");
const logic = require("../dvr-logic");
const users = require("../users");
const tunnel = require("../dvr-tunnel");
const { bearer } = require("../http-auth");

// authColetor: valida a site_key do coletor pelos headers (ingest-style). Sync (memória).
function authColetor(req) {
  return dvr.coletores.verify(req.headers["x-coletor-id"], req.headers["x-coletor-key"]);
}

// Token do técnico para o /_dvr_auth: cookie cp_session (o nginx repassa no subdomínio) ou Bearer.
function cookieToken(req, name) {
  const raw = req.headers["cookie"];
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return "";
}

async function handle(req, res, ctx) {
  const { json, readBody, requireSuper } = ctx;
  const path0 = (req.url || "").split("?")[0];
  const method = req.method;

  // ── GET /_dvr_auth — SUBREQUISIÇÃO de auth do nginx (contratos §5) ────────────────────────────
  // NÃO é /api/ de propósito: o nginx faz auth_request AQUI num subdomínio *.dvr.box3.software
  // (≠ origem do portal), então o técnico chega pelo COOKIE cp_session (mesmo verifyToken do Bearer;
  // fallback Bearer p/ teste/curl). Valida técnico (superadmin — modelo-tag) → acha o DVR pelo Host
  // → exige sessão ATIVA → aplica timeout imediato → RENOVA a atividade → audita (com throttle) →
  // 200 + header X-Dvr-Upstream = 127.0.0.1:<remotePort> (o nginx faz proxy_pass dinâmico por request).
  if (path0 === "/_dvr_auth") {
    if (method !== "GET") return false;
    const u = users.verifyToken(cookieToken(req, "cp_session") || bearer(req));
    if (!u) {
      json(res, 401, { error: "sessão do técnico ausente/inválida (faça login no portal)" });
      return true;
    }
    if (u.papel !== "superadmin") {
      json(res, 403, { error: "acesso restrito ao suporte" });
      return true;
    }
    const host = String(req.headers["x-original-host"] || req.headers["host"] || "");
    const sess = dvr.sessoes.ativaPorHost(host);
    if (!sess) {
      json(res, 401, { error: "sem sessão ativa para este host (túnel caiu ou foi encerrado)" });
      return true;
    }
    const agora = Date.now();
    const idleMs = Number(process.env.CP_DVR_IDLE_MS || 20 * 60 * 1000);
    // Gate de timeout imediato (camada 1): sessão ociosa é encerrada aqui mesmo (não espera a varredura).
    if (logic.sessaoOciosa(sess, agora, idleMs)) {
      await dvr.sessoes.encerrar(sess.id, { encerradaEm: agora });
      await dvr.auditoria.registrar({
        ator: u.usuario || u.id,
        dvr_id: sess.dvr_id,
        coletor_id: sess.coletor_id,
        acao: "sessao.timeout",
        detalhe: { sessaoId: sess.id, via: "_dvr_auth" },
      });
      json(res, 401, { error: "sessão expirada por inatividade" });
      return true;
    }
    // Auditar ANTES de renovar (o throttle lê ultima_atividade pré-renovação — dvr-logic.deveAuditarAcesso).
    const throttleMs = Number(process.env.CP_DVR_AUDIT_THROTTLE_MS ?? 60000);
    if (logic.deveAuditarAcesso(sess, agora, throttleMs)) {
      await dvr.auditoria.registrar({
        ator: u.usuario || u.id,
        dvr_id: sess.dvr_id,
        coletor_id: sess.coletor_id,
        acao: "acesso.tecnico",
        detalhe: { sessaoId: sess.id, host, uri: req.headers["x-original-uri"] || null },
      });
    }
    await dvr.sessoes.tocarAtividade(sess.id, agora);
    res.setHeader("X-Dvr-Upstream", `127.0.0.1:${sess.remote_port}`);
    json(res, 200, { ok: true, sessaoId: sess.id, remotePort: sess.remote_port, host });
    return true;
  }

  if (!path0.startsWith("/api/dvr")) return false;
  const seg = path0.split("/").filter(Boolean); // ["api","dvr", action, sub, sub2]
  const action = seg[2];

  // ── /api/dvr/web/<dvrId>/… — ACESSO À WEB DO DVR pelo TÚNEL WS (contratos §5, variante sem frp) ──
  // O técnico (superadmin) abre a web do DVR aqui, na MESMA origem do portal (o navegador manda o
  // COOKIE cp_session). O hub relaya a requisição pelo socket.io do app (que faz fetch no DVR na LAN)
  // e reescreve os caminhos absolutos p/ passarem pelo prefixo. Qualquer método/caminho.
  if (action === "web") {
    const u = users.verifyToken(cookieToken(req, "cp_session") || bearer(req));
    if (!u || u.papel !== "superadmin") {
      json(res, 401, { error: "faça login no portal (suporte) para acessar a web do DVR" });
      return true;
    }
    const dvrId = seg[3];
    if (!dvrId) {
      json(res, 404, { error: "DVR não informado no caminho" });
      return true;
    }
    const info = tunnel.ativo(dvrId);
    if (!info) {
      json(res, 502, { error: "sem túnel ativo — peça para liberarem o acesso no aparelho, no local" });
      return true;
    }
    const prefixo = `/api/dvr/web/${dvrId}`;
    const caminho = (req.url || "").slice(prefixo.length) || "/"; // subpath + querystring, no DVR
    // Corpo da REQUISIÇÃO (forms/POST) como STRING (config do DVR é urlencoded — texto). O app repassa
    // direto ao fetch. A RESPOSTA do DVR volta BINÁRIA (ArrayBuffer via socket.io) — ver montarResposta.
    let body = "";
    if (method !== "GET" && method !== "HEAD") body = (await readBody(req)) || "";
    // Headers repassados ao DVR: fora host/hop-by-hop e o cookie/credenciais DO PORTAL (não vazam pro DVR).
    const headers = {};
    for (const [k, val] of Object.entries(req.headers)) {
      const kl = k.toLowerCase();
      if (["host", "connection", "cookie", "content-length", "x-coletor-id", "x-coletor-key", "authorization"].includes(kl)) continue;
      headers[k] = val;
    }
    try {
      const resp = await tunnel.requisitar(dvrId, { method, path: caminho, headers, body });
      const { status, headers: h, buffer } = tunnel.montarResposta(resp, prefixo, info.dvrBase);
      res.writeHead(status, h);
      res.end(buffer);
    } catch (e) {
      json(res, 502, { error: `falha na ponte com o DVR: ${e.message}` });
    }
    return true; // (o acesso do técnico é auditado na ABERTURA da sessão, não por sub-requisição)
  }

  // ── POST /api/dvr/enrollment/trocar — DEVICE, SEM auth prévia (o token É a credencial) ─────────
  // Fluxo QR (contratos §8): troca o enrollmentToken (uso único) por uma site_key durável. A chave
  // crua sai UMA vez aqui (o hub guarda só o hash). Inválido ⇒ 401; usado/expirado ⇒ 410.
  if (action === "enrollment" && seg[3] === "trocar" && method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const r = await dvr.coletores.trocarEnrollment(body.enrollmentToken);
    if (r.error) {
      json(res, r.status || 400, { error: r.error });
      return true;
    }
    json(res, 200, { coletorId: r.coletorId, siteKey: r.siteKey });
    return true;
  }

  // ── POST /api/dvr/frp-login — LOGIN-PLUGIN do frps (contratos §2) ──────────────────────────────
  // Protocolo server-plugin do frp: body { version, op, content }; a DECISÃO vai no CORPO e o HTTP é
  // SEMPRE 200 (reject:true barra; unchange:true aceita). Ops não gerenciadas (Ping/NewWorkConn…) →
  // aceita. Login → valida site_key+coletorId (content.metas). NewProxy → menor privilégio: só tcp,
  // coletor válido, sessão ativa e remote_port == porta alocada. Trava de rede opcional CP_FRP_PLUGIN_TOKEN.
  if (action === "frp-login" && method === "POST") {
    const guard = process.env.CP_FRP_PLUGIN_TOKEN;
    if (guard && req.headers["x-frp-plugin-token"] !== guard) {
      json(res, 401, { error: "plugin token inválido" });
      return true;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const op = body && body.op ? String(body.op) : "";
    const content = (body && body.content) || {};
    if (op !== "Login" && op !== "NewProxy") {
      json(res, 200, logic.frpAccept());
      return true;
    }
    if (op === "NewProxy") {
      const perm = logic.frpProxyPermitido(content); // só tcp (puro)
      if (!perm.ok) {
        json(res, 200, logic.frpReject(perm.error));
        return true;
      }
    }
    const { coletorId, siteKey } = logic.frpIdentidade(op, content);
    const v = dvr.coletores.verify(coletorId, siteKey);
    if (v.error) {
      json(res, 200, logic.frpReject(v.error)); // 404/403/401 → reject no corpo (HTTP 200)
      return true;
    }
    if (op === "NewProxy") {
      const sess = dvr.sessoes.ativaPorColetor(v.coletorId);
      if (!sess) {
        json(res, 200, logic.frpReject("sem sessão ativa para este coletor"));
        return true;
      }
      const pedido = Number(content.remote_port ?? content.remotePort);
      if (Number.isFinite(pedido) && pedido !== sess.remote_port) {
        json(res, 200, logic.frpReject(`remote_port ${pedido} != porta alocada ${sess.remote_port}`));
        return true;
      }
    }
    json(res, 200, logic.frpAccept());
    return true;
  }

  // ── POST /api/dvr/registrar — DEVICE (auth por site_key) ───────────────────────────────────────
  // Upsert idempotente por coletor (1 DVR/coletor) + consentimento + auditoria. cliente_id é DERIVADO
  // do coletor autenticado (não confia no corpo). A credencial do DVR NUNCA trafega (contratos §3).
  if (action === "registrar" && method === "POST") {
    const a = authColetor(req);
    if (a.error) {
      json(res, a.code, { error: a.error });
      return true;
    }
    const parsed = logic.normalizeRegistro(JSON.parse((await readBody(req)) || "{}"));
    if (!parsed.ok) {
      json(res, 400, { error: parsed.error });
      return true;
    }
    const v = parsed.value;
    const r = await dvr.dvrs.upsert({
      coletor_id: a.coletorId,
      cliente_id: a.clienteId,
      marca: v.marca,
      modelo: v.modelo,
      ip: v.ip,
      porta: v.porta,
      consentimento: v.consentimento,
    });
    if (r.error) {
      json(res, r.status || 400, { error: r.error });
      return true;
    }
    await dvr.auditoria.registrar({
      ator: a.coletorId,
      dvr_id: r.dvr.id,
      coletor_id: a.coletorId,
      acao: r.inserido ? "dvr.registrar" : "dvr.atualizar",
      detalhe: { marca: v.marca, modelo: v.modelo, consentimentoVersao: v.consentimento.versaoTexto },
    });
    json(res, r.inserido ? 201 : 200, { ok: true, dvr: r.dvr });
    return true;
  }

  // ── /api/dvr/sessao — SESSÃO do acesso remoto (contratos §4) ───────────────────────────────────
  if (action === "sessao") {
    const sub = seg[3]; // "abrir" | <sessaoId>

    // POST /api/dvr/sessao/abrir — abre (idempotente por coletor). DEVICE (site_key) OU TÉCNICO
    // (superadmin, body { coletorId }). Aloca remotePort, persiste a sessão (= mapa de rota) e
    // devolve { sessaoId, relay, remotePort, hostPublico }. Audita a abertura.
    if (sub === "abrir" && method === "POST") {
      let coletorId;
      let clienteId;
      let ator;
      if (req.headers["x-coletor-id"] != null) {
        const a = authColetor(req);
        if (a.error) {
          json(res, a.code, { error: a.error });
          return true;
        }
        coletorId = a.coletorId;
        clienteId = a.clienteId;
        ator = a.coletorId;
      } else {
        const u = requireSuper(req, res);
        if (!u) return true;
        const body = JSON.parse((await readBody(req)) || "{}");
        coletorId = body.coletorId ? String(body.coletorId) : null;
        if (!coletorId) {
          json(res, 400, { error: "coletorId é obrigatório (abertura pelo técnico)" });
          return true;
        }
        const col = dvr.coletores.get(coletorId);
        if (!col) {
          json(res, 404, { error: "coletor inexistente" });
          return true;
        }
        clienteId = col.cliente_id;
        ator = u.usuario || u.id;
      }
      const dvrRow = dvr.dvrs.getByColetor(coletorId);
      if (!dvrRow) {
        json(res, 409, { error: "coletor sem DVR registrado (registre o DVR antes de abrir sessão)" });
        return true;
      }
      let sessao = dvr.sessoes.ativaPorColetor(coletorId);
      let criada = false;
      if (!sessao) {
        const host = logic.hostPublico(clienteId, dvrRow.id);
        const r = await dvr.sessoes.abrir({
          dvr_id: dvrRow.id,
          coletor_id: coletorId,
          cliente_id: clienteId,
          ator,
          host_publico: host,
        });
        if (r.error) {
          json(res, r.status || 400, { error: r.error });
          return true;
        }
        sessao = r.sessao;
        criada = !r.reusada;
        if (criada) {
          await dvr.auditoria.registrar({
            ator,
            dvr_id: dvrRow.id,
            coletor_id: coletorId,
            acao: "sessao.abrir",
            detalhe: { sessaoId: sessao.id, remotePort: sessao.remote_port, hostPublico: sessao.host_publico },
          });
        }
      }
      json(res, criada ? 201 : 200, {
        sessaoId: sessao.id,
        relay: logic.relayConfig(),
        remotePort: sessao.remote_port,
        hostPublico: sessao.host_publico,
      });
      return true;
    }

    const sessaoId = sub;

    // GET /api/dvr/sessao/:id — ESTADO (o app faz poll; autentica como o coletor DONO da sessão).
    // O campo é `status` (contratos §4 — NÃO `estado`). 404 se sumiu/não-dono (fail-safe do app).
    if (sessaoId && !seg[4] && method === "GET") {
      const a = authColetor(req);
      if (a.error) {
        json(res, a.code, { error: a.error });
        return true;
      }
      const s = dvr.sessoes.get(sessaoId);
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

    // POST /api/dvr/sessao/:id/encerrar — DEVICE (coletor dono) OU TÉCNICO (superadmin). Idempotente
    // (2ª chamada não re-audita). Marca encerrada → libera o mapa de rota.
    if (sessaoId && seg[4] === "encerrar" && method === "POST") {
      const s = dvr.sessoes.get(sessaoId);
      if (!s) {
        json(res, 404, { error: "sessão não encontrada" });
        return true;
      }
      let ator;
      if (req.headers["x-coletor-id"] != null) {
        const a = authColetor(req);
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
        const u = requireSuper(req, res);
        if (!u) return true;
        ator = u.usuario || u.id;
      }
      const r = await dvr.sessoes.encerrar(sessaoId);
      if (r.error) {
        json(res, r.status || 500, { error: r.error });
        return true;
      }
      if (r.encerrada) {
        await dvr.auditoria.registrar({
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
    return false;
  }

  // ── /api/dvr/coletores — ENROLLMENT (SUPORTE: superadmin) ──────────────────────────────────────
  if (action === "coletores") {
    // GET — lista todos os coletores (modelo-tag: superadmin vê tudo; filtro opcional ?cliente=).
    if (!seg[3] && method === "GET") {
      const u = requireSuper(req, res);
      if (!u) return true;
      const cliente = new URL(req.url, "http://x").searchParams.get("cliente");
      let rows = dvr.coletores.list();
      if (cliente) rows = rows.filter((c) => c.cliente_id === cliente);
      json(res, 200, rows);
      return true;
    }
    // POST — cria o coletor e EMITE o enrollmentToken (uso único; vai no QR). Audita.
    if (!seg[3] && method === "POST") {
      const u = requireSuper(req, res);
      if (!u) return true;
      const body = JSON.parse((await readBody(req)) || "{}");
      const r = await dvr.coletores.criar(body);
      if (r.error) {
        json(res, r.status || 400, { error: r.error });
        return true;
      }
      await dvr.auditoria.registrar({
        ator: u.usuario || u.id,
        dvr_id: null,
        coletor_id: r.coletor.id,
        acao: "enrollment",
        detalhe: { cliente_id: r.coletor.cliente_id, empresa_id_box3: r.coletor.empresa_id_box3 },
      });
      json(res, 201, { ...r.coletor, enrollmentToken: r.enrollmentToken, expira: r.expira });
      return true;
    }
    // POST /api/dvr/coletores/:id/revogar — revoga o coletor (mitigação de drift).
    if (seg[3] && seg[4] === "revogar" && method === "POST") {
      const u = requireSuper(req, res);
      if (!u) return true;
      const r = await dvr.coletores.revogar(seg[3]);
      if (r.error) {
        json(res, r.status || 400, { error: r.error });
        return true;
      }
      await dvr.auditoria.registrar({
        ator: u.usuario || u.id,
        dvr_id: null,
        coletor_id: seg[3],
        acao: "coletor.revogar",
        detalhe: {},
      });
      json(res, 200, r.coletor);
      return true;
    }
    return false;
  }

  // ── GET /api/dvr/dvrs — LISTA de DVRs + status da sessão (SUPORTE) ──────────────────────────────
  // Modelo-tag: superadmin vê tudo (filtro opcional ?cliente=). Junta DVR→coletor (nome/empresa) e
  // ANEXA a sessão ATIVA (se houver). NENHUMA credencial (site_key) trafega aqui.
  if (action === "dvrs" && !seg[3] && method === "GET") {
    const u = requireSuper(req, res);
    if (!u) return true;
    const cliente = new URL(req.url, "http://x").searchParams.get("cliente");
    const ativas = dvr.sessoes.listAtivas();
    const sessaoPorColetor = new Map();
    for (const s of ativas) if (!sessaoPorColetor.has(s.coletor_id)) sessaoPorColetor.set(s.coletor_id, s);
    let linhas = dvr.dvrs.listComContexto();
    if (cliente) linhas = linhas.filter((d) => d.cliente_id === cliente);
    const rows = linhas.map((d) => {
      const s = sessaoPorColetor.get(d.coletor_id) || null;
      return {
        id: d.id,
        coletor_id: d.coletor_id,
        coletor_nome: d.coletor_nome,
        empresa_id_box3: d.empresa_id_box3,
        coletor_revogado: d.coletor_revogado,
        cliente_id: d.cliente_id,
        marca: d.marca,
        modelo: d.modelo,
        ip: d.ip,
        porta: d.porta,
        criado_em: d.criado_em,
        atualizado_em: d.atualizado_em,
        sessao: s
          ? {
              sessaoId: s.id,
              status: s.status,
              remotePort: s.remote_port,
              hostPublico: s.host_publico,
              aberta_em: s.aberta_em,
              ultima_atividade: s.ultima_atividade,
            }
          : null,
      };
    });
    json(res, 200, rows);
    return true;
  }

  // ── GET /api/dvr/auditoria — HISTÓRICO (SUPORTE) ───────────────────────────────────────────────
  // Modelo-tag: superadmin vê tudo. Filtros opcionais ?coletor=, ?cliente=, ?limit=.
  if (action === "auditoria" && !seg[3] && method === "GET") {
    const u = requireSuper(req, res);
    if (!u) return true;
    const q = new URL(req.url, "http://x").searchParams;
    const rows = dvr.auditoria.list({
      limit: q.get("limit") ? Number(q.get("limit")) : 200,
      coletorId: q.get("coletor") || null,
      clienteId: q.get("cliente") || null,
    });
    json(res, 200, rows);
    return true;
  }

  return false; // nenhuma rota casou → dispatch segue (index responde 404)
}

module.exports = { handle };
