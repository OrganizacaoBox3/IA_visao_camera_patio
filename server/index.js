// Hub de câmeras — relé de frames câmera → dashboard via socket.io.
// Não processa nem armazena vídeo: apenas registra câmeras conectadas e repassa frames.
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const rtsp = require("./rtsp");
const go2rtc = require("./go2rtc");
const cameraStore = require("./cameras");
const alerts = require("./alerts");
const users = require("./users");
const whatsapp = require("./whatsapp");
const dispatch = require("./dispatch");
const alarmPolicy = require("./alarmPolicy");
const recipients = require("./recipients");
const camcfg = require("./camcfg");
const events = require("./events");
const db = require("./db");
const settings = require("./settings");
const analysis = require("./analysis/engine");
// Helpers HTTP/auth (json/bearer/requireAuth/requireSuper/requireConfigurer) e shed por audiência
// extraídos deste arquivo (Onda C do retrofit): index.js é composição/bootstrap.
const { json, requireAuth, requireSuper, requireConfigurer } = require("./http-auth");
const { createShed } = require("./shed");

// Grupos de rotas HTTP (corpos dos handlers). Cada módulo expõe handle(req,res,ctx) e
// devolve true quando tratou a requisição (resposta enviada), senão false → o dispatch segue.
const routeAuth = require("./routes/auth");
const routeData = require("./routes/data");
const routeAlarms = require("./routes/alarms");
const routeNotif = require("./routes/notif");
const routeUsers = require("./routes/users");
const routeCameras = require("./routes/cameras");
const routeConfig = require("./routes/config-routes");
const routeAnalysis = require("./routes/analysis");

const PORT = Number(process.env.PORT ?? 4000);
// HOST: em dev fica 0.0.0.0 (celular aponta p/ o IP do laptop). Em produção, atrás do
// Caddy, defina HOST=127.0.0.1 para o hub só ser alcançável pelo reverse proxy local.
const HOST = process.env.HOST ?? "0.0.0.0";

// API HTTP do hub (login etc.). socket.io anexa a este server e intercepta /socket.io/;
// as demais rotas caem aqui. Em produção o nginx faz proxy de /api/ e /socket.io/ → hub.
// R2: a Promise SEMPRE resolve/rejeita — nunca fica pendurada (antes, o `destroy()` no overflow
// travava o handler p/ sempre). Overflow → rejeita (marcado `.tooLarge` p/ o dispatch responder
// 413); `close` sem `end` (conexão abortada) → resolve com o que chegou; `error` → rejeita.
// NÃO destruímos o socket no overflow: removemos só o listener de `data` (para de acumular — sem
// crescimento de memória; o TCP faz backpressure) para que o dispatch AINDA consiga enviar a
// resposta 413 pelo mesmo socket. Destruir aqui derrubaria a conexão antes da resposta.
function readBody(req, limit = 10_000) {
  return new Promise((resolve, reject) => {
    let b = "";
    let done = false;
    const settle = (fn, arg) => {
      if (done) return;
      done = true;
      req.removeListener("data", onData);
      fn(arg);
    };
    const onData = (c) => {
      b += c;
      if (b.length > limit) {
        const err = new Error("corpo excede o limite");
        err.tooLarge = true;
        settle(reject, err);
      }
    };
    req.on("data", onData);
    req.on("end", () => settle(resolve, b));
    req.on("close", () => settle(resolve, b));
    req.on("error", (e) => settle(reject, e));
  });
}

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // dev cross-origin; prod é same-origin via nginx
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Fase 1 (go2rtc): reverse-proxy same-origin /go2rtc/* -> 127.0.0.1:1984 (WebRTC/MSE/HLS/MJPEG).
  // Antes do dispatch de rotas: o front fala /go2rtc/api/... na MESMA origem (CSP quase intacto).
  // Inerte quando o flag/binário estão ausentes (proxyRequest responde 503 — o front usa MJPEG).
  if (req.url && (req.url === "/go2rtc" || req.url.startsWith("/go2rtc/"))) {
    return go2rtc.proxyRequest(req, res);
  }

  // Contexto passado aos grupos de rotas: helpers de resposta/auth + io (p/ emitir aos painéis).
  // io = ioAnalysis (tee): mesmo io de sempre, mas o motor de análise observa os emits que
  // consome (ex.: "camcfg-updated" recarrega zonas/tripwires no engine) — contrato intacto.
  const ctx = { json, readBody, requireAuth, requireSuper, requireConfigurer, io: ioAnalysis };
  try {
    // Dispatch por grupo (ordem preservada do arquivo original; padrões de URL não colidem
    // entre grupos, então o agrupamento não altera qual handler casa).
    if (await routeAuth.handle(req, res, ctx)) return;
    if (await routeData.handle(req, res, ctx)) return;
    if (await routeAlarms.handle(req, res, ctx)) return;
    if (await routeNotif.handle(req, res, ctx)) return;
    if (await routeUsers.handle(req, res, ctx)) return;
    if (await routeCameras.handle(req, res, ctx)) return;
    if (await routeConfig.handle(req, res, ctx)) return;
    if (await routeAnalysis.handle(req, res, ctx)) return;
  } catch (err) {
    // R3: distingue erro do CLIENTE (corpo grande/malformado → 4xx) de erro INTERNO (bug → 500),
    // em vez de 400 cego p/ tudo. E LOGA — antes, um defeito de server virava 400 silencioso.
    if (err && err.tooLarge) {
      console.warn(`[http] corpo grande demais: ${req.method} ${req.url}`);
      return json(res, 413, { error: "corpo grande demais" });
    }
    if (err instanceof SyntaxError) {
      // JSON.parse malformado no corpo — erro do cliente.
      return json(res, 400, { error: "requisição inválida" });
    }
    console.error(`[http] erro ao processar ${req.method} ${req.url}:`, err && err.stack ? err.stack : err);
    return json(res, 500, { error: "erro interno" });
  }

  res.writeHead(404);
  res.end();
});
const io = new Server(httpServer, { cors: { origin: "*" }, maxHttpBufferSize: 8e6 });

// Fase 1 (go2rtc): proxy do upgrade WebSocket da SINALIZAÇÃO WebRTC (/go2rtc/api/ws).
// Coexiste com o socket.io: só tratamos /go2rtc/* — os upgrades de /socket.io/ seguem para o
// engine.io (que ignora paths que não são dele). Inerte quando o flag/binário estão ausentes.
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/go2rtc/")) go2rtc.proxyUpgrade(req, socket, head);
});

// ── Motor de análise no hub (F1/ADR-009) — tee de observação sobre o io ─────────────────────
// O engine consome coisas que já trafegam pelo io SEM mudar nenhum contrato: frames do relé
// RTSP (emitidos dentro de rtsp.js via ctx.io) e "camcfg-updated" (emitido pelas rotas de
// config). Este wrapper repassa TODO emit ao io real e apenas OBSERVA esses dois eventos.
// Frames de webcam não passam por aqui — o handler de "frame" abaixo chama onFrame direto.
function analysisTee(target) {
  return {
    to: (room) => analysisTee(target.to(room)),
    get volatile() {
      return analysisTee(target.volatile);
    },
    emit(ev, payload) {
      if (ev === "frame" && payload) analysis.onFrame(payload.id, payload.buf, payload.ts);
      else if (ev === "camcfg-updated") analysis.onCamcfgUpdated(payload);
      return target.emit(ev, payload);
    },
  };
}
const ioAnalysis = analysisTee(io);

// Acesso restrito (multi-usuário): todo socket precisa de token de sessão válido.
// Câmeras (dispositivos) também aceitam CAMERA_TOKEN quando definido (F4 — token de dispositivo).
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const role = socket.handshake.query.role;
  if (role === "camera" && process.env.CAMERA_TOKEN && token === process.env.CAMERA_TOKEN)
    return next();
  const user = users.verifyToken(token);
  if (!user) return next(new Error("unauthorized"));
  socket.data.user = user;
  next();
});

/** câmeras conectadas: id -> { id, label, kind? } */
const cameras = new Map();
/** id -> socket da câmera (p/ enviar config de captura direcionada) */
const socketById = new Map();
const cameraList = () => [...cameras.values()];
const broadcast = () => {
  io.to("dashboards").emit("cameras", cameraList());
  // Fase 1 (go2rtc): a lista de câmeras mudou → regenera o go2rtc.yaml (debounced, no-op se OFF).
  // broadcast() é chamado por rtsp.addSource/removeSource/restartSource (CRUD via routes/cameras),
  // então qualquer alteração de câmera IP re-sincroniza os streams do go2rtc sem hook extra.
  go2rtc.sync();
};

// ── 2.1 — Assinatura por câmera (rooms) + shed de câmeras sem espectador ─────────────────────
// Contrato ADITIVO: dashboard NOVO emite `watch { ids }` (conjunto COMPLETO do que quer receber)
// e entra nas rooms `cam:<id>`; dashboard ANTIGO nunca emite `watch` e permanece na room
// `dash-legacy`, recebendo TODOS os frames (comportamento atual preservado). Só o evento `frame`
// é filtrado por room — `cameras`/`camera-status`/`alarm-*`/`camcfg-updated` seguem em "dashboards".
//
// A LÓGICA de rebaixamento/religamento por audiência vive em ./shed.js (extraída na Onda C do
// retrofit). Aqui só instanciamos com as dependências e chamamos a API pública (sweepShed/
// setLastCapture/onCameraConnected) nos pontos do fluxo de socket abaixo.
const shed = createShed({ io, cameras, socketById, rtsp });

io.on("connection", (socket) => {
  const role = socket.handshake.query.role;

  if (role === "camera") {
    const id = String(socket.handshake.query.id || socket.id);
    const label = String(socket.handshake.query.label || `Câmera ${id.slice(0, 4)}`);
    cameras.set(id, { id, label });
    socketById.set(id, socket);
    socket.data.cameraId = id;
    shed.onCameraConnected(id); // nó (re)conectou no perfil default — estado de shed anterior não vale mais
    io.to("dashboards").emit("cameras", cameraList());
    io.to("dashboards").emit("camera-status", { id, state: "online", label, kind: "browser" });
    console.log(`[camera+] ${label} (${id}) · total=${cameras.size}`);

    // Relé de frames (payload: { buf, w, h, ts }). VOLATILE: se um dashboard está lento, o frame
    // é DESCARTADO em vez de enfileirar — vídeo prefere o frame mais novo a acumular latência/backlog.
    // Rooms (2.1): dashboards novos assistem por câmera (`cam:<id>`, via `watch`); antigos recebem
    // tudo pela `dash-legacy`. União de rooms — socket.io deduplica destinos.
    socket.on("frame", (payload) => {
      // Motor de análise (F1): o hub JÁ possui o frame — amostragem @1fps acontece no engine
      // (último-vence); aqui é só entregar a referência (custo ~zero por frame).
      if (payload && payload.buf) analysis.onFrame(id, payload.buf, payload.ts);
      io.to(`cam:${id}`).to("dash-legacy").volatile.emit("frame", { id, ...payload });
    });

    socket.on("disconnect", () => {
      cameras.delete(id);
      socketById.delete(id);
      io.to("dashboards").emit("cameras", cameraList());
      io.to("dashboards").emit("camera-status", { id, state: "stopped", label, kind: "browser" });
      console.log(`[camera-] ${label} (${id}) · total=${cameras.size}`);
    });
  } else {
    // dashboard
    socket.join("dashboards");
    // Retrocompat (2.1): todo dashboard começa na room LEGADA (recebe TODOS os frames, como hoje).
    // Um dashboard novo emite `watch` e migra para rooms por câmera; um antigo segue recebendo tudo.
    socket.join("dash-legacy");
    shed.sweepShed(); // espectador legado chegou — religa imediatamente câmeras que estavam em shed
    socket.emit("cameras", cameraList());
    // Estado inicial por câmera p/ este dashboard (RTSP: do ingestor; navegador: já conectadas = online).
    for (const s of rtsp.statuses()) socket.emit("camera-status", s);
    for (const c of cameraList())
      if (c.kind !== "rtsp")
        socket.emit("camera-status", {
          id: c.id,
          state: "online",
          label: c.label,
          kind: "browser",
        });
    // Anti-duplicação (F1/ADR-009): snapshot do "analysis-status" por câmera analisada
    // ({ cameraId, engine: "hub" }) — o dashboard novo desliga o ingest local dessas câmeras.
    analysis.snapshotTo(socket);
    console.log(`[dashboard+] ${socket.id}`);

    // 2.1 — assinatura por câmera (contrato ADITIVO): o dashboard anuncia o conjunto COMPLETO de
    // câmeras que quer receber (`{ ids }` substitui o anterior — idempotente, sem unwatch). O
    // socket sai da room legada e das `cam:*` que não quer mais, e entra nas pedidas. A partir do
    // 1º `watch`, este dashboard só recebe `frame` das câmeras assistidas; os demais eventos
    // (cameras/camera-status/alarm-*/camcfg-updated) continuam chegando pela room "dashboards".
    socket.on("watch", (p) => {
      const ids = p && Array.isArray(p.ids) ? p.ids.map(String) : [];
      socket.data.usesWatch = true;
      socket.leave("dash-legacy");
      const want = new Set(ids.map((id) => `cam:${id}`));
      for (const room of [...socket.rooms]) {
        if (room.startsWith("cam:") && !want.has(room)) socket.leave(room);
      }
      for (const room of want) socket.join(room);
      shed.sweepShed(); // religa NA HORA câmeras que ganharam espectador (o debounce só vale p/ shed)
    });

    // Central define o perfil de captura por câmera (ex.: leitura = alta resolução).
    // payload: { id, width, quality, fps }
    socket.on("set-capture", (cfg) => {
      if (!cfg || !cfg.id) return;
      // Guarda o último perfil pedido pelo operador: o shed (2.1) restaura ESTE perfil ao religar,
      // não o default — o rebaixamento automático nunca sobrescreve uma intenção manual.
      shed.setLastCapture(cfg.id, { width: cfg.width, quality: cfg.quality, fps: cfg.fps });
      const target = socketById.get(String(cfg.id));
      if (target) target.emit("capture", { width: cfg.width, quality: cfg.quality, fps: cfg.fps });
    });

    // Andon: alerta do painel → política de alarme (dedup/inundação/prioridade) → webhook + WhatsApp.
    // A política decide UMA vez e roteia a mesma decisão p/ os dois canais; null = suprimido.
    socket.on("alert", (p) => {
      const d = alarmPolicy.evaluate(p);
      if (!d) return;
      alerts.notify(d);
      if (d.text) dispatch.dispatchAlert(d.text, d.ts, d.priority);
      // Onda B: grava o evento de alarme (SÓ METADADOS — LGPD) na fila acionável,
      // reusando a MESMA decisão da política (priority já calculada). Aditivo:
      // emite "alarm-event" aos painéis ao vivo sem tocar em frame/cameras/alert.
      const cam = d.cameraId && d.cameraId !== "_" ? cameras.get(d.cameraId) : null;
      events
        .record({
          ts: d.ts,
          cameraId: d.cameraId,
          cameraLabel: cam ? cam.label : undefined,
          zona: d.zona,
          tipo: d.tipo,
          priority: d.priority,
          text: d.text,
        })
        .then((ev) => {
          if (ev) io.to("dashboards").emit("alarm-event", ev);
        })
        .catch((e) => console.error("[alarm-events] falha ao gravar:", e.message));
    });
  }
});

// Bootstrap: garante o schema do Postgres e carrega os caches (users/recipients/settings) ANTES de
// aceitar conexões — assim verifyToken/login já têm os dados em memória.
(async () => {
  await db.init();
  await Promise.all([
    users.init(),
    recipients.init(),
    settings.init(),
    events.init(),
    camcfg.init(),
  ]);
  cameraStore.init(); // câmeras dinâmicas (cameras.json) — síncrono, JSON
  // Motor de análise no hub (F1/ADR-009): D-FINE-N em worker process, ingest direto no pgstore.
  // Liga/desliga por ANALYSIS_ENABLED (ver server/analysis/engine.js). Câmera analisada conta
  // como ESPECTADOR p/ o shed: o ffmpeg de RTSP não é pausado enquanto o motor estiver ativo.
  await analysis.init({ io, cameras });
  rtsp.setAnalysisViewer(analysis.isAnalyzing);
  httpServer.listen(PORT, HOST, () => {
    console.log(`Hub de câmeras ouvindo em http://${HOST}:${PORT} (socket.io)`);
    console.log(
      alerts.andonEnabled()
        ? "[andon] webhook de alertas ATIVO"
        : "[andon] desligado (defina ALERT_WEBHOOK_URL para ligar)",
    );
    console.log(
      whatsapp.enabled()
        ? "[whatsapp] habilitado — pareie pelo QR no painel"
        : "[whatsapp] desligado (defina WHATSAPP_ENABLED=1 para ligar)",
    );
    whatsapp.init();
    // Fase 1 (go2rtc): supervisor do sidecar de vídeo WebRTC. DESLIGADO por default —
    // só sobe com GO2RTC_ENABLED=1 + GO2RTC_BIN presente. getSources espelha o que o rtsp.js
    // ingere: fontes LEGADAS (rtsp.sources.json/env, ids rtsp-N) + DINÂMICAS (cameras.json).
    // O NOME de cada stream = ID da câmera (contrato com o front: /go2rtc/api/ws?src=<id>).
    go2rtc.init({
      getSources: () => {
        const legacy = rtsp
          .loadSources()
          .map((s, i) => ({ id: `rtsp-${i + 1}`, url: s.url }));
        const dynamic = cameraStore
          .all()
          .filter((c) => c && c.url && c.enabled !== false)
          .map((c) => ({ id: c.id, url: c.url }));
        return [...legacy, ...dynamic];
      },
    });
    // Câmeras IP/RTSP (via ffmpeg → frames JPEG), tratadas como câmeras comuns.
    // Legadas: rtsp.sources.json/env (retrocompat). Dinâmicas: cameras.json (CRUD em runtime).
    // io = ioAnalysis (tee): o motor de análise observa os frames JPEG que o rtsp.js emite
    // (mesmo caminho dos dashboards, custo ~zero) — nenhum contrato de evento muda.
    rtsp.startRtspIngestion({
      io: ioAnalysis,
      cameras,
      broadcast,
      dynamicSources: cameraStore.all(),
    });
  });
})();
