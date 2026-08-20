// PONTE DVR — a lógica PURA do domínio (sem banco, sem rede), no molde de login.js/sitekey.js.
// Valida/normaliza os dois payloads da Fase 2:
//   • ENROLLMENT — o integrador liga empresa(box3) ↔ cliente(visão); o visão emite a site_key.
//   • REGISTRO   — o coletor grava marca/modelo/ip/porta do DVR + o consentimento.
//
// INVARIANTE (contratos §3): a credencial do DVR NUNCA trafega — o app só informa que validou.
// Por isso o objeto normalizado é ALLOW-LIST: só os campos abaixo entram; qualquer "senha"/
// "usuario" que venha no corpo é IGNORADO (não persistido). Testável 100% offline.

// Trunca strings (defesa barata contra corpo abusivo) e normaliza vazio → null.
function str(v, max = 200) {
  if (v == null) return null;
  const s = String(v).slice(0, max);
  return s.length ? s : null;
}

// ── ENROLLMENT — liga empresa(box3) ↔ cliente(visão). cliente_id + empresa_id_box3 obrigatórios.
// coletor_id_box3 é opcional (pode chegar só no registro/heartbeat, ou nunca).
function validateEnrollment(body) {
  const b = body || {};
  const cliente_id = str(b.cliente_id, 100);
  const empresa_id_box3 = str(b.empresa_id_box3, 100);
  if (!cliente_id) return { ok: false, error: "cliente_id é obrigatório" };
  if (!empresa_id_box3) return { ok: false, error: "empresa_id_box3 é obrigatório" };
  return {
    ok: true,
    value: {
      cliente_id,
      empresa_id_box3,
      nome: str(b.nome),
      coletor_id_box3: str(b.coletor_id_box3, 100),
    },
  };
}

// ── REGISTRO do DVR — só marca/modelo/ip/porta + consentimento. porta ∈ 1..65535 (ou null).
// consentimento.aceito=true é OBRIGATÓRIO (contratos §3) — sem aceite, não registra.
function normalizeRegistro(body) {
  const b = body || {};
  const d = b.dvr || {};
  const c = b.consentimento || {};
  if (c.aceito !== true) {
    return { ok: false, error: "consentimento obrigatório (consentimento.aceito=true)" };
  }
  let porta = null;
  if (d.porta != null && d.porta !== "") {
    porta = Number(d.porta);
    if (!Number.isInteger(porta) || porta < 1 || porta > 65535) {
      return { ok: false, error: "porta inválida (1..65535)" };
    }
  }
  return {
    ok: true,
    value: {
      // ALLOW-LIST: nada de credencial do DVR entra aqui (contratos §3).
      marca: str(d.marca),
      modelo: str(d.modelo),
      ip: str(d.ip),
      porta,
      consentimento: {
        aceito: true,
        quando: Number(c.quando) || Date.now(),
        versaoTexto: str(c.versaoTexto),
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════
// F3 backend — LOGIN-PLUGIN do frps (C-be-4) · lógica PURA do protocolo
// ════════════════════════════════════════════════════════════════════════════
// O frps (server manage plugin) faz POST { version, op, content } e ESPERA a decisão NO CORPO
// (sempre HTTP 200): { reject:false, unchange:true } aceita; { reject:true, reject_reason } barra.
// (frp docs: features/common/server-plugin). Aqui só a parte que NÃO toca banco; a validação da
// site_key (que consulta a tabela `coletor`) fica no routes.js, reusando o authColetor.

function frpAccept() {
  return { reject: false, unchange: true };
}
function frpReject(reason) {
  return { reject: true, reject_reason: String(reason || "recusado") };
}

// Identidade do coletor conforme a operação. O frpc.toml declara `metadatas.coletorId` +
// `metadatas.siteKey` (contratos §2) → o frp entrega isso em `metas`. No Login vem em
// `content.metas` (+ `content.user`); no NewProxy vem em `content.user.metas` (+ `user.user`).
function frpIdentidade(op, content) {
  const c = content || {};
  const fromMetas = (metas, user) => ({
    coletorId: str((metas || {}).coletorId, 100) || str(user, 100),
    siteKey: (metas || {}).siteKey != null ? String((metas || {}).siteKey) : null,
  });
  if (op === "NewProxy") {
    const u = c.user || {};
    return fromMetas(u.metas, u.user);
  }
  return fromMetas(c.metas, c.user); // Login (default)
}

// MENOR PRIVILÉGIO no NewProxy (contratos §2), parte PURA: o coletor só expõe UM proxy TCP (a
// porta web do DVR). Recusa qualquer outro tipo (http/https/stcp/xtcp/udp/…). O casamento com a
// PORTA alocada à sessão e o `maxPortsPerClient=1` são impostos no routes.js / no próprio frps.
function frpProxyPermitido(content) {
  const c = content || {};
  const tipo = String(c.proxy_type || c.proxyType || "").toLowerCase();
  if (tipo && tipo !== "tcp") {
    return { ok: false, error: `tipo de proxy não permitido: ${tipo} (só tcp)` };
  }
  return { ok: true };
}

// ════════════════════════════════════════════════════════════════════════════
// F3 backend — SESSÃO (C-be-5) · helpers PUROS (alocação de porta, host, timeout)
// ════════════════════════════════════════════════════════════════════════════

// Menor porta LIVRE na faixa [start,end] dado o conjunto em uso — a alocação do remotePort da
// sessão. Determinística (menor primeiro) p/ facilitar o teste; a corrida real é resolvida pela
// UNIQUE parcial em sessao(remote_port) where status='ativa' (stores.js). Faixa esgotada → null.
function proximaPortaLivre(usadas, start = 20000, end = 20099) {
  const set = new Set((usadas || []).map(Number));
  for (let p = start; p <= end; p++) if (!set.has(p)) return p;
  return null;
}

// slug seguro p/ subdomínio (sem acento, [a-z0-9-]). Vazio → "cliente".
function slugify(s) {
  const out = String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return out || "cliente";
}

// Sufixo de domínio dos hosts públicos (env; default de dev). Sem segredo — só o domínio.
function hostSuffix() {
  return process.env.CP_DVR_HOST_SUFFIX || "dvr.box3.software";
}

// Host público POR DVR: slug(cliente) + sufixo curto do dvrId → único por DVR (dois coletores do
// mesmo cliente não colidem). O nginx (B-3, próxima onda) roteia Host → remotePort → DVR por aqui.
function hostPublico(clienteNome, dvrId, sufixo) {
  const suf = sufixo || hostSuffix();
  const short = String(dvrId || "").replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase() || "000000";
  return `${slugify(clienteNome)}-${short}.${suf}`;
}

// Dados do relay que o app recebe no abrir (§4). serverAddr/porta/token vêm de env (invariante 6:
// o token NUNCA no repo; default vazio em dev/teste). O mesmo token compartilhado do frps.
function relayConfig() {
  return {
    serverAddr: process.env.CP_RELAY_ADDR || "relay.box3.software",
    serverPort: Number(process.env.CP_RELAY_PORT || 7000),
    token: process.env.CP_RELAY_TOKEN || "",
  };
}

// Regra do TIMEOUT de inatividade (contratos §4/§7): sessão ativa sem atividade há mais de idleMs.
// A `ultima_atividade` é renovada pelo /_dvr_auth a cada acesso do técnico (F4); no abrir, nasce =
// aberta_em. A varredura real é em SQL (stores.sessoes.varrerOciosas); o /_dvr_auth também aplica
// esta MESMA regra como gate imediato (camada 1 do de-risking/relay-proxy §5).
function sessaoOciosa(sessao, agora, idleMs) {
  if (!sessao || sessao.status !== "ativa") return false;
  const ref = Number(sessao.ultima_atividade || sessao.aberta_em || 0);
  return agora - ref > Number(idleMs);
}

// ════════════════════════════════════════════════════════════════════════════
// F4 backend — /_dvr_auth (C-be-6) · helper PURO do THROTTLE de auditoria de acesso
// ════════════════════════════════════════════════════════════════════════════
// Auditar o acesso do técnico é do contrato (§5). Mas o auth_request do nginx dispara a CADA
// request (inclui todo asset/poll da UI do DVR) — auditar literalmente cada um inundaria a
// auditoria_dvr. Throttle barato SEM coluna nova: usa a PRÓPRIA `ultima_atividade` (lida antes de
// renovar) — audita no máximo 1×/janela por sessão. throttleMs<=0 → audita sempre (fiel ao "cada
// acesso" do de-risking, ao custo de volume). Ver a divergência documentada no routes.js.
function deveAuditarAcesso(sessao, agora, throttleMs) {
  const janela = Number(throttleMs);
  if (!(janela > 0)) return true;
  const ref = Number((sessao && sessao.ultima_atividade) || (sessao && sessao.aberta_em) || 0);
  return agora - ref >= janela;
}

module.exports = {
  validateEnrollment,
  normalizeRegistro,
  str,
  // login-plugin do frps (C-be-4)
  frpAccept,
  frpReject,
  frpIdentidade,
  frpProxyPermitido,
  // sessão (C-be-5)
  proximaPortaLivre,
  slugify,
  hostSuffix,
  hostPublico,
  relayConfig,
  sessaoOciosa,
  // /_dvr_auth (C-be-6)
  deveAuditarAcesso,
};
