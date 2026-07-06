// Shed de câmeras por audiência: estado + lógica de rebaixamento/religamento de câmeras SEM
// espectador, com dependências injetadas — index.js só chama a API pública abaixo.
//
// ESPECTADOR de uma câmera = socket em `cam:<id>` OU em `dash-legacy`. Sem espectador por
// SHED_IDLE_MS (debounce — paginar não derruba stream), a câmera é REBAIXADA: RTSP entra em
// "idle" (ffmpeg morto, sem contar como erro/reconexão) e webcam recebe `capture { fps: baixo }`.
// Ao ganhar espectador, religa IMEDIATAMENTE (sweepShed roda no `watch`/conexão além do timer).

const SHED_IDLE_MS = Number(process.env.SHED_IDLE_MS ?? 60_000);
const SHED_SWEEP_MS = Number(process.env.SHED_SWEEP_MS ?? 5_000);
// INVARIANTE: SHED_WEBCAM_FPS ≥ 1 — o sampler do motor de análise é @1fps (ADR-009); abaixo
// disso a análise de webcam rebaixada degradaria sem nenhum aviso.
const SHED_WEBCAM_FPS = Number(process.env.SHED_WEBCAM_FPS ?? 2);
// fps default do nó webcam (espelha APP_CONFIG.net.frameFps em src/config.ts): o hub não conhece
// o default do nó, então restaura com este valor quando NÃO há um set-capture manual guardado.
const WEBCAM_DEFAULT_FPS = Number(process.env.WEBCAM_DEFAULT_FPS ?? 12);

/**
 * Cria o controlador de shed. Injeção de dependências (sem estado global de módulo):
 *  - io: servidor socket.io (para inspecionar rooms e emitir `capture` às webcams)
 *  - cameras: Map id -> { id, label, kind? } (fonte da verdade de câmeras conectadas)
 *  - socketById: Map id -> socket da câmera (para enviar `capture` direcionado)
 *  - rtsp: módulo de ingestão RTSP (idleSource/wakeSource, idempotentes)
 *  - analysisViewer?: predicado (id) => boolean — "o motor analisa esta câmera?"
 */
function createShed({ io, cameras, socketById, rtsp, analysisViewer }) {
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
    // ADR-009 — análise conta como ESPECTADOR: câmera analisada NUNCA é rebaixada (nem o
    // ffmpeg RTSP pausado, nem a webcam derrubada p/ SHED_WEBCAM_FPS). É o pilar do motor
    // 24/7 sem dashboard aberto; a decisão de shed é DESTE módulo, então o guard mora aqui.
    if (analysisViewer && analysisViewer(cam.id)) return;
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

  const timer = setInterval(sweepShed, SHED_SWEEP_MS);

  return {
    sweepShed,
    // Guarda o último perfil pedido pelo operador (`set-capture`): restaurado ao religar, nunca
    // sobrescrito pelo rebaixamento automático — o shed nunca apaga uma intenção manual.
    setLastCapture(id, cfg) {
      lastCaptureCfg.set(String(id), cfg);
    },
    // Nó de câmera (re)conectou no perfil default — estado de shed anterior não vale mais.
    onCameraConnected(id) {
      shedWebcams.delete(String(id));
    },
    // Cancela o timer (uso em teardown/teste). Não faz parte do fluxo normal do hub.
    stop() {
      clearInterval(timer);
    },
  };
}

module.exports = { createShed };
