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
//   • FASE 4 — DETECÇÃO ATIVA POR DEFAULT: com o modelo presente o usuário NÃO precisa
//     ligar nada; o motor sobe sozinho no boot e cobre TODA câmera do relé (exceto as em
//     modo=fadiga, que rodam no cliente). ANALYSIS_ENABLED=0 é o único desligamento explícito.
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
// FONTE go2rtc (Fase 3 — ADITIVO, OFF por default): além do relé, o motor pode
// PUXAR frames do go2rtc (GET /api/frame.jpeg?src=<cameraId>) a ~ANALYSIS_FPS e
// alimentar o MESMO pipeline (mesmo st.latest / tick / worker / ingest / emit).
// Resolve o caveat da câmera que transmite por WHIP (Fase 5): ela deixa de mandar
// relé socket → hoje não é analisada; com o pull, volta a ser. QUEM é puxada:
//   • só quando go2rtc está habilitado (go2rtc.enabled()) — logo, OFF por default;
//   • câmera que o go2rtc conhece (GET /api/streams) E cujo RELÉ está PARADO
//     (sem `onFrame` há PULL_STALE_MS) → evita puxar E receber relé (dobraria a
//     AQUISIÇÃO de frame; a inferência nunca dobra — st.latest é último-vence).
//   • ANALYSIS_SOURCE=go2rtc força o pull de TODAS as streams do go2rtc (mesmo as
//     que mandam relé); custo: aquisição redundante nessas — use só se pedir.
// CONTENÇÃO: o pull respeita a cadência do worker (não puxa se já há frame pronto
// p/ a próxima rodada) e faz BACKOFF exponencial por câmera se o go2rtc não
// responde (stream ainda sem produtor / go2rtc reiniciando). LGPD: JPEG puxado é
// EFÊMERO em memória, alimenta o worker por IPC e nada é gravado (igual ao relé).
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
const go2rtc = require("../go2rtc"); // Fase 3: fonte alternativa de frames (pull frame.jpeg)
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
// Cadência ELEVADA p/ câmera COM tripwire/linha (Fase 4): a contagem de linha quebra por
// recall×cadência (acuracia-modelos.md §3 e Medida D) — a 0,5-1fps um caminhante cruza em
// 2-3 rodadas, insuficiente p/ nascimento+histerese; a ≥2fps o ByteTrack tem rodadas de
// sobra na travessia. SÓ a câmera com linha paga o custo; a sem linha segue @ANALYSIS_FPS.
// ANALYSIS_FPS_LINE (default 2) nunca abaixo do ANALYSIS_FPS nem acima de 4fps.
const FPS_LINE = Math.min(4, Math.max(FPS, Number(process.env.ANALYSIS_FPS_LINE) || 2));
const ROUND_MS_LINE = Math.round(1000 / FPS_LINE);
// Ponto de operação do spike §8: nascimento/1ª passada em ~0.35; o worker devolve ≥0.25,
// que alimenta a 2ª passada do ByteTrack (score baixo SUSTENTA track, não nasce).
const HIGH_SCORE = Number(process.env.ANALYSIS_HIGH_SCORE ?? 0.35);
const AGG_MS = Math.max(1000, Number(process.env.ANALYSIS_AGG_MS ?? 3000));
// TTL escala com a cadência (a 1fps, o 1500ms do front mataria o track numa rodada perdida).
const TTL_MS = Math.max(1500, Math.round(ROUND_MS * 3.5));
const PRUNE_MS = 5 * 60_000; // câmera sem frame há tanto tempo sai do estado/status
// Resolução do tick baseada na cadência MAIS RÁPIDA (linha) p/ o dispatch honrar 2fps.
const TICK_MS = Math.min(250, Math.max(50, Math.round(Math.min(ROUND_MS, ROUND_MS_LINE) / 4)));
// Grid do perfil "Longo alcance/Panorâmica" (F3): 2×2 com overlap 0.1 — espelha o
// tiling do front (src/vision/detect.ts tileGrid). Fixo de propósito (YAGNI): um
// grid maior quadruplicaria de novo o custo sem caso de uso medido.
const LR_TILES = { cols: 2, rows: 2, overlap: 0.1 };

// ── Auto-máscara de exclusão APRENDIDA (Fase 4 — OPT-IN, OFF por default) ─────
// ANALYSIS_AUTOMASK: ausente/"off"/"0" (feature OFF — nada aprende, nada suprime, custo zero);
//   "suggest" (aprende + expõe a sugestão em status() + loga, mas NÃO suprime — transparência
//    sem risco; caminho RECOMENDADO p/ validar contra a realidade antes de esconder);
//   "hide"/"1"/"on" (aprende + SUPRIME as células aprendidas + loga — como a zona de exclusão
//    manual, mas APRENDIDA). Aprende a célula do grid onde há detecção de pessoa PRESENTE
//   ~100% do tempo E com bbox quase ESTÁTICO por uma janela ≥10min = objeto fixo lido como
//   pessoa no piso de score (acuracia-modelos.md §2: 47-86% dos FP são poucos objetos fixos).
//   CONSERVADOR de propósito: pessoa real num posto AINDA varia (pé/tronco oscilam, ela sai
//   de quadro); objeto fixo não. Por isso o gate é presença altíssima + jitter baixíssimo +
//   janela longa. Auto-suprimir é o modo ARRISCADO (pode esconder pessoa quase imóvel) → OFF.
const AUTOMASK_RAW = String(process.env.ANALYSIS_AUTOMASK || "").toLowerCase();
const AUTOMASK_MODE = /^(1|on|hide|true)$/.test(AUTOMASK_RAW)
  ? "hide"
  : /^(suggest|sug|learn)$/.test(AUTOMASK_RAW)
    ? "suggest"
    : "off";
const AUTOMASK_ON = AUTOMASK_MODE !== "off";
const AM_COLS = Math.max(4, Math.min(64, Number(process.env.ANALYSIS_AUTOMASK_COLS) || 24));
const AM_ROWS = Math.max(4, Math.min(64, Number(process.env.ANALYSIS_AUTOMASK_ROWS) || 18));
const AM_WIN_MS = Math.max(60_000, Number(process.env.ANALYSIS_AUTOMASK_WIN_MS) || 600_000); // janela ≥10min
const AM_PRESENT = Math.min(1, Math.max(0.5, Number(process.env.ANALYSIS_AUTOMASK_PRESENT) || 0.97));
const AM_JITTER = Math.max(0.001, Number(process.env.ANALYSIS_AUTOMASK_JITTER) || 0.02); // std norm máx p/ "fixo"
const AM_MIN_ROUNDS = Math.max(30, Number(process.env.ANALYSIS_AUTOMASK_MIN_ROUNDS) || 120);

// ── Fonte go2rtc (Fase 3): pull de frame.jpeg p/ câmeras SEM relé (ex.: WHIP) ──
// ANALYSIS_SOURCE=go2rtc → puxa TODAS as streams do go2rtc (força); ausente/qualquer
// outro valor → modo "relay-less" (puxa só quem não manda relé). ANALYSIS_GO2RTC_PULL=0
// desliga o pull mesmo com go2rtc ligado (escape hatch).
const PULL_FORCE_ALL = String(process.env.ANALYSIS_SOURCE || "").toLowerCase() === "go2rtc";
const PULL_OPT_OUT = /^(0|false|off|no)$/i.test(String(process.env.ANALYSIS_GO2RTC_PULL || ""));
// Relé considerado PARADO após isto sem onFrame → câmera vira elegível ao pull. Maior que
// ROUND_MS p/ um relé só levemente atrasado não disparar pull redundante.
const PULL_STALE_MS = Math.max(3000, ROUND_MS * 3);
const PULL_TIMEOUT_MS = Math.max(500, Number(process.env.ANALYSIS_GO2RTC_TIMEOUT_MS) || 2000);
const STREAMS_REFRESH_MS = Math.max(1000, Number(process.env.ANALYSIS_GO2RTC_STREAMS_MS) || 4000);
const PULL_BACKOFF_BASE_MS = 2000;
const PULL_BACKOFF_MAX_MS = 30_000;

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

// ── Fonte go2rtc: descoberta de streams + estado de pull por câmera ──────────
let go2rtcStreams = new Set(); // ids que o go2rtc conhece agora (cache, refrescado @STREAMS_REFRESH_MS)
let streamsAt = 0; // epoch ms da última TENTATIVA de refresh
let streamsInflight = false; // um GET /api/streams em voo
let streamsFails = 0; // refreshes seguidos falhos (limpa o cache após alguns)
/** cameraId → { inflight, nextAt, fails } — controle de pull/backoff por câmera */
const pulls = new Map();

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

// Papel da câmera (CameraCfg.modo — src/cameraConfig.ts). "fadiga" é modo ESPECIALIZADO que
// roda no CLIENTE (MediaPipe/face mesh do operador) — o hub NÃO deve detectar/contar PESSOA
// nela: (a) economiza CPU do worker, (b) tira do relatório o ruído de "pessoa" contada sobre
// o rosto do operador em close. Leitura DEFENSIVA (mesma disciplina do longRange): sem config
// salva → cleanCamConfig default "atividade" → não é fadiga.
function modoOf(cameraId) {
  const cfg = camcfg.getCamConfig(cameraId);
  return (cfg && cfg.modo) || "atividade";
}
function isFadiga(cameraId) {
  return modoOf(cameraId) === "fadiga";
}

// ── Auto-máscara: estado por câmera + observação/avaliação (Fase 4) ──────────
function createAutoMask() {
  // cells: cellIndex → { present, n, mean:[fx,fy,w,h], m2:[...] } (Welford p/ variância).
  return { rounds: 0, windowStart: Date.now(), cells: new Map(), suppressed: new Set(), suggestions: [] };
}
/** célula do grid AM p/ um ponto NORMALIZADO (o PÉ da detecção — igual à zona de exclusão). */
function amCell(fx, fy) {
  const c = Math.min(AM_COLS - 1, Math.max(0, Math.floor(fx * AM_COLS)));
  const r = Math.min(AM_ROWS - 1, Math.max(0, Math.floor(fy * AM_ROWS)));
  return r * AM_COLS + c;
}
/** acumula uma observação (pé + tamanho do bbox) na célula; marca presença desta rodada. */
function amObserve(am, cell, vals, roundCells) {
  roundCells.add(cell);
  let c = am.cells.get(cell);
  if (!c) am.cells.set(cell, (c = { present: 0, n: 0, mean: [0, 0, 0, 0], m2: [0, 0, 0, 0] }));
  c.n += 1;
  for (let k = 0; k < 4; k++) {
    const delta = vals[k] - c.mean[k];
    c.mean[k] += delta / c.n;
    c.m2[k] += delta * (vals[k] - c.mean[k]);
  }
}
/** Fim da janela: reavalia quais células são objeto fixo, loga transições, reinicia a janela. */
function evaluateAutoMask(st, now) {
  const am = st.autoMask;
  const prev = am.suppressed;
  const next = new Set();
  const suggestions = [];
  for (const [cell, c] of am.cells) {
    if (c.n < AM_MIN_ROUNDS) continue; // pouca amostra → não decide
    const presentPct = c.present / am.rounds;
    if (presentPct < AM_PRESENT) continue; // não está presente ~100% do tempo → não é objeto fixo
    const std0 = Math.sqrt(c.m2[0] / c.n);
    const std1 = Math.sqrt(c.m2[1] / c.n);
    const std2 = Math.sqrt(c.m2[2] / c.n);
    const std3 = Math.sqrt(c.m2[3] / c.n);
    const jitter = Math.max(std0, std1, std2, std3);
    if (jitter > AM_JITTER) continue; // ainda VARIA (pé/tamanho oscilam) → provável pessoa real
    next.add(cell);
    suggestions.push({ cell, presentPct, jitter });
  }
  for (const cell of next) {
    if (prev.has(cell)) continue; // já conhecida — só loga a novidade
    const col = cell % AM_COLS;
    const row = Math.floor(cell / AM_COLS);
    const c = am.cells.get(cell);
    console.log(
      `[analysis:${st.id}] auto-máscara ${AUTOMASK_MODE === "hide" ? "SUPRIMINDO" : "SUGESTÃO"} ` +
        `célula (${col},${row}) ~${Math.round(((col + 0.5) / AM_COLS) * 100)}%,${Math.round(((row + 0.5) / AM_ROWS) * 100)}% ` +
        `— presente ${Math.round((c.present / am.rounds) * 100)}% da janela (${Math.round(AM_WIN_MS / 60000)}min), objeto fixo provável`,
    );
  }
  am.suppressed = next;
  am.suggestions = suggestions;
  // reinicia a janela: re-aprende do zero → objeto que SOME deixa de ser reaprendido e a
  // supressão cai na próxima avaliação (adaptativo, com atraso de até uma janela).
  am.cells = new Map();
  am.rounds = 0;
  am.windowStart = now;
}

function createState(id) {
  const st = {
    id,
    latest: null, // { buf, ts } — último frame recebido (último-vence)
    busy: false,
    inflight: 0,
    lastSentAt: 0,
    lastFrameAt: Date.now(),
    lastRelayAt: 0, // último frame vindo do RELÉ (só onFrame) — base da decisão de pull
    source: "relay", // origem do último frame: "relay" | "go2rtc" (aditivo no status)
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
    fadiga: isFadiga(id), // F4: câmera modo=fadiga NÃO é analisada no hub (roda no cliente)
    roundMs: camcfg.getTripwires(id).length ? ROUND_MS_LINE : ROUND_MS, // F4: câmera com linha amostra mais rápido
    autoMask: AUTOMASK_ON ? createAutoMask() : null, // F4: aprendizado de hotspots fixos (opt-in)
    window: { frames: 0, zones: new Map() }, // acumulação p/ o ingest "ativ" (~AGG_MS)
    rounds: [], // timestamps das rodadas (p/ fps real no status)
    detsLog: [], // { t, n } pessoas por rodada (p/ dets1m)
    lastMs: 0,
  };
  states.set(id, st);
  // Fadiga: o hub não cobre PESSOA nessa câmera → anuncia engine:null (front mantém o modo
  // especializado local, não liga o ingest de pessoa). Demais câmeras: engine:"hub".
  emitAnalysisStatus(id, st.fadiga ? null : "hub");
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
  let autoHidden = 0;
  const am = st.autoMask; // F4: auto-máscara aprendida (null quando a feature está OFF)
  const roundCells = am ? new Set() : null; // células com ≥1 pé NESTA rodada (presença por rodada)
  for (const d of dets) {
    if (!d || d.class !== "person" || !Array.isArray(d.bbox)) continue;
    if (st.zonesExcl.length && inExclusionZone(d.bbox, st.zonesExcl)) {
      excluded += 1;
      continue;
    }
    // Auto-máscara (F4): o PÉ (bottom-center) → célula do grid aprendido. APRENDE de TODAS as
    // detecções (mesmo as já suprimidas): assim um objeto fixo AINDA presente segue confirmado
    // (e suprimido); quando ele some, deixa de ser reaprendido e a supressão cai (adaptativo).
    if (am) {
      const fx = d.bbox[0] + d.bbox[2] / 2;
      const fy = d.bbox[1] + d.bbox[3];
      const cell = amCell(fx, fy);
      amObserve(am, cell, [fx, fy, d.bbox[2], d.bbox[3]], roundCells);
      if (AUTOMASK_MODE === "hide" && am.suppressed.has(cell)) {
        autoHidden += 1; // célula aprendida como objeto fixo → suprime (como zona de exclusão manual)
        continue;
      }
    }
    persons.push({ score: d.score, bbox: d.bbox });
  }
  if (am) {
    am.rounds += 1;
    for (const cell of roundCells) am.cells.get(cell).present += 1; // 1 presença/rodada/célula
    if (now - am.windowStart >= AM_WIN_MS && am.rounds >= AM_MIN_ROUNDS) evaluateAutoMask(st, now);
  }
  st.rounds.push(now);
  st.detsLog.push({ t: now, n: persons.length, x: excluded, a: autoHidden });
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
      // F4 (ADITIVO ao contrato analysis-tracks): score REAL (0..1) da detecção que sustenta o
      // track nesta rodada — antes era descartado no emit. O front usa p/ o slider de confiança
      // no modo hub (hoje forçado a 1). Sustentado por det de score baixo → reflete o piso 0.25.
      score: t.score,
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
    // F4: câmera modo=fadiga não é analisada no hub (roda no cliente) — nada de inferência,
    // tracks ou ingest de PESSOA nela. Este é o único choke point (pega relé E pull go2rtc).
    if (st.fadiga) continue;
    // F4: câmera com linha amostra @ROUND_MS_LINE (≥2fps); sem linha, @ROUND_MS (1fps).
    if (st.busy || !st.latest || now - st.lastSentAt < (st.roundMs || ROUND_MS)) continue;
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
      pulls.delete(id);
      emitAnalysisStatus(id, null);
    }
  }
}

// ── Fonte go2rtc (Fase 3): descoberta + pull de frame.jpeg (alimenta st.latest) ──
/** Pull ativo? Só com o motor ligado, go2rtc habilitado e sem opt-out. OFF por default (go2rtc é OFF). */
function pullActive() {
  return enabled && !stopping && !PULL_OPT_OUT && go2rtc.enabled();
}

/** Frame PUXADO do go2rtc: mesmo destino do relé (st.latest, último-vence). NÃO mexe em lastRelayAt. */
function ingestPulled(cameraId, buf) {
  if (!enabled || stopping) return;
  const id = String(cameraId);
  const st = states.get(id) || createState(id);
  const now = Date.now();
  st.lastFrameAt = now;
  st.source = "go2rtc";
  st.latest = { buf, ts: now };
}

/** GET /api/streams → conjunto de ids que o go2rtc conhece (RTSP do yaml + WHIP dinâmicos). */
async function refreshStreams() {
  if (streamsInflight) return;
  const now = Date.now();
  if (now - streamsAt < STREAMS_REFRESH_MS) return;
  streamsInflight = true;
  streamsAt = now;
  const { host, port } = go2rtc.apiTarget();
  try {
    const res = await fetch(`http://${host}:${port}/api/streams`, { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    go2rtcStreams = new Set(data && typeof data === "object" ? Object.keys(data) : []);
    streamsFails = 0;
  } catch {
    // go2rtc fora/subindo: mantém o cache por algumas tentativas, depois esvazia (para de puxar fantasmas)
    streamsFails += 1;
    if (streamsFails >= 3) go2rtcStreams = new Set();
  } finally {
    streamsInflight = false;
  }
}

/** Puxa 1 frame.jpeg do go2rtc p/ a câmera e alimenta o pipeline. Backoff por câmera em falha. */
async function pullFrame(id, ps) {
  ps.inflight = true;
  const { host, port } = go2rtc.apiTarget();
  try {
    const res = await fetch(`http://${host}:${port}/api/frame.jpeg?src=${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    if (!ab.byteLength) throw new Error("frame vazio");
    ps.fails = 0;
    ps.nextAt = 0;
    ingestPulled(id, Buffer.from(ab)); // JPEG efêmero → worker por IPC → nada gravado (LGPD)
  } catch (e) {
    ps.fails += 1;
    const delay = Math.min(PULL_BACKOFF_BASE_MS * 2 ** (ps.fails - 1), PULL_BACKOFF_MAX_MS);
    ps.nextAt = Date.now() + delay; // stream ainda sem produtor / go2rtc reiniciando → espaça as tentativas
    if (ps.fails <= 2 || ps.fails % 20 === 0)
      console.warn(`[analysis:${id}] pull go2rtc falhou (${ps.fails}): ${e && e.message ? e.message : e}`);
  } finally {
    ps.inflight = false;
  }
}

/** Ronda de pull (@ROUND_MS): descobre streams e puxa as câmeras elegíveis (relay-less OU força). */
function pullTick() {
  if (!pullActive()) return;
  void refreshStreams(); // debounced internamente (@STREAMS_REFRESH_MS)
  if (!go2rtcStreams.size) return;
  const now = Date.now();
  for (const id of go2rtcStreams) {
    const st = states.get(id);
    // ANTI-DOBRA: no modo relay-less, câmera com relé FRESCO não é puxada (já recebe frame de graça).
    // Em ANALYSIS_SOURCE=go2rtc força-se o pull de todas (custo de aquisição redundante assumido).
    if (!PULL_FORCE_ALL && st && now - st.lastRelayAt < PULL_STALE_MS) continue;
    // CADÊNCIA/CONTENÇÃO: se já há frame pronto p/ a próxima rodada, não acumula (o worker consome
    // a ~ROUND_MS via tick — pull mais rápido só sobrescreveria st.latest e gastaria rede à toa).
    if (st && st.latest) continue;
    let ps = pulls.get(id);
    if (!ps) pulls.set(id, (ps = { inflight: false, nextAt: 0, fails: 0 }));
    if (ps.inflight || now < ps.nextAt) continue; // um pull por câmera em voo; respeita o backoff
    void pullFrame(id, ps);
  }
}

function logMinute() {
  if (!states.size) return;
  const parts = [];
  for (const [id, st] of states) {
    const fps = Math.round((st.rounds.length / 60) * 100) / 100;
    const src = st.source === "go2rtc" ? "[g2r]" : "";
    parts.push(`${id}${st.longRange ? "[LR]" : ""}${src}: ${fps}fps ${st.lastMs}ms`);
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
    // F4: ganhou/perdeu linha → recalcula a cadência (câmera com linha amostra a ≥2fps).
    st.roundMs = camcfg.getTripwires(st.id).length ? ROUND_MS_LINE : ROUND_MS;
  } else if (p.kind === "zones") {
    st.zonesAtiv = ativZonesOf(st.id);
    st.zonesExcl = exclZonesOf(st.id); // recarrega a máscara de exclusão na próxima rodada
    st.window = { frames: 0, zones: new Map() }; // janela reinicia com a nova geometria
  } else if (p.kind === "camconfig") {
    st.longRange = longRangeOf(st.id); // F3: liga/desliga o tiling na PRÓXIMA rodada
    // F4: entrou/saiu do modo fadiga → atualiza o contrato anti-duplicação (hub ⇄ cliente).
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

/** GET /api/analysis/status — métricas por câmera (aditivo). */
function status() {
  const perCamera = {};
  for (const [id, st] of states) {
    let dets1m = 0;
    let excluded1m = 0;
    let automasked1m = 0;
    for (const d of st.detsLog) {
      dets1m += d.n;
      excluded1m += d.x || 0;
      automasked1m += d.a || 0;
    }
    perCamera[id] = {
      fps: Math.round((st.rounds.length / 60) * 100) / 100,
      targetFps: st.fadiga ? 0 : st.roundMs === ROUND_MS_LINE ? FPS_LINE : FPS, // F4 (aditivo): cadência efetiva
      queue: (st.busy ? 1 : 0) + (st.latest ? 1 : 0),
      lastMs: st.lastMs,
      dets1m,
      excluded1m, // aditivo: dets de pessoa suprimidas por zona de exclusão em 60s
      longRange: st.longRange, // F3 (aditivo): true = rodada com tiling 2×2 no worker
      fadiga: st.fadiga, // F4 (aditivo): true = câmera modo=fadiga (NÃO analisada no hub)
      source: st.source, // aditivo: origem do último frame ("relay" | "go2rtc")
    };
    // F4 (aditivo): sugestões/supressões da auto-máscara aprendida — TRANSPARÊNCIA. Cada célula
    // vem como rect NORMALIZADO, pronto p/ o operador pintar uma zona de exclusão manual ali.
    if (st.autoMask) {
      perCamera[id].automasked1m = automasked1m; // dets suprimidas pela auto-máscara em 60s
      perCamera[id].autoMask = {
        mode: AUTOMASK_MODE, // "suggest" (só expõe) | "hide" (suprime)
        // células ENFORCED (suprimindo dets) — só no modo "hide"; em "suggest" nada é suprimido.
        suppressed: AUTOMASK_MODE === "hide" ? st.autoMask.suppressed.size : 0,
        suggestions: (st.autoMask.suggestions || []).map((s) => {
          const col = s.cell % AM_COLS;
          const row = Math.floor(s.cell / AM_COLS);
          return {
            x: col / AM_COLS,
            y: row / AM_ROWS,
            w: 1 / AM_COLS,
            h: 1 / AM_ROWS,
            presentPct: Math.round(s.presentPct * 100) / 100,
            jitter: Math.round(s.jitter * 1000) / 1000,
          };
        }),
      };
    }
  }
  return {
    enabled,
    model: path.basename(MODEL_PATH),
    targetFps: FPS,
    lineFps: FPS_LINE, // F4 (aditivo): cadência das câmeras com linha/tripwire
    autoMask: { mode: AUTOMASK_MODE }, // F4 (aditivo): modo global da auto-máscara ("off"|"suggest"|"hide")
    worker: { ready: workerReady, pid: workerPid, respawns, cpuPct },
    // Fonte go2rtc (Fase 3, aditivo): estado do pull p/ diagnóstico.
    go2rtcPull: { active: pullActive(), mode: PULL_FORCE_ALL ? "all" : "relay-less", streams: go2rtcStreams.size },
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
  // Fonte go2rtc (Fase 3): ronda de pull na cadência MAIS RÁPIDA (linha) p/ alimentar 2fps
  // quando a câmera de linha é puxada. Inerte (no-op) enquanto go2rtc estiver desligado
  // (pullActive()=false) — logo, OFF por default sem custo além de um guard por tick.
  timers.push(setInterval(pullTick, Math.min(ROUND_MS, ROUND_MS_LINE)));
  for (const t of timers) if (t.unref) t.unref();
  console.log(
    `[analysis] motor ATIVO — ${modelSpec.label} no hub @${FPS}fps/câmera (linha @${FPS_LINE}fps)` +
      `${AUTOMASK_ON ? ` · auto-máscara=${AUTOMASK_MODE}` : ""} (worker process, CPU EP)`,
  );
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
