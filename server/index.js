// Hub de câmeras — relé de frames câmera → dashboard via socket.io.
// Não processa nem armazena vídeo: apenas registra câmeras conectadas e repassa frames.
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const rtsp = require("./rtsp");
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
function readBody(req, limit = 10_000) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > limit) req.destroy();
    });
    req.on("end", () => resolve(b));
  });
}
function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function bearer(req) {
  const h = req.headers["authorization"] || "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}
// devolve o usuário autenticado (qualquer papel), ou responde 401 e devolve null
function requireAuth(req, res) {
  const u = users.verifyToken(bearer(req));
  if (!u) {
    json(res, 401, { error: "não autenticado" });
    return null;
  }
  return u;
}
// devolve o superadmin autenticado, ou responde 401/403 e devolve null
function requireSuper(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (u.papel !== "superadmin") {
    json(res, 403, { error: "acesso restrito ao superadmin" });
    return null;
  }
  return u;
}
// RBAC Setup × Live (Onda C item 12): devolve o usuário que PODE configurar (superadmin OU
// engenheiro), ou responde 401/403. Usado pelos endpoints de saúde de alarmes (shelve/unshelve).
function requireConfigurer(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (!users.canConfigure(u.papel)) {
    json(res, 403, { error: "acesso restrito à equipe de configuração" });
    return null;
  }
  return u;
}

const httpServer = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); // dev cross-origin; prod é same-origin via nginx
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
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
  } catch {
    return json(res, 400, { error: "requisição inválida" });
  }

  res.writeHead(404);
  res.end();
});
const io = new Server(httpServer, { cors: { origin: "*" }, maxHttpBufferSize: 8e6 });

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
const broadcast = () => io.to("dashboards").emit("cameras", cameraList());

// ── 2.1 — Assinatura por câmera (rooms) + shed de câmeras sem espectador ─────────────────────
// Contrato ADITIVO: dashboard NOVO emite `watch { ids }` (conjunto COMPLETO do que quer receber)
// e entra nas rooms `cam:<id>`; dashboard ANTIGO nunca emite `watch` e permanece na room
// `dash-legacy`, recebendo TODOS os frames (comportamento atual preservado). Só o evento `frame`
// é filtrado por room — `cameras`/`camera-status`/`alarm-*`/`camcfg-updated` seguem em "dashboards".
//
// ESPECTADOR de uma câmera = socket em `cam:<id>` OU em `dash-legacy`. Sem espectador por
// SHED_IDLE_MS (debounce — paginar não derruba stream), a câmera é REBAIXADA: RTSP entra em
// "idle" (ffmpeg morto, sem contar como erro/reconexão) e webcam recebe `capture { fps: baixo }`.
// Ao ganhar espectador, religa IMEDIATAMENTE (sweepShed roda no `watch`/conexão além do timer).
const SHED_IDLE_MS = Number(process.env.SHED_IDLE_MS ?? 60_000);
const SHED_SWEEP_MS = Number(process.env.SHED_SWEEP_MS ?? 5_000);
const SHED_WEBCAM_FPS = Number(process.env.SHED_WEBCAM_FPS ?? 2);
// fps default do nó webcam (espelha APP_CONFIG.net.frameFps em src/config.ts): o hub não conhece
// o default do nó, então restaura com este valor quando NÃO há um set-capture manual guardado.
const WEBCAM_DEFAULT_FPS = Number(process.env.WEBCAM_DEFAULT_FPS ?? 12);

/** id -> último perfil pedido via `set-capture` (não deixar o shed sobrescrever o operador) */
const lastCaptureCfg = new Map();
/** id -> epoch ms de quando ficou SEM espectador (debounce do shed) */
const idleSince = new Map();
/** ids de webcam atualmente rebaixadas para fps baixo */
const shedWebcams = new Set();

function viewersOf(id) {
  const rooms = io.sockets.adapter.rooms;
  return (rooms.get(`cam:${id}`)?.size ?? 0) + (rooms.get("dash-legacy")?.size ?? 0);
}

function shedCamera(cam) {
  if (cam.kind === "rtsp") {
    rtsp.idleSource(cam.id); // idempotente: no-op se já idle/parada
    return;
  }
  if (shedWebcams.has(cam.id)) return;
  const target = socketById.get(cam.id);
  if (!target) return;
  shedWebcams.add(cam.id);
  target.emit("capture", { fps: SHED_WEBCAM_FPS });
  console.log(`[shed] ${cam.id} sem espectador — webcam rebaixada p/ ${SHED_WEBCAM_FPS}fps`);
}

function restoreCamera(cam) {
  if (cam.kind === "rtsp") {
    rtsp.wakeSource(cam.id); // idempotente: no-op se não está idle
    return;
  }
  if (!shedWebcams.has(cam.id)) return;
  shedWebcams.delete(cam.id);
  const target = socketById.get(cam.id);
  if (!target) return;
  const manual = lastCaptureCfg.get(cam.id);
  target.emit("capture", manual ?? { fps: WEBCAM_DEFAULT_FPS });
  console.log(`[shed] ${cam.id} ganhou espectador — perfil de captura restaurado`);
}

function sweepShed() {
  const now = Date.now();
  for (const cam of cameras.values()) {
    if (viewersOf(cam.id) > 0) {
      idleSince.delete(cam.id);
      restoreCamera(cam);
    } else if (!idleSince.has(cam.id)) {
      idleSince.set(cam.id, now);
    } else if (now - idleSince.get(cam.id) >= SHED_IDLE_MS) {
      shedCamera(cam);
    }
  }
  // poda estado de câmeras que saíram da lista
  for (const id of idleSince.keys()) if (!cameras.has(id)) idleSince.delete(id);
  for (const id of shedWebcams) if (!cameras.has(id)) shedWebcams.delete(id);
}
setInterval(sweepShed, SHED_SWEEP_MS);

io.on("connection", (socket) => {
  const role = socket.handshake.query.role;

  if (role === "camera") {
    const id = String(socket.handshake.query.id || socket.id);
    const label = String(socket.handshake.query.label || `Câmera ${id.slice(0, 4)}`);
    cameras.set(id, { id, label });
    socketById.set(id, socket);
    socket.data.cameraId = id;
    shedWebcams.delete(id); // nó (re)conectou no perfil default — estado de shed anterior não vale mais
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
    sweepShed(); // espectador legado chegou — religa imediatamente câmeras que estavam em shed
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
      sweepShed(); // religa NA HORA câmeras que ganharam espectador (o debounce só vale p/ shed)
    });

    // Central define o perfil de captura por câmera (ex.: leitura = alta resolução).
    // payload: { id, width, quality, fps }
    socket.on("set-capture", (cfg) => {
      if (!cfg || !cfg.id) return;
      // Guarda o último perfil pedido pelo operador: o shed (2.1) restaura ESTE perfil ao religar,
      // não o default — o rebaixamento automático nunca sobrescreve uma intenção manual.
      lastCaptureCfg.set(String(cfg.id), { width: cfg.width, quality: cfg.quality, fps: cfg.fps });
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
