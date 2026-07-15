// Rotas de câmeras: token de enrolamento + CRUD de câmeras IP/RTSP dinâmicas (superadmin) e
// snapshot das câmeras CONECTADAS p/ a busca do shell (qualquer papel autenticado).
// O CRUD reflete em runtime no ffmpeg (rtsp) sem reiniciar o hub. Persistido em cameras.json.
const cameraStore = require("../cameras");
const rtsp = require("../rtsp");
const users = require("../users");
const { bearer } = require("../http-auth");
const videoTicket = require("../video-ticket");

async function handle(req, res, ctx) {
  const { json, readBody, requireAuth, requireSuper, cameraList } = ctx;

  // Token de enrolamento de câmera (superadmin) — p/ montar o link /camera?key=
  if (req.url === "/api/camera-enroll" && req.method === "GET") {
    if (!requireSuper(req, res)) return true;
    json(res, 200, { token: process.env.CAMERA_TOKEN || null });
    return true;
  }

  // Ticket de vídeo p/ o proxy /go2rtc/* (fecha o buraco "vídeo sem auth"). Emite um passe HMAC de
  // curta duração (server/video-ticket.js); o front injeta ?ticket= nas URLs de vídeo. Com ?src=
  // o ticket é ESPECÍFICO daquela câmera; sem src é GERAL (p/ /api/streams). Aceita QUALQUER
  // credencial válida do produto: sessão de usuário (requireAuth) OU o CAMERA_TOKEN de dispositivo
  // — este último p/ o nó de webcam seguir PUBLICANDO por WHIP (que também passa pelo proxy gateado).
  if (req.url && req.url.startsWith("/api/video-ticket") && req.method === "GET") {
    const t = bearer(req);
    const user = users.verifyToken(t);
    const isDevice =
      !!process.env.CAMERA_TOKEN && users.constantTimeEqual(t, process.env.CAMERA_TOKEN);
    if (!user && !isDevice) {
      json(res, 401, { error: "não autenticado" });
      return true;
    }
    let src;
    try {
      src = new URL(req.url, "http://localhost").searchParams.get("src") || undefined;
    } catch {
      src = undefined;
    }
    json(res, 200, { ticket: videoTicket.signTicket({ src }) });
    return true;
  }

  // Busca do shell: câmeras CONECTADAS agora (ctx.cameraList — o MESMO registry vivo que alimenta
  // o evento socket "cameras"; sem estado duplicado). Qualquer papel autenticado: expõe só
  // id/rótulo/disponibilidade (sem URL/credencial — o CRUD abaixo segue superadmin).
  // CONTRATO com o front (não mudar o shape): { cameras: [{ id, label, online }] }.
  if (req.url === "/api/cameras/connected" && req.method === "GET") {
    if (!requireAuth(req, res)) return true;
    // RTSP: online = ffmpeg entregando ("online") ou pausado pelo shed ("idle" — religa sozinho
    // ao ganhar espectador); "connecting"/"error"/"stopped" = indisponível agora.
    // Nó-navegador: estar no registry = socket conectado = online.
    const rtspState = new Map(rtsp.statuses().map((s) => [s.id, s.state]));
    json(res, 200, {
      cameras: cameraList().map((c) => ({
        id: String(c.id),
        label: String(c.label || c.id),
        online: c.kind === "rtsp" ? ["online", "idle"].includes(rtspState.get(c.id)) : true,
      })),
    });
    return true;
  }

  if (req.url === "/api/cameras") {
    if (req.method === "GET") {
      if (!requireSuper(req, res)) return true;
      json(res, 200, cameraStore.all());
      return true;
    }
    if (req.method === "POST") {
      if (!requireSuper(req, res)) return true;
      const r = cameraStore.create(JSON.parse((await readBody(req)) || "{}"));
      if (r.error) {
        json(res, 400, r);
        return true;
      }
      if (r.camera.enabled !== false) rtsp.addSource(r.camera); // sobe o ffmpeg já
      json(res, 201, r.camera);
      return true;
    }
  }
  const mcam = req.url && req.url.match(/^\/api\/cameras\/([\w-]+)$/);
  if (mcam) {
    const id = mcam[1];
    if (req.method === "PATCH") {
      if (!requireSuper(req, res)) return true;
      const r = cameraStore.update(id, JSON.parse((await readBody(req)) || "{}"));
      if (r.error) {
        json(res, 400, r);
        return true;
      }
      if (r.camera.enabled === false)
        rtsp.removeSource(id); // desabilitada → para o stream
      else rtsp.restartSource(r.camera); // aplica url/transporte/perfil em runtime
      json(res, 200, r.camera);
      return true;
    }
    if (req.method === "DELETE") {
      if (!requireSuper(req, res)) return true;
      const r = cameraStore.remove(id);
      if (r.error) {
        json(res, 404, r);
        return true;
      }
      rtsp.removeSource(id);
      json(res, 200, { ok: true });
      return true;
    }
  }

  return false;
}

module.exports = { handle };
