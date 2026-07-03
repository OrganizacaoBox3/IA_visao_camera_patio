// ─────────────────────────────────────────────────────────────────────────────
// engine.js — MOTOR DE ANÁLISE NO HUB (F1 do plano-analise-server-side, ADR-009).
//
// Consome os frames que o hub JÁ possui (relé webcam + RTSP), amostra
// @ANALYSIS_FPS (default 1fps, último-vence) e envia ao worker de inferência
// (worker.js, D-FINE-N / onnxruntime-node em PROCESSO SEPARADO — spike §6).
// Com as detecções: ByteTrack por câmera → tripwires/zonas do camcfg →
// pgstore.ingest DIRETO (mesmos formatos do front — src/report/store.ts):
//   • "flow"/"cross"  { cameraId, cameraLabel, tripwireId, dir, ts, shift }
//   • "ativ"/"samples" { cameraId, samples:[{ zoneId, label, atividade,
//       idleMs:0, frames, activeFrames, people }] } a cada ~ANALYSIS_AGG_MS.
//     (people = PICO de pessoas na janela → people_peak; activeFrames = rodadas
//      com ≥1 pessoa na zona → activePct. idleMs fica 0: ociosidade por MOTION
//      continua no front — alarmes de ociosidade estão FORA da F1.)
//
// LIGA/DESLIGA (documentado — contrato):
//   • ANALYSIS_ENABLED=0 → motor DESLIGADO.
//   • ANALYSIS_ENABLED=1 → motor LIGADO; se o modelo não existe, BAIXA no boot
//     (HuggingFace, com verificação de tamanho+sha256). Download falhou →
//     motor desliga com aviso; o hub segue normal.
//   • ausente (default) → LIGADO se o modelo já existe em server/models/;
//     ausente+sem modelo → desligado (log explica como ligar). Ou seja: o 1º
//     boot com ANALYSIS_ENABLED=1 baixa o modelo; dali em diante o default liga.
//
// OVERLAYS SERVIDOS (F2 — ADITIVO): a cada rodada de análise o hub emite
// `analysis-tracks { cameraId, ts, tracks, zones }` (volatile, room "dashboards")
// com os tracks de pessoa (bbox normalizado + zona atribuída) e o estado por zona
// (people/occupied) — o dashboard desenha overlays sem inferir localmente.
// Sem socket na room, a emissão nem monta o payload (ver emitTracks).
//
// ANTI-DUPLICAÇÃO (contrato com F1-C — ADITIVO): para cada câmera analisada o
// hub emite `analysis-status { cameraId, engine: "hub" }` aos dashboards (no
// connect, via snapshotTo(); e a cada mudança). Câmera que sai da análise →
// { cameraId, engine: null }. O front usa isso p/ desligar o ingest local.
//
// LONGO ALCANCE (F3 — perfil por câmera): câmera com CameraCfg.longRange=true no
// camcfg é analisada com TILING 2×2 (overlap 0.1, estilo SAHI) a 640/tile em vez
// do squash 640 único — recall de pedestre distante em panorâmicas. O engine só
// DECIDE (lê o camcfg no createState e no `camcfg-updated` kind:"camconfig") e
// passa `tiles` no pedido; recorte/reprojeção/fusão vivem no worker. CUSTO: 4×
// inferência por rodada, SÓ nas câmeras marcadas (ver README §Longo alcance).
//
// SHED: câmera analisada conta como espectador — index.js injeta
// rtsp.setAnalysisViewer(isAnalyzing), então o shed NÃO pausa o ffmpeg de
// câmera RTSP analisada. Webcam segue podendo ser rebaixada p/ SHED_WEBCAM_FPS
// (2fps ≥ cadência de análise — o motor não perde nada e o nó economiza CPU).
//
// LGPD/ADR-002: frames continuam EFÊMEROS em memória (hub→worker via IPC);
// persiste-se SÓ indicadores/metadados, como hoje.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { fork } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const camcfg = require("../camcfg");
const pgstore = require("../pgstore");
const { createByteTracker } = require("./bytetrack");
const { createCounter } = require("./counting");
const { attributeZone, inExclusionZone } = require("./zones");

// ── Modelo: catálogo N/S/M (D-FINE, MESMA arquitetura → drop-in — eval/MODELS.md) ──
// Resolução por env ANALYSIS_MODEL = n|s|m (default "s"). O default de PRODUÇÃO é o
// D-FINE-S obj2coco: no fixture/full-set (eval/MODELS.md) o recall de pessoa média/pequena
// ~DOBRA vs o N — exatamente o gargalo que travava a contagem de linha
// (analises/acuracia-modelos.md §3) — a ~2.4× o CPU (~0.9 câmera/core @1fps no S vs ~2.2 no
// N; ~7 vs ~17 câmeras/core). CPU-bound? ANALYSIS_MODEL=n volta ao nano (recall menor, mais
// câmeras/core). Todos onnx-community/*-ONNX, Apache-2.0, fp32; baixados no boot com sha256.
const MODELS = {
  n: {
    file: "dfine_n_coco.onnx",
    url: "https://huggingface.co/onnx-community/dfine_n_coco-ONNX/resolve/main/onnx/model.onnx",
    sha256: "0f684f409618ee8a822410e754a29caa817d1aa16283ce89cad936d0a48e2f35",
    bytes: 15_258_358, // 14,55 MB
    label: "D-FINE-N coco",
  },
  s: {
    file: "dfine_s_obj2coco.onnx",
    url: "https://huggingface.co/onnx-community/dfine_s_obj2coco-ONNX/resolve/main/onnx/model.onnx",
    sha256: "b9e2e76610053aeeac3b2f1f685d8f9a1182a93a338f624b6c8cb7fb390cb532",
    bytes: 41_535_197, // 39,6 MB
    label: "D-FINE-S obj2coco",
  },
  m: {
    file: "dfine_m_obj2coco.onnx",
    url: "https://huggingface.co/onnx-community/dfine_m_obj2coco-ONNX/resolve/main/onnx/model.onnx",
    sha256: "347f2faba93248c2e7500c9e604317fb391706c58a04802dd908573376dc1323",
    bytes: 78_624_257, // 75,0 MB
    label: "D-FINE-M obj2coco",
  },
};
// ANALYSIS_MODEL_PATH fixa o arquivo explicitamente (usado pelo eval/): sem catálogo/fallback.
const MODEL_OVERRIDE = process.env.ANALYSIS_MODEL_PATH || "";
const MODEL_KEY = (process.env.ANALYSIS_MODEL || "s").toLowerCase();
let modelSpec = MODELS[MODEL_KEY] || MODELS.s; // default de produção: S
let MODEL_PATH = MODEL_OVERRIDE || path.join(__dirname, "..", "models", modelSpec.file);

// ── Parâmetros de operação (defaults espelham APP_CONFIG.people.track do front) ──
const FPS = Math.min(4, Math.max(0.2, Number(process.env.ANALYSIS_FPS) || 1));
const ROUND_MS = Math.round(1000 / FPS);
// Ponto de operação do spike §8: nascimento/1ª passada em ~0.35; o worker devolve ≥0.25,
// que alimenta a 2ª passada do ByteTrack (score baixo SUSTENTA track, não nasce).
const HIGH_SCORE = Number(process.env.ANALYSIS_HIGH_SCORE ?? 0.35);
const AGG_MS = Math.max(1000, Number(process.env.ANALYSIS_AGG_MS ?? 3000));
// TTL escala com a cadência (a 1fps, o 1500ms do front mataria o track numa rodada perdida).
const TTL_MS = Math.max(1500, Math.round(ROUND_MS * 3.5));
const PRUNE_MS = 5 * 60_000; // câmera sem frame há tanto tempo sai do estado/status
const TICK_MS = Math.min(250, Math.max(50, Math.round(ROUND_MS / 4)));
// Grid do perfil "Longo alcance/Panorâmica" (F3): 2×2 com overlap 0.1 — espelha o
// tiling do front (src/vision/detect.ts tileGrid). Fixo de propósito (YAGNI): um
// grid maior quadruplicaria de novo o custo sem caso de uso medido.
const LR_TILES = { cols: 2, rows: 2, overlap: 0.1 };

let ctx = null; // { io, cameras } injetado pelo index.js
let enabled = false;
let stopping = false;

let worker = null;
let workerReady = false;
let workerPid = 0;
let respawns = 0;
let backoffAttempt = 0;
let respawnTimer = null;

let seq = 0;
/** cameraId → estado por câmera (tracker/counter/zonas/fila/métricas) */
const states = new Map();
const timers = [];

// CPU do worker (amostrada dos process.cpuUsage() que ele manda em cada resposta)
let cpuSample = null; // { user, system, t }
let cpuPct = 0;

const shiftOf = (hour) => (hour >= 6 && hour < 14 ? "Manhã" : hour >= 14 && hour < 22 ? "Tarde" : "Noite");

// ── Modelo: verificação + download com sha256 ────────────────────────────────
function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function modelOk() {
  try {
    const st = fs.statSync(MODEL_PATH);
    if (MODEL_OVERRIDE) return st.size > 0; // path fixado pelo operador → confia (não força sha do catálogo)
    if (st.size !== modelSpec.bytes) return false;
    return sha256File(MODEL_PATH) === modelSpec.sha256;
  } catch {
    return false;
  }
}

async function downloadModel() {
  console.log(`[analysis] baixando modelo ${modelSpec.label} (${(modelSpec.bytes / 1e6).toFixed(1)} MB) de ${modelSpec.url} …`);
  const res = await fetch(modelSpec.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar o modelo`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== modelSpec.bytes)
    throw new Error(`tamanho inesperado: ${buf.length} bytes (esperado ${modelSpec.bytes})`);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== modelSpec.sha256) throw new Error(`sha256 divergente: ${sha} (esperado ${modelSpec.sha256})`);
  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
  fs.writeFileSync(MODEL_PATH + ".tmp", buf); // escrita atômica: nunca deixa modelo truncado
  fs.renameSync(MODEL_PATH + ".tmp", MODEL_PATH);
  console.log(`[analysis] modelo salvo em ${MODEL_PATH} (sha256 ok)`);
}

async function ensureModel(allowDownload) {
  if (modelOk()) return true;
  if (fs.existsSync(MODEL_PATH))
    console.warn("[analysis] modelo existente com tamanho/sha divergente — será rebaixado");
  if (!allowDownload) return false;
  try {
    await downloadModel();
    return true;
  } catch (e) {
    console.error(`[analysis] download de ${modelSpec.label} FALHOU: ${e.message}`);
    // Fallback: modelo grande (S/M) indisponível e SEM path fixado → cai p/ o N (recall
    // menor, mas o hub SEGUE analisando). Ajuste ANALYSIS_MODEL=n p/ evitar este caminho.
    if (!MODEL_OVERRIDE && modelSpec !== MODELS.n) {
      modelSpec = MODELS.n;
      MODEL_PATH = path.join(__dirname, "..", "models", modelSpec.file);
      console.warn(`[analysis] fallback → ${modelSpec.label} (recall menor que o default S)`);
      if (modelOk()) return true;
      try {
        await downloadModel();
        return true;
      } catch (e2) {
        console.error(`[analysis] fallback ${modelSpec.label} também FALHOU: ${e2.message} — motor DESLIGADO (hub segue normal)`);
        return false;
      }
    }
    console.error("[analysis] motor de análise DESLIGADO (hub segue normal)");
    return false;
  }
}

// ── Worker: spawn + respawn com backoff ──────────────────────────────────────
function spawnWorker() {
  workerReady = false;
  worker = fork(path.join(__dirname, "worker.js"), [], {
    serialization: "advanced", // Buffers de JPEG viajam como binário, sem base64
    env: { ...process.env, ANALYSIS_MODEL_PATH: MODEL_PATH },
  });
  workerPid = worker.pid;
  worker.on("message", onWorkerMessage);
  worker.on("exit", (code, signal) => {
    workerReady = false;
    worker = null;
    // pedidos em voo morreram com o processo: libera os slots p/ a próxima rodada
    for (const st of states.values()) {
      st.busy = false;
      st.inflight = 0;
    }
    if (stopping) return;
    respawns += 1;
    const delay = Math.min(1000 * 2 ** backoffAttempt, 30_000);
    backoffAttempt += 1;
    console.warn(
      `[analysis] worker morreu (code=${code} signal=${signal}) — respawn em ${delay}ms (tentativa ${backoffAttempt})`,
    );
    respawnTimer = setTimeout(spawnWorker, delay);
    if (respawnTimer.unref) respawnTimer.unref();
  });
}

function onWorkerMessage(msg) {
  if (!msg) return;
  if (msg.type === "ready") {
    workerReady = true;
    backoffAttempt = 0; // subiu limpo — zera o backoff
    if (msg.cpu) cpuSample = { ...msg.cpu, t: Date.now() };
    console.log(`[analysis] worker pronto (pid=${workerPid}, modelo=${msg.model})`);
    return;
  }
  if (msg.type === "fatal") {
    console.error(`[analysis] worker FATAL: ${msg.error}`);
    return; // o handler de exit cuida do respawn
  }
  const st = states.get(msg.cameraId);
  if (msg.cpu) sampleCpu(msg.cpu);
  if (!st || st.inflight !== msg.id) return; // resposta órfã (respawn/prune) — ignora
  st.busy = false;
  st.inflight = 0;
  if (msg.dropped) return; // substituído na fila do worker (último-vence)
  if (msg.error) {
    st.errors += 1;
    if (st.errors <= 3 || st.errors % 50 === 0)
      console.warn(`[analysis:${st.id}] falha no frame: ${msg.error}`);
    return;
  }
  st.lastMs = msg.inferMs || 0;
  processDets(st, Array.isArray(msg.dets) ? msg.dets : [], Date.now());
}

function sampleCpu(cpu) {
  const t = Date.now();
  if (!cpuSample) {
    cpuSample = { user: cpu.user, system: cpu.system, t };
    return;
  }
  const dt = t - cpuSample.t;
  if (dt < 5000) return; // janela mínima p/ % estável
  const dcpuMs = (cpu.user + cpu.system - cpuSample.user - cpuSample.system) / 1000;
  cpuPct = Math.round((dcpuMs / dt) * 1000) / 10; // % de UM core
  cpuSample = { user: cpu.user, system: cpu.system, t };
}

// ── Estado por câmera ────────────────────────────────────────────────────────
function ativZonesOf(cameraId) {
  return camcfg.getZones(cameraId).filter((z) => z.modo === "atividade");
}

// Zonas de EXCLUSÃO (calibração — analises/acuracia-modelos.md Medida A): a pessoa cujo
// PÉ cai aqui é descartada antes de tracking/contagem/ingest (mata FP de objeto fixo).
// Contrato compartilhado com o front: modo "exclusao" no camcfg.
function exclZonesOf(cameraId) {
  return camcfg.getZones(cameraId).filter((z) => z.modo === "exclusao");
}

// Perfil "Longo alcance/Panorâmica" da câmera (CameraCfg.longRange — src/cameraConfig.ts).
// Leitura DEFENSIVA (=== true): config ausente/legada sem o campo → false (squash atual).
function longRangeOf(cameraId) {
  const cfg = camcfg.getCamConfig(cameraId);
  return !!(cfg && cfg.longRange === true);
}

function createState(id) {
  const st = {
    id,
    latest: null, // { buf, ts } — último frame recebido (último-vence)
    busy: false,
    inflight: 0,
    lastSentAt: 0,
    lastFrameAt: Date.now(),
    errors: 0,
    tracker: createByteTracker({ highScore: HIGH_SCORE, iouThreshold: 0.25, ttlMs: TTL_MS }),
    counter: createCounter(camcfg.getTripwires(id), {
      minMove: 0.01,
      ttl: TTL_MS,
      maxDist: 0.35, // gate de teleporte (APP_CONFIG.people.track.counterMaxDist)
      debounceMs: 800,
      minCrossingFrames: 2, // histerese: lado novo sustentado 2 rodadas
    }),
    zonesAtiv: ativZonesOf(id),
    zonesExcl: exclZonesOf(id), // pessoas com o pé aqui são descartadas antes do tracking
    longRange: longRangeOf(id), // F3: true → pedido ao worker leva tiles 2×2 (LR_TILES)
    window: { frames: 0, zones: new Map() }, // acumulação p/ o ingest "ativ" (~AGG_MS)
    rounds: [], // timestamps das rodadas (p/ fps real no status)
    detsLog: [], // { t, n } pessoas por rodada (p/ dets1m)
    lastMs: 0,
  };
  states.set(id, st);
  emitAnalysisStatus(id, "hub");
  return st;
}

function emitAnalysisStatus(cameraId, engine) {
  if (ctx) ctx.io.to("dashboards").emit("analysis-status", { cameraId, engine });
}

// ── Pipeline por rodada: dets → tracker → counter/zonas → ingest ─────────────
function processDets(st, dets, now) {
  // Zona de EXCLUSÃO (calibração — analises/acuracia-modelos.md Medida A): a detecção de
  // pessoa cujo PÉ (bottom-center do bbox) cai numa zona modo "exclusao" (mask-aware) é
  // DESCARTADA AQUI — antes de ByteTrack/counter/zonas/ingest/emit. Não conta, não rastreia,
  // não vira overlay. Os FP de objeto fixo (grade/placa/janela) são espacialmente presos;
  // a pessoa real se move, então mascarar o hotspot mata o FP sem custar recall.
  const persons = [];
  let excluded = 0;
  for (const d of dets) {
    if (!d || d.class !== "person" || !Array.isArray(d.bbox)) continue;
    if (st.zonesExcl.length && inExclusionZone(d.bbox, st.zonesExcl)) {
      excluded += 1;
      continue;
    }
    persons.push({ score: d.score, bbox: d.bbox });
  }
  st.rounds.push(now);
  st.detsLog.push({ t: now, n: persons.length, x: excluded });
  const cutoff = now - 60_000;
  while (st.rounds.length && st.rounds[0] < cutoff) st.rounds.shift();
  while (st.detsLog.length && st.detsLog[0].t < cutoff) st.detsLog.shift();

  const tracks = st.tracker.update(persons, now, HIGH_SCORE);

  // Tripwires → eventos de cruzamento → ingest "flow"/"cross" (mesmo formato do front)
  const crossings = st.counter.update(
    tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, foot: t.foot })),
    now,
  );
  if (crossings.length) {
    const cam = ctx && ctx.cameras.get(st.id);
    const cameraLabel = cam ? cam.label : st.id;
    const ts = Date.now();
    for (const ev of crossings) {
      pgstore
        .ingest("flow", "cross", {
          cameraId: st.id,
          cameraLabel,
          tripwireId: ev.tripwireId,
          dir: ev.dir,
          ts,
          shift: shiftOf(new Date(ts).getHours()),
        })
        .catch((e) => console.error("[analysis] ingest flow falhou:", e.message));
    }
  }

  // Zonas de atividade → people/occupied por zona (janela agregada em flushAtiv).
  // A atribuição por track roda UMA vez e alimenta os dois consumidores: a janela
  // do ingest e o payload de overlay (analysis-tracks) — zero trabalho extra.
  const zoneByTrack = new Map(); // track.id → label | null
  const perLabel = new Map(); // label → pessoas nesta rodada
  if (st.zonesAtiv.length) {
    for (const t of tracks) {
      const label = attributeZone(t.bbox, st.zonesAtiv);
      zoneByTrack.set(t.id, label);
      if (label) perLabel.set(label, (perLabel.get(label) || 0) + 1);
    }
    st.window.frames += 1;
    for (const z of st.zonesAtiv) {
      const n = perLabel.get(z.label) || 0;
      let acc = st.window.zones.get(z.id);
      if (!acc)
        st.window.zones.set(z.id, (acc = { label: z.label, atividade: z.atividade || "", active: 0, peak: 0 }));
      if (n > 0) acc.active += 1;
      if (n > acc.peak) acc.peak = n;
    }
  }

  // Overlays servidos (F2): tracks/estados desta rodada p/ os dashboards desenharem
  // sem inferir localmente. Roda TODA rodada (inclusive com 0 tracks — o dashboard
  // precisa da rodada vazia p/ apagar caixas), mesmo sem zona/tripwire configurada.
  emitTracks(st, tracks, zoneByTrack, perLabel, now);
}

// ── Overlays servidos (F2 do plano — evento `analysis-tracks`, ADITIVO) ──────
// io.to("dashboards").volatile.emit: mesmo padrão último-vence dos frames do relé —
// overlay atrasado não acumula backlog em socket lento. Payload EXPLÍCITO: só o que
// o contrato pede (não vazam campos internos do tracker: vx/vy/score/firstSeen…).
// ECONOMIA: sem socket na room "dashboards" não monta nem serializa nada
// (io.sockets.adapter.rooms.get("dashboards")?.size — custo de um lookup por rodada).
function emitTracks(st, tracks, zoneByTrack, perLabel, ts) {
  if (!ctx) return;
  if (!ctx.io.sockets.adapter.rooms.get("dashboards")?.size) return;
  ctx.io.to("dashboards").volatile.emit("analysis-tracks", {
    cameraId: st.id,
    ts,
    tracks: tracks.map((t) => ({
      id: t.id,
      bbox: [t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]], // normalizado 0..1
      cx: t.cx,
      cy: t.cy,
      zone: zoneByTrack.get(t.id) ?? null,
    })),
    zones: st.zonesAtiv.map((z) => {
      const people = perLabel.get(z.label) || 0;
      return { id: z.id, label: z.label, people, occupied: people > 0 };
    }),
  });
}

// Flush do "ativ"/"samples" (~AGG_MS): MESMO shape do front (SamplePayload/ZoneSample).
function flushAtiv() {
  for (const st of states.values()) {
    if (!st.window.frames || !st.window.zones.size) continue;
    const samples = [];
    for (const [zoneId, acc] of st.window.zones) {
      samples.push({
        zoneId,
        label: acc.label,
        atividade: acc.atividade,
        idleMs: 0, // ociosidade por motion segue no front (fora da F1)
        frames: st.window.frames,
        activeFrames: acc.active,
        people: acc.peak,
      });
    }
    st.window = { frames: 0, zones: new Map() };
    pgstore
      .ingest("ativ", "samples", { cameraId: st.id, samples })
      .catch((e) => console.error("[analysis] ingest ativ falhou:", e.message));
  }
}

// ── Amostragem: tick escolhe o último frame por câmera e manda ao worker ─────
function tick() {
  if (!workerReady || !worker) return;
  const now = Date.now();
  for (const st of states.values()) {
    if (st.busy || !st.latest || now - st.lastSentAt < ROUND_MS) continue;
    const frame = st.latest;
    st.latest = null;
    st.busy = true;
    st.lastSentAt = now;
    st.inflight = ++seq;
    try {
      // cópia no envio: o buf do relé pode ser view de um buffer maior (RTSP) — a cópia
      // acontece só 1×/rodada (não por frame do relé) e serializa enxuto no IPC.
      // F3: câmera longRange leva `tiles` — o worker recorta/reprojeta/funde (4× inferência).
      worker.send({
        type: "detect",
        id: st.inflight,
        cameraId: st.id,
        jpeg: Buffer.from(frame.buf),
        ...(st.longRange ? { tiles: LR_TILES } : {}),
      });
    } catch {
      st.busy = false;
      st.inflight = 0;
    }
  }
}

function prune() {
  const now = Date.now();
  for (const [id, st] of states) {
    if (now - st.lastFrameAt > PRUNE_MS) {
      states.delete(id);
      emitAnalysisStatus(id, null);
    }
  }
}

function logMinute() {
  if (!states.size) return;
  const parts = [];
  for (const [id, st] of states) {
    const fps = Math.round((st.rounds.length / 60) * 100) / 100;
    parts.push(`${id}${st.longRange ? "[LR]" : ""}: ${fps}fps ${st.lastMs}ms`);
  }
  console.log(
    `[analysis] worker ${workerReady ? "ok" : "fora"} pid=${workerPid} cpu~${cpuPct}% · ${parts.join(" · ")}`,
  );
}

// ── API pública (consumida pelo index.js / routes/analysis.js) ───────────────

/** Frame do relé (webcam OU RTSP). Guarda só o MAIS NOVO por câmera (último-vence). */
function onFrame(cameraId, buf, ts) {
  if (!enabled || stopping || !cameraId || !buf) return;
  const id = String(cameraId);
  const st = states.get(id) || createState(id);
  st.lastFrameAt = Date.now();
  st.latest = { buf, ts: ts || st.lastFrameAt };
}

/** Mudança de camcfg (teed pelo index.js a partir do evento "camcfg-updated"). */
function onCamcfgUpdated(p) {
  if (!enabled || !p || !p.cameraId) return;
  const st = states.get(String(p.cameraId));
  if (!st) return;
  if (p.kind === "tripwires") {
    st.counter.setTripwires(camcfg.getTripwires(st.id)); // preserva contadores por id
  } else if (p.kind === "zones") {
    st.zonesAtiv = ativZonesOf(st.id);
    st.zonesExcl = exclZonesOf(st.id); // recarrega a máscara de exclusão na próxima rodada
    st.window = { frames: 0, zones: new Map() }; // janela reinicia com a nova geometria
  } else if (p.kind === "camconfig") {
    st.longRange = longRangeOf(st.id); // F3: liga/desliga o tiling na PRÓXIMA rodada
  }
}

/** Câmera analisada conta como espectador (shed). Com o motor ON, TODA câmera do relé é analisada. */
function isAnalyzing() {
  return enabled && !stopping;
}

/** Snapshot do contrato anti-duplicação p/ um dashboard que acabou de conectar. */
function snapshotTo(socket) {
  if (!enabled) return;
  for (const id of states.keys()) socket.emit("analysis-status", { cameraId: id, engine: "hub" });
}

/** GET /api/analysis/status — métricas por câmera (aditivo). */
function status() {
  const perCamera = {};
  for (const [id, st] of states) {
    let dets1m = 0;
    let excluded1m = 0;
    for (const d of st.detsLog) {
      dets1m += d.n;
      excluded1m += d.x || 0;
    }
    perCamera[id] = {
      fps: Math.round((st.rounds.length / 60) * 100) / 100,
      queue: (st.busy ? 1 : 0) + (st.latest ? 1 : 0),
      lastMs: st.lastMs,
      dets1m,
      excluded1m, // aditivo: dets de pessoa suprimidas por zona de exclusão em 60s
      longRange: st.longRange, // F3 (aditivo): true = rodada com tiling 2×2 no worker
    };
  }
  return {
    enabled,
    model: path.basename(MODEL_PATH),
    targetFps: FPS,
    worker: { ready: workerReady, pid: workerPid, respawns, cpuPct },
    perCamera,
  };
}

/**
 * Boot do motor. `{ io, cameras }` vêm do index.js. Ver regras de liga/desliga no cabeçalho.
 */
async function init({ io, cameras }) {
  ctx = { io, cameras };
  const want = process.env.ANALYSIS_ENABLED;
  if (want === "0") {
    console.log("[analysis] motor DESLIGADO (ANALYSIS_ENABLED=0)");
    return;
  }
  const ok = await ensureModel(want === "1");
  if (!ok) {
    console.log(
      want === "1"
        ? "[analysis] motor desligado (modelo indisponível)"
        : `[analysis] motor desligado — modelo ausente em ${MODEL_PATH}. Defina ANALYSIS_ENABLED=1 para baixá-lo no boot.`,
    );
    return;
  }
  enabled = true;
  spawnWorker();
  timers.push(setInterval(tick, TICK_MS));
  timers.push(setInterval(flushAtiv, AGG_MS));
  timers.push(setInterval(prune, 60_000));
  timers.push(setInterval(logMinute, 60_000));
  for (const t of timers) if (t.unref) t.unref();
  console.log(`[analysis] motor ATIVO — ${modelSpec.label} no hub @${FPS}fps/câmera (worker process, CPU EP)`);
}

/** Desliga o motor (usado em testes/encerramento). */
function stop() {
  stopping = true;
  enabled = false;
  if (respawnTimer) clearTimeout(respawnTimer);
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  if (worker) {
    try {
      worker.kill();
    } catch {
      /* ignore */
    }
  }
}

module.exports = { init, onFrame, onCamcfgUpdated, isAnalyzing, snapshotTo, status, stop };
