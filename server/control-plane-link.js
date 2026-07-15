// control-plane-link.js — a ponta HUB do CANAL DE SINALIZAÇÃO REVERSO (Fase 3, tijolo 1).
//
// O site está atrás de NAT: o HUB é quem DISCA. Este módulo abre um WebSocket persistente PARA o
// control-plane (${CP_URL}/api/site-link) e mantém o canal vivo — com o canal aberto, o plane passa
// a ALCANÇAR o hub por request/response, sem precisar de inbound no site. É a EVOLUÇÃO do forwarder
// (control-plane-forwarder.js: heartbeat + POST out); aqui a discagem vira um canal duradouro.
//
// ESCOPO deste tijolo: SÓ o canal + um handler de ECHO/PING que prova o caminho. O relay de vídeo
// (go2rtc) e o coturn são os PRÓXIMOS tijolos — NÃO estão aqui.
//
// Disciplina da casa (idêntica ao forwarder):
//  - INERTE sem CP_URL/SITE_ID/SITE_KEY (só 1 log no boot dizendo desligado).
//  - FAIL-SOFT: o plane cair/estar fora NÃO derruba nem trava o hub — só reconecta com backoff.
//  - Auth por header x-site-id/x-site-key (o `ws` do Node manda header; o plane compara com o hash).
//
// Contrato de frames (espelha control-plane/site-link.js):
//   plane → hub : {t:"req", id, op, ...}   →   hub → plane : {t:"res", id, ...payload}
const WebSocket = require("ws");

const CP_URL = (process.env.CP_URL || "").trim().replace(/\/+$/, "");
const SITE_ID = (process.env.SITE_ID || "").trim();
const SITE_KEY = (process.env.SITE_KEY || "").trim();
// Backoff exponencial (molde do go2rtc.js:58-59,218): base dobra a cada tentativa até um teto.
const BASE_DELAY = Math.max(500, Number(process.env.CP_LINK_BASE_MS) || 2_000);
const MAX_DELAY = Math.max(BASE_DELAY, Number(process.env.CP_LINK_MAX_MS) || 30_000);
const PING_MS = Math.max(10_000, Number(process.env.CP_LINK_PING_MS) || 30_000);

/** Ligado só quando os três envs existem. Ausente qualquer um → INERTE. */
function enabled() {
  return !!(CP_URL && SITE_ID && SITE_KEY);
}

// http(s)://… → ws(s)://… (https→wss, http→ws). O path do canal é fixo.
function linkUrl() {
  return CP_URL.replace(/^http/i, "ws") + "/api/site-link";
}

// Handler das REQ do plane. Para ESTE tijolo: um ECHO/PING que prova o canal ponta-a-ponta.
// Puro (sem I/O) → testável isolado. Retorna o payload que vira {t:"res", id, ...payload}.
function handleReq(frame) {
  if (frame && frame.op === "ping") return { ok: true, ts: Date.now() };
  return { ok: false, error: `op desconhecida: ${frame && frame.op}` };
}

let ws = null;
let stopped = false;
let attempt = 0;
let reconnectTimer = null;
let pingTimer = null;
let alive = false;

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function startPing() {
  stopPing();
  alive = true;
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      // não respondeu o pong do tick anterior → canal morto, derruba p/ reconectar.
      try {
        ws.terminate();
      } catch {
        /* o close reconecta */
      }
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      /* best-effort */
    }
  }, PING_MS);
  if (pingTimer.unref) pingTimer.unref();
}

function scheduleReconnect() {
  ws = null;
  stopPing();
  if (stopped || !enabled()) return;
  attempt++;
  const delay = Math.min(BASE_DELAY * 2 ** (attempt - 1), MAX_DELAY);
  console.warn(`[control-plane-link] canal caiu — reconectando em ${delay}ms (tentativa ${attempt})`);
  reconnectTimer = setTimeout(connect, delay);
  if (reconnectTimer.unref) reconnectTimer.unref();
}

function onMessage(data) {
  let frame;
  try {
    frame = JSON.parse(data.toString());
  } catch {
    return; // não-JSON → ignora
  }
  if (frame && frame.t === "req" && frame.id != null) {
    const payload = handleReq(frame);
    try {
      ws.send(JSON.stringify({ t: "res", id: frame.id, ...payload }));
    } catch {
      /* fail-soft: se o send falhar, o close/reconnect cuida */
    }
  }
}

function connect() {
  if (stopped || !enabled()) return;
  reconnectTimer = null;
  let sock;
  try {
    sock = new WebSocket(linkUrl(), {
      headers: { "x-site-id": SITE_ID, "x-site-key": SITE_KEY },
    });
  } catch (e) {
    console.error("[control-plane-link] falha ao abrir o canal:", e.message);
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.on("open", () => {
    if (ws !== sock) return; // já substituído
    attempt = 0; // reset do backoff ao conectar
    console.log(`[control-plane-link] canal ABERTO — site ${SITE_ID} → ${CP_URL}`);
    startPing();
  });
  sock.on("pong", () => {
    alive = true;
  });
  sock.on("message", onMessage);
  sock.on("error", (e) => {
    // 'error' vem seguido de 'close' — logamos e deixamos o close agendar o reconnect.
    console.error("[control-plane-link] erro no canal:", e.message);
  });
  sock.on("close", () => {
    if (ws !== sock) return; // um reconnect já assumiu
    scheduleReconnect();
  });
}

/** Liga o canal (disca ao plane). Inerte-sem-env. Retorna um handle {stop} (ou null). */
function startSiteLink() {
  if (!enabled()) {
    console.log("[control-plane-link] desligado (defina CP_URL, SITE_ID e SITE_KEY para ligar)");
    return null;
  }
  stopped = false;
  attempt = 0;
  console.log(`[control-plane-link] discando canal para ${CP_URL}/api/site-link`);
  connect();
  return { stop: stopSiteLink };
}

function stopSiteLink() {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopPing();
  if (ws) {
    try {
      ws.close();
    } catch {
      /* best-effort */
    }
    ws = null;
  }
}

module.exports = { enabled, handleReq, startSiteLink, stopSiteLink, linkUrl };
