// ─────────────────────────────────────────────────────────────────────────────
// scripts/profile-infer.cjs — PROFILING STANDALONE (Carmack: "measure, don't guess").
//
// NÃO modifica worker.js. Replica EXATAMENTE os estágios do pipeline single-shot do
// server/analysis/worker.js (decode+resize via sharp → tensor CHW fp32 → session.run
// onnxruntime-node CPU intraOpNumThreads=2 → postprocess sigmoid+argmax+NMS) e cronometra
// CADA estágio isoladamente sobre uma imagem de fixture, N vezes (com warmup), reportando
// p50/p95 por estágio × tier (n/s/m) × input (640/512/416).
//
// Uso:   node scripts/profile-infer.cjs [--iters 30] [--tiers n,s,m] [--sizes 640,512,416] [--img <path>]
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const ort = require("onnxruntime-node");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const MODELS = {
  n: path.join(ROOT, "server", "models", "dfine_n_coco.onnx"),
  s: path.join(ROOT, "server", "models", "dfine_s_obj2coco.onnx"),
  m: path.join(ROOT, "server", "models", "dfine_m_obj2coco.onnx"),
};
const INTRA_THREADS = Number(process.env.ANALYSIS_INTRA_THREADS ?? 2);
const SCORE_MIN = 0.25;
const NMS_IOU = 0.6;

// ── args ─────────────────────────────────────────────────────────────────────
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const ITERS = Number(arg("--iters", "30"));
const WARMUP = 3;
const TIERS = arg("--tiers", "n,s,m").split(",").map((s) => s.trim()).filter(Boolean);
const SIZES = arg("--sizes", "640,512,416").split(",").map((s) => Number(s.trim())).filter(Boolean);

// ── fixture: uma imagem COCO + uma versão "produção" 1920×1080 p/ isolar custo de decode ──
const IMAGES_DIR = path.join(ROOT, "eval", "data", "images");
const DEFAULT_IMG = path.join(IMAGES_DIR, "000000000139.jpg");
const IMG = arg("--img", DEFAULT_IMG);

// ── estágios (replicam worker.js linha a linha) ──────────────────────────────
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

function rgbToTensor(data, SIZE) {
  const n = SIZE * SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = data[i * 3] / 255;
    f[n + i] = data[i * 3 + 1] / 255;
    f[2 * n + i] = data[i * 3 + 2] / 255;
  }
  return new ort.Tensor("float32", f, [1, 3, SIZE, SIZE]);
}
function iouXYWH(a, b) {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}
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
    for (const d of arr) if (!kept.some((k) => iouXYWH(k.bbox, d.bbox) > NMS_IOU)) kept.push(d);
    keep.push(...kept);
  }
  return keep;
}
function postprocess(outputs) {
  const logits = outputs.logits;
  const boxes = outputs.pred_boxes;
  const nq = logits.dims[1];
  const nc = logits.dims[2];
  const L = logits.data;
  const B = boxes.data;
  const dets = [];
  for (let q = 0; q < nq; q++) {
    let best = -Infinity, bestC = -1;
    for (let c = 0; c < nc; c++) {
      const v = L[q * nc + c];
      if (v > best) { best = v; bestC = c; }
    }
    const score = sigmoid(best);
    if (score < SCORE_MIN) continue;
    const cx = B[q * 4], cy = B[q * 4 + 1], bw = B[q * 4 + 2], bh = B[q * 4 + 3];
    dets.push({ class: String(bestC), score, bbox: [cx - bw / 2, cy - bh / 2, bw, bh] });
  }
  return nmsPerClass(dets);
}

// ── stats ────────────────────────────────────────────────────────────────────
function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
function summarize(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return { p50: pct(s, 50), p95: pct(s, 95), min: s[0], max: s[s.length - 1], mean: arr.reduce((a, b) => a + b, 0) / arr.length };
}
const f1 = (x) => x.toFixed(1);

// ── run ──────────────────────────────────────────────────────────────────────
async function profile(tier, SIZE, jpegBuf, srcLabel) {
  const modelPath = MODELS[tier];
  if (!fs.existsSync(modelPath)) return { skip: `modelo ausente: ${modelPath}` };

  let session;
  try {
    session = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      intraOpNumThreads: INTRA_THREADS,
    });
  } catch (e) {
    return { skip: `create falhou: ${e.message}` };
  }

  // valida se o modelo aceita este SIZE (input pode ser fixo 640)
  try {
    await session.run({ pixel_values: new ort.Tensor("float32", new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]) });
  } catch (e) {
    await session.release?.();
    return { skip: `input ${SIZE} rejeitado (provável shape fixo): ${String(e.message).slice(0, 80)}` };
  }

  const t = { decodeResize: [], decodeFull: [], tensor: [], infer: [], post: [] };
  let nDets = 0;

  for (let it = 0; it < WARMUP + ITERS; it++) {
    const timed = it >= WARMUP;

    // (a') decode FULL-RES isolado (só p/ saber quanto do estágio 1 é decode puro)
    let s = performance.now();
    await sharp(jpegBuf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (timed) t.decodeFull.push(performance.now() - s);

    // (a) decode+resize FUNDIDO — EXATO como worker.preprocess()
    s = performance.now();
    const { data } = await sharp(jpegBuf).resize(SIZE, SIZE, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (timed) t.decodeResize.push(performance.now() - s);

    // (b) tensor CHW fp32 (rgbToTensor)
    s = performance.now();
    const tensor = rgbToTensor(data, SIZE);
    if (timed) t.tensor.push(performance.now() - s);

    // (c) session.run
    s = performance.now();
    const outputs = await session.run({ pixel_values: tensor });
    if (timed) t.infer.push(performance.now() - s);

    // (d) postprocess/NMS
    s = performance.now();
    const dets = postprocess(outputs);
    if (timed) { t.post.push(performance.now() - s); nDets = dets.length; }
  }

  await session.release?.();
  return {
    decodeResize: summarize(t.decodeResize),
    decodeFull: summarize(t.decodeFull),
    tensor: summarize(t.tensor),
    infer: summarize(t.infer),
    post: summarize(t.post),
    total: summarize(t.decodeResize.map((v, i) => v + t.tensor[i] + t.infer[i] + t.post[i])),
    nDets, srcLabel, SIZE, tier,
  };
}

(async () => {
  const meta = await sharp(fs.readFileSync(IMG)).metadata();
  const jpegSmall = fs.readFileSync(IMG);
  // versão "produção" 1080p (frame de câmera real é ~720p/1080p; COCO é ~640px → decode subestimaria)
  const jpeg1080 = await sharp(jpegSmall).resize(1920, 1080, { fit: "fill" }).jpeg({ quality: 85 }).toBuffer();

  const fixtures = [
    { label: `coco(${meta.width}x${meta.height})`, buf: jpegSmall },
    { label: `prod(1920x1080)`, buf: jpeg1080 },
  ];

  console.log(`\n=== profile-infer — Carmack stage breakdown ===`);
  console.log(`cpus=${require("node:os").cpus().length} · intraOpNumThreads=${INTRA_THREADS} · iters=${ITERS} (warmup ${WARMUP}) · EP=cpu`);
  console.log(`fixture=${path.basename(IMG)} (${meta.width}x${meta.height})  ·  tiers=${TIERS.join(",")}  ·  sizes=${SIZES.join(",")}\n`);

  const rows = [];
  for (const fx of fixtures) {
    for (const tier of TIERS) {
      for (const SIZE of SIZES) {
        const r = await profile(tier, SIZE, fx.buf, fx.label);
        if (r.skip) { console.log(`  [skip] ${tier} @${SIZE} on ${fx.label}: ${r.skip}`); continue; }
        rows.push({ fx: fx.label, ...r });
      }
    }
  }

  // ── TABELA p50/p95 por estágio × tier × input × fixture ─────────────────────
  const H = ["fixture", "tier", "input", "decode+resize", "tensor", "infer(run)", "post/NMS", "TOTAL", "dets"];
  const line = (c) => "| " + c.join(" | ") + " |";
  const cell = (st) => `${f1(st.p50)}/${f1(st.p95)}`;
  console.log(line(H));
  console.log("|" + H.map(() => "---").join("|") + "|");
  for (const r of rows) {
    console.log(line([
      r.fx, r.tier, String(r.SIZE),
      cell(r.decodeResize), cell(r.tensor), cell(r.infer), cell(r.post), cell(r.total), String(r.nDets),
    ]));
  }
  console.log(`\n(valores = p50/p95 em ms. "decode+resize" é o estágio fundido do worker.preprocess; "infer(run)" = session.run.)`);

  // decode puro full-res p/ contexto (quanto do decode+resize é decode vs resize)
  console.log(`\n-- decode FULL-RES isolado (sharp raw, sem resize) — p50/p95 ms --`);
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.fx}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  ${r.fx}: ${cell(r.decodeFull)}`);
  }
})();
