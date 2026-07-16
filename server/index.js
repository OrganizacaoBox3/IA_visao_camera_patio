// Hub de câmeras — relé de frames câmera → dashboard via socket.io.
// Não processa nem armazena vídeo: apenas registra câmeras conectadas e repassa frames.
const { createServer } = require("node:http");
const { Server } = require("socket.io");
const rtsp = require("./rtsp");
const { createAutoEnroll } = require("./rtmp-auto-enroll");
const go2rtc = require("./go2rtc");
const cameraStore = require("./cameras");
const alerts = require("./alerts");
const cpForwarder = require("./control-plane-forwarder");
const cpLink = require("./control-plane-link");
const users = require("./users");
const whatsapp = require("./whatsapp");
const recipients = require("./recipients");
const shifts = require("./shifts");
const persistenceHealth = require("./persistence-health");
const camcfg = require("./camcfg");
const events = require("./events");
const db = require("./db");
const settings = require("./settings");
const analysis = require("./analysis/engine");
const { json, requireAuth, requireSuper, requireConfigurer } = require("./http-auth");
const { createShed } = require("./shed");

// Grupos de rotas HTTP (corpos dos handlers). Cada módulo expõe handle(req,res,ctx) e
// devolve true quando tratou a requisição (resposta enviada), senão false → o dispatch segue.
const routeAuth = require("./routes/auth");
const routeData = require("./routes/data");
const routeAlarms = require("./routes/alarms");
const routeNotif = require("./routes/notif");
const routeShifts = require("./routes/shifts");
const routeUsers = require("./routes/users");
const routeCameras = require("./routes/cameras");
const routeConfig = require("./routes/config-routes");
const routeAnalysis = require("./routes/analysis");

// Camada socket (espelha o padrão de routes/): protocolo de nó-câmera e de dashboard em
// módulos próprios; cada um expõe attach(socket, ctx). index.js só compõe.
const socketCamera = require("./sockets/camera");
const socketDashboard = require("./sockets/dashboard");

const PORT = Number(process.env.PORT ?? 4000);
// HOST: em dev fica 0.0.0.0 (celular aponta p/ o IP do laptop). Em produção, atrás do
// Caddy, defina HOST=127.0.0.1 para o hub só ser alcançável pelo reverse proxy local.
const HOST = process.env.HOST ?? "0.0.0.0";

// API HTTP do hub (login etc.). socket.io anexa a este server e intercepta /socket.io/;
// as demais rotas caem aqui. Em produção o nginx faz proxy de /api/ e /socket.io/ → hub.
// INVARIANTE: a Promise SEMPRE resolve/rejeita. Overflow → rejeita (`.tooLarge` p/ o dispatch
// responder 413); `close` sem `end` (conexão abortada) → resolve com o que chegou; `error` →
// rejeita. No overflow NÃO destruímos o socket: só removemos o listener de `data` (o TCP faz
// backpressure) para que o dispatch ainda consiga responder 413 pela mesma conexão.
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

  // go2rtc: reverse-proxy same-origin /go2rtc/* -> 127.0.0.1:1984 (WebRTC/MSE/HLS/MJPEG).
  // Antes do dispatch de rotas: o front fala /go2rtc/api/... na MESMA origem (CSP quase intacto).
  // Inerte quando o flag/binário estão ausentes (proxyRequest responde 503 — o front usa MJPEG).
  if (req.url && (req.url === "/go2rtc" || req.url.startsWith("/go2rtc/"))) {
    return go2rtc.proxyRequest(req, res);
  }

  // Contexto passado aos grupos de rotas: helpers de resposta/auth + io (p/ emitir aos painéis).
  // io = ioAnalysis (tee): mesmo io de sempre, mas o motor de análise observa os emits que
  // consome (ex.: "camcfg-updated" recarrega zonas/tripwires no engine) — contrato intacto.
  // cameraList = snapshot das câmeras CONECTADAS (o MESMO estado que alimenta o evento
  // "cameras" — sem duplicação) p/ GET /api/cameras/connected (routes/cameras.js).
  const ctx = { json, readBody, requireAuth, requireSuper, requireConfigurer, io: ioAnalysis, cameraList };
  try {
    // Dispatch por grupo (ordem preservada do arquivo original; padrões de URL não colidem
    // entre grupos, então o agrupamento não altera qual handler casa).
    if (await routeAuth.handle(req, res, ctx)) return;
    if (await routeData.handle(req, res, ctx)) return;
    if (await routeAlarms.handle(req, res, ctx)) return;
    if (await routeNotif.handle(req, res, ctx)) return;
    if (await routeShifts.handle(req, res, ctx)) return;
    if (await routeUsers.handle(req, res, ctx)) return;
    if (await routeCameras.handle(req, res, ctx)) return;
    if (await routeConfig.handle(req, res, ctx)) return;
    if (await routeAnalysis.handle(req, res, ctx)) return;
  } catch (err) {
    // Distingue erro do CLIENTE (corpo grande/malformado → 4xx) de erro INTERNO (bug → 500 + log).
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
// maxHttpBufferSize 8e6 = teto SILENCIOSO do frame de webcam (JPEG > 8MB é dropado pelo
// engine.io) — na prática limita a resolução máxima que o motor de análise vê de webcam.
const io = new Server(httpServer, { cors: { origin: "*" }, maxHttpBufferSize: 8e6 });

// go2rtc: proxy do upgrade WebSocket da SINALIZAÇÃO WebRTC (/go2rtc/api/ws).
// Coexiste com o socket.io: só tratamos /go2rtc/* — os upgrades de /socket.io/ seguem para o
// engine.io (que ignora paths que não são dele). Inerte quando o flag/binário estão ausentes.
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/go2rtc/")) go2rtc.proxyUpgrade(req, socket, head);
});

// ── Motor de análise no hub (ADR-009) — tee de observação sobre o io ────────────────────────
// O engine consome coisas que já trafegam pelo io SEM mudar nenhum contrato: frames do relé
// (RTSP via rtsp.js e webcam via sockets/camera.js — o MESMO caminho) e "camcfg-updated"
// (emitido pelas rotas de config). Este wrapper repassa TODO emit ao io real e apenas OBSERVA
// esses dois eventos. INVARIANTE: trocar ioAnalysis→io em qualquer consumidor desliga
// frames/zonas do motor SEM nenhum erro — é o fio a proteger em refactor.
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
// Câmeras (dispositivos) também aceitam CAMERA_TOKEN quando definido (token de dispositivo).
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const role = socket.handshake.query.role;
  if (
    role === "camera" &&
    process.env.CAMERA_TOKEN &&
    users.constantTimeEqual(token, process.env.CAMERA_TOKEN)
  )
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
  // Lista de câmeras mudou → regenera o go2rtc.yaml (debounced, no-op se OFF). broadcast() é
  // chamado pelo CRUD de câmera IP (rtsp.add/remove/restartSource), então qualquer alteração
  // re-sincroniza os streams do go2rtc sem hook extra.
  go2rtc.sync();
};

// Shed por audiência: rebaixa/religa câmeras SEM espectador (lógica em ./shed.js; aqui só a
// instância com dependências). Contrato de rooms: só o evento `frame` é filtrado por room
// (`cam:<id>`/`dash-legacy`) — `cameras`/`camera-status`/`alarm-*`/`camcfg-updated` seguem
// na room "dashboards".
// analysisViewer: câmera analisada conta como espectador (ADR-009) — nunca vai a idle; sem
// audiência HUMANA ela desce ao MODO VIGÍLIA (fps dinâmico = piso 2× a cadência da análise,
// perf-round3 frente 1) e volta ao fps cheio quando chega espectador ou foco.
// effectiveFps: cadência efetiva do motor por câmera — usa o getter do engine quando existir
// (frente P1); enquanto não existe, fallback local que ESPELHA os envs/clamps do engine
// (FPS_LINE p/ câmera com tripwire, FPS normal p/ as demais — engine.js).
const SHED_ANALYSIS_FPS = Math.min(4, Math.max(0.2, Number(process.env.ANALYSIS_FPS) || 1));
const SHED_ANALYSIS_FPS_LINE = Math.min(
  4,
  Math.max(SHED_ANALYSIS_FPS, Number(process.env.ANALYSIS_FPS_LINE) || 2),
);
const effectiveFpsOf = (id) =>
  typeof analysis.effectiveFps === "function"
    ? analysis.effectiveFps(id)
    : camcfg.getTripwires(id).length > 0
      ? SHED_ANALYSIS_FPS_LINE
      : SHED_ANALYSIS_FPS;
// isFocused: câmera em TELA CHEIA em algum dashboard (socket.data.focusId — sockets/dashboard.js).
// Foco segura/retoma o fps cheio mesmo sem contagem de room (cinto e suspensório do "subir").
const isFocusedOf = (id) => {
  for (const s of io.of("/").sockets.values()) if (s.data && s.data.focusId === String(id)) return true;
  return false;
};
const shed = createShed({
  io,
  cameras,
  socketById,
  rtsp,
  analysisViewer: analysis.isAnalyzing,
  effectiveFps: effectiveFpsOf,
  isFocused: isFocusedOf,
});

// Contexto da camada socket: io = TEE de análise — o frame de webcam entra no motor pelo
// MESMO caminho do RTSP (1 caminho só); os demais eventos passam intactos. O pipeline de
// alarme (alert → política → canais → events → "alarm-event") vive em alarm/pipeline.js.
const socketCtx = { io: ioAnalysis, cameras, cameraList, socketById, shed, analysis, rtsp };
io.on("connection", (socket) => {
  if (socket.handshake.query.role === "camera") socketCamera.attach(socket, socketCtx);
  else socketDashboard.attach(socket, socketCtx);
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
    shifts.init(), // turnos de trabalho (cadastro global — spec-turnos-por-zona F1)
  ]);
  // GUARDIÃO DE PERSISTÊNCIA (persistence-health.js): se o PG está configurado mas algum store caiu
  // no fallback JSON, GRITA no boot — foi a armadilha que fez os turnos do dono sumirem (um .json não
  // sobrevive a um redeploy sem volume persistente).
  persistenceHealth.report(db.configured(), {
    users: users.persistence(),
    recipients: recipients.persistence(),
    settings: settings.persistence(),
    events: events.persistence(),
    camcfg: camcfg.persistence(),
    shifts: shifts.persistence(),
  });
  // Guarda de segurança do boot (auditoria 01, R-A): avisa sobre DEFAULTS INSEGUROS e, em
  // produção, ABORTA SÓ pelo AUTH_SECRET default (catastrófico + corrigível por env, sem deadlock).
  // A senha default 'admin@box3' NÃO derruba — só se troca pela UI (hub de pé), então é AVISO
  // persistente (users.bootAbort explica). Detecta a senha inclusive JÁ GRAVADA no store.
  {
    const insecure = users.insecureDefaults();
    if (insecure.authSecret || insecure.adminPassword) {
      const itens = [
        insecure.authSecret &&
          "AUTH_SECRET está no DEFAULT — defina um AUTH_SECRET forte (env do systemd) [BLOQUEIA o boot em produção]",
        insecure.adminPassword &&
          "a senha do superadmin ainda é o DEFAULT 'admin@box3' — TROQUE NA UI (aviso; não bloqueia o boot)",
      ].filter(Boolean);
      const bar = "═".repeat(72);
      console.error(`\n${bar}\n⚠  SEGURANÇA — DEFAULTS INSEGUROS ATIVOS:\n   • ${itens.join("\n   • ")}\n${bar}\n`);
      if (users.bootAbort(insecure, process.env.NODE_ENV)) {
        console.error(
          "[boot] NODE_ENV=production com AUTH_SECRET default → ABORTANDO. Defina AUTH_SECRET e reinicie.",
        );
        process.exit(1);
      }
    }
  }
  cameraStore.init(); // câmeras dinâmicas (cameras.json) — síncrono, JSON
  // Motor de análise no hub (ADR-009): D-FINE em worker process, ingest direto no pgstore.
  // Liga/desliga por ANALYSIS_ENABLED (ver server/analysis/engine.js). Câmera analisada conta
  // como ESPECTADOR p/ o shed (guard no shed E no rtsp.idleSource — defesa em profundidade).
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
    // Control-plane (spec-control-plane §4): registro do hub silo + heartbeat. Inerte sem
    // CP_URL/SITE_ID/SITE_KEY (só loga o desligado); o forwardAlarm vive em alarm/pipeline.js.
    cpForwarder.startHeartbeat();
    // Canal de sinalização reverso (Fase 3): o hub DISCA um WS persistente p/ o plane, que passa a
    // alcançar o hub por ele (o site está atrás de NAT). Inerte sem CP_URL/SITE_ID/SITE_KEY; fail-soft
    // (o plane cair não derruba o hub — só reconecta com backoff).
    cpLink.startSiteLink();
    // Supervisor do sidecar go2rtc (WebRTC): AUTO-ON pela presença de bin/go2rtc[.exe];
    // GO2RTC_ENABLED=0 força off (ver server/go2rtc.js). getSources espelha o que o rtsp.js
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
    // AUTO-CADASTRO de canais RTMP (rtmp-auto-enroll.js): publisher que bate num canal
    // inexistente ("stream not found" no log do go2rtc) vira câmera cadastrada sozinho —
    // o mesmo espírito da auto-descoberta de estações BLE. RTMP_AUTO_ENROLL=0 desliga.
    const autoEnroll = createAutoEnroll({
      enabled: process.env.RTMP_AUTO_ENROLL !== "0",
      hasChannel: (name) =>
        cameraStore.all().some((c) => c && typeof c.url === "string" && c.url.endsWith(`:8554/${name}`)),
      register: (name) => {
        const r = cameraStore.create({
          label: `${name} (auto)`,
          url: `rtsp://127.0.0.1:8554/${name}`,
        });
        if (r.error) {
          console.warn(`[rtmp-auto] cadastro de "${name}" falhou: ${r.error}`);
          return;
        }
        rtsp.addSource(r.camera); // sobe o ffmpeg e dispara broadcast() → go2rtc.sync()
      },
    });
    go2rtc.onLogLine(autoEnroll.onLogLine);
    // RELAY de ingest RTMP (server/rtmp-ingest.js): por default é ELE quem escuta a :1935 —
    // aceita o publish de DVRs que o parser do go2rtc não decodifica (MHDX: producer sem
    // tracks; spec docs/analises/rtmp-ingest/spec-relay-ingest.md) e serve FLV cru por HTTP
    // local para a fonte "ffmpeg:" dos canais (go2rtc.js). O evento publish alimenta o
    // auto-cadastro DIRETO (sem raspagem de log — o vídeo forma na mesma sessão do DVR).
    // RTMP_INGEST=go2rtc reverte ao listener legado do go2rtc (rollback sem redeploy).
    if (go2rtc.enabled() && process.env.RTMP_INGEST !== "go2rtc") {
      const { startRtmpIngest } = require("./rtmp-ingest");
      const ingest = startRtmpIngest({
        rtmpPort: Number(process.env.GO2RTC_RTMP_PORT ?? 1935),
        httpPort: Number(process.env.RTMP_RELAY_HTTP_PORT ?? 8935),
      });
      ingest.relay.on("publish", (name) => autoEnroll.onPublish(name));
    }
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
