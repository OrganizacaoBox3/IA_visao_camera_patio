// ─────────────────────────────────────────────────────────────────────────────
// worker-fadiga.js — processo DEDICADO do pipeline de fadiga no hub (F1a,
// spec-fadiga-no-hub). Fica FORA do pool D-FINE de propósito: o binding do
// onnxruntime-node serializa inferências por processo (um pipeline não pode
// atrasar o outro) e o autoscale mede o CPU do pool — um segundo modelo lá
// dentro viraria "gargalo do detector" falso. Aqui rodam DOIS grafos leves:
//   · YuNet 2023mar (detector de rosto, input FIXO 640×640, BGR 0..255 —
//     variante validada empiricamente: RGB/0..1 não detecta NADA; ver spike);
//   · FaceMesh V2 (478 landmarks, input 256×256 RGB 0..1 — 7,4ms/inf medido).
// Estratégia de crop: o ENGINE manda o bbox do rosto do frame anterior (`box`);
// com box → só o mesh roda (rápido, e o crop SEGUE o rosto — mata a classe
// "rosto saiu do recorte da zona" do cliente). Sem box, ou mesh reprovado
// (sigmoid do presence baixo) → YuNet re-detecta no frame inteiro.
// Worker é STATELESS por frame (respawn barato); o estado (box/risk) é do host.
// LGPD: JPEG efêmero em memória; sai daqui só métrica + pontos (nunca imagem).
// Protocolo IPC (aditivo): {type:"detect", id, cameraId, jpeg, ts, box?} →
//   {id, cameraId, ts, face:{ok, score, box, pts(Float32Array 478*2 norm.)},
//    decodeMs, inferMs} | {id, cameraId, dropped:true} | {id, error}.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");
const { fadigaModelPath } = require("./model-fadiga");

const INTRA_THREADS = Math.max(1, Number(process.env.ANALYSIS_FADIGA_THREADS ?? 2));
const DET_SIZE = 640; // fixo no grafo do YuNet
const MESH_SIZE = 256; // fixo no grafo do FaceMesh
const MESH_POINTS = 478;
const STRIDES = [8, 16, 32];
const DET_SCORE_THR = 0.5; // YuNet: sqrt(cls*obj) — 0.91 medido no posto real
const DET_NMS_IOU = 0.3; // convenção OpenCV p/ YuNet
// sigmoid(presence) mínimo p/ aceitar o mesh SEM re-detectar. Crops de detector no spike
// renderam ~0.4-0.5 até com crop manual folgado; abaixo disto o host re-roda o YuNet.
const MESH_VALID_SIGMOID = 0.35;
const CROP_MARGIN = 1.6; // lado do crop quadrado = 1.6× o maior lado do bbox do rosto

let ort = null;
let sharp = null;
let detSession = null;
let meshSession = null;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function iouXYWH(a, b) {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

/**
 * Decode do YuNet (grades 8/16/32 do input 640): score = sqrt(cls·obj); caixa por célula
 * cx=(col+dx)·s, cy=(row+dy)·s, w=e^dw·s, h=e^dh·s. Devolve [{score, box:[x,y,w,h] 0..1}]
 * pós-NMS (guloso por score). PURO — coberto por teste com tensores sintéticos.
 */
function decodeYunet(outputs, scoreThr = DET_SCORE_THR, iouThr = DET_NMS_IOU) {
  const cand = [];
  for (const s of STRIDES) {
    const cls = outputs[`cls_${s}`].data;
    const obj = outputs[`obj_${s}`].data;
    const bb = outputs[`bbox_${s}`].data;
    const cols = DET_SIZE / s;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.max(0, cls[i]) * Math.max(0, obj[i]));
      if (score < scoreThr) continue;
      const c = i % cols,
        r = Math.floor(i / cols);
      const cx = (c + bb[i * 4]) * s,
        cy = (r + bb[i * 4 + 1]) * s;
      const w = Math.exp(bb[i * 4 + 2]) * s,
        h = Math.exp(bb[i * 4 + 3]) * s;
      cand.push({ score, box: [(cx - w / 2) / DET_SIZE, (cy - h / 2) / DET_SIZE, w / DET_SIZE, h / DET_SIZE] });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const d of cand) if (kept.every((k) => iouXYWH(k.box, d.box) < iouThr)) kept.push(d);
  return kept;
}

/**
 * Crop QUADRADO com margem em volta do bbox do rosto (0..1 do frame), clampado ao frame.
 * Devolve {left, top, size} em PIXELS. PURO — coberto por teste.
 */
function squareCrop(box, W, H, margin = CROP_MARGIN) {
  const cx = (box[0] + box[2] / 2) * W;
  const cy = (box[1] + box[3] / 2) * H;
  let size = Math.max(box[2] * W, box[3] * H) * margin;
  size = Math.min(size, W, H); // nunca maior que o frame
  let left = Math.round(cx - size / 2),
    top = Math.round(cy - size / 2);
  size = Math.round(size);
  left = Math.max(0, Math.min(left, W - size));
  top = Math.max(0, Math.min(top, H - size));
  return { left, top, size };
}

// ── Pré-processamentos (validados empiricamente no spike/probe) ──────────────
async function detTensor(jpeg) {
  const { data } = await sharp(jpeg)
    .resize(DET_SIZE, DET_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = DET_SIZE * DET_SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    // BGR, 0..255 (RGB e/ou 0..1 NÃO detectam — medido)
    f[i] = data[i * 3 + 2];
    f[n + i] = data[i * 3 + 1];
    f[2 * n + i] = data[i * 3];
  }
  return new ort.Tensor("float32", f, [1, 3, DET_SIZE, DET_SIZE]);
}

async function meshTensor(jpeg, crop) {
  const { data } = await sharp(jpeg)
    .extract({ left: crop.left, top: crop.top, width: crop.size, height: crop.size })
    .resize(MESH_SIZE, MESH_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = MESH_SIZE * MESH_SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = data[i * 3] / 255;
    f[n + i] = data[i * 3 + 1] / 255;
    f[2 * n + i] = data[i * 3 + 2] / 255;
  }
  return new ort.Tensor("float32", f, [1, 3, MESH_SIZE, MESH_SIZE]);
}

/** Landmarks crus (px do crop 256) → Float32Array [x0,y0,x1,y1,…] normalizado ao FRAME. */
function meshToFramePts(raw, crop, W, H) {
  const pts = new Float32Array(MESH_POINTS * 2);
  for (let i = 0; i < MESH_POINTS; i++) {
    pts[i * 2] = (crop.left + (raw[i * 3] / MESH_SIZE) * crop.size) / W;
    pts[i * 2 + 1] = (crop.top + (raw[i * 3 + 1] / MESH_SIZE) * crop.size) / H;
  }
  return pts;
}

// ── Fila último-vence por câmera (mesmo padrão do worker.js do D-FINE) ───────
const jobs = new Map();
const order = [];
let draining = false;

function send(msg) {
  try {
    process.send(msg);
  } catch {
    /* pai morreu — supervisor cuida */
  }
}

process.on("message", (msg) => {
  if (!msg || msg.type !== "detect") return;
  const prev = jobs.get(msg.cameraId);
  jobs.set(msg.cameraId, msg);
  if (prev) send({ id: prev.id, cameraId: prev.cameraId, dropped: true });
  else order.push(msg.cameraId);
  void drain();
});

async function drain() {
  if (draining || !meshSession) return;
  draining = true;
  while (order.length) {
    const cameraId = order.shift();
    const job = jobs.get(cameraId);
    jobs.delete(cameraId);
    if (!job) continue;
    try {
      const t0 = performance.now();
      const meta = await sharp(job.jpeg).metadata();
      const W = meta.width,
        H = meta.height;
      let box = Array.isArray(job.box) && job.box.length === 4 ? job.box : null;
      let inferMs = 0;

      if (!box) {
        const dt = await detTensor(job.jpeg);
        const ti = performance.now();
        const out = await detSession.run({ input: dt });
        inferMs += performance.now() - ti;
        const faces = decodeYunet(out);
        box = faces.length ? faces[0].box : null; // 1 operador por posto: a melhor face
      }

      if (!box) {
        send({ id: job.id, cameraId, ts: job.ts, face: { ok: false, score: 0, box: null, pts: null }, decodeMs: Math.round(performance.now() - t0 - inferMs), inferMs: Math.round(inferMs) });
        continue;
      }

      const crop = squareCrop(box, W, H);
      const mt = await meshTensor(job.jpeg, crop);
      const ti2 = performance.now();
      const mo = await meshSession.run({ [meshSession.inputNames[0]]: mt });
      inferMs += performance.now() - ti2;
      const names = meshSession.outputNames; // [landmarks(1434), presence(1), extra(1)]
      const raw = mo[names[0]].data;
      const score = sigmoid(mo[names[1]].data[0]);
      const ok = score >= MESH_VALID_SIGMOID;
      // bbox re-derivado dos PONTOS (segue o rosto p/ o próximo frame — tracking do host)
      let nb = null;
      if (ok) {
        let minX = 1,
          minY = 1,
          maxX = 0,
          maxY = 0;
        const pts = meshToFramePts(raw, crop, W, H);
        for (let i = 0; i < MESH_POINTS; i++) {
          const x = pts[i * 2],
            y = pts[i * 2 + 1];
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
        nb = [minX, minY, maxX - minX, maxY - minY];
        send({
          id: job.id,
          cameraId,
          ts: job.ts,
          face: { ok: true, score, box: nb, pts },
          decodeMs: Math.round(performance.now() - t0 - inferMs),
          inferMs: Math.round(inferMs),
        });
      } else {
        send({ id: job.id, cameraId, ts: job.ts, face: { ok: false, score, box: null, pts: null }, decodeMs: Math.round(performance.now() - t0 - inferMs), inferMs: Math.round(inferMs) });
      }
    } catch (e) {
      send({ id: job.id, cameraId, error: e && e.message ? e.message : String(e) });
    }
  }
  draining = false;
}

// ── Boot (só como processo principal; require em teste NÃO sobe ORT/sharp) ───
if (require.main === module) {
  (async () => {
    try {
      ort = require("onnxruntime-node");
      sharp = require("sharp");
      detSession = await ort.InferenceSession.create(fadigaModelPath("yunet"), {
        executionProviders: ["cpu"],
        intraOpNumThreads: INTRA_THREADS,
      });
      meshSession = await ort.InferenceSession.create(fadigaModelPath("facemesh"), {
        executionProviders: ["cpu"],
        intraOpNumThreads: INTRA_THREADS,
      });
      // warmup: 1º frame real não paga o custo de inicialização dos grafos
      await detSession.run({ input: new ort.Tensor("float32", new Float32Array(3 * DET_SIZE * DET_SIZE), [1, 3, DET_SIZE, DET_SIZE]) });
      await meshSession.run({ [meshSession.inputNames[0]]: new ort.Tensor("float32", new Float32Array(3 * MESH_SIZE * MESH_SIZE), [1, 3, MESH_SIZE, MESH_SIZE]) });
      send({ type: "ready", models: [path.basename(fadigaModelPath("yunet")), path.basename(fadigaModelPath("facemesh"))], cpu: process.cpuUsage() });
      void drain();
    } catch (e) {
      send({ type: "fatal", error: e && e.message ? e.message : String(e) });
      process.exit(1);
    }
  })();
}

module.exports = { decodeYunet, squareCrop, meshToFramePts, sigmoid, DET_SIZE, MESH_SIZE, MESH_POINTS, MESH_VALID_SIGMOID };
