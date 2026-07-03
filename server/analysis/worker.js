// ─────────────────────────────────────────────────────────────────────────────
// worker.js — WORKER PROCESS de inferência D-FINE-N (F1 do plano-analise-server-side,
// ADR-009). Roda via child_process.fork({serialization:"advanced"}) a partir do
// engine.js: recebe JPEGs por IPC, devolve detecções COCO normalizadas.
//
// POR QUE UM PROCESSO SEPARADO (spike §6): o binding do onnxruntime-node
// SERIALIZA inferências dentro de um processo Node; além disso, um crash nativo
// do ORT não pode derrubar o hub (relé + persistência). O engine respawna este
// worker com backoff se ele morrer.
//
// PRÉ/PÓS-PROCESSAMENTO — reaproveitado DO SPIKE VALIDADO (spike-dfine/infer.mjs):
//   • decode JPEG via sharp → resize 640×640 "squash" (fit:fill — o
//     preprocessor_config do modelo usa RTDetrImageProcessor com do_pad:false,
//     NÃO letterbox) → rescale 1/255, SEM mean/std → tensor CHW fp32.
//   • saídas: logits [1,300,80] + pred_boxes [1,300,4] (cxcywh NORMALIZADO) →
//     sigmoid + argmax por query + corte de score + NMS leve por classe (a
//     D-FINE-N emite queries duplicadas no mesmo alvo na faixa 0.25-0.5 —
//     spike §4.3).
//   • CPU EP APENAS: DML retorna saída ERRADA e WebGPU crasha nesta família de
//     modelo (spike §5). intraOpNumThreads=2 (~2,7× mais eficiente por frame
//     que o default; latência ~178ms serve folgado a 1-2fps — spike §3).
//
// PROTOCOLO IPC (advanced serialization — Buffer viaja como binário):
//   engine → worker: { type:"detect", id, cameraId, jpeg:Buffer, w?, h? }
//   worker → engine: { id, cameraId, dets:[{class, score, bbox:[x,y,w,h] 0..1}],
//                      decodeMs, inferMs, cpu }        (sucesso)
//                    { id, cameraId, dropped:true }     (substituído na fila antes de rodar)
//                    { id, cameraId, error }            (falha neste frame; worker segue vivo)
//   worker → engine: { type:"ready", model, cpu } no boot ·
//                    { type:"fatal", error } se o modelo não carregar (e sai).
//
// FILA: último-vence POR CÂMERA (profundidade 1 por câmera) — se chega um frame
// novo de uma câmera cujo pedido ainda não rodou, o antigo é descartado e
// respondido com {dropped:true}. Entre câmeras, FIFO.
//
// LGPD/ADR-002: o JPEG vive só em memória durante a inferência; NADA é gravado.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");

const MODEL =
  process.env.ANALYSIS_MODEL_PATH || path.join(__dirname, "..", "models", "dfine_n_coco.onnx");
const SIZE = 640; // input nativo do D-FINE-N
const SCORE_MIN = Number(process.env.ANALYSIS_SCORE_MIN ?? 0.25); // só devolve dets ≥ isto
const NMS_IOU = Number(process.env.ANALYSIS_NMS_IOU ?? 0.6);
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

// JPEG buffer → tensor CHW fp32 [1,3,640,640] (squash resize, 1/255 — igual ao spike).
async function preprocess(jpegBuf) {
  const { data } = await sharp(jpegBuf)
    .resize(SIZE, SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = SIZE * SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = data[i * 3] / 255;
    f[n + i] = data[i * 3 + 1] / 255;
    f[2 * n + i] = data[i * 3 + 2] / 255;
  }
  return new ort.Tensor("float32", f, [1, 3, SIZE, SIZE]);
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

/** NMS leve POR CLASSE (spike §4.3: a nano emite queries duplicadas no mesmo alvo). */
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
      const t0 = performance.now();
      const tensor = await preprocess(job.jpeg);
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
    } catch (e) {
      send({ id: job.id, cameraId, error: e && e.message ? e.message : String(e) });
    }
  }
  draining = false;
}

// ── Boot: carrega modelo, faz warmup e anuncia "ready" ───────────────────────
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
    send({ type: "ready", model: path.basename(MODEL), cpu: process.cpuUsage() });
    void drain(); // pedidos que chegaram durante o load
  } catch (e) {
    send({ type: "fatal", error: e && e.message ? e.message : String(e) });
    process.exit(1);
  }
})();
