// ─────────────────────────────────────────────────────────────────────────────
// engine.js — ORQUESTRADOR do motor de análise no hub (ADR-009). Arquitetura,
// contratos, modelo N/S/M e dimensionamento: README.md deste diretório.
//
// O que mora AQUI (e só aqui): ciclo de vida (init/stop/timers), amostragem por
// câmera (último-vence + cadência FOCO > LINHA > normal em slots absolutos com
// fase áurea por câmera — anti-serrote, frente2), gate de movimento
// (decode do thumbnail + decisão do motion.js), válvula do autoscale e o
// TRANSPORTE dos contratos socket (`analysis-status`, `analysis-tracks`). As
// demais responsabilidades têm módulo próprio:
//   • precision.js  — PAINEL de knobs de qualidade (dono único; sensores lá).
//   • pipeline.js   — dets → exclusão/automask → track → contagem → ingest → overlay.
//   • telemetry.js  — payload do GET /api/analysis/status.
//   • focus.js      — registro de foco por socket (união entre dashboards).
//   • model.js / worker-host.js / autoscale.js / motion.js / automask.js /
//     go2rtc-source.js — catálogo, pool, tier, gate, máscara aprendida, pull.
//
// LGPD/ADR-002: frames EFÊMEROS em memória (hub→worker via IPC); persiste-se SÓ
// indicador/metadado. Nenhum caminho (nem de erro) grava imagem.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");
const os = require("node:os");
const sharp = require("sharp"); // decode do THUMBNAIL de luma p/ o gate de movimento (shrink-on-load)

const camcfg = require("../camcfg");
const motion = require("./motion");
const zones = require("./zones"); // polygonOf/rasterizePolygonMask — o gate de movimento honra `points`
const pgstore = require("../pgstore");
const go2rtc = require("../go2rtc");
const alarmPipeline = require("../alarm/pipeline"); // alarme server-side (presença em zona proibida)
const { PRECISION, trackTtlMs } = require("./precision");
const { createByteTracker } = require("./bytetrack");
const { createCounter } = require("./counting");
const { createInflightSlots } = require("./inflight");
const model = require("./model");
const autoscale = require("./autoscale");
const telemetry = require("./telemetry");
const { createPipeline } = require("./pipeline");
const { pickRoundMs, focusUnion, createFocusRegistry } = require("./focus");
const { createWorkerPool, resolveWorkerCount, dispatchReady } = require("./worker-host");
const { createGo2rtcSource } = require("./go2rtc-source");
const { createAutoMask, AUTOMASK_ON, AUTOMASK_MODE } = require("./automask");

// ── Cadência/custo (qualidade mora em precision.js — fronteira documentada lá) ──
const FPS = Math.min(4, Math.max(0.2, Number(process.env.ANALYSIS_FPS) || 1));
const ROUND_MS = Math.round(1000 / FPS);
// Câmera COM tripwire: a contagem quebra por recall×cadência (acuracia-modelos.md §3)
// — a 0,5-1fps um caminhante cruza em 2-3 rodadas, insuficiente p/ nascimento+histerese;
// a ≥2fps o ByteTrack tem rodadas de sobra. SÓ quem tem linha paga o custo.
const FPS_LINE = Math.min(4, Math.max(FPS, Number(process.env.ANALYSIS_FPS_LINE) || 2));
const ROUND_MS_LINE = Math.round(1000 / FPS_LINE);
// Câmera FOCADA (aberta em tela cheia — contrato `analysis-focus`, união entre
// dashboards): mais cadência p/ quem está sendo OLHADO. Precedência FOCO > LINHA.
// Clamp piso = FPS (nunca abaixo do normal); teto 8fps p/ não afogar o pool.
const FPS_FOCUS = Math.min(8, Math.max(FPS, Number(process.env.ANALYSIS_FPS_FOCUS) || 6));
const ROUND_MS_FOCUS = Math.round(1000 / FPS_FOCUS);
const ROUNDS = { normal: ROUND_MS, line: ROUND_MS_LINE, focus: ROUND_MS_FOCUS };
const AGG_MS = Math.max(1000, Number(process.env.ANALYSIS_AGG_MS ?? 3000)); // janela do ingest "ativ"
const PRUNE_MS = 5 * 60_000; // câmera sem frame há tanto tempo sai do estado/status
// Resolução do tick baseada na cadência MAIS RÁPIDA (foco > linha) p/ o dispatch honrar o boost.
const TICK_MS = Math.min(
  250,
  Math.max(50, Math.round(Math.min(ROUND_MS, ROUND_MS_LINE, ROUND_MS_FOCUS) / 4)),
);

// ── Knobs de QUALIDADE — painel de precisão (racional+sensor de cada um: precision.js) ──
const HIGH_SCORE = PRECISION.detector.highScore; // nascimento/1ª passada; worker devolve ≥ scoreMin (2ª passada sustenta)
const LR_TILES = PRECISION.detector.tiles; // grid do perfil longRange (pedido ao worker leva `tiles`)
const INPUT = PRECISION.detector.input; // input global (squash) — base p/ decidir o override de foco
const FOCUS_INPUT = PRECISION.detector.focusInput; // input (menor) da câmera FOCADA — overlay fresco (07-*)
const MOTION_GATE_ON = motion.GATE_ON;
const MOTION_W = motion.THUMB_W;
const MOTION_H = motion.THUMB_H;
// TTL DERIVADO (nunca-cego): sobrevive à rodada perdida E ao piso de probe do gate.
const TTL_MS = trackTtlMs({ roundMs: ROUND_MS, gateOn: MOTION_GATE_ON });

// ── Auto-dimensionamento do modelo (autoscale.js) ────────────────────────────
// `ANALYSIS_MODEL` (n|s|m) é PIN opcional (escape hatch p/ ops): setado, FIXA o tier
// e DESLIGA o autoscale; ausente = AUTO (pick de startup + válvula de runtime). O
// override de path (ANALYSIS_MODEL_PATH — eval/) também desliga (tier fora do catálogo).
const MODEL_PIN = (process.env.ANALYSIS_MODEL || "").toLowerCase();
const PIN_TIER = autoscale.TIERS.includes(MODEL_PIN) ? MODEL_PIN : null;
const AUTOSCALE_OFF = !!PIN_TIER || !!process.env.ANALYSIS_MODEL_PATH;

let autoTier = null; // tier ATIVO real (o engine é a autoridade; model.getActiveTier() confirma)
let autoState = null; // estado de histerese do reducer puro (autoscale.decideRuntime)
let switchingTier = false; // trava reentrância enquanto uma troca (download+respawn) está em curso

let ctx = null; // { io, cameras } injetado pelo index.js
let enabled = false;
let stopping = false;
let poolSize = 1; // nº de workers do pool (resolvido no init — env ANALYSIS_WORKERS / cores / câmeras)

let seq = 0;
/** cameraId → estado por câmera (tracker/counter/zonas/fila/métricas) */
const states = new Map();
const timers = [];

// Foco do operador (focus.js — contrato socket `analysis-focus`). GUARDA: muitos
// dashboards focando câmeras distintas saturam o pool — a entrega cai graciosamente
// (dispatchReady coalesce por câmera; nenhum throttle inventado).
const focus = createFocusRegistry();

// ── Pipeline por rodada (pipeline.js) + módulos fiados com as deps do engine ──
function cameraLabelOf(cameraId) {
  const cam = ctx && ctx.cameras.get(cameraId);
  return cam ? cam.label : cameraId;
}
const pipeline = createPipeline({
  highScore: HIGH_SCORE,
  ingest: (kind, sub, payload) => pgstore.ingest(kind, sub, payload),
  // Transporte do `analysis-tracks` (payload montado no pipeline). volatile =
  // último-vence: overlay atrasado não acumula backlog em socket lento.
  hasViewers: () => !!(ctx && ctx.io.sockets.adapter.rooms.get("dashboards")?.size),
  emitTracks: (payload) => ctx.io.to("dashboards").volatile.emit("analysis-tracks", payload),
  cameraLabelOf,
  // PRODUTOR server-side de alarme (presença em zona proibida — presence-alert.js
  // via pipeline): handleAlert DIRETO no hub cobre a câmera 24/7 sem dashboard
  // aberto (CA-4 da spec de atividade). O caminho a jusante (dedup/flap/flood/
  // shelve/canais/alarm-event) é o MESMO do socket "alert" — agnóstico, intocado.
  raiseAlarm: (p) => {
    if (ctx) alarmPipeline.handleAlert(p, { cameras: ctx.cameras, io: ctx.io });
  },
});
// worker-host (POOL): roteia por MENOR-CARGA e respawna POR-WORKER (nunca-cego
// enquanto ≥1 vive). O path do modelo é lido no spawn (pode mudar por fallback/tier).
const workerHost = createWorkerPool({
  states,
  getModelPath: model.getModelPath,
  onDets: pipeline.processRound,
  isStopping: () => stopping,
  getSize: () => poolSize,
});
// go2rtc-source: pull de frame.jpeg p/ câmera sem relé (mesmo st.latest/tick/pipeline).
const go2rtcSource = createGo2rtcSource({
  go2rtc,
  states,
  createState,
  running: () => enabled && !stopping,
  roundMs: ROUND_MS,
});

// ── Estado por câmera ────────────────────────────────────────────────────────
function ativZonesOf(cameraId) {
  return camcfg.getZones(cameraId).filter((z) => z.modo === "atividade");
}

// Zonas de EXCLUSÃO: pessoa cujo PÉ cai aqui é descartada antes de tracking/
// contagem/ingest (mata FP de objeto fixo — acuracia-modelos.md Medida A).
// Contrato compartilhado com o front: modo "exclusao" no camcfg.
function exclZonesOf(cameraId) {
  return camcfg.getZones(cameraId).filter((z) => z.modo === "exclusao");
}

// Zonas PROIBIDAS: presença vigiada 24/7 no hub (presence-alert.js — dwell →
// alarme server-side). Contrato pinado com a frente de camcfg: modo "proibida"
// + presencaAlertMs/arming aditivos — leitura read-only via getZones.
function proibZonesOf(cameraId) {
  return camcfg.getZones(cameraId).filter((z) => z.modo === "proibida");
}

// Máscara de HOTSPOT do gate de movimento: reaproveita as MESMAS zonas de exclusão
// como mapa de ignore do thumbnail (relógio/galho/timestamp queimado não disparam o
// gate). Rebuild só quando as zonas mudam; null = sem exclusão (caminho rápido).
//
// POLÍGONO (spec-zona-unificada §5 — o risco nº 1): a zona de exclusão POLIGONAL é
// RASTERIZADA na grade do thumbnail (MOTION_W×MOTION_H). Antes, esta função mapeava a zona
// para {x,y,w,h} e DESCARTAVA `points` em silêncio: uma exclusão em "L" virava o RETÂNGULO
// ENVOLVENTE e o gate passava a ignorar TAMBÉM o vão do L — área onde há gente de verdade.
// A direção da falha é a perigosa: movimento no vão não conta ⇒ ratio abaixo do limiar ⇒
// o motor NÃO ACORDA (só o piso de probe salvaria, segundos depois). Mesma classe do bug do
// `stations`: consumidor descartando um campo calado. Zona sem `points` segue no retângulo
// conservador de motion.buildIgnoreMask (CA-5, caminho intocado).
// CUSTO (medido 2026-07-13, 500 iterações após warm-up, grade 64×48 = 3072 células): rasteriza só
// no REBUILD (mudança de config de zona / createState), NUNCA por frame — 0,31 ms por zona de 4
// vértices, 0,44 ms no L côncavo, 0,76 ms no teto de 20. Referência: um decodeThumb do gate custa
// 8,28 ms de CPU e roda A CADA FRAME. Ou seja: o rebuild mais caro que existe custa MENOS que um
// décimo de um único frame do gate, e acontece quando o operador salva uma zona. O medo de perf é
// fantasma (spec §4). O assert de regressão (engine.test.js) usa teto FOLGADO de 10 ms: ele existe
// p/ pegar ordem de grandeza (alguém rasterizando por FRAME), não p/ cronometrar a máquina do CI.
function buildMotionIgnore(zonesExcl) {
  if (!MOTION_GATE_ON || !zonesExcl || !zonesExcl.length) return null;
  const rects = [];
  const polys = [];
  for (const z of zonesExcl) {
    if (!z) continue;
    const pts = zones.polygonOf(z);
    if (pts) polys.push(pts);
    else rects.push({ x: z.x, y: z.y, w: z.w, h: z.h });
  }
  const base = motion.buildIgnoreMask(MOTION_W, MOTION_H, rects); // null quando não há retângulo
  if (!polys.length) return base;
  const m = base || new Uint8Array(MOTION_W * MOTION_H);
  let any = !!base;
  for (const pts of polys) {
    const { bits } = zones.rasterizePolygonMask(MOTION_W, MOTION_H, pts); // mesma indexação (r*cols+c)
    for (let i = 0; i < m.length; i++)
      if (bits[i]) {
        m[i] = 1;
        any = true;
      }
  }
  return any ? m : null; // nada marcado (polígono menor que uma célula) → caminho rápido, como o rect vazio
}

// Perfil "Longo alcance/Panorâmica" (CameraCfg.longRange — src/cameraConfig.ts).
// Leitura DEFENSIVA (=== true): config ausente/legada sem o campo → false (squash).
function longRangeOf(cameraId) {
  const cfg = camcfg.getCamConfig(cameraId);
  return !!(cfg && cfg.longRange === true);
}

// Câmera modo "fadiga" roda no CLIENTE (MediaPipe do operador) — o hub NÃO detecta
// pessoa nela: (a) economiza worker, (b) tira do relatório o ruído de "pessoa"
// contada sobre o rosto em close. Leitura defensiva: sem config → "atividade".
function modoOf(cameraId) {
  const cfg = camcfg.getCamConfig(cameraId);
  return (cfg && cfg.modo) || "atividade";
}
function isFadiga(cameraId) {
  return modoOf(cameraId) === "fadiga";
}

// cadência efetiva → fps efetivo (reflete o boost de foco no targetFps do status/autoscale).
function targetFpsOf(st) {
  if (st.fadiga) return 0;
  if (st.roundMs === ROUND_MS_FOCUS) return FPS_FOCUS;
  if (st.roundMs === ROUND_MS_LINE) return FPS_LINE;
  return FPS;
}

// Máx. de inferências EM VOO por câmera. Só a FOCADA paraleliza (mais cadência = marcador acompanha
// giro/entrada, SEM trocar de modelo → recall intacto); as demais seguem serial (1). Teto = poolSize
// (nunca mais que os workers). Env: ANALYSIS_FOCUS_INFLIGHT manda quando setado.
//
// DEFAULT com PISO 2 (spec-overlay-tempo-real CA-3): o default original `poolSize-1` ("deixa ≥1
// worker p/ as outras") ZERAVA o recurso no host pequeno — pool=2 (4-core, o homolog) dava
// maxInflight=1 e o paralelismo da spec 09 ficava INERTE justamente onde o overlay mais atrasa.
// Com pool=2 a focada agora pode ocupar os 2 workers; as não-focadas degradam graciosamente
// (último-vence — atrasam, nunca acumulam). Custo declarado; com pool≥3 volta a sobrar worker.
// PURA (poolSize/env por parâmetro) — contrato de teste em engine.test.js.
function focusInflightFor(pool, envRaw) {
  const env = Number(envRaw);
  const k = Number.isFinite(env) && env > 0 ? env : Math.max(pool - 1, Math.min(2, pool));
  return Math.max(1, Math.min(pool, Math.round(k)));
}
function focusInflight() {
  return focusInflightFor(poolSize, process.env.ANALYSIS_FOCUS_INFLIGHT);
}
function maxInflightFor(focused) {
  return focused ? focusInflight() : 1;
}

// (Re)aplica a cadência efetiva ao estado de UMA câmera (foco > linha > normal) + o limite de paralelismo.
function applyRoundMs(st) {
  const focused = focus.has(st.id);
  st.roundMs = pickRoundMs({ focused, hasLine: camcfg.getTripwires(st.id).length > 0 }, ROUNDS);
  st.maxInflight = maxInflightFor(focused); // foco paraleliza; resto serial
}

// Reajusta a cadência SÓ das câmeras que entraram/saíram do foco. Câmera focada sem
// estado ainda (sem frame) não faz nada — createState lê focus.has(id) ao materializar.
function applyFocusChanges(changed) {
  for (const id of changed) {
    const st = states.get(id);
    if (st) applyRoundMs(st);
  }
}

// Índice de CRIAÇÃO da câmera → fase áurea do stagger anti-serrote (worker-host.
// staggerPhaseMs). Map por id (e não contador no estado): câmera podada (prune)
// que volta reusa o MESMO índice — fase estável durante a vida do processo.
const staggerOrder = new Map();
function staggerIndexOf(id) {
  if (!staggerOrder.has(id)) staggerOrder.set(id, staggerOrder.size);
  return staggerOrder.get(id);
}

// Opções do ByteTracker derivadas do PAINEL (precision.js) — função PURA p/ o teste de fiação
// (engine.test.js) provar que TODOS os knobs do painel chegam ao tracker. Fecha o ⚠ WIRING dos
// knobs 23-26 (estado estacionário): antes o motor herdava os DEFAULTS internos do bytetrack.js
// (paridade por VALOR); agora o precision.js é quem manda (mudar lá MUDA produção).
function byteTrackerOpts() {
  const t = PRECISION.tracker;
  return {
    highScore: HIGH_SCORE,
    iouThreshold: t.iouThreshold,
    birthIouThreshold: t.birthIouThreshold,
    birthContainment: t.birthContainment, // knob 8b — duplicata PARCIAL não nasce 2º track
    ttlMs: TTL_MS,
    // Anti-rastro/salto (precision.js knobs 20-22): re-associação 2º estágio +
    // política LOST (track sem match some da emissão mas vive interno até o TTL).
    reassocDist: t.reassocDist,
    reassocMaxGapMs: t.reassocMaxGapMs,
    lostAfterMisses: t.lostAfterMisses,
    refuteMaxDist: t.refuteMaxDist, // knob 22b — teto da refutação LOCAL por realocação
    // Estado ESTACIONÁRIO (knobs 23-26 — spec-tracking-pessoa-parada §2 C2): pessoa parada é
    // ESTADO, não morte — isenta do TTL de relógio, morre por EVIDÊNCIA. Sensor: eval/stationary.mjs.
    stationaryTolerance: t.stationaryTolerance,
    stationaryEnterRounds: t.stationaryEnterRounds,
    stationaryMaxMisses: t.stationaryMaxMisses,
    stationaryMaxMs: t.stationaryMaxMs,
  };
}

function createState(id) {
  const now = Date.now();
  const st = {
    id,
    latest: null, // { buf, ts } — último frame recebido (último-vence)
    slots: createInflightSlots(), // inferências em voo desta câmera (contador + órfã + ordem — inflight.js)
    maxInflight: maxInflightFor(focus.has(id)), // foco paraleliza; resto serial (recalc em applyRoundMs)
    // Stagger anti-serrote (perf-round3/frente2-serrote-stagger.md): fase áurea por
    // índice de criação + nascer com lastSentAt=AGORA (não 0) → o 1º despacho cai no
    // PRÓXIMO slot do grid próprio da câmera (dispatchReady, slot absoluto), não no
    // mesmo tick de todas que materializaram juntas (o burst de nascimento era a
    // semente do alinhamento). Custo declarado: a 1ª inferência espera ≤1 roundMs.
    staggerIndex: staggerIndexOf(id),
    lastSentAt: now,
    lastFrameAt: now,
    lastRelayAt: 0, // último frame vindo do RELÉ (só onFrame) — base da decisão de pull
    source: "relay", // origem do último frame: "relay" | "go2rtc"
    errors: 0,
    tracker: createByteTracker(byteTrackerOpts()), // TODOS os knobs do painel (incl. 23-26)
    counter: createCounter(camcfg.getTripwires(id), {
      minMove: PRECISION.counter.minMove,
      ttl: TTL_MS,
      maxDist: PRECISION.counter.maxDist, // gate de teleporte
      debounceMs: PRECISION.counter.debounceMs,
      minCrossingFrames: PRECISION.counter.minCrossingFrames, // histerese: lado novo sustentado
    }),
    zonesAtiv: ativZonesOf(id),
    zonesExcl: exclZonesOf(id), // pessoas com o pé aqui são descartadas antes do tracking
    zonesProib: proibZonesOf(id), // modo "proibida" — presença vigiada (presence-alert.js)
    presence: new Map(), // máquina ARMADA/VIOLADA por zona proibida (presence-alert.js muta)
    occupancy: new Map(), // máquina OK/VIOLADA por zona de lotação (occupancy-alert.js muta)
    // ── Gate de movimento ──
    prevLuma: null, // thumbnail de luma anterior (MOTION_W×MOTION_H); null = sem baseline ainda
    motionIgnore: null, // mapa de ignore (hotspots das zonas de exclusão) — montado após states.set
    motionRatio: 0, // último ratio de movimento medido (diagnóstico/status)
    lastInferAt: 0, // última rodada REALMENTE despachada ao worker (base do piso de PROBE)
    gating: false, // decode de thumbnail em voo → o tick não reentra nesta câmera
    skipped: 0, // total de inferências PULADAS pelo gate (prova do ganho no status)
    gateLog: [], // janela rolante 60s de TODA rodada gateada (sensor do gate — recordGateRound)
    longRange: longRangeOf(id), // true → pedido ao worker leva tiles (LR_TILES)
    fadiga: isFadiga(id), // câmera modo=fadiga NÃO é analisada no hub (roda no cliente)
    lastTracks: null, // último payload de analysis-tracks emitido — re-emissão coasting no skip (C1)
    // Cadência efetiva: se o operador já focou esta câmera antes do 1º frame, ela
    // nasce a FPS_FOCUS; senão com linha @FPS_LINE; senão @FPS (último-vence).
    roundMs: pickRoundMs(
      { focused: focus.has(id), hasLine: camcfg.getTripwires(id).length > 0 },
      ROUNDS,
    ),
    autoMask: AUTOMASK_ON ? createAutoMask() : null, // hotspots fixos aprendidos (automask.js)
    window: { frames: 0, zones: new Map() }, // acumulação p/ o ingest "ativ" (~AGG_MS)
    rounds: [], // timestamps das rodadas (p/ fps real no status)
    ageLog: [], // { t, a } idade captura→despacho por rodada (janela 60s — recordFrameAge)
    detsLog: [], // { t, n, x, a, r } pessoas/exclusões/re-associações por rodada (p/ *1m)
    reassocSeen: 0, // acumulado de re-associações já lançado no detsLog (delta por rodada — pipeline)
    lastMs: 0,
  };
  st.motionIgnore = buildMotionIgnore(st.zonesExcl); // hotspots do gate (reuso das zonas de exclusão)
  states.set(id, st);
  // Fadiga: o hub não cobre PESSOA nessa câmera → anuncia engine:null (front mantém o
  // modo especializado local, não liga o ingest de pessoa). Demais: engine:"hub".
  emitAnalysisStatus(id, st.fadiga ? null : "hub");
  return st;
}

function emitAnalysisStatus(cameraId, engine) {
  if (ctx) ctx.io.to("dashboards").emit("analysis-status", { cameraId, engine });
}

// ── Amostragem: tick escolhe o último frame por câmera, GATA por movimento e despacha ─
function tick() {
  if (!workerHost.ready()) return;
  const now = Date.now();
  for (const st of states.values()) {
    if (st.gating) continue; // decode de thumbnail em voo → não reentra (evita despacho duplo)
    // Guarda de despacho PURA (worker-host.dispatchReady): fadiga, coalescência (≤1 job
    // em voo por câmera), último-vence e cadência por SLOT ABSOLUTO com fase áurea por
    // câmera (anti-serrote — frente2). Único choke point — pega relé E pull go2rtc.
    // O roteamento ao worker de menor carga é do pool.send.
    if (!dispatchReady(st, now, ROUND_MS)) continue;
    // Gate de movimento: decodifica um thumbnail barato e PULA a inferência em cena
    // estática. Async (não bloqueia o tick); st.gating serializa por câmera.
    // .catch defensivo: o finally já reabre o gate; aqui só evitamos unhandled rejection.
    gateAndDispatch(st, now).catch((e) => {
      st.gating = false;
      if (st.errors < 3) console.warn(`[analysis:${st.id}] gate de movimento falhou: ${e.message}`);
    });
  }
}

// Thumbnail de luma single-channel (0..255, length MOTION_W*MOTION_H) a partir do JPEG.
// sharp faz shrink-on-load (decodifica já em escala reduzida via DCT). CUSTO MEDIDO:
// 8,28ms de CPU por decode (26ms wall sob contenção) — NÃO é sub-ms como se assumia
// (docs/analises/perf-round3/frente3-hub-hotloops.md §4d). Trade-off que se paga: ~8ms p/
// economizar uma inferência de centenas de ms (1 pulo do gate a cada ~50 decodes já
// paga); roda no pool de threads do libvips, sem bloquear o event loop. Barateá-lo
// (shrink mais agressivo/kernel nearest) só vale investigar com ≥8 câmeras.
// `greyscale` + 1º canal: robusto ao nº de canais que o raw devolver.
async function decodeThumb(jpeg) {
  const { data, info } = await sharp(jpeg)
    .resize(MOTION_W, MOTION_H, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = MOTION_W * MOTION_H;
  const ch = info.channels || 1;
  if (ch === 1 && data.length === n) return data; // já single-channel
  const out = new Uint8Array(n); // greyscale → R=G=B; pega o 1º canal de cada pixel
  for (let i = 0; i < n; i++) out[i] = data[i * ch];
  return out;
}

// Despacho efetivo ao worker. Marca busy/inflight e registra lastInferAt (base do piso
// de PROBE). Cópia no envio: o buf do relé pode ser view de um buffer maior (RTSP) —
// a cópia sai 1×/rodada e serializa enxuto no IPC. Câmera longRange leva `tiles`.
function dispatchToWorker(st, frame, now) {
  const jobId = ++seq;
  st.slots.begin(jobId); // ocupa um slot de inferência em voo (inflight.js: contador + órfã + ordem)
  st.lastInferAt = now;
  recordFrameAge(st, now, frame.ts);
  try {
    workerHost.send({
      type: "detect",
      id: jobId,
      cameraId: st.id,
      jpeg: Buffer.from(frame.buf),
      // ts da CAPTURA — o worker ECHOA de volta → base do latencyMs (07-*) E da guarda de ordem quando
      // a focada tem várias inferências em voo (resposta de frame mais velho não regride o tracker).
      ts: frame.ts,
      ...(st.longRange ? { tiles: LR_TILES } : {}),
      // Câmera FOCADA com input de foco configurado (< global) → inferência mais rápida = overlay mais
      // fresco (07-*). Só manda o campo quando difere do global — o caminho default fica idêntico.
      ...(st.roundMs === ROUND_MS_FOCUS && FOCUS_INPUT !== INPUT ? { input: FOCUS_INPUT } : {}),
    });
  } catch {
    st.slots.abort(jobId); // send falhou (canal fechado) → libera o slot p/ re-despacho
  }
}

// ── SENSOR DE IDADE DO QUADRO (transporte, isolado do custo da inferência) ───
// A LACUNA QUE ISTO FECHA: `latencyMs` (captura→resposta) já era CALCULADO no worker-host e
// enviado ao cliente no analysis-tracks, mas só para o interpolador extrapolar a caixa — ele
// nunca era RETIDO nem agregado, então ninguém conseguia responder "o quadro está chegando em
// dia?" sem abrir o navegador. E `lastMs` no /status é a duração da INFERÊNCIA, outro número.
//
// Aqui a idade é medida no DESPACHO (captura→despacho), de propósito: isso é o transporte PURO
// (câmera → ffmpeg/go2rtc → hub → amostragem), sem somar os ~64ms da própria inferência. Junto
// com `lastMs`, dá a decomposição — e é a decomposição que separa "o modelo está ruim" de "a
// rede está ruim".
//
// POR QUE IMPORTA (medido no repo irmão `mvp_maos`, inspecao_biscoito/fonte.py, e reproduzido
// aqui por `scripts/diagnose-source.mjs`): quando a fonte entrega mais rápido do que o consumidor
// processa, a fila cresce e o atraso CRESCE SEM LIMITE — +5,3 s em 12 s lá, +4,1 s em 10 s na
// reprodução daqui. O último-vence de `st.latest` protege contra isso, mas nada PROVAVA que a
// proteção estava funcionando em campo. Agora prova: idade que sobe ao longo do tempo é fila.
const AGE_WINDOW_MS = 60_000;

/** Registra a idade do quadro no despacho, em janela rolante de 60s (podada no push — o log
 *  não pode crescer sem teto em deploy que nunca consulta o /status). */
function recordFrameAge(st, now, frameTs) {
  if (!Array.isArray(st.ageLog)) st.ageLog = []; // leitura defensiva: estado antigo/parcial
  st.ageLog.push({ t: now, a: Math.max(0, now - (frameTs || now)) });
  const cutoff = now - AGE_WINDOW_MS;
  while (st.ageLog.length && st.ageLog[0].t < cutoff) st.ageLog.shift();
}

// ── SENSOR DO GATE (o pulo é medido, não presumido) ──────────────────────────
// A LACUNA QUE ISTO FECHA: até aqui o gate só tinha sensor de CUSTO (`skipped1m` —
// quanto se economizou). Quanto ele CEGA não tinha número nenhum: uma pessoa DISTANTE
// andando move poucas células das 3072 do thumbnail 64×48 e pode ficar ABAIXO de
// PRECISION.gate.motionRatio (0,005 ≈ 16 células) — a rodada é pulada e a câmera só
// volta a olhar no piso de probe. O README do diretório admitia a lacuna ("o gate NÃO
// tem sensor direto de recall do pulo"). Este log é a medição: TODA rodada gateada
// entra, pulada ou não, com o que permite responder "o gate está me cegando?".
//   { t, ratio, infer, reason, moving }
//   • ratio  — motionRatio MEDIDO; 0 quando NÃO houve medição (decode falhou, gate
//              desligado) — o `reason` diz qual dos dois (telemetry.js exclui esses
//              zeros do percentil: zero não medido enviesaria PARA BAIXO exatamente o
//              número que se usaria p/ mexer no limiar).
//   • infer/reason — rodou? e POR QUÊ (baseline|motion|probe|skip|decode-error|gate-off).
//   • moving — quanta GENTE se movendo havia NO INSTANTE da decisão (movingOf).
// Sem knob novo: MEDIR VEM ANTES DE MEXER (nenhum limiar mudou nesta frente).
const GATE_LOG_MS = 60_000;

/**
 * Tracks VIVOS e NÃO ESTACIONÁRIOS agora — "gente se movendo em quadro" no instante
 * da decisão do gate. É o denominador da pergunta do dono: pulo com `moving ≥ 1` é
 * cegueira MEDIDA (o motor deixou de olhar uma cena com gente andando).
 *
 * CT-4 (contrato com a frente do tracker): `stats()` devolve `alive` além de
 * `{reassociations, lost, stationary}`. LEITURA DEFENSIVA e DEGRADAÇÃO DECLARADA —
 * nunca lança, e cada degrau diz o que passa a medir:
 *   1. `alive - stationary` — o número certo (inclui LOST oculto: pessoa oclusa segue pessoa).
 *   2. `tracks().length - stationary` — MESMA semântica pelo snapshot interno (tracks()
 *      é API do bytetrack.js): exato, não degradado.
 *   3. `lost` — LIMITE INFERIOR (só os ocultos; sub-reporta cegueira).
 *   4. 0 — tracker estranho/sem sensor: "não observado". Sub-reporta.
 * SEMÂNTICA DO `alive` (o ponto onde os degraus poderiam divergir em silêncio): o
 * bytetrack.js publica `alive = tracks.length` — tracks VIVOS internos, LOST incluído.
 * É o que este sensor quer: quem sumiu do overlay por oclusão NÃO virou ausência, e
 * pular a rodada dela é o pior caso da cegueira. Se um dia `alive` passar a significar
 * "emitíveis", o número CAI sem que este arquivo mude — mudança de SEMÂNTICA, e o teste
 * "pessoa OCLUSA ainda conta" (engine.test.js, contra o tracker REAL) é quem avisa.
 * PURA (recebe o tracker) — contrato de teste em engine.test.js.
 */
function movingOf(tracker) {
  if (!tracker || typeof tracker.stats !== "function") return 0;
  let s;
  try {
    s = tracker.stats();
  } catch {
    return 0; // tracker que LANÇA não pode derrubar a rodada do gate
  }
  if (!s) return 0;
  const stationary = Number.isFinite(s.stationary) ? s.stationary : 0;
  if (Number.isFinite(s.alive)) return Math.max(0, s.alive - stationary); // CT-4
  if (typeof tracker.tracks === "function") {
    try {
      return Math.max(0, tracker.tracks().length - stationary); // fallback EXATO
    } catch {
      /* segue p/ o degrau seguinte */
    }
  }
  return Number.isFinite(s.lost) ? s.lost : 0; // limite INFERIOR
}

/**
 * Registra UMA rodada gateada no log rolante de 60s (poda no push — o log não cresce
 * sob tráfego; telemetry.js poda de novo ao medir, p/ a câmera parada). `moving` é
 * amostrado AQUI porque é o estado do tracker NO INSTANTE da decisão — medi-lo depois
 * (no /status) mediria outro instante. PURA quanto ao relógio (now injetado).
 */
function recordGateRound(st, now, { ratio, infer, reason }) {
  const log = st.gateLog || (st.gateLog = []);
  log.push({ t: now, ratio: ratio || 0, infer: !!infer, reason, moving: movingOf(st.tracker) });
  const cutoff = now - GATE_LOG_MS;
  while (log.length && log[0].t < cutoff) log.shift();
}

// GATE + despacho de UMA câmera. Consome o frame (último-vence), mede o movimento no
// thumbnail e decide (motion.gateDecision, PURO). NUNCA-CEGO: baseline (1º frame), piso
// de PROBE (cena estática ainda roda; focada com piso menor) e FAIL-OPEN (erro de decode
// → despacha). lastSentAt=now CONSOME o slot corrente do grid da câmera (slot
// absoluto — dispatchReady): pular NÃO acelera a próxima medição nem desloca a fase.
async function gateAndDispatch(st, now) {
  const frame = st.latest;
  if (!frame) return;
  st.latest = null; // consome (um frame mais novo chega depois — último-vence)
  st.lastSentAt = now; // a medição do gate JÁ consome o slot da rodada (cadência/fase preservadas)
  st.gating = true;
  try {
    if (!MOTION_GATE_ON) {
      // ratio=0 EXPLÍCITO: com o gate desligado não há decode, logo não há medição —
      // o `reason` distingue "não medido" de "medido zero" (telemetry não percentila isto).
      recordGateRound(st, now, { ratio: 0, infer: true, reason: "gate-off" });
      dispatchToWorker(st, frame, now); // gate desligado (escape hatch) → comportamento original
      return;
    }
    let ratio = 1;
    let decodeOk = true;
    const hasPrev = !!st.prevLuma;
    try {
      const thumb = await decodeThumb(frame.buf);
      const m = motion.motionRatio(thumb, st.prevLuma, st.motionIgnore);
      ratio = m.ratio;
      st.motionRatio = ratio;
      st.prevLuma = thumb;
    } catch {
      decodeOk = false; // FAIL-OPEN (nunca-cego): não conseguiu medir → NÃO pula, despacha
    }
    const focused = focus.has(st.id);
    const dec = decodeOk
      ? motion.gateDecision({
          ratio,
          sinceMs: now - st.lastInferAt,
          probeMs: focused ? PRECISION.gate.probeFocusMs : PRECISION.gate.probeMs,
          hasPrev,
        })
      : { infer: true, reason: "decode-error" };
    // SENSOR: TODA rodada gateada entra no log — a pulada E a que rodou (sem as que
    // rodaram não há denominador, e sem `ratio` das que rodaram não há como calibrar o
    // limiar com dado). `ratio` só é o medido quando o decode deu certo.
    recordGateRound(st, now, { ratio: decodeOk ? ratio : 0, infer: dec.infer, reason: dec.reason });
    if (!dec.infer) {
      st.skipped += 1; // PULA a inferência — economiza o session.run inteiro
      // C1 (spec-tracking §2): rodada PULADA re-emite o último payload com ts fresco
      // e coasting:true — o interpolador do front não expira a caixa (expireMs 2,6s <
      // probe 6s) com o track VIVO. Cadência = a própria rodada gateada (st.roundMs;
      // o slot já foi consumido acima — de graça no laço); volatile e só com
      // espectador, como a emissão normal (pipeline.emitCoasting).
      //
      // O QUE O COASTING AFIRMA (e o que NÃO afirma): "o motor NÃO OBSERVOU nada de
      // novo nesta rodada" — jamais "nada aconteceu". O gate pula sempre que o ratio
      // medido fica abaixo do limiar, o que INCLUI pessoa pequena/distante em
      // movimento (poucas células mudadas no thumbnail 64×48). Quanto isso acontece
      // deixou de ser opinião: `perCamera[].gate.skipMoving1m` no /api/analysis/status
      // conta exatamente os pulos com gente NÃO estacionária viva em quadro.
      pipeline.emitCoasting(st, now);
      return;
    }
    dispatchToWorker(st, frame, now);
  } finally {
    st.gating = false;
  }
}

function prune() {
  const now = Date.now();
  for (const [id, st] of states) {
    if (now - st.lastFrameAt > PRUNE_MS) {
      states.delete(id);
      go2rtcSource.dropPull(id);
      emitAnalysisStatus(id, null);
    }
  }
  go2rtcSource.prunePulls(now); // entradas de pull órfãs (stream que só falha/sumiu) saem por idade
}

function logMinute() {
  if (!states.size) return;
  const parts = [];
  for (const [id, st] of states) {
    const fps = Math.round((st.rounds.length / 60) * 100) / 100;
    const src = st.source === "go2rtc" ? "[g2r]" : "";
    // Pulos do gate no minuto + quantos deles aconteceram COM gente se movendo em
    // quadro (cegueira medida — mesmo número do gate.skipMoving1m do /status).
    let nSkip = 0;
    let nBlind = 0;
    for (const g of st.gateLog) {
      if (g.infer) continue;
      nSkip += 1;
      if (g.moving > 0) nBlind += 1;
    }
    const skips = MOTION_GATE_ON && nSkip ? ` (${nSkip} pulos/gate${nBlind ? `, ${nBlind} c/ gente em movimento` : ""})` : "";
    parts.push(`${id}${st.longRange ? "[LR]" : ""}${src}: ${fps}fps ${st.lastMs}ms${skips}`);
  }
  const w = workerHost.stats();
  const perW = w.workers.map((x) => `#${x.id}${x.ready ? "" : "!"}:${x.cpuPct}%`).join(" ");
  console.log(
    `[analysis] pool ${w.readyCount}/${w.size} cpu~${w.cpuPct}% (${perW}) · ${parts.join(" · ")}`,
  );
}

// ── Auto-dimensionamento: válvula de runtime (downgrade sob pressão medida) ──
// 1×/janela: agrega cadência ALCANÇADA × ALVO das câmeras analisadas + cpuPct do pool
// → decisão PURA (autoscale.decideRuntime). Troca via model.setActiveTier (ATÔMICO:
// reverte se o download falhar) + workerHost.reload(). SEGURANÇA: em falha, mantém o
// tier vivo (nunca cego). switchingTier trava reentrância durante download/respawn.
async function evaluateAutoscale() {
  if (!enabled || stopping || AUTOSCALE_OFF || switchingTier) return;
  let sumAch = 0;
  let sumTgt = 0;
  let cams = 0;
  for (const st of states.values()) {
    if (st.fadiga) continue; // fadiga roda no cliente — não pesa no worker do hub
    sumAch += st.rounds.length / 60; // fps REAL da janela (rounds guarda 60s)
    sumTgt += targetFpsOf(st); // alvo efetivo da câmera (foco > linha > normal)
    cams += 1;
  }
  const w = workerHost.stats();
  const sample = {
    now: Date.now(),
    tier: autoTier,
    cpuPct: w.cpuPct, // agregado do pool (soma dos N) — decideRuntime escala o teto por workers
    achievedFps: sumAch,
    targetFps: sumTgt,
    cameras: cams,
    cores: os.cpus().length,
    workers: w.size, // capacidade REAL do pool: throughput/orçamento ≈ N × por-worker
  };
  const d = autoscale.decideRuntime(autoState, sample);
  autoState = d.state;
  if (d.action === "hold") return;

  switchingTier = true;
  try {
    const ok = await model.setActiveTier(d.to, true);
    if (ok) {
      autoTier = model.getActiveTier() || d.to;
      autoState.tier = autoTier;
      workerHost.reload(); // respawn imediato com o novo modelo
      console.log(`[analysis] autoscale ${d.action.toUpperCase()} ${d.from}→${autoTier}: ${d.reason}`);
    } else {
      // Troca falhou (download indisponível) → mantém o tier vivo. O lastSwitchAt já
      // entrou em cooldown (não martela download que falha). NUNCA fica sem modelo.
      autoState.tier = autoTier;
      console.warn(`[analysis] autoscale ${d.action} ${d.from}→${d.to} ABORTADO (modelo indisponível) — mantém ${autoTier}`);
    }
  } catch (e) {
    autoState.tier = autoTier;
    console.error(`[analysis] autoscale ${d.action} ${d.from}→${d.to} ERRO: ${e.message} — mantém ${autoTier}`);
  } finally {
    switchingTier = false;
  }
}

// ── API pública (consumida pelo index.js / routes/analysis.js) ───────────────

/** Frame do relé (webcam OU RTSP). Guarda só o MAIS NOVO por câmera (último-vence). */
function onFrame(cameraId, buf, ts) {
  if (!enabled || stopping || !cameraId || !buf) return;
  const id = String(cameraId);
  const st = states.get(id) || createState(id);
  const now = Date.now();
  st.lastFrameAt = now;
  st.lastRelayAt = now; // relé ativo → em modo "relay-less" esta câmera não é puxada do go2rtc
  st.source = "relay";
  st.latest = { buf, ts: ts || now };
}

/** Mudança de camcfg (teed pelo index.js a partir do evento "camcfg-updated"). */
function onCamcfgUpdated(p) {
  if (!enabled || !p || !p.cameraId) return;
  const st = states.get(String(p.cameraId));
  if (!st) return;
  if (p.kind === "tripwires") {
    st.counter.setTripwires(camcfg.getTripwires(st.id)); // preserva contadores por id
    applyRoundMs(st); // ganhou/perdeu linha → recalcula a cadência (foco > linha > normal)
  } else if (p.kind === "zones") {
    st.zonesAtiv = ativZonesOf(st.id);
    st.zonesExcl = exclZonesOf(st.id); // recarrega a máscara de exclusão na próxima rodada
    st.zonesProib = proibZonesOf(st.id); // zonas vigiadas — presence-alert poda estados órfãos por id
    st.motionIgnore = buildMotionIgnore(st.zonesExcl); // e o mapa de hotspot do gate (mesmas zonas)
    st.window = { frames: 0, zones: new Map() }; // janela reinicia com a nova geometria
    st.lastTracks = null; // snapshot de coasting carrega a lista de zonas ANTIGA → invalida
  } else if (p.kind === "camconfig") {
    st.longRange = longRangeOf(st.id); // liga/desliga o tiling na PRÓXIMA rodada
    // Entrou/saiu do modo fadiga → atualiza o contrato anti-duplicação (hub ⇄ cliente).
    const wasFadiga = st.fadiga;
    st.fadiga = isFadiga(st.id);
    if (st.fadiga !== wasFadiga) {
      if (st.fadiga) st.window = { frames: 0, zones: new Map() }; // descarta janela pendente
      emitAnalysisStatus(st.id, st.fadiga ? null : "hub");
    }
  }
}

/** Câmera analisada conta como espectador (shed). Com o motor ON, TODA câmera do relé é analisada. */
function isAnalyzing() {
  return enabled && !stopping;
}

/** Snapshot do contrato anti-duplicação p/ um dashboard que acabou de conectar. */
function snapshotTo(socket) {
  if (!enabled) return;
  // Fadiga: engine:null (o hub não cobre pessoa nela — front mantém o modo especializado local).
  for (const [id, st] of states) socket.emit("analysis-status", { cameraId: id, engine: st.fadiga ? null : "hub" });
}

/** Contrato socket `analysis-focus` (cliente→hub, ADITIVO) — registro em focus.js. */
function setFocus(socketId, cameraId) {
  applyFocusChanges(focus.set(socketId, cameraId));
}

/** Socket desconectou: remove a contribuição dele à união (nunca deixa foco órfão). */
function clearFocus(socketId) {
  applyFocusChanges(focus.clear(socketId));
}

/**
 * Cadência EFETIVA da câmera em fps — FPS_FOCUS > FPS_LINE > FPS normal conforme o
 * estado corrente (fadiga = 0: roda no cliente). Câmera ainda sem estado (nenhum
 * frame materializou) devolve o FPS normal. CONTRATO ADITIVO p/ o ingest dinâmico
 * (frente P2) calcular o piso de captura por câmera.
 */
function effectiveFps(cameraId) {
  const st = states.get(String(cameraId));
  return st ? targetFpsOf(st) : FPS;
}

/** GET /api/analysis/status — montagem em telemetry.js (contrato aditivo). */
function status() {
  return telemetry.buildStatus({
    now: Date.now(),
    states,
    focusedCams: new Set(focus.ids()),
    targetFpsOf,
    enabled,
    modelFile: path.basename(model.getModelPath()),
    fps: { normal: FPS, line: FPS_LINE, focus: FPS_FOCUS },
    motionGate: {
      enabled: MOTION_GATE_ON,
      ratio: PRECISION.gate.motionRatio,
      probeMs: PRECISION.gate.probeMs,
      probeFocusMs: PRECISION.gate.probeFocusMs,
      thumb: `${MOTION_W}x${MOTION_H}`,
    },
    autoscale: {
      mode: AUTOSCALE_OFF ? "pin" : "auto", // "pin"=fixo (ANALYSIS_MODEL/PATH) · "auto"=dimensiona sozinho
      tier: autoTier || model.getActiveTier(), // n|s|m ativo (null sob override de path)
      pin: PIN_TIER || (process.env.ANALYSIS_MODEL_PATH ? "path" : null), // por que está fixo, se estiver
      choked: autoState ? autoState.choked : 0, // janelas afogadas acumuladas (rumo a downgrade)
      idle: autoState ? autoState.idle : 0, // janelas folgadas acumuladas (rumo a upgrade)
      lastSwitchAt: autoState ? autoState.lastSwitchAt : 0, // ts da última troca (cooldown)
    },
    worker: workerHost.stats(),
    go2rtcPull: go2rtcSource.stats(),
  });
}

/**
 * Boot do motor. `{ io, cameras }` vêm do index.js. LIGA/DESLIGA (contrato):
 * ausente ou "1" → LIGADO (baixa o modelo no boot se preciso — sha256 + escrita
 * atômica + fallback S→N; download falhou → motor off, hub segue normal);
 * ANALYSIS_ENABLED=0 → DESLIGADO (único escape hatch — nó sem CPU / só-vídeo).
 */
async function init({ io, cameras }) {
  ctx = { io, cameras };
  const want = process.env.ANALYSIS_ENABLED;
  if (want === "0") {
    console.log("[analysis] motor DESLIGADO (ANALYSIS_ENABLED=0)");
    return;
  }
  // POOL: nº de workers (env ANALYSIS_WORKERS fixa; ausente = min(floor(cores/2),
  // câmeras), piso 1). Resolvido AQUI e lido pelo pool no spawn (getSize). O autoscale
  // usa esse N como capacidade real (throughput ≈ N × por-worker).
  const cores = os.cpus().length;
  const camCount = ctx.cameras ? ctx.cameras.size : 0;
  poolSize = resolveWorkerCount({ cores, cameras: camCount, pin: process.env.ANALYSIS_WORKERS });
  // PICK DE STARTUP (autoscale): ANTES de baixar, escolhe o melhor tier que o hardware
  // sustenta. PIN fixa; AUTO escolhe pelo orçamento. Override de path (eval/) não mexe
  // no catálogo. ensureModel baixa o tier corrente com fallback S/M→N (nunca sem modelo).
  if (PIN_TIER) {
    model.setTier(PIN_TIER);
    console.log(`[analysis] autoscale PIN — tier fixo em ${PIN_TIER.toUpperCase()} (ANALYSIS_MODEL), auto-dimensionamento DESLIGADO`);
  } else if (!process.env.ANALYSIS_MODEL_PATH) {
    const pick = autoscale.pickStartupTier({ cores, cameras: camCount, workers: poolSize });
    model.setTier(pick);
    console.log(`[analysis] autoscale AUTO — pick de startup ${pick.toUpperCase()} (${cores} cores, ${poolSize} workers, ${camCount} câmeras esperadas)`);
  }
  const ok = await model.ensureModel(want !== "0");
  if (!ok) {
    console.log(
      `[analysis] motor desligado — modelo indisponível em ${model.getModelPath()} (download falhou; sem rede no 1º boot?). ANALYSIS_ENABLED=0 desliga o motor de propósito.`,
    );
    return;
  }
  enabled = true;
  // Tier ATIVO real após o ensure (pode ter caído por fallback S/M→N no download) — é
  // daqui que a válvula de runtime parte. O reducer nasce sem histerese acumulada.
  autoTier = model.getActiveTier() || "s";
  autoState = autoscale.initState(autoTier);
  workerHost.spawnWorker();
  timers.push(setInterval(tick, TICK_MS));
  timers.push(setInterval(() => pipeline.flushWindows(states), AGG_MS));
  timers.push(setInterval(prune, 60_000));
  timers.push(setInterval(logMinute, 60_000));
  // Ronda de pull go2rtc na cadência MAIS RÁPIDA. Inerte (no-op) enquanto o go2rtc
  // estiver desligado — OFF por default sem custo além de um guard por tick.
  timers.push(setInterval(go2rtcSource.pullTick, Math.min(ROUND_MS, ROUND_MS_LINE, ROUND_MS_FOCUS)));
  // Válvula de runtime do autoscale: 1×/janela. Com PIN/override nem agendamos.
  if (!AUTOSCALE_OFF) timers.push(setInterval(evaluateAutoscale, autoscale.DEFAULTS.evalMs));
  for (const t of timers) if (t.unref) t.unref();
  console.log(
    `[analysis] motor ATIVO — ${model.getModelSpec().label} no hub @${FPS}fps/câmera (linha @${FPS_LINE}fps, foco @${FPS_FOCUS}fps)` +
      ` · tier=${autoTier}(${AUTOSCALE_OFF ? "pin" : "auto"})` +
      `${AUTOMASK_ON ? ` · auto-máscara=${AUTOMASK_MODE}` : ""} (pool de ${poolSize} worker(s), CPU EP)`,
  );
}

/** Desliga o motor (usado em testes/encerramento). */
function stop() {
  stopping = true;
  enabled = false;
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  focus.reset();
  workerHost.stop();
}

module.exports = {
  init,
  onFrame,
  onCamcfgUpdated,
  isAnalyzing,
  snapshotTo,
  setFocus,
  clearFocus,
  effectiveFps, // cadência efetiva por câmera (fps) — consumidor: ingest dinâmico (P2)
  status,
  stop,
  // Puros re-exportados de focus.js (contrato de teste — focus.test.js; não são runtime):
  pickRoundMs,
  focusUnion,
  // PURO (contrato de teste — engine.test.js): mapa de ignore do gate a partir das zonas de
  // exclusão. Exposto porque é o ponto onde o hub honra (ou descarta) `points` — spec §5.
  buildMotionIgnore,
  // PUROS (contrato de teste — engine.test.js, spec-overlay-tempo-real Onda 1): a fiação
  // painel→tracker (knobs 23-26 incluídos) e o piso do paralelismo da focada (CA-3).
  byteTrackerOpts,
  focusInflightFor,
  // PUROS (contrato de teste — engine.test.js): o SENSOR do gate. `movingOf` é a leitura
  // defensiva do CT-4 (stats().alive) com degradação declarada; `recordGateRound` é o log
  // rolante de 60s que o telemetry.js agrega em perCamera[].gate.
  movingOf,
  recordGateRound,
};
