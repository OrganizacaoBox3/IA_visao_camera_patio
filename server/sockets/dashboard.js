// Protocolo socket do DASHBOARD: rooms/snapshot inicial, assinatura por câmera (watch),
// foco de análise e entrada do pipeline de alarme (alert).
// Espelha o padrão de server/routes/: o corpo do handler mora aqui; index.js só compõe.
// Contrato ADITIVO (CLAUDE.md §3): "cameras", "camera-status", "watch", "analysis-focus"
// e "alert" → "alarm-event" byte-a-byte. O listener "set-capture" foi REMOVIDO na faxina
// jul/12 (órfão: nenhum cliente jamais o emitiu); o evento "capture" hub→nó-câmera segue
// VIVO — é o shed.js quem o emite (rebaixar/restaurar perfil).
const pipeline = require("../alarm/pipeline");
const { canSeeCamera } = require("../users");
const { visibleCameras } = require("../socket-scope");

/**
 * Anexa os handlers de dashboard a um socket recém-conectado.
 * @param socket socket.io autenticado (io.use em index.js)
 * @param ctx { io, cameras, cameraList, shed, analysis, rtsp }
 */
function attach(socket, { io, cameras, cameraList, shed, analysis, rtsp }) {
  const me = socket.data.user;
  socket.join("dashboards");
  // Retrocompat: dashboard de EQUIPE começa na room LEGADA (recebe TODOS os frames) até
  // emitir `watch` e migrar para rooms por câmera. Papel "cliente" NUNCA entra aqui (RBAC com
  // escopo — spec-multitenancy §4 S2): sem isso, o frame de câmeras fora da alocação vazaria
  // pela room legada antes mesmo do 1º `watch`.
  if (me.papel !== "cliente") socket.join("dash-legacy");
  shed.sweepShed(); // espectador legado chegou — religa imediatamente câmeras que estavam em shed
  socket.emit("cameras", visibleCameras(cameraList(), me));
  // Estado inicial por câmera p/ este dashboard (RTSP: do ingestor; navegador: conectada = online).
  for (const s of rtsp.statuses()) if (canSeeCamera(me, s.id)) socket.emit("camera-status", s);
  for (const c of cameraList())
    if (c.kind !== "rtsp" && canSeeCamera(me, c.id))
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
    const requested = p && Array.isArray(p.ids) ? p.ids.map(String) : [];
    // S3/§4 spec-multitenancy — NÃO confiar no cliente: só entram em `cam:<id>` os ids que o hub
    // REALMENTE conhece E que este usuário pode ver. Papéis de equipe: todas as conectadas
    // (comportamento de sempre). Papel "cliente": só as de `cameraIds` — um id de fora da
    // alocação (legítimo mas de OUTRO cliente, ou forjado) é IGNORADO, nunca entra na room.
    const ids = requested.filter((id) => cameras.has(id) && canSeeCamera(me, id));
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
    // Foco conta como audiência no shed (fps dinâmico): câmera focada sobe ao fps cheio
    // NA HORA (a saída do foco desce pelo debounce normal do sweep — subir é imediato).
    if (id) shed.sweepShed();
  });

  // Dashboard saiu: remove sua contribuição à união de foco (evita foco órfão prendendo o boost).
  socket.on("disconnect", () => {
    analysis.clearFocus(socket.id);
  });

  // Alerta do painel → pipeline de alarme (política → canais → persistência → broadcast).
  // A política decide UMA vez e a decisão vai aos dois canais; null = suprimido (ADR-004).
  // Papel "cliente" NUNCA emite (é só-visualização/notificação) — sem este gate, um cliente
  // poderia FORJAR `cameraId` de outro cliente e o novo roteamento por câmera (dispatch.js)
  // mandaria a notificação forjada pro WhatsApp de um cliente que não é o dele.
  socket.on("alert", (p) => {
    if (me.papel === "cliente") return;
    void pipeline.handleAlert(p, { cameras, io });
  });
}

module.exports = { attach };
