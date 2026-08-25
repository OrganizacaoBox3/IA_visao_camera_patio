// Ponte DVR — TÚNEL por WebSocket (socket.io), SEM frp/relay/root.
//
// Ideia (contratos §5, variante "sem infra"): o app roda DENTRO da LAN do cliente (mesma rede do DVR).
// Em vez de um túnel TCP reverso (frp), o app abre um socket.io com role=dvr-tunnel e vira um
// PROXY: o hub manda uma requisição HTTP pela ponte → o app faz `fetch` no DVR (http://ip:porta) →
// devolve a resposta. O hub serve isso ao técnico em /api/dvr/web/<dvrId>/… (mesma origem do portal,
// então o cookie cp_session/login já vale). Zero frps, zero porta aberta, zero nginx novo: reusa o
// /api e o socket.io que já passam pelo nginx hoje (as câmeras usam socket.io ao vivo).
//
// MVP: web de CONFIGURAÇÃO/login do DVR (HTML/CSS/JS/forms/imagens). Vídeo ao vivo (WS/ActiveX do
// firmware) fica para depois. Corpo trafega base64 (aguenta binário); teto = maxHttpBufferSize (8MB).

// Registro em memória: 1 túnel ativo por DVR. dvrId → { socket, coletorId, clienteId }.
const tuneis = new Map();
let seq = 0;

/** Registra (ou substitui) o túnel de um DVR. Se já havia um, o antigo é desconectado (fica 1 só). */
function registrar(dvrId, info) {
  const chave = String(dvrId);
  const antigo = tuneis.get(chave);
  if (antigo && antigo.socket !== info.socket) {
    try {
      antigo.socket.disconnect(true);
    } catch {
      /* já caiu */
    }
  }
  tuneis.set(chave, info);
}

/** Remove o túnel de um DVR (só se for ESTE socket — evita corrida com uma reconexão). */
function remover(dvrId, socket) {
  const chave = String(dvrId);
  const atual = tuneis.get(chave);
  if (atual && (!socket || atual.socket === socket)) tuneis.delete(chave);
}

/** Remove TODOS os túneis de um socket que caiu (o app pode servir mais de um DVR). */
function removerPorSocket(socket) {
  for (const [chave, info] of tuneis) if (info.socket === socket) tuneis.delete(chave);
}

/** Há túnel ativo para este DVR? */
function ativo(dvrId) {
  return tuneis.get(String(dvrId)) || null;
}

/**
 * Faz UMA requisição HTTP pela ponte: emite "proxy-req" com ACK (socket.io) e espera a resposta do app.
 * `req` = { method, path, headers, bodyB64 }. Resolve { status, headers, bodyB64 } ou rejeita (timeout/sem túnel).
 */
function requisitar(dvrId, req, timeoutMs = 30000) {
  const info = tuneis.get(String(dvrId));
  if (!info) return Promise.reject(new Error("sem túnel ativo para este DVR"));
  const id = `q${++seq}`;
  return new Promise((resolve, reject) => {
    info.socket
      .timeout(timeoutMs)
      .emit("proxy-req", { id, ...req }, (erroTimeout, resposta) => {
        if (erroTimeout) return reject(new Error("o DVR não respondeu pela ponte (timeout)"));
        if (!resposta || typeof resposta.status !== "number") {
          return reject(new Error("resposta inválida do app na ponte"));
        }
        resolve(resposta);
      });
  });
}

// ── Reescrita da web do DVR ────────────────────────────────────────────────────────────────────
// A web servida pelo DVR usa caminhos ABSOLUTOS (/doc/…) e às vezes o IP dele hardcoded. Como servimos
// sob o prefixo /api/dvr/web/<id>, reescrevemos os absolutos p/ passarem pelo prefixo. É best-effort
// (varia por firmware) — o MVP cobre os casos comuns; o que escapar a gente ajusta vendo o DVR real.

const TIPOS_TEXTO = /^(text\/|application\/(javascript|x-javascript|json|xml)|application\/xhtml)/i;

/** Reescreve um corpo de texto (HTML/CSS/JS): absolutos "/x" → "<prefixo>/x" e o IP do DVR → prefixo. */
function reescreverCorpo(texto, prefixo, dvrBase) {
  let out = texto;
  // 1) atributos com caminho absoluto: href/src/action/formaction/data-* = "/x" (aspas simples/duplas).
  out = out.replace(/\b(href|src|action|formaction|poster|data-src|data-url)=(["'])\/(?!\/)/gi, `$1=$2${prefixo}/`);
  // 2) CSS url(/x) nas três formas de aspa.
  out = out.replace(/url\((["']?)\/(?!\/)/gi, `url($1${prefixo}/`);
  // 3) o próprio endereço do DVR hardcoded (http://ip:porta ou //ip:porta) → prefixo.
  if (dvrBase) {
    const esc = dvrBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`https?:\\/\\/${esc}`, "gi"), prefixo);
    out = out.replace(new RegExp(`\\/\\/${esc}`, "gi"), prefixo);
  }
  return out;
}

/** Reescreve um header Location (redirect) absoluto p/ passar pelo prefixo. */
function reescreverLocation(valor, prefixo, dvrBase) {
  if (!valor) return valor;
  if (dvrBase) {
    const esc = dvrBase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    valor = valor.replace(new RegExp(`^https?:\\/\\/${esc}`, "i"), prefixo);
  }
  if (valor.startsWith("/") && !valor.startsWith(prefixo)) valor = prefixo + valor;
  return valor;
}

/** Reescreve Set-Cookie: tira Domain (era do IP do DVR) e prende o Path sob o prefixo. */
function reescreverSetCookie(valor, prefixo) {
  const cookies = Array.isArray(valor) ? valor : [valor];
  return cookies.map((c) => {
    let v = String(c).replace(/;\s*Domain=[^;]*/i, "");
    if (/;\s*Path=/i.test(v)) v = v.replace(/;\s*Path=([^;]*)/i, (_m, p) => `; Path=${prefixo}${p.startsWith("/") ? p : "/" + p}`);
    else v = v + `; Path=${prefixo}/`;
    return v;
  });
}

/**
 * Monta a resposta final ao técnico a partir da resposta do app (via ponte), aplicando a reescrita.
 * `resp` = { status, headers, bodyB64 }. Devolve { status, headers, buffer } pronto p/ escrever.
 */
function montarResposta(resp, prefixo, dvrBase) {
  const headers = {};
  const origem = resp.headers || {};
  for (const [k, v] of Object.entries(origem)) {
    const kl = k.toLowerCase();
    // Removidos: hop-by-hop + os que quebram sob proxy/reescrita.
    if (["transfer-encoding", "content-length", "connection", "content-encoding", "content-security-policy", "x-frame-options"].includes(kl)) continue;
    if (kl === "location") headers[k] = reescreverLocation(String(v), prefixo, dvrBase);
    else if (kl === "set-cookie") headers[k] = reescreverSetCookie(v, prefixo);
    else headers[k] = v;
  }
  let buffer = Buffer.from(resp.bodyB64 || "", "base64");
  const tipo = String(origem["content-type"] || origem["Content-Type"] || "");
  if (TIPOS_TEXTO.test(tipo)) {
    buffer = Buffer.from(reescreverCorpo(buffer.toString("utf8"), prefixo, dvrBase), "utf8");
  }
  return { status: resp.status, headers, buffer };
}

/**
 * Atende um socket.io com role=dvr-tunnel: autentica o COLETOR por site_key (deps.verificarColetor),
 * registra o túnel do DVR (dvrId + endereço do DVR na LAN) e o remove ao cair. O app do coletor é quem
 * RESPONDE aos "proxy-req" (fazendo fetch no DVR) — o hub só guarda o socket e relaya.
 * handshake.query: { role, coletorId, siteKey, dvrId, dvrIp, dvrPorta }.
 */
function conectar(socket, deps) {
  const q = (socket.handshake && socket.handshake.query) || {};
  const v = deps.verificarColetor(q.coletorId, q.siteKey);
  if (!v || v.code) {
    socket.emit("tunel-erro", { erro: (v && v.error) || "site_key inválida" });
    socket.disconnect(true);
    return;
  }
  const dvrId = String(q.dvrId || "");
  if (!dvrId) {
    socket.emit("tunel-erro", { erro: "dvrId ausente" });
    socket.disconnect(true);
    return;
  }
  const dvrBase = q.dvrIp
    ? `${q.dvrIp}${q.dvrPorta && String(q.dvrPorta) !== "80" ? ":" + q.dvrPorta : ""}`
    : null;
  registrar(dvrId, { socket, coletorId: v.coletorId, clienteId: v.clienteId, dvrBase });
  socket.emit("tunel-ok", { dvrId });
  socket.on("disconnect", () => removerPorSocket(socket));
}

module.exports = {
  registrar,
  remover,
  removerPorSocket,
  ativo,
  requisitar,
  conectar,
  // expostos p/ teste:
  reescreverCorpo,
  reescreverLocation,
  reescreverSetCookie,
  montarResposta,
  _tuneis: tuneis,
};
