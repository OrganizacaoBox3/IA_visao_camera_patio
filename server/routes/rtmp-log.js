// Painel de log do ingest RTMP (superadmin): responde "o canal que CHEGA é o mesmo que o painel
// PEDE?" (a pergunta do diagnóstico manual em docs/analises/rtmp-ingest/) sem precisar de SSH —
// lê o ring buffer em memória do relay (server/rtmp-ingest.js) direto do processo do hub.
// Só metadados (nome de canal, key, timestamps) — sem URL/credencial, sem vídeo (LGPD/ADR-002).
const cameraStore = require("../cameras");

async function handle(req, res, ctx) {
  const { json, requireSuper, rtmpRelay } = ctx;
  if (req.url !== "/api/rtmp-ingest/log" || req.method !== "GET") return false;
  if (!requireSuper(req, res)) return true;

  if (!rtmpRelay) {
    json(res, 200, { enabled: false, events: [], channels: [] });
    return true;
  }

  const events = rtmpRelay.recentEvents().sort((a, b) => b.ts - a.ts);
  const live = new Set(rtmpRelay.activeChannels());
  const lastSeenByChannel = new Map();
  for (const e of events) {
    if (!lastSeenByChannel.has(e.name)) lastSeenByChannel.set(e.name, e.ts); // events já vem desc
  }

  // canal = nome do stream (último segmento da url self-referente rtsp://127.0.0.1:8554/<canal>).
  const ingestCameras = cameraStore
    .all()
    .filter((c) => c && typeof c.url === "string" && /^rtsp:\/\/127\.0\.0\.1:\d+\//.test(c.url))
    .map((c) => ({ id: c.id, label: c.label || c.id, canal: c.url.split("/").pop() }));

  const canais = new Set([...ingestCameras.map((c) => c.canal), ...live]);
  const channels = [...canais].sort().map((canal) => {
    const cam = ingestCameras.find((c) => c.canal === canal);
    return {
      canal,
      cadastrada: !!cam,
      cameraId: cam ? cam.id : null,
      label: cam ? cam.label : null,
      aoVivo: live.has(canal),
      ultimaAtividade: lastSeenByChannel.get(canal) ?? null,
    };
  });

  json(res, 200, { enabled: true, events, channels });
  return true;
}

module.exports = { handle };

