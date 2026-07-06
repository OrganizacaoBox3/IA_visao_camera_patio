// Protocolo socket do DASHBOARD: rooms/snapshot inicial, assinatura por câmera (watch),
// foco de análise, perfil de captura (set-capture) e entrada do pipeline de alarme (alert).
// Espelha o padrão de server/routes/: o corpo do handler mora aqui; index.js só compõe.
// Contrato ADITIVO (CLAUDE.md §3): "cameras", "camera-status", "watch", "analysis-focus",
// "set-capture"/"capture" e "alert" → "alarm-event" byte-a-byte.
const pipeline = require("../alarm/pipeline");

/**
 * Anexa os handlers de dashboard a um socket recém-conectado.
 * @param socket socket.io autenticado (io.use em index.js)
 * @param ctx { io, cameras, cameraList, socketById, shed, analysis, rtsp }
 */
function attach(socket, { io, cameras, cameraList, socketById, shed, analysis, rtsp }) {
  socket.join("dashboards");
  // Retrocompat: todo dashboard começa na room LEGADA (recebe TODOS os frames). Um dashboard
  // novo emite `watch` e migra para rooms por câmera; um antigo segue recebendo tudo.
  socket.join("dash-legacy");
  shed.sweepShed(); // espectador legado chegou — religa imediatamente câmeras que estavam em shed
  socket.emit("cameras", cameraList());
  // Estado inicial por câmera p/ este dashboard (RTSP: do ingestor; navegador: conectada = online).
  for (const s of rtsp.statuses()) socket.emit("camera-status", s);
  for (const c of cameraList())
    if (c.kind !== "rtsp")
      socket.emit("camera-status", { id: c.id, state: "online", label: c.label, kind: "browser" });
  // Anti-duplicação (ADR-009): snapshot do "analysis-status" por câmera analisada
  // ({ cameraId, engine: "hub" }) — o dashboard novo desliga o ingest local dessas câmeras.
  analysis.snapshotTo(socket);
  console.log(`[dashboard+] ${socket.id}`);

  // Assinatura por câmera (contrato ADITIVO): o dashboard anuncia o conjunto COMPLETO de
  // câmeras que quer receber (`{ ids }` substitui o anterior — idempotente, sem unwatch).
  // A partir do 1º `watch`, este dashboard só recebe `frame` das câmeras assistidas; os demais
  // eventos (cameras/camera-status/alarm-*/camcfg-updated) seguem pela room "dashboards".
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

  // Foco do operador (contrato ADITIVO `analysis-focus`): câmera aberta em TELA CHEIA ganha
  // mais cadência no motor (FPS_FOCUS). `{ id }` foca; `{ id: null }` libera. A câmera focada
  // é a UNIÃO entre todos os dashboards (por socket) — no disconnect a contribuição some.
  socket.on("analysis-focus", (p) => {
    const id = p && p.id != null && p.id !== "" ? String(p.id) : null;
    socket.data.focusId = id;
    analysis.setFocus(socket.id, id);
  });

  // Dashboard saiu: remove sua contribuição à união de foco (evita foco órfão prendendo o boost).
  socket.on("disconnect", () => {
    analysis.clearFocus(socket.id);
  });

  // Central define o perfil de captura por câmera (ex.: leitura = alta resolução).
  // payload: { id, width, quality, fps }
  socket.on("set-capture", (cfg) => {
    if (!cfg || !cfg.id) return;
    // Guarda o último perfil pedido pelo operador: o shed restaura ESTE perfil ao religar,
    // não o default — o rebaixamento automático nunca sobrescreve uma intenção manual.
    shed.setLastCapture(cfg.id, { width: cfg.width, quality: cfg.quality, fps: cfg.fps });
    const target = socketById.get(String(cfg.id));
    if (target) target.emit("capture", { width: cfg.width, quality: cfg.quality, fps: cfg.fps });
  });

  // Alerta do painel → pipeline de alarme (política → canais → persistência → broadcast).
  // A política decide UMA vez e a decisão vai aos dois canais; null = suprimido (ADR-004).
  socket.on("alert", (p) => {
    void pipeline.handleAlert(p, { cameras, io });
  });
}

module.exports = { attach };
