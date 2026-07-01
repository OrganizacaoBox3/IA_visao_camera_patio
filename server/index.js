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

// Grupos de rotas HTTP (corpos dos handlers). Cada módulo expõe handle(req,res,ctx) e
// devolve true quando tratou a requisição (resposta enviada), senão false → o dispatch segue.
const routeAuth = require("./routes/auth");
const routeData = require("./routes/data");
const routeAlarms = require("./routes/alarms");
const routeNotif = require("./routes/notif");
const routeUsers = require("./routes/users");
const routeCameras = require("./routes/cameras");
const routeConfig = require("./routes/config-routes");

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
  const ctx = { json, readBody, requireAuth, requireSuper, requireConfigurer, io };
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
  } catch {
    return json(res, 400, { error: "requisição inválida" });
  }

  res.writeHead(404);
  res.end();
});
const io = new Server(httpServer, { cors: { origin: "*" }, maxHttpBufferSize: 8e6 });

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

io.on("connection", (socket) => {
  const role = socket.handshake.query.role;

  if (role === "camera") {
    const id = String(socket.handshake.query.id || socket.id);
    const label = String(socket.handshake.query.label || `Câmera ${id.slice(0, 4)}`);
    cameras.set(id, { id, label });
    socketById.set(id, socket);
    socket.data.cameraId = id;
    io.to("dashboards").emit("cameras", cameraList());
    io.to("dashboards").emit("camera-status", { id, state: "online", label, kind: "browser" });
    console.log(`[camera+] ${label} (${id}) · total=${cameras.size}`);

    // Relé de frames (payload: { buf, w, h, ts }). VOLATILE: se um dashboard está lento, o frame
    // é DESCARTADO em vez de enfileirar — vídeo prefere o frame mais novo a acumular latência/backlog.
    socket.on("frame", (payload) => {
      io.to("dashboards").volatile.emit("frame", { id, ...payload });
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
    console.log(`[dashboard+] ${socket.id}`);

    // Central define o perfil de captura por câmera (ex.: leitura = alta resolução).
    // payload: { id, width, quality, fps }
    socket.on("set-capture", (cfg) => {
      if (!cfg || !cfg.id) return;
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
    rtsp.startRtspIngestion({ io, cameras, broadcast, dynamicSources: cameraStore.all() });
  });
})();
