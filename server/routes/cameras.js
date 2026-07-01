// Rotas de câmeras (superadmin): token de enrolamento + CRUD de câmeras IP/RTSP dinâmicas.
// O CRUD reflete em runtime no ffmpeg (rtsp) sem reiniciar o hub. Persistido em cameras.json.
const cameraStore = require("../cameras");
const rtsp = require("../rtsp");

async function handle(req, res, ctx) {
  const { json, readBody, requireSuper } = ctx;

  // Token de enrolamento de câmera (superadmin) — p/ montar o link /camera?key=
  if (req.url === "/api/camera-enroll" && req.method === "GET") {
    if (!requireSuper(req, res)) return true;
    json(res, 200, { token: process.env.CAMERA_TOKEN || null });
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
