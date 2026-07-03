// ─────────────────────────────────────────────────────────────────────────────
// eval/compare-models.mjs — COMPARA candidatos de UPGRADE do detector no MESMO
// harness de acurácia do MVP, respondendo: "mais capacidade conserta o recall de
// pessoa média/pequena — e a que custo de CPU?".
//
// Reusa o pipeline REAL de produção: dá fork em server/analysis/worker.js UMA VEZ
// POR MODELO (SEQUENCIAL — nunca em paralelo, p/ não brigar com o hub/dev ao vivo),
// passando ANALYSIS_MODEL_PATH=<.onnx>. Como D-FINE-N/S/M obj2coco são a MESMA
// arquitetura (input pixel_values 640, saídas logits[1,300,80]+pred_boxes[1,300,4],
// classes COCO iguais), a troca é só o arquivo .onnx — mesmo pré/pós-processamento.
//
// Mede, por modelo, no modo SQUASH 640 (o de produção):
//   • P/R/F1 por threshold (0.25→0.55) × TAMANHO COCO (S/M/L por área de bbox do GT,
//     <32² / 32²–96² / >96² px) — mesmo matching guloso 1-1, IoU≥0.5 do run-eval.
//   • LATÊNCIA real: inferMs por frame → p50/p95 (1 warmup descartado + medição).
//   • CUSTO CPU real: process.cpuUsage() (user+system) que o worker já devolve,
//     diferença entre frames = core·segundos consumidos naquele frame (captura o
//     multi-thread do ORT intraOpNumThreads=2). @1fps: câmeras/core = 1 / core·s.
//
// Uso:
//   node eval/compare-models.mjs --dataset fixture|full [--models N,S,M]
// Saída: tabela markdown no stdout + eval/model-comparison.json (gitignored).
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL_DIR);
const WORKER = path.join(ROOT, "server", "analysis", "worker.js");
const MODELS_DIR = path.join(ROOT, "server", "models");
const OUT_PATH = path.join(EVAL_DIR, "model-comparison.json");

const THRESHOLDS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
const IOU_MATCH = 0.5;
const SMALL_MAX = 32 * 32;
const MEDIUM_MAX = 96 * 96;
const sizeBucket = (area) => (area < SMALL_MAX ? "S" : area < MEDIUM_MAX ? "M" : "L");

const CATALOG = {
  N: { label: "D-FINE-N (baseline)", file: "dfine_n_coco.onnx" },
  S: { label: "D-FINE-S obj2coco", file: "dfine_s_obj2coco.onnx" },
  M: { label: "D-FINE-M obj2coco", file: "dfine_m_obj2coco.onnx" },
};

const arg = (name, def) =>
  process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def;
const DATASET = arg("--dataset", "fixture");
const WHICH = arg("--models", "N,S,M").split(",").map((s) => s.trim().toUpperCase());

// Dataset: fixture (29, commitado) ou full (300, gitignored).
const DS =
  DATASET === "full"
    ? { manifest: path.join(EVAL_DIR, "manifest.json"), img: path.join(EVAL_DIR, "data", "images") }
    : {
        manifest: path.join(EVAL_DIR, "fixture", "manifest-fixture.json"),
        img: path.join(EVAL_DIR, "fixture", "img"),
      };
const manifest = JSON.parse(fs.readFileSync(DS.manifest, "utf8"));

// ── Worker de produção via IPC (mesmo contrato do engine.js) ─────────────────
function startWorker(modelPath) {
  const w = fork(WORKER, [], {
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, ANALYSIS_SCORE_MIN: "0.25", ANALYSIS_MODEL_PATH: modelPath },
  });
  const pending = new Map();
  let onReady;
  const ready = new Promise((res, rej) => {
    onReady = res;
    w.on("exit", (code) => rej(new Error(`worker saiu com código ${code} antes do ready`)));
  });
  w.on("message", (m) => {
    if (!m) return;
    if (m.type === "ready") onReady(m);
    else if (m.type === "fatal") {
      console.error("worker fatal:", m.error);
      process.exit(1);
    } else if (m.id != null && pending.has(m.id)) {
      const res = pending.get(m.id);
      pending.delete(m.id);
      res(m);
    }
  });
  const detect = (id, jpeg) =>
    new Promise((res) => {
      pending.set(id, res);
      w.send({ type: "detect", id, cameraId: id, jpeg }); // sem tiles → squash 640 (default)
    });
  return { ready, detect, kill: () => w.kill() };
}

// ── Matching guloso por score (1-1, IoU≥thr) — dets e GT em PIXELS ───────────
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
      if (v >= bestIou) {
        bestIou = v;
        best = g;
      }
    }
    if (best >= 0) {
      detMatch[i] = best;
      gtTaken[best] = true;
    }
  }
  return { det: detMatch, gt: gtTaken };
}

// ── Inferência sobre o dataset (1 warmup + medição, SEQUENCIAL) ──────────────
async function runModel(worker, modelKey) {
  const perImage = new Map(); // id → dets person em PIXELS
  const inferMsArr = [];
  const decodeMsArr = [];
  const cpuMsArr = []; // core·ms consumidos por frame (process.cpuUsage delta)
  const all = [...manifest.positives, ...manifest.negatives];

  // Warmup: 1 frame real DESCARTADO (o worker já fez warmup de grafo no boot; este
  // aquece cache/JIT e dá a baseline de cpuUsage p/ o 1º frame medido).
  const warm = await worker.detect(`warm`, fs.readFileSync(path.join(DS.img, all[0].file)));
  let prevCpu = warm.cpu; // {user, system} µs acumulados

  let n = 0;
  for (const im of all) {
    const jpeg = fs.readFileSync(path.join(DS.img, im.file));
    const r = await worker.detect(`${modelKey}-${im.id}`, jpeg);
    if (r.error) throw new Error(`worker error em ${im.file}: ${r.error}`);
    const persons = (r.dets || [])
      .filter((d) => d.class === "person")
      .map((d) => ({
        box: [d.bbox[0] * im.width, d.bbox[1] * im.height, d.bbox[2] * im.width, d.bbox[3] * im.height],
        score: d.score,
      }));
    perImage.set(im.id, persons);
    inferMsArr.push(r.inferMs);
    decodeMsArr.push(r.decodeMs);
    const dUser = r.cpu.user - prevCpu.user;
    const dSys = r.cpu.system - prevCpu.system;
    cpuMsArr.push((dUser + dSys) / 1000); // µs → ms de core·tempo
    prevCpu = r.cpu;
    if (++n % 50 === 0) console.error(`  [${modelKey}] ${n}/${all.length}`);
  }
  return { perImage, inferMsArr, decodeMsArr, cpuMsArr };
}

// ── Métricas por threshold × tamanho ─────────────────────────────────────────
function computeMetrics(perImage) {
  const byThr = {};
  for (const thr of THRESHOLDS) {
    const acc = {
      all: { tp: 0, fp: 0, fn: 0 },
      S: { tp: 0, fp: 0, fn: 0 },
      M: { tp: 0, fp: 0, fn: 0 },
      L: { tp: 0, fp: 0, fn: 0 },
    };
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
    let fpEmpty = 0;
    let imgsWithFp = 0;
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
    byThr[thr] = {
      all: prf(acc.all),
      S: prf(acc.S),
      M: prf(acc.M),
      L: prf(acc.L),
      empty: { fpDets: fpEmpty, imgsWithFp, fpPerImage: fpEmpty / manifest.negatives.length },
    };
  }
  return byThr;
}

const pctl = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(q * (s.length - 1)));
  return s[i];
};
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

// ── main ─────────────────────────────────────────────────────────────────────
const results = {
  ranAt: new Date().toISOString(),
  host: { cores: (await import("node:os")).cpus().length, node: process.version },
  dataset: {
    which: DATASET,
    positives: manifest.positives.length,
    negatives: manifest.negatives.length,
    gtPersons: manifest.positives.reduce((s, p) => s + p.gt.length, 0),
  },
  mode: "squash-640",
  iouMatch: IOU_MATCH,
  intraOpThreads: 2,
  models: {},
};

for (const key of WHICH) {
  const spec = CATALOG[key];
  if (!spec) {
    console.error(`modelo desconhecido: ${key} (use N/S/M)`);
    continue;
  }
  const modelPath = path.join(MODELS_DIR, spec.file);
  if (!fs.existsSync(modelPath)) {
    console.error(`.onnx ausente: ${modelPath} — pulando ${key}`);
    continue;
  }
  console.error(`\n=== ${key} · ${spec.label} · ${spec.file} ===`);
  const worker = startWorker(modelPath);
  const info = await worker.ready;
  console.error(`worker pronto (modelo ${info.model}) — ${DATASET} ${manifest.positives.length}+${manifest.negatives.length}, squash 640`);

  const { perImage, inferMsArr, decodeMsArr, cpuMsArr } = await runModel(worker, key);
  worker.kill();

  const byThr = computeMetrics(perImage);
  const cpuMsMean = mean(cpuMsArr);
  const coreSecPerFrame = cpuMsMean / 1000; // core·segundos por frame @1fps
  const camerasPerCore = 1 / coreSecPerFrame;

  results.models[key] = {
    label: spec.label,
    file: spec.file,
    latency: {
      inferMs_p50: Math.round(pctl(inferMsArr, 0.5)),
      inferMs_p95: Math.round(pctl(inferMsArr, 0.95)),
      inferMs_mean: +mean(inferMsArr).toFixed(1),
      decodeMs_mean: +mean(decodeMsArr).toFixed(1),
    },
    cost: {
      cpuMs_per_frame_mean: +cpuMsMean.toFixed(1),
      cpuMs_p50: Math.round(pctl(cpuMsArr, 0.5)),
      cpuMs_p95: Math.round(pctl(cpuMsArr, 0.95)),
      coreSec_per_frame: +coreSecPerFrame.toFixed(3),
      cameras_per_core_1fps: +camerasPerCore.toFixed(2),
    },
    byThreshold: byThr,
  };

  const at = (t) => byThr[t];
  console.error(
    `  R@0.25 all=${(at(0.25).all.r * 100).toFixed(0)}% S=${(at(0.25).S.r * 100).toFixed(0)}% M=${(at(0.25).M.r * 100).toFixed(0)}% L=${(at(0.25).L.r * 100).toFixed(0)}% | ` +
      `F1@0.35=${(at(0.35).all.f1 * 100).toFixed(0)}% | infer p50=${Math.round(pctl(inferMsArr, 0.5))}ms p95=${Math.round(pctl(inferMsArr, 0.95))}ms | ` +
      `cpu=${cpuMsMean.toFixed(0)}ms/frame → ${camerasPerCore.toFixed(1)} cam/core`,
  );
}

fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 1) + "\n");

// ── Tabela comparativa markdown ──────────────────────────────────────────────
const pct = (v) => (v * 100).toFixed(0);
const row = (k) => {
  const m = results.models[k];
  if (!m) return "";
  const a25 = m.byThreshold[0.25];
  const a35 = m.byThreshold[0.35];
  return [
    k,
    m.label,
    `${pct(a25.S.r)}/${pct(a25.M.r)}/${pct(a25.L.r)}`,
    `${pct(a35.S.r)}/${pct(a35.M.r)}/${pct(a35.L.r)}`,
    `${pct(a25.all.r)}`,
    `${pct(a35.all.f1)}`,
    `${pct(a35.all.p)}`,
    `${m.latency.inferMs_p50}/${m.latency.inferMs_p95}`,
    `${m.cost.cpuMs_per_frame_mean}`,
    `${m.cost.cameras_per_core_1fps}`,
  ].join(" | ");
};
console.log(`\n## Comparativo N vs S vs M — dataset ${DATASET} (${manifest.positives.length}+${manifest.negatives.length}), squash 640, CPU EP 2 threads\n`);
console.log("| key | modelo | R S/M/L @0.25 | R S/M/L @0.35 | R all@0.25 | F1@0.35 | P@0.35 | infer p50/p95 ms | cpu ms/frame | cam/core @1fps |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const k of WHICH) if (results.models[k]) console.log(`| ${row(k)} |`);
console.log(`\nResultados completos: ${OUT_PATH}`);
