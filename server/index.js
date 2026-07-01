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
const pgstore = require("./pgstore");
const settings = require("./settings");

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

  try {
    // Login (público)
    if (req.method === "POST" && req.url === "/api/login") {
      const { usuario, senha } = JSON.parse((await readBody(req)) || "{}");
      const r = users.authenticate(usuario, senha);
      return r ? json(res, 200, r) : json(res, 401, { error: "credenciais inválidas" });
    }

    // Histórico/indicadores no Postgres (qualquer usuário autenticado)
    if (req.url === "/api/ingest" && req.method === "POST") {
      if (!requireAuth(req, res)) return;
      const { kind, op, payload } = JSON.parse((await readBody(req, 200_000)) || "{}");
      await pgstore.ingest(kind, op, payload);
      return json(res, 200, { ok: true });
    }
    const mb = req.url && req.url.match(/^\/api\/data\/(ativ|read|obj|fad)\/(buckets|events)$/);
    if (mb && req.method === "GET") {
      if (!requireAuth(req, res)) return;
      return json(
        res,
        200,
        mb[2] === "buckets" ? await pgstore.buckets(mb[1]) : await pgstore.events(mb[1]),
      );
    }
    if (req.url === "/api/data/clear" && req.method === "POST") {
      if (!requireSuper(req, res)) return;
      await pgstore.clear();
      return json(res, 200, { ok: true });
    }

    // Eventos de alarme — fila acionável com acknowledge (Onda B). Qualquer usuário
    // autenticado lê/opera (mesmo padrão de auth dos dados/indicadores). SÓ METADADOS.
    const path0 = req.url ? req.url.split("?")[0] : "";
    if (path0 === "/api/alarms" && req.method === "GET") {
      if (!requireAuth(req, res)) return;
      const q = new URL(req.url, "http://x").searchParams;
      return json(
        res,
        200,
        events.query({
          limit: q.get("limit"),
          since: q.get("since"),
          state: q.get("state"),
          priority: q.get("priority"),
        }),
      );
    }
    const mAck = path0.match(/^\/api\/alarms\/([\w-]+)\/ack$/);
    if (mAck && req.method === "POST") {
      const me = requireAuth(req, res);
      if (!me) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const r = await events.ack(mAck[1], body.by || me.usuario || me.id);
      if (r.error) return json(res, 404, r);
      io.to("dashboards").emit("alarm-update", r.event);
      return json(res, 200, r.event);
    }
    const mFwd = path0.match(/^\/api\/alarms\/([\w-]+)\/forward$/);
    if (mFwd && req.method === "POST") {
      const me = requireAuth(req, res);
      if (!me) return;
      const body = JSON.parse((await readBody(req)) || "{}");
      const r = await events.forward(mFwd[1], body.by || me.usuario || me.id);
      if (r.error) return json(res, 404, r);
      io.to("dashboards").emit("alarm-update", r.event);
      return json(res, 200, r.event);
    }

    // Saúde de alarmes (Onda C, item 14) — expõe a lógica EM MEMÓRIA de alarmPolicy.js.
    // metrics()/listShelved() são leitura (qualquer usuário autenticado); shelve/unshelve
    // são ações de configuração (requireConfigurer). NÃO persiste — estado volátil do processo.
    // Estas rotas vêm ANTES das de :id (ack/forward usam [\w-]+ e não casam "metrics"/"shelves").
    if (path0 === "/api/alarms/metrics" && req.method === "GET") {
      if (!requireAuth(req, res)) return;
      return json(res, 200, alarmPolicy.metrics());
    }
    if (path0 === "/api/alarms/shelves") {
      if (req.method === "GET") {
        if (!requireAuth(req, res)) return;
        return json(res, 200, alarmPolicy.listShelved());
      }
      if (req.method === "POST") {
        const me = requireConfigurer(req, res);
        if (!me) return;
        const body = JSON.parse((await readBody(req)) || "{}");
        const key = typeof body.key === "string" ? body.key.trim() : "";
        if (!key) return json(res, 400, { error: "key é obrigatória (string não vazia)" });
        const by = me.usuario || me.id;
        const shelf = alarmPolicy.shelve(key, body.ms, { reason: body.reason, by });
        return json(res, 201, shelf);
      }
    }
    const mShelf = path0.match(/^\/api\/alarms\/shelves\/(.+)$/);
    if (mShelf && req.method === "DELETE") {
      if (!requireConfigurer(req, res)) return;
      const ok = alarmPolicy.unshelve(decodeURIComponent(mShelf[1]));
      return json(res, 200, { ok });
    }

    // Perfil do próprio usuário (qualquer papel) — WhatsApp + preferências + opt-in
    if (req.url === "/api/me") {
      const me = requireAuth(req, res);
      if (!me) return;
      if (req.method === "GET") return json(res, 200, users.getProfile(me.id));
      if (req.method === "PATCH" || req.method === "PUT") {
        const r = await users.updateProfile(me.id, JSON.parse((await readBody(req)) || "{}"));
        return r.error ? json(res, 400, r) : json(res, 200, r.user);
      }
    }

    // Token de enrolamento de câmera (superadmin) — p/ montar o link /camera?key=
    if (req.url === "/api/camera-enroll" && req.method === "GET") {
      if (!requireSuper(req, res)) return;
      return json(res, 200, { token: process.env.CAMERA_TOKEN || null });
    }

    // Destinatários de WhatsApp (superadmin) — lista central
    if (req.url === "/api/recipients") {
      if (req.method === "GET") {
        if (!requireSuper(req, res)) return;
        return json(res, 200, recipients.all());
      }
      if (req.method === "POST") {
        if (!requireSuper(req, res)) return;
        const r = await recipients.create(JSON.parse((await readBody(req)) || "{}"));
        return r.error ? json(res, 400, r) : json(res, 201, r.recipient);
      }
    }
    const mr = req.url && req.url.match(/^\/api\/recipients\/([\w-]+)$/);
    if (mr) {
      const id = mr[1];
      if (req.method === "PATCH") {
        if (!requireSuper(req, res)) return;
        const r = await recipients.update(id, JSON.parse((await readBody(req)) || "{}"));
        return r.error ? json(res, 400, r) : json(res, 200, r.recipient);
      }
      if (req.method === "DELETE") {
        if (!requireSuper(req, res)) return;
        await recipients.remove(id);
        return json(res, 200, { ok: true });
      }
    }

    // Configuração de notificações (superadmin): GET atual, PUT salva, POST preview (sem salvar)
    if (req.url === "/api/notif-settings") {
      if (req.method === "GET") {
        if (!requireSuper(req, res)) return;
        return json(res, 200, settings.get());
      }
      if (req.method === "PUT" || req.method === "PATCH") {
        if (!requireSuper(req, res)) return;
        return json(res, 200, await settings.update(JSON.parse((await readBody(req)) || "{}")));
      }
    }
    if (req.url === "/api/notif-preview" && req.method === "POST") {
      if (!requireSuper(req, res)) return;
      const s = settings.normalize(JSON.parse((await readBody(req)) || "{}"));
      const now = Date.now();
      const samples = {
        atividade: "⚠ Doca 2: Doca 2 sem movimentação há 15 min.",
        fadiga: "⚠ Câmera Frente · Posto 1: Fadiga",
        leitura: "⚠ Ponto 1: taxa de leitura 72% (abaixo de 80%)",
        objetos: "📦 caixa entrou em Setor 2",
      };
      const out = {};
      for (const [tipo, txt] of Object.entries(samples))
        out[tipo] = dispatch.formatWhatsApp(txt, dispatch.classify(txt), now, s);
      return json(res, 200, out);
    }

    // WhatsApp (superadmin): status/QR + envio de teste
    if (req.url === "/api/wa-status" && req.method === "GET") {
      if (!requireSuper(req, res)) return;
      return json(res, 200, whatsapp.status());
    }
    if (req.url === "/api/wa-test" && req.method === "POST") {
      if (!requireSuper(req, res)) return;
      const { numero } = JSON.parse((await readBody(req)) || "{}");
      try {
        await whatsapp.sendText(
          numero,
          "✅ Teste — Visão de Pátio: notificações de WhatsApp funcionando.",
        );
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    // Gestão de usuários (somente superadmin)
    if (req.url === "/api/users") {
      if (req.method === "GET") {
        if (!requireSuper(req, res)) return;
        return json(res, 200, users.publicList());
      }
      if (req.method === "POST") {
        if (!requireSuper(req, res)) return;
        const r = await users.createUser(JSON.parse((await readBody(req)) || "{}"));
        return r.error ? json(res, 400, r) : json(res, 201, r.user);
      }
    }
    const m = req.url && req.url.match(/^\/api\/users\/([\w-]+)$/);
    if (m) {
      const id = m[1];
      if (req.method === "PATCH") {
        if (!requireSuper(req, res)) return;
        const r = await users.updateUser(id, JSON.parse((await readBody(req)) || "{}"));
        return r.error ? json(res, 400, r) : json(res, 200, r.user);
      }
      if (req.method === "DELETE") {
        if (!requireSuper(req, res)) return;
        const r = await users.removeUser(id);
        return r.error ? json(res, 400, r) : json(res, 200, { ok: true });
      }
    }

    // Câmeras IP/RTSP dinâmicas (superadmin) — CRUD em runtime + start/stop do ffmpeg sem reiniciar o hub.
    // Persistido em cameras.json; as fontes legadas (rtsp.sources.json/env) continuam carregando no boot.
    if (req.url === "/api/cameras") {
      if (req.method === "GET") {
        if (!requireSuper(req, res)) return;
        return json(res, 200, cameraStore.all());
      }
      if (req.method === "POST") {
        if (!requireSuper(req, res)) return;
        const r = cameraStore.create(JSON.parse((await readBody(req)) || "{}"));
        if (r.error) return json(res, 400, r);
        if (r.camera.enabled !== false) rtsp.addSource(r.camera); // sobe o ffmpeg já
        return json(res, 201, r.camera);
      }
    }
    const mcam = req.url && req.url.match(/^\/api\/cameras\/([\w-]+)$/);
    if (mcam) {
      const id = mcam[1];
      if (req.method === "PATCH") {
        if (!requireSuper(req, res)) return;
        const r = cameraStore.update(id, JSON.parse((await readBody(req)) || "{}"));
        if (r.error) return json(res, 400, r);
        if (r.camera.enabled === false)
          rtsp.removeSource(id); // desabilitada → para o stream
        else rtsp.restartSource(r.camera); // aplica url/transporte/perfil em runtime
        return json(res, 200, r.camera);
      }
      if (req.method === "DELETE") {
        if (!requireSuper(req, res)) return;
        const r = cameraStore.remove(id);
        if (r.error) return json(res, 404, r);
        rtsp.removeSource(id);
        return json(res, 200, { ok: true });
      }
    }

    // ── VIEWS (layouts do dashboard) — COMPARTILHADAS, lista global ───────────
    // GET (qualquer usuário autenticado) lê; PUT (qualquer autenticado — operadores
    // organizam o monitoramento compartilhado) substitui a lista inteira e persiste.
    if (path0 === "/api/views") {
      if (req.method === "GET") {
        if (!requireAuth(req, res)) return;
        return json(res, 200, camcfg.allViews());
      }
      if (req.method === "PUT") {
        if (!requireAuth(req, res)) return;
        const body = JSON.parse((await readBody(req, 200_000)) || "{}");
        const saved = await camcfg.saveViews(body && body.views);
        io.to("dashboards").emit("camcfg-updated", { kind: "views" });
        return json(res, 200, saved);
      }
    }

    // ── TRIPWIRES (linhas de contagem) — COMPARTILHADAS, por câmera ───────────
    // GET (qualquer autenticado) lê; PUT exige perfil de configuração (engenharia),
    // coerente com o gate de edição no front. Substitui as linhas da câmera e persiste.
    const mtw = path0.match(/^\/api\/tripwires\/([\w-]+)$/);
    if (mtw) {
      const cameraId = decodeURIComponent(mtw[1]);
      if (req.method === "GET") {
        if (!requireAuth(req, res)) return;
        return json(res, 200, camcfg.getTripwires(cameraId));
      }
      if (req.method === "PUT") {
        if (!requireConfigurer(req, res)) return;
        const body = JSON.parse((await readBody(req, 200_000)) || "{}");
        const saved = await camcfg.saveTripwires(cameraId, body && body.tripwires);
        io.to("dashboards").emit("camcfg-updated", { kind: "tripwires", cameraId });
        return json(res, 200, saved);
      }
    }

    // ── ZONES (ROIs + modo/config) — COMPARTILHADAS, por câmera ───────────────
    // GET (qualquer autenticado) lê; PUT exige perfil de configuração (engenharia),
    // coerente com o gate de edição no front. Substitui as zonas da câmera e persiste.
    const mzn = path0.match(/^\/api\/zones\/([\w-]+)$/);
    if (mzn) {
      const cameraId = decodeURIComponent(mzn[1]);
      if (req.method === "GET") {
        if (!requireAuth(req, res)) return;
        return json(res, 200, camcfg.getZones(cameraId));
      }
      if (req.method === "PUT") {
        if (!requireConfigurer(req, res)) return;
        const body = JSON.parse((await readBody(req, 200_000)) || "{}");
        const saved = await camcfg.saveZones(cameraId, body && body.zones);
        io.to("dashboards").emit("camcfg-updated", { kind: "zones", cameraId });
        return json(res, 200, saved);
      }
    }

    // ── CAMCONFIG (config de câmera) — COMPARTILHADA, por câmera ───────────────
    // GET (qualquer autenticado) lê (null se nunca salva → front usa defaults);
    // PUT exige perfil de configuração. Substitui a config da câmera e persiste.
    const mcc = path0.match(/^\/api\/camconfig\/([\w-]+)$/);
    if (mcc) {
      const cameraId = decodeURIComponent(mcc[1]);
      if (req.method === "GET") {
        if (!requireAuth(req, res)) return;
        return json(res, 200, camcfg.getCamConfig(cameraId));
      }
      if (req.method === "PUT") {
        if (!requireConfigurer(req, res)) return;
        const body = JSON.parse((await readBody(req, 200_000)) || "{}");
        const saved = await camcfg.saveCamConfig(cameraId, body && body.config);
        if (!saved) return json(res, 400, { error: "config inválida" });
        io.to("dashboards").emit("camcfg-updated", { kind: "camconfig", cameraId });
        return json(res, 200, saved);
      }
    }
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
