// ─────────────────────────────────────────────────────────────────────────────
// scripts/spike-yolo.cjs — SPIKE ISOLADO (zero mudança de produto): mede se um
// YOLO nano ONNX (conv, end-to-end/NMS-free) bate o D-FINE (transformer) em CPU
// no NOSSO caso — latência nesta máquina + acurácia de PESSOA no nosso eval set.
//
// Metodologia (replicada de scripts/profile-infer.cjs e eval/compare-models.mjs):
//   • LATÊNCIA: sharp decode+resize → tensor CHW fp32 /255 → session.run
//     (onnxruntime-node CPU, intraOpNumThreads=2) → decode saída. p50/p95 de
//     25 iterações (3 warmup), fixture 1080p (mesma do profile-infer: COCO
//     000000000139.jpg re-encodada 1920×1080 q85). D-FINE N/S medidos
//     BACK-TO-BACK na mesma sessão → razões honestas mesmo sob contenção.
//   • ACURÁCIA: mesmas 300 imagens do eval full-set (eval/manifest.json,
//     150 positivas + 150 vazias, 591 GT person), MESMO matching guloso 1-1
//     IoU≥0.5 e MESMOS thresholds 0.25→0.55 do run-eval/compare-models.
//     Uma passada a score≥0.25 serve todas as curvas (YOLOv10 é NMS-free:
//     filtrar por threshold depois ≡ rodar com conf=thr).
//   • CUSTO CPU: process.cpuUsage() delta por frame (core·ms) → cam/core @1fps,
//     idêntico ao compare-models.mjs.
//
// Preprocess por família (o que cada modelo PEDE):
//   • YOLOv10: letterbox 640 (fit contain, pad cinza 114) — export Ultralytics.
//     Saída output0 [1,300,6] = (x1,y1,x2,y2,score,cls) em px do input 640;
//     boxes des-letterboxadas de volta a px da imagem original p/ o matching.
//   • D-FINE: squash 640 (fit fill) — pipeline de produção (worker.js).
//
// Modelos YOLO (baixados no scratchpad — NÃO entram no repo):
//   https://huggingface.co/onnx-community/yolov10n  (onnx/model.onnx, fp32)
//   https://huggingface.co/onnx-community/yolov10s  (onnx/model.onnx, fp32)
//   Licença: YOLOv10 (THU-MIG) = AGPL-3.0 — implicação comercial relevante!
//
// Uso:
//   node scripts/spike-yolo.cjs [--latency] [--accuracy] [--models v10n,v10s,dfine-n,dfine-s]
//   (sem flags: roda os dois estágios; latência só p/ os modelos pedidos)
// Saída: tabelas markdown no stdout + <scratchpad>/spike-yolo-results.json
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const ort = require("onnxruntime-node");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const SCRATCH = process.env.SPIKE_SCRATCH ||
  "C:/Users/crist/AppData/Local/Temp/claude/C--Users-crist-grendene-cd-inovacao-visao-computacional-mvp/4d25e2e4-e55e-413d-b81b-a5979604c8ef/scratchpad";
const IMAGES_DIR = path.join(ROOT, "eval", "data", "images");
const MANIFEST = path.join(ROOT, "eval", "manifest.json");
const FIXTURE_IMG = path.join(IMAGES_DIR, "000000000139.jpg"); // mesma do profile-infer
const OUT_JSON = path.join(SCRATCH, "spike-yolo-results.json");

const INTRA_THREADS = Number(process.env.ANALYSIS_INTRA_THREADS ?? 2);
const SCORE_MIN = 0.25;
const NMS_IOU = 0.6; // só D-FINE (YOLOv10 é NMS-free)
const IOU_MATCH = 0.5;
const THRESHOLDS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
const ITERS = 25;
const WARMUP = 3;
const SIZE = 640; // input fixo dos 4 modelos (verificado: 480 é rejeitado)

const SMALL_MAX = 32 * 32;
const MEDIUM_MAX = 96 * 96;
const sizeBucket = (a) => (a < SMALL_MAX ? "S" : a < MEDIUM_MAX ? "M" : "L");

// ── catálogo ─────────────────────────────────────────────────────────────────
const CATALOG = {
  "v10n": { label: "YOLOv10n e2e (AGPL-3.0)", file: path.join(SCRATCH, "models", "yolov10n.onnx"), family: "yolov10" },
  "v10s": { label: "YOLOv10s e2e (AGPL-3.0)", file: path.join(SCRATCH, "models", "yolov10s.onnx"), family: "yolov10" },
  "dfine-n": { label: "D-FINE-N coco (Apache-2.0)", file: path.join(ROOT, "server", "models", "dfine_n_coco.onnx"), family: "dfine" },
  "dfine-s": { label: "D-FINE-S obj2coco (Apache-2.0)", file: path.join(ROOT, "server", "models", "dfine_s_obj2coco.onnx"), family: "dfine" },
};

// ── args ─────────────────────────────────────────────────────────────────────
const argHas = (n) => process.argv.includes(n);
const argVal = (n, d) => (argHas(n) && process.argv[process.argv.indexOf(n) + 1]) || d;
const DO_LAT = argHas("--latency") || !argHas("--accuracy");
const DO_ACC = argHas("--accuracy") || !argHas("--latency");
const WHICH = argVal("--models", "v10n,v10s,dfine-n,dfine-s").split(",").map((s) => s.trim()).filter(Boolean);

// ── preprocess ───────────────────────────────────────────────────────────────
async function preprocess(jpegBuf, family) {
  if (family === "dfine") {
    // squash (worker.preprocess exato)
    const { data } = await sharp(jpegBuf).resize(SIZE, SIZE, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data };
  }
  // letterbox (o que o export Ultralytics do YOLOv10 pede): contain + pad 114
  const { data } = await sharp(jpegBuf)
    .resize(SIZE, SIZE, { fit: "contain", background: { r: 114, g: 114, b: 114 } })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data };
}
function rgbToTensor(data) {
  const n = SIZE * SIZE;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = data[i * 3] / 255;
    f[n + i] = data[i * 3 + 1] / 255;
    f[2 * n + i] = data[i * 3 + 2] / 255;
  }
  return new ort.Tensor("float32", f, [1, 3, SIZE, SIZE]);
}

// ── postprocess D-FINE (cópia fiel do profile-infer/worker) ──────────────────
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
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
/** dets D-FINE: bbox NORMALIZADA [x,y,w,h] 0..1, class = índice COCO80 (0=person) */
function postDfine(outputs) {
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
    dets.push({ class: bestC, score, bbox: [cx - bw / 2, cy - bh / 2, bw, bh] });
  }
  return nmsPerClass(dets);
}
/** dets YOLOv10: output0 [1,300,6] (x1,y1,x2,y2,score,cls) em px do input 640.
 *  Sem NMS (head one-to-one). bbox devolvida em px do INPUT 640 [x,y,w,h]. */
function postYolo10(outputs) {
  const o = outputs.output0;
  const D = o.data;
  const n = o.dims[1];
  const dets = [];
  for (let i = 0; i < n; i++) {
    const s = D[i * 6 + 4];
    if (s < SCORE_MIN) continue;
    const x1 = D[i * 6], y1 = D[i * 6 + 1], x2 = D[i * 6 + 2], y2 = D[i * 6 + 3];
    dets.push({ class: D[i * 6 + 5] | 0, score: s, bbox: [x1, y1, x2 - x1, y2 - y1] });
  }
  return dets;
}
const POST = { dfine: postDfine, yolov10: postYolo10 };

// ── conversão det → px da imagem original (p/ matching com GT) ───────────────
function detsToPixels(dets, family, W, H) {
  const persons = [];
  for (const d of dets) {
    if (d.class !== 0) continue; // COCO 0 = person (mesmo índice nas duas famílias)
    if (family === "dfine") {
      persons.push({ box: [d.bbox[0] * W, d.bbox[1] * H, d.bbox[2] * W, d.bbox[3] * H], score: d.score });
    } else {
      // desfaz o letterbox: scale = min(640/W, 640/H); pad centrado (como o sharp 'contain')
      const scale = Math.min(SIZE / W, SIZE / H);
      const padX = (SIZE - W * scale) / 2;
      const padY = (SIZE - H * scale) / 2;
      persons.push({
        box: [(d.bbox[0] - padX) / scale, (d.bbox[1] - padY) / scale, d.bbox[2] / scale, d.bbox[3] / scale],
        score: d.score,
      });
    }
  }
  return persons;
}

// ── matching + métricas (cópia fiel do compare-models.mjs) ───────────────────
function iou(a, b) {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}
function matchGreedy(dets, gts) {
  const detMatch = new Array(dets.length).fill(-1);
  const gtTaken = new Array(gts.length).fill(false);
  const order = dets.map((_, i) => i).sort((a, b) => dets[b].score - dets[a].score);
  for (const i of order) {
    let best = -1;
    let bestIou = IOU_MATCH;
    for (let g = 0; g < gts.length; g++) {
      if (gtTaken[g]) continue;
      const v = iou(dets[i].box, gts[g]);
      if (v >= bestIou) { bestIou = v; best = g; }
    }
    if (best >= 0) { detMatch[i] = best; gtTaken[best] = true; }
  }
  return { det: detMatch, gt: gtTaken };
}
function computeMetrics(perImage, manifest) {
  const byThr = {};
  for (const thr of THRESHOLDS) {
    const acc = { all: { tp: 0, fp: 0, fn: 0 }, S: { tp: 0, fp: 0, fn: 0 }, M: { tp: 0, fp: 0, fn: 0 }, L: { tp: 0, fp: 0, fn: 0 } };
    for (const im of manifest.positives) {
      const dets = perImage.get(im.id).filter((d) => d.score >= thr);
      const m = matchGreedy(dets, im.gt);
      for (let i = 0; i < dets.length; i++) {
        if (m.det[i] >= 0) {
          acc.all.tp++;
          acc[sizeBucket(im.gt[m.det[i]][2] * im.gt[m.det[i]][3])].tp++;
        } else {
          acc.all.fp++;
          acc[sizeBucket(dets[i].box[2] * dets[i].box[3])].fp++;
        }
      }
      for (let g = 0; g < im.gt.length; g++)
        if (!m.gt[g]) {
          acc.all.fn++;
          acc[sizeBucket(im.gt[g][2] * im.gt[g][3])].fn++;
        }
    }
    let fpEmpty = 0, imgsWithFp = 0;
    for (const im of manifest.negatives) {
      const k = perImage.get(im.id).filter((d) => d.score >= thr).length;
      fpEmpty += k;
      if (k) imgsWithFp++;
    }
    const prf = (a) => {
      const p = a.tp + a.fp ? a.tp / (a.tp + a.fp) : 1;
      const r = a.tp + a.fn ? a.tp / (a.tp + a.fn) : 0;
      return { ...a, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
    };
    byThr[thr] = { all: prf(acc.all), S: prf(acc.S), M: prf(acc.M), L: prf(acc.L), empty: { fpDets: fpEmpty, imgsWithFp, fpPerImage: fpEmpty / manifest.negatives.length } };
  }
  return byThr;
}

// ── stats ────────────────────────────────────────────────────────────────────
const pctl = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const f1fmt = (x) => x.toFixed(1);

// ── LATÊNCIA (metodologia profile-infer, fixture 1080p, back-to-back) ────────
async function profileLatency(key) {
  const spec = CATALOG[key];
  const session = await ort.InferenceSession.create(spec.file, { executionProviders: ["cpu"], intraOpNumThreads: INTRA_THREADS });
  const inputName = session.inputNames[0];
  const jpegSmall = fs.readFileSync(FIXTURE_IMG);
  const jpeg1080 = await sharp(jpegSmall).resize(1920, 1080, { fit: "fill" }).jpeg({ quality: 85 }).toBuffer();

  const t = { decodeResize: [], tensor: [], infer: [], post: [] };
  let nDets = 0;
  for (let it = 0; it < WARMUP + ITERS; it++) {
    const timed = it >= WARMUP;
    let s = performance.now();
    const { data } = await preprocess(jpeg1080, spec.family);
    if (timed) t.decodeResize.push(performance.now() - s);
    s = performance.now();
    const tensor = rgbToTensor(data);
    if (timed) t.tensor.push(performance.now() - s);
    s = performance.now();
    const outputs = await session.run({ [inputName]: tensor });
    if (timed) t.infer.push(performance.now() - s);
    s = performance.now();
    const dets = POST[spec.family](outputs);
    if (timed) { t.post.push(performance.now() - s); nDets = dets.length; }
  }
  await session.release?.();
  const sum = (k) => ({ p50: pctl(t[k], 0.5), p95: pctl(t[k], 0.95) });
  const totals = t.decodeResize.map((v, i) => v + t.tensor[i] + t.infer[i] + t.post[i]);
  return {
    decodeResize: sum("decodeResize"), tensor: sum("tensor"), infer: sum("infer"), post: sum("post"),
    total: { p50: pctl(totals, 0.5), p95: pctl(totals, 0.95) }, nDets,
  };
}

// ── ACURÁCIA (full-set, mesma passada única a 0.25) ──────────────────────────
async function runAccuracy(key, manifest) {
  const spec = CATALOG[key];
  const session = await ort.InferenceSession.create(spec.file, { executionProviders: ["cpu"], intraOpNumThreads: INTRA_THREADS });
  const inputName = session.inputNames[0];
  const perImage = new Map();
  const cpuMsArr = [];
  const inferMsArr = [];
  const all = [...manifest.positives, ...manifest.negatives];

  // warmup: 1 frame descartado (baseline do cpuUsage)
  {
    const jpeg = fs.readFileSync(path.join(IMAGES_DIR, all[0].file));
    const { data } = await preprocess(jpeg, spec.family);
    await session.run({ [inputName]: rgbToTensor(data) });
  }
  let prevCpu = process.cpuUsage();

  let n = 0;
  for (const im of all) {
    const jpeg = fs.readFileSync(path.join(IMAGES_DIR, im.file));
    const { data } = await preprocess(jpeg, spec.family);
    const tensor = rgbToTensor(data);
    const s = performance.now();
    const outputs = await session.run({ [inputName]: tensor });
    inferMsArr.push(performance.now() - s);
    const dets = POST[spec.family](outputs);
    perImage.set(im.id, detsToPixels(dets, spec.family, im.width, im.height));
    const cpu = process.cpuUsage();
    cpuMsArr.push((cpu.user - prevCpu.user + cpu.system - prevCpu.system) / 1000);
    prevCpu = cpu;
    if (++n % 50 === 0) console.error(`  [${key}] ${n}/${all.length}`);
  }
  await session.release?.();
  const byThr = computeMetrics(perImage, manifest);
  const cpuMsMean = mean(cpuMsArr);
  return {
    byThreshold: byThr,
    inferMs_p50: Math.round(pctl(inferMsArr, 0.5)),
    inferMs_p95: Math.round(pctl(inferMsArr, 0.95)),
    cpuMs_per_frame_mean: +cpuMsMean.toFixed(1),
    cameras_per_core_1fps: +(1000 / cpuMsMean).toFixed(2),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const results = {
    ranAt: new Date().toISOString(),
    host: { cores: os.cpus().length, cpu: os.cpus()[0]?.model, node: process.version },
    intraOpThreads: INTRA_THREADS, size: SIZE, iouMatch: IOU_MATCH,
    dataset: { positives: manifest.positives.length, negatives: manifest.negatives.length, gtPersons: manifest.positives.reduce((s, p) => s + p.gt.length, 0) },
    latency: {}, accuracy: {},
  };

  for (const key of WHICH) {
    const spec = CATALOG[key];
    if (!spec || !fs.existsSync(spec.file)) { console.error(`[skip] ${key}: modelo ausente (${spec?.file})`); continue; }
    const mb = (fs.statSync(spec.file).size / 1024 / 1024).toFixed(1);
    console.error(`\n=== ${key} · ${spec.label} · ${mb}MB ===`);

    if (DO_LAT) {
      const lat = await profileLatency(key);
      results.latency[key] = { ...lat, modelMB: +mb };
      console.error(`  latency 1080p→${SIZE}: decode+resize ${f1fmt(lat.decodeResize.p50)}/${f1fmt(lat.decodeResize.p95)} · tensor ${f1fmt(lat.tensor.p50)} · infer ${f1fmt(lat.infer.p50)}/${f1fmt(lat.infer.p95)} · post ${f1fmt(lat.post.p50)} · TOTAL ${f1fmt(lat.total.p50)}/${f1fmt(lat.total.p95)} ms (dets=${lat.nDets})`);
    }
    if (DO_ACC) {
      const acc = await runAccuracy(key, manifest);
      results.accuracy[key] = { ...acc, modelMB: +mb };
      const at = (t) => acc.byThreshold[t];
      console.error(
        `  acc: R@0.25 all=${(at(0.25).all.r * 100).toFixed(0)}% S/M/L=${(at(0.25).S.r * 100).toFixed(0)}/${(at(0.25).M.r * 100).toFixed(0)}/${(at(0.25).L.r * 100).toFixed(0)} | F1@0.35=${(at(0.35).all.f1 * 100).toFixed(0)}% | cpu=${acc.cpuMs_per_frame_mean}ms/frame → ${acc.cameras_per_core_1fps} cam/core`,
      );
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 1) + "\n");

  // ── tabelas markdown ───────────────────────────────────────────────────────
  const pc = (v) => (v * 100).toFixed(0);
  if (DO_LAT) {
    console.log(`\n## Latência — fixture 1080p → ${SIZE}, CPU EP, intraOp=${INTRA_THREADS}, ${ITERS} iters (p50/p95 ms), back-to-back\n`);
    console.log("| modelo | MB | decode+resize | tensor | infer(run) | post | TOTAL |");
    console.log("|---|---|---|---|---|---|---|");
    for (const key of WHICH) {
      const l = results.latency[key];
      if (!l) continue;
      const c = (st) => `${f1fmt(st.p50)}/${f1fmt(st.p95)}`;
      console.log(`| ${CATALOG[key].label} | ${l.modelMB} | ${c(l.decodeResize)} | ${c(l.tensor)} | ${c(l.infer)} | ${c(l.post)} | **${c(l.total)}** |`);
    }
  }
  if (DO_ACC) {
    console.log(`\n## Acurácia person — full-set ${results.dataset.positives}+${results.dataset.negatives} (${results.dataset.gtPersons} GT), matching guloso IoU≥${IOU_MATCH}\n`);
    console.log("| modelo | thr | P | R | F1 | R S/M/L | FP vazias (dets/imgs) |");
    console.log("|---|---|---|---|---|---|---|");
    for (const key of WHICH) {
      const a = results.accuracy[key];
      if (!a) continue;
      for (const thr of THRESHOLDS) {
        const m = a.byThreshold[thr];
        console.log(`| ${key} | ${thr.toFixed(2)} | ${pc(m.all.p)} | ${pc(m.all.r)} | ${pc(m.all.f1)} | ${pc(m.S.r)}/${pc(m.M.r)}/${pc(m.L.r)} | ${m.empty.fpDets}/${m.empty.imgsWithFp} |`);
      }
    }
    console.log(`\n| modelo | best F1 (thr) | R@bestF1 | P@bestF1 | infer full-set p50/p95 ms | cpu ms/frame | cam/core @1fps |`);
    console.log("|---|---|---|---|---|---|---|");
    for (const key of WHICH) {
      const a = results.accuracy[key];
      if (!a) continue;
      let best = THRESHOLDS[0];
      for (const t of THRESHOLDS) if (a.byThreshold[t].all.f1 > a.byThreshold[best].all.f1) best = t;
      const m = a.byThreshold[best];
      console.log(`| ${CATALOG[key].label} | ${pc(m.all.f1)}% (@${best}) | ${pc(m.all.r)}% | ${pc(m.all.p)}% | ${a.inferMs_p50}/${a.inferMs_p95} | ${a.cpuMs_per_frame_mean} | ${a.cameras_per_core_1fps} |`);
    }
  }
  console.log(`\nResultados completos: ${OUT_JSON}`);
})().catch((e) => { console.error(e); process.exit(1); });
