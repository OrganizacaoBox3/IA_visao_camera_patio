// Shed de câmeras por audiência: estado + lógica de rebaixamento/religamento de câmeras SEM
// espectador, com dependências injetadas — index.js só chama a API pública abaixo.
//
// ESPECTADOR de uma câmera = socket em `cam:<id>` OU em `dash-legacy`. Sem espectador por
// SHED_IDLE_MS (debounce — paginar não derruba stream), a câmera é REBAIXADA:
//  - RTSP SEM análise → "idle" (ffmpeg morto, sem contar como erro/reconexão);
//  - RTSP COM análise → MODO VIGÍLIA (fps dinâmico, perf-round3 frente 1): o ffmpeg
//    re-spawna com fps reduzido ao PISO = max(2× a cadência efetiva da análise, 2) —
//    a análise NUNCA fica sem frames (nunca-cego), só some o excedente sem consumidor
//    (−25/−35% do CPU do ffmpeg por câmera, medido). ADR-009 continua de pé: análise
//    conta como espectador, mas agora segura só o PISO, não o fps cheio.
//  - webcam → `capture { fps: baixo }` (inalterado; análise protege integral — ADR-009).
// Ao ganhar espectador OU foco, religa IMEDIATAMENTE (sweepShed roda no `watch`/conexão/
// `analysis-focus` além do timer) — descer tem debounce generoso; subir é na hora.

const SHED_IDLE_MS = Number(process.env.SHED_IDLE_MS ?? 60_000);
const SHED_SWEEP_MS = Number(process.env.SHED_SWEEP_MS ?? 5_000);
// Piso ABSOLUTO do modo vigília (fps). 2 é o mínimo seguro provado na bancada: a 2fps de
// ingest a análise @1fps degradou 0,97→0,78fps — o piso 2× a cadência dá margem; abaixo
// disso a rodada + inferência perdem janelas (docs/analises/perf-round3/frente1-ingest-relay.md §5).
const VIGIL_MIN_FPS = Math.max(1, Number(process.env.SHED_VIGIL_MIN_FPS ?? 2));
// INVARIANTE: SHED_WEBCAM_FPS ≥ 1 — o sampler do motor de análise é @1fps (ADR-009); abaixo
// disso a análise de webcam rebaixada degradaria sem nenhum aviso.
const SHED_WEBCAM_FPS = Number(process.env.SHED_WEBCAM_FPS ?? 2);
// fps default do nó webcam (espelha APP_CONFIG.net.frameFps em src/config.ts): o hub não conhece
// o default do nó, então restaura com este valor quando NÃO há um set-capture manual guardado.
const WEBCAM_DEFAULT_FPS = Number(process.env.WEBCAM_DEFAULT_FPS ?? 12);

/**
 * Decisão PURA do fps-alvo do ingest RTSP de UMA câmera (unit test em shed.test.js).
 * Insumos: audiência (viewers/focused), análise (analyzed + effFps = cadência efetiva do
 * motor p/ esta câmera) e cfgFps (fps configurado no cadastro/env). Devolve { mode, fps }:
 *  - "full"  fps=cfg  → espectador humano OU foco OU o piso não fica abaixo do configurado;
 *  - "vigil" fps=piso → sem audiência mas analisada: piso = max(2×effFps, floorMin) — a
 *    margem 2× cobre o último-vence + gate (nunca-cego; degradação medida quando 1:1);
 *  - "idle"  fps=0    → sem audiência e sem análise (ffmpeg pode dormir — semântica antiga).
 * Insumo inválido cai no lado SEGURO: cfg desconhecido → default 10; cadência desconhecida → 1.
 */
function decideRtspFps({ viewers, focused, analyzed, effFps, cfgFps, floorMin = VIGIL_MIN_FPS }) {
  const cfg = Number.isFinite(cfgFps) && cfgFps > 0 ? cfgFps : 10;
  if (viewers > 0 || focused) return { mode: "full", fps: cfg };
  if (!analyzed) return { mode: "idle", fps: 0 };
  const cad = Number.isFinite(effFps) && effFps > 0 ? effFps : 1;
  const floor = Math.max(floorMin, Math.round(2 * cad * 100) / 100);
  if (floor >= cfg) return { mode: "full", fps: cfg }; // reduzir não ganharia nada
  return { mode: "vigil", fps: floor };
}

/**
 * Cria o controlador de shed. Injeção de dependências (sem estado global de módulo):
 *  - io: servidor socket.io (para inspecionar rooms e emitir `capture` às webcams)
 *  - cameras: Map id -> { id, label, kind? } (fonte da verdade de câmeras conectadas)
 *  - socketById: Map id -> socket da câmera (para enviar `capture` direcionado)
 *  - rtsp: módulo de ingestão RTSP (idleSource/wakeSource/vigilSource/captureFps, idempotentes)
 *  - analysisViewer?: predicado (id) => boolean — "o motor analisa esta câmera?"
 *  - effectiveFps?: (id) => number — cadência EFETIVA da análise p/ a câmera (getter do
 *    engine quando existir; index.js injeta fallback por env). Ausente → assume 1fps.
 *  - isFocused?: (id) => boolean — câmera FOCADA (tela cheia) sobe/permanece em fps cheio
 *    mesmo que a contagem de rooms falhe. Ausente → false (foco implica viewer na prática).
 */
function createShed({ io, cameras, socketById, rtsp, analysisViewer, effectiveFps, isFocused }) {
  const effFpsOf = typeof effectiveFps === "function" ? effectiveFps : () => 1;
  const focusedOf = typeof isFocused === "function" ? isFocused : () => false;
  const cfgFpsOf = (id) => (typeof rtsp.captureFps === "function" ? rtsp.captureFps(id) : null);
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
    const analyzed = !!(analysisViewer && analysisViewer(cam.id));
    if (cam.kind === "rtsp") {
      // Decisão pura (viewers=0: shedCamera só roda além do debounce sem audiência).
      // ADR-009 revisado (perf-round3 frente 1): câmera analisada NUNCA vai a idle —
      // desce no máximo à VIGÍLIA (piso ≥ 2× a cadência da análise; nunca-cego).
      const d = decideRtspFps({
        viewers: 0,
        focused: focusedOf(cam.id),
        analyzed,
        effFps: analyzed ? effFpsOf(cam.id) : 0,
        cfgFps: cfgFpsOf(cam.id),
      });
      if (d.mode === "idle") rtsp.idleSource(cam.id); // idempotente: no-op se já idle/parada
      else if (d.mode === "vigil" && typeof rtsp.vigilSource === "function")
        rtsp.vigilSource(cam.id, d.fps); // idempotente por fps: re-spawna só se o piso mudou
      // "full": focada ou piso ≥ cfg — não desce.
      return;
    }
    // ADR-009 — webcam analisada NUNCA é derrubada p/ SHED_WEBCAM_FPS: o motor consome o
    // relé dela na cadência normal e SHED_WEBCAM_FPS pode ficar abaixo do piso 2×cadência.
    // (Modo vigília é só RTSP nesta onda — o custo medido mora no ffmpeg.)
    if (analyzed) return;
    if (shedWebcams.has(cam.id)) return;
    const target = socketById.get(cam.id);
    if (!target) return;
    shedWebcams.add(cam.id);
    target.emit("capture", { fps: SHED_WEBCAM_FPS });
    console.log(`[shed] ${cam.id} sem espectador — webcam rebaixada p/ ${SHED_WEBCAM_FPS}fps`);
  }

  function restoreCamera(cam) {
    if (cam.kind === "rtsp") {
      rtsp.wakeSource(cam.id); // idempotente: religa de idle OU de vigília (fps cheio)
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
      // Foco conta como audiência (câmera em tela cheia): sobe/permanece em fps cheio na
      // hora, mesmo que a contagem de rooms atrase — subir é imediato, descer tem debounce.
      if (viewersOf(cam.id) > 0 || focusedOf(cam.id)) {
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

module.exports = { createShed, decideRtspFps };
