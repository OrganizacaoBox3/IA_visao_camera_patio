// ─────────────────────────────────────────────────────────────────────────────
// worker.js — WORKER PROCESS de inferência D-FINE (ADR-009). Forkado pelo
// worker-host ({serialization:"advanced"}): recebe JPEGs por IPC, devolve
// detecções COCO normalizadas. Arquitetura e dimensionamento: README.md.
//
// POR QUE PROCESSO SEPARADO: o binding do onnxruntime-node SERIALIZA inferências
// dentro de um processo, e um crash nativo do ORT não pode derrubar o hub
// (relé + persistência) — o worker-host respawna com backoff (spike-dfine-hub.md §6).
//
// PRÉ/PÓS: squash SIZE×SIZE (fit:fill — o preprocessor do modelo usa
// RTDetrImageProcessor com do_pad:false, NÃO letterbox), rescale 1/255 SEM
// mean/std → tensor CHW fp32; saídas logits[1,300,80] + pred_boxes[1,300,4]
// (cxcywh normalizado) → sigmoid + argmax + corte de score + NMS por classe
// (o D-FINE emite queries duplicadas no mesmo alvo na faixa 0.25-0.5).
// CPU EP APENAS: DML retorna saída ERRADA e WebGPU crasha nesta família de
// modelo (spike §5). Knobs de QUALIDADE (scoreMin/nmsIou/input/contenção/tiles):
// precision.js — o env é o transporte (o fork herda), o painel interpreta.
//
// PROTOCOLO IPC (advanced serialization — Buffer viaja como binário):
//   engine → worker: { type:"detect", id, cameraId, jpeg:Buffer, w?, h?,
//                      tiles?:{cols,rows,overlap} }   (tiles ausente → squash único)
//   worker → engine: { id, cameraId, dets:[{class, score, bbox:[x,y,w,h] 0..1}],
//                      decodeMs, inferMs, cpu }        (sucesso)
//                    { id, cameraId, dropped:true }     (substituído na fila antes de rodar)
//                    { id, cameraId, error }            (falha neste frame; worker segue vivo)
//   worker → engine: { type:"ready", model, cpu } no boot ·
//                    { type:"fatal", error } se o modelo não carregar (e sai).
//   4 CONSUMIDORES: engine (via worker-host) + eval/run-eval.mjs + eval/gate.mjs
//   + eval/compare-models.mjs — mudança de shape SÓ aditiva.
//
// FILA: último-vence POR CÂMERA (profundidade 1 por câmera); FIFO entre câmeras.
// Frame antigo substituído é respondido com {dropped:true} (libera o slot no engine).
//
// LGPD/ADR-002: o JPEG vive só em memória durante a inferência; NADA é gravado.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");
const { PRECISION } = require("./precision");

const MODEL =
  process.env.ANALYSIS_MODEL_PATH || path.join(__dirname, "..", "models", "dfine_n_coco.onnx");

// Knobs de qualidade — painel de precisão (dono único; sensores documentados lá).
const SIZE = PRECISION.detector.input; // alvo do resize squash (H=W); tiles usam o MESMO input
const SCORE_MIN = PRECISION.detector.scoreMin; // só devolve dets ≥ isto
const NMS_IOU = PRECISION.detector.nmsIou;
const CONTAINMENT_THR = PRECISION.detector.containment; // dedupe do tiling (fuseTiles)
// Custo (não qualidade): threads intra-op do ORT — fica fora do painel.
const INTRA_THREADS = Number(process.env.ANALYSIS_INTRA_THREADS ?? 2);

// id2label do config.json do modelo (onnx-community/dfine_n_coco-ONNX) — COCO 80.
const COCO80 = [
  "person", "bicycle", "car", "motorbike", "aeroplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog",
  "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
  "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
  "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
  "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "sofa", "pottedplant",
  "bed", "diningtable", "toilet", "tvmonitor", "laptop", "mouse", "remote", "keyboard",
  "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
  "scissors", "teddy bear", "hair drier", "toothbrush",
];

let ort = null;
let sharp = null;
let session = null;

function send(msg) {
  if (process.send) process.send(msg);
}

// RGB raw size×size → tensor CHW fp32 [1,3,size,size] (rescale 1/255, sem mean/std).
// size default = SIZE (input global); a câmera FOCADA pode pedir menor (ANALYSIS_FOCUS_INPUT) p/
// inferência mais rápida = overlay mais fresco (07-*). O eixo H/W do ONNX é dinâmico (múltiplo de 32).
function rgbToTensor(data, size = SIZE) {
  const n = size * size;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = data[i * 3] / 255;
    f[n + i] = data[i * 3 + 1] / 255;
    f[2 * n + i] = data[i * 3 + 2] / 255;
  }
  return new ort.Tensor("float32", f, [1, 3, size, size]);
}

// JPEG buffer → tensor CHW fp32 (squash resize, 1/255). size default = SIZE (por-requisição na focada).
async function preprocess(jpegBuf, size = SIZE) {
  const { data } = await sharp(jpegBuf)
    .resize(size, size, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return rgbToTensor(data, size);
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** IoU de bboxes [x,y,w,h] (mesma unidade). */
function iouXYWH(a, b) {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

/** NMS leve POR CLASSE (o D-FINE emite queries duplicadas no mesmo alvo). */
function nmsPerClass(dets) {
  const byClass = new Map();
  for (const d of dets) {
    let arr = byClass.get(d.class);
    if (!arr) byClass.set(d.class, (arr = []));
    arr.push(d);
  }
  const keep = [];
  for (const arr of byClass.values()) {
    arr.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const d of arr) {
      if (!kept.some((k) => iouXYWH(k.bbox, d.bbox) > NMS_IOU)) kept.push(d);
    }
    keep.push(...kept);
  }
  return keep;
}

/** logits+pred_boxes → dets [{class, score, bbox:[x,y,w,h] normalizado 0..1}]. */
function postprocess(outputs) {
  const logits = outputs.logits; // [1, 300, 80]
  const boxes = outputs.pred_boxes; // [1, 300, 4] cxcywh normalizado
  const nq = logits.dims[1];
  const nc = logits.dims[2];
  const L = logits.data;
  const B = boxes.data;
  const dets = [];
  for (let q = 0; q < nq; q++) {
    let best = -Infinity;
    let bestC = -1;
    for (let c = 0; c < nc; c++) {
      const v = L[q * nc + c];
      if (v > best) {
        best = v;
        bestC = c;
      }
    }
    const score = sigmoid(best);
    if (score < SCORE_MIN) continue;
    const cx = B[q * 4];
    const cy = B[q * 4 + 1];
    const bw = B[q * 4 + 2];
    const bh = B[q * 4 + 3];
    dets.push({ class: COCO80[bestC] ?? String(bestC), score, bbox: [cx - bw / 2, cy - bh / 2, bw, bh] });
  }
  return nmsPerClass(dets);
}

// ── Longo alcance: tiling + reprojeção + fusão (espelha src/vision/) ─────────

/** CONTENÇÃO: interseção / área da caixa MENOR (0..1) — port de src/vision/nms.ts. */
function containment(a, b) {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const minArea = Math.min(a[2] * a[3], b[2] * b[3]);
  return minArea > 0 ? inter / minArea : 0;
}

/** Fusão pós-reprojeção: POR CLASSE, guloso do maior score — descarta a caixa com
 *  IoU ≥ NMS_IOU OU contenção ≥ CONTAINMENT_THR contra alguma já mantida. A caixa
 *  PARCIAL do tile vizinho tem IoU BAIXO com a inteira e passaria no NMS clássico —
 *  a contenção mata essa dupla (racional do 0.7: precision.js). */
function fuseTiles(dets) {
  const byClass = new Map();
  for (const d of dets) {
    let arr = byClass.get(d.class);
    if (!arr) byClass.set(d.class, (arr = []));
    arr.push(d);
  }
  const keep = [];
  for (const arr of byClass.values()) {
    arr.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const d of arr) {
      if (kept.every((k) => iouXYWH(k.bbox, d.bbox) <= NMS_IOU && containment(k.bbox, d.bbox) < CONTAINMENT_THR))
        kept.push(d);
    }
    keep.push(...kept);
  }
  return keep;
}

/** Grid em FRAÇÕES do frame (mesma conta do front — src/vision/detect.ts tileGrid). */
function tileGrid(cols, rows, overlap) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const tw = 1 / cols;
  const th = 1 / rows;
  const out = [];
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++)
      out.push({
        x0: clamp(i * tw - overlap * tw),
        y0: clamp(j * th - overlap * th),
        x1: clamp((i + 1) * tw + overlap * tw),
        y1: clamp((j + 1) * th + overlap * th),
      });
  return out;
}

/**
 * Detecção com TILING (perfil longo alcance): decode 1× → extract por tile →
 * squash SIZE/tile → inferências SEQUENCIAIS → reprojeção tile→frame → fusão.
 * Devolve { dets, decodeMs, inferMs } com dets em frações 0..1 do FRAME.
 * Custo: N× inferência por rodada (medição: README.md §Longo alcance).
 */
async function detectTiled(jpegBuf, spec, size = SIZE) {
  const cols = Math.max(1, Math.min(4, Math.round(spec.cols) || 1));
  const rows = Math.max(1, Math.min(4, Math.round(spec.rows) || 1));
  const overlap = Math.max(0, Math.min(0.5, Number(spec.overlap) || 0));

  // decode do JPEG UMA vez p/ raw; cada tile é extract do raw (sem re-decodificar N×)
  let t0 = performance.now();
  const { data, info } = await sharp(jpegBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  let decodeMs = performance.now() - t0;
  let inferMs = 0;

  const all = [];
  for (const t of tileGrid(cols, rows, overlap)) {
    t0 = performance.now();
    const left = Math.max(0, Math.round(t.x0 * W));
    const top = Math.max(0, Math.round(t.y0 * H));
    const width = Math.max(1, Math.min(W - left, Math.round((t.x1 - t.x0) * W)));
    const height = Math.max(1, Math.min(H - top, Math.round((t.y1 - t.y0) * H)));
    const { data: tileRgb } = await sharp(data, { raw: { width: W, height: H, channels: info.channels } })
      .extract({ left, top, width, height })
      .resize(size, size, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const tensor = rgbToTensor(tileRgb, size);
    const t1 = performance.now();
    const outputs = await session.run({ pixel_values: tensor });
    inferMs += performance.now() - t1;
    decodeMs += t1 - t0;
    // reprojeção: frações do TILE → frações do FRAME (mesma conta do detect.ts)
    const tw = t.x1 - t.x0;
    const th = t.y1 - t.y0;
    for (const d of postprocess(outputs)) {
      all.push({
        class: d.class,
        score: d.score,
        bbox: [t.x0 + d.bbox[0] * tw, t.y0 + d.bbox[1] * th, d.bbox[2] * tw, d.bbox[3] * th],
      });
    }
  }
  return { dets: fuseTiles(all), decodeMs: Math.round(decodeMs), inferMs: Math.round(inferMs) };
}

// ── Fila último-vence por câmera ─────────────────────────────────────────────
const order = []; // cameraIds na ordem de chegada (FIFO entre câmeras)
const jobs = new Map(); // cameraId → pedido pendente (profundidade 1)
let draining = false;

process.on("message", (msg) => {
  if (!msg || msg.type !== "detect" || !msg.cameraId || !msg.jpeg) return;
  const prev = jobs.get(msg.cameraId);
  jobs.set(msg.cameraId, msg);
  if (prev) {
    // frame antigo da MESMA câmera ainda não rodou → último-vence (libera o slot no engine)
    send({ id: prev.id, cameraId: prev.cameraId, dropped: true });
  } else {
    order.push(msg.cameraId);
  }
  void drain();
});

async function drain() {
  if (draining || !session) return;
  draining = true;
  while (order.length) {
    const cameraId = order.shift();
    const job = jobs.get(cameraId);
    jobs.delete(cameraId);
    if (!job) continue;
    try {
      // Input por-requisição (câmera FOCADA pede menor p/ inferência rápida = overlay fresco, 07-*).
      // Validado [160,1024]; ausente/inválido → SIZE (input global, comportamento de sempre).
      const size = Number.isFinite(job.input) && job.input >= 160 && job.input <= 1024 ? job.input : SIZE;
      // pedido com `tiles` multi-bloco → tiling (longo alcance); senão, squash único.
      if (job.tiles && (job.tiles.cols > 1 || job.tiles.rows > 1)) {
        const r = await detectTiled(job.jpeg, job.tiles, size);
        send({ id: job.id, cameraId, dets: r.dets, decodeMs: r.decodeMs, inferMs: r.inferMs, cpu: process.cpuUsage() });
      } else {
        const t0 = performance.now();
        const tensor = await preprocess(job.jpeg, size);
        const t1 = performance.now();
        const outputs = await session.run({ pixel_values: tensor });
        const t2 = performance.now();
        send({
          id: job.id,
          cameraId,
          dets: postprocess(outputs),
          decodeMs: Math.round(t1 - t0),
          inferMs: Math.round(t2 - t1),
          cpu: process.cpuUsage(),
        });
      }
    } catch (e) {
      send({ id: job.id, cameraId, error: e && e.message ? e.message : String(e) });
    }
  }
  draining = false;
}

// ── Boot: carrega modelo, faz warmup e anuncia "ready" ───────────────────────
// Só quando o worker é o processo PRINCIPAL (fork do worker-host/eval). Sob require
// (unit test) o boot não roda — nada de ORT/sharp/IPC no processo do teste.
if (require.main === module) {
  (async () => {
    try {
      ort = require("onnxruntime-node");
      sharp = require("sharp");
      session = await ort.InferenceSession.create(MODEL, {
        executionProviders: ["cpu"], // CPU EP only — DML/WebGPU reprovados em paridade (spike §5)
        intraOpNumThreads: INTRA_THREADS,
      });
      // warmup com tensor zerado: o 1º frame real não paga o custo de inicialização do grafo
      await session.run({
        pixel_values: new ort.Tensor("float32", new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]),
      });
      send({ type: "ready", model: path.basename(MODEL), input: SIZE, cpu: process.cpuUsage() });
      void drain(); // pedidos que chegaram durante o load
    } catch (e) {
      send({ type: "fatal", error: e && e.message ? e.message : String(e) });
      process.exit(1);
    }
  })();
}

// Puros exportados SÓ p/ unit test (worker.test.js). NÃO são contrato de runtime —
// o contrato deste processo é o protocolo IPC do cabeçalho.
module.exports = { iouXYWH, nmsPerClass, postprocess, containment, fuseTiles, tileGrid };
