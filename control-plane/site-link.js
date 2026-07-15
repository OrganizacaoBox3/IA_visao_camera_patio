// site-link.js — o CANAL DE SINALIZAÇÃO REVERSO (control-plane Fase 3, tijolo 1).
//
// O site do cliente está atrás de NAT (sem inbound): quem DISCA é o HUB. Aqui, no plane, mora
// a ponta que RECEBE essa discagem — um WebSocket server (transporte `ws`, o mesmo que o
// socket.io do hub já traz) ligado ao http do control-plane no path /api/site-link. Com o canal
// aberto, o plane passa a ALCANÇAR o hub (request/response) por ele, sem precisar de inbound no site.
//
// ESCOPO deste tijolo: SÓ o canal + registro + o primitivo request/response. O relay de vídeo
// (proxy /sites/<id>/go2rtc/*) e o coturn/TURN são os PRÓXIMOS tijolos (spec §2 Passo 2) — NÃO estão aqui.
//
// Auth do upgrade: REUSA a credencial de site (x-site-id/x-site-key) — a MESMA de ingest/heartbeat
// (routes.authSite). O cliente WS do Node manda por HEADER; aceitamos também por QUERY (?site_id/
// ?site_key) p/ um cliente-navegador que não sabe setar header. Inválido → 401 cru + destroy (sem upgrade).
//
// Contrato de frames (JSON por mensagem):
//   plane → hub : {t:"req", id, ...msg}     (msg ex.: {op:"ping"})
//   hub → plane : {t:"res", id, ...payload} (payload ex.: {ok:true, ts})
// O `id` casa a resposta ao request pendente. Sem ordem garantida — o mux é por id, não por FIFO.
const WebSocket = require("ws");
const routes = require("./routes");

const PING_MS = 30_000; // keepalive: pinga cada canal a cada 30s; sem pong até o próximo tick → derruba.
const DEFAULT_TIMEOUT_MS = 5_000;

// authenticate(req) default: REUSA routes.authSite (x-site-id/x-site-key → hash guardado, timing-safe).
// Aceita a credencial por header OU por query. Devolve {siteId} se válida, senão null.
async function defaultAuthenticate(req) {
  const url = new URL(req.url || "/", "http://x");
  const headers = { ...req.headers };
  if (!headers["x-site-id"]) headers["x-site-id"] = url.searchParams.get("site_id") || undefined;
  if (!headers["x-site-key"]) headers["x-site-key"] = url.searchParams.get("site_key") || undefined;
  const a = await routes.authSite({ headers });
  if (a.error) return null;
  return { siteId: String(a.siteId) };
}

// Fábrica: cada instância tem seu Map de canais e seu próprio WSS (noServer — o upgrade vem do
// http do index). Injetável (authenticate) p/ teste isolado sem PG.
function createSiteLink({ authenticate = defaultAuthenticate, pingMs = PING_MS } = {}) {
  const wss = new WebSocket.Server({ noServer: true });
  const siteLinks = new Map(); // siteId -> { ws, pending:Map<id,{resolve,reject,timer}>, alive }
  let seq = 0;

  function register(siteId, ws) {
    // Reconexão-safe: um socket NOVO do mesmo site SUBSTITUI o antigo (o antigo é derrubado e
    // seus pendentes rejeitados no seu próprio close). Idempotente por siteId.
    const prev = siteLinks.get(siteId);
    if (prev && prev.ws !== ws) {
      try {
        prev.ws.terminate();
      } catch {
        /* best-effort */
      }
    }
    const link = { ws, pending: new Map(), alive: true };
    siteLinks.set(siteId, link);

    ws.on("message", (data) => onMessage(link, data));
    ws.on("pong", () => {
      link.alive = true;
    });
    ws.on("error", () => {
      try {
        ws.terminate();
      } catch {
        /* o close cuida da limpeza */
      }
    });
    ws.on("close", () => {
      // só desregistra se ESTE link ainda é o vigente (um replace já pôs outro no lugar).
      if (siteLinks.get(siteId) === link) siteLinks.delete(siteId);
      for (const p of link.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("site-link fechado"));
      }
      link.pending.clear();
    });
  }

  function onMessage(link, data) {
    let frame;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return; // frame não-JSON → ignora (não derruba o canal)
    }
    if (!frame || typeof frame !== "object") return;
    if (frame.t === "res" && frame.id != null) {
      const p = link.pending.get(frame.id);
      if (!p) return; // resposta órfã (timeout já disparou, ou id desconhecido) — ignora
      clearTimeout(p.timer);
      link.pending.delete(frame.id);
      const { t: _t, id: _id, ...payload } = frame;
      p.resolve(payload);
    }
    // outros t (ex.: eventos hub→plane) ficam p/ tijolos futuros; aqui só casamos res.
  }

  // upgrade HTTP → WS. Autentica ANTES do handshake; inválido = 401 cru + destroy (nunca vira canal).
  async function handleUpgrade(req, socket, head) {
    let auth = null;
    try {
      auth = await authenticate(req);
    } catch {
      auth = null;
    }
    if (!auth || !auth.siteId) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => register(auth.siteId, ws));
  }

  function isLinked(siteId) {
    const link = siteLinks.get(String(siteId));
    return !!(link && link.ws.readyState === WebSocket.OPEN);
  }

  // request(siteId, msg, timeoutMs): envia {t:"req", id, ...msg} e casa a {t:"res", id, ...}.
  // site não-conectado → rejeita na hora; sem resposta em timeoutMs → rejeita timeout.
  function request(siteId, msg = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const link = siteLinks.get(String(siteId));
      if (!link || link.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("site não conectado ao canal"));
        return;
      }
      const id = `q${++seq}`;
      const timer = setTimeout(() => {
        link.pending.delete(id);
        reject(new Error("timeout aguardando resposta do site"));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      link.pending.set(id, { resolve, reject, timer });
      try {
        link.ws.send(JSON.stringify({ t: "req", id, ...msg }));
      } catch (e) {
        clearTimeout(timer);
        link.pending.delete(id);
        reject(e);
      }
    });
  }

  // keepalive: derruba canal morto (não respondeu o ping anterior); pinga os vivos.
  const pingTimer = setInterval(() => {
    for (const link of siteLinks.values()) {
      if (!link.alive) {
        try {
          link.ws.terminate();
        } catch {
          /* best-effort */
        }
        continue;
      }
      link.alive = false;
      try {
        link.ws.ping();
      } catch {
        /* best-effort */
      }
    }
  }, pingMs);
  if (pingTimer.unref) pingTimer.unref();

  function count() {
    return siteLinks.size;
  }

  function close() {
    clearInterval(pingTimer);
    for (const link of siteLinks.values()) {
      try {
        link.ws.terminate();
      } catch {
        /* best-effort */
      }
    }
    siteLinks.clear();
    wss.close();
  }

  return { handleUpgrade, isLinked, request, count, close };
}

// Singleton de produção (auth real via routes.authSite). O index liga o upgrade a este; o
// overview lê isLinked dele. O WSS noServer não abre porta — criar no require é barato/inerte.
const siteLink = createSiteLink();

module.exports = { createSiteLink, siteLink, defaultAuthenticate };
