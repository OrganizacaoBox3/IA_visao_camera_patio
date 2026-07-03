// ─────────────────────────────────────────────────────────────────────────────
// eval/run-eval.mjs — ONDA 1 (plano-acuracia-modelos §1.1/§1.3): harness de
// acurácia que mede o pipeline REAL de produção.
//
// Como mede o pipeline real: dá fork no PRÓPRIO server/analysis/worker.js
// (decode sharp → squash 640 → D-FINE-N ONNX/CPU → sigmoid+argmax → score≥0.25 →
// NMS por classe; modo tiling 2×2 overlap 0.1 = o perfil longRange do motor) e
// manda os JPEGs pelo MESMO protocolo IPC do engine. Nada é reimplementado.
// Filtrar por threshold DEPOIS do NMS ≡ rodar com SCORE_MIN=thr (o NMS/fusão só
// suprime caixa de score menor), então uma passada a 0.25 serve todas as curvas.
//
// Métricas (matching guloso por score, 1-1, IoU≥0.5 — det "person" × GT person):
//   • P/R/F1 por threshold (0.25→0.55, passo 0.05) × tamanho COCO (S/M/L por área
//     de bbox: <32², 32²–96², >96² px). Recall por bucket do GT; precisão por
//     bucket usa TP no bucket do GT casado e FP no bucket do det (aproximação
//     honesta — o "all" é exato).
//   • FP nas 150 imagens SEM pessoa, por threshold (dets person = tudo é FP).
//   • Piores erros COM imagem: top-15 FPs (maior score, sem GT com IoU≥0.5) e
//     top-15 misses (GT sem det mesmo a 0.25, maior área) → PNGs anotados em
//     eval/data/errors/ (verde = GT · ciano = det ok · vermelho = FP · laranja = miss).
//
// Uso:   node eval/run-eval.mjs [--mode squash|tiled|both] [--no-errors]
// Saída: tabelas markdown no stdout + eval/last-results.json (gitignored).
// Pré-requisitos: node eval/fetch-dataset.mjs (dataset) + modelo em
// server/models/ (o hub baixa no 1º boot com ANALYSIS_ENABLED=1 — ver
// server/analysis/README.md).
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL_DIR);
const WORKER = path.join(ROOT, "server", "analysis", "worker.js");
const MODEL = process.env.ANALYSIS_MODEL_PATH || path.join(ROOT, "server", "models", "dfine_n_coco.onnx");
const IMAGES_DIR = path.join(EVAL_DIR, "data", "images");
const ERRORS_DIR = path.join(EVAL_DIR, "data", "errors");
const RESULTS_PATH = path.join(EVAL_DIR, "last-results.json");

const THRESHOLDS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55];
const IOU_MATCH = 0.5;
const TILES = { cols: 2, rows: 2, overlap: 0.1 }; // = perfil longRange do engine (F3)
const N_ERRORS = 15;

const SMALL_MAX = 32 * 32;
const MEDIUM_MAX = 96 * 96;
const sizeBucket = (area) => (area < SMALL_MAX ? "S" : area < MEDIUM_MAX ? "M" : "L");

const modeArg = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : "both";
const MODES = modeArg === "both" ? ["squash", "tiled"] : [modeArg];
const SAVE_ERRORS = !process.argv.includes("--no-errors");

if (!fs.existsSync(MODEL))
  throw new Error(`modelo ausente em ${MODEL} — rode o hub uma vez com ANALYSIS_ENABLED=1 (ver server/analysis/README.md)`);
const manifest = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, "manifest.json"), "utf8"));

// ── Worker de produção via IPC (mesmo contrato do engine.js) ─────────────────
function startWorker() {
  const w = fork(WORKER, [], {
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, ANALYSIS_SCORE_MIN: "0.25", ANALYSIS_MODEL_PATH: MODEL },
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
  const detect = (id, jpeg, tiles) =>
    new Promise((res) => {
      pending.set(id, res);
      // cameraId único por pedido → a fila último-vence nunca descarta nada aqui
      w.send({ type: "detect", id, cameraId: id, jpeg, ...(tiles ? { tiles } : {}) });
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
/** @returns {{det:number[], gt:boolean[]}} det[i] = índice do GT casado ou -1 */
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

// ── Inferência sobre o dataset (uma passada por modo, dets a 0.25) ───────────
async function runMode(worker, mode) {
  const tiles = mode === "tiled" ? TILES : undefined;
  const perImage = new Map(); // id → dets person em PIXELS [{box:[x,y,w,h], score}]
  let decodeMs = 0;
  let inferMs = 0;
  let n = 0;
  const all = [...manifest.positives, ...manifest.negatives];
  for (const im of all) {
    const jpeg = fs.readFileSync(path.join(IMAGES_DIR, im.file));
    const r = await worker.detect(`${mode}-${im.id}`, jpeg, tiles);
    if (r.error) throw new Error(`worker error em ${im.file}: ${r.error}`);
    const persons = (r.dets || [])
      .filter((d) => d.class === "person")
      .map((d) => ({
        box: [d.bbox[0] * im.width, d.bbox[1] * im.height, d.bbox[2] * im.width, d.bbox[3] * im.height],
        score: d.score,
      }));
    perImage.set(im.id, persons);
    decodeMs += r.decodeMs;
    inferMs += r.inferMs;
    if (++n % 50 === 0) console.error(`  [${mode}] ${n}/${all.length}`);
  }
  return { perImage, avgDecodeMs: decodeMs / n, avgInferMs: inferMs / n };
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
          acc[sizeBucket(im.gt[m.det[i]][2] * im.gt[m.det[i]][3])].tp++; // TP no bucket do GT
        } else {
          acc.all.fp++;
          acc[sizeBucket(dets[i].box[2] * dets[i].box[3])].fp++; // FP no bucket do det
        }
      }
      for (let g = 0; g < im.gt.length; g++)
        if (!m.gt[g]) {
          acc.all.fn++;
          acc[sizeBucket(im.gt[g][2] * im.gt[g][3])].fn++;
        }
    }
    // FP puro nas negativas (qualquer det person é FP)
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

// ── Piores erros com imagem (PNG anotado) ────────────────────────────────────
function collectErrors(perImage) {
  const fps = []; // det sem GT (IoU≥0.5) a 0.25 — inclui os das imagens vazias
  const misses = []; // GT sem det NEM a 0.25 (o modelo é cego a ele)
  for (const im of manifest.positives) {
    const dets = perImage.get(im.id);
    const m = matchGreedy(dets, im.gt);
    dets.forEach((d, i) => {
      if (m.det[i] < 0) fps.push({ im, det: d });
    });
    im.gt.forEach((g, gi) => {
      if (!m.gt[gi]) misses.push({ im, gt: g, area: g[2] * g[3] });
    });
  }
  for (const im of manifest.negatives)
    for (const d of perImage.get(im.id)) fps.push({ im, det: d, empty: true });
  fps.sort((a, b) => b.det.score - a.det.score);
  misses.sort((a, b) => b.area - a.area);
  return { fps: fps.slice(0, N_ERRORS), misses: misses.slice(0, N_ERRORS) };
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function svgRect([x, y, w, h], color, width, dash = "") {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
}
async function renderError(kind, idx, entry, perImage) {
  const { im } = entry;
  const dets = perImage.get(im.id);
  const gts = im.gt || [];
  const parts = [];
  for (const g of gts) parts.push(svgRect(g, "#22c55e", 2)); // GT verde
  for (const d of dets) parts.push(svgRect(d.box, "#22d3ee", 2, "6,4")); // dets ciano tracejado
  let label;
  if (kind === "fp") {
    parts.push(svgRect(entry.det.box, "#ef4444", 4));
    label = { box: entry.det.box, text: `FP ${entry.det.score.toFixed(2)}${entry.empty ? " (img vazia)" : ""}`, color: "#ef4444" };
  } else {
    parts.push(svgRect(entry.gt, "#f97316", 4));
    label = { box: entry.gt, text: `MISS ${Math.round(Math.sqrt(entry.area))}px`, color: "#f97316" };
  }
  const ty = Math.max(16, label.box[1] - 6);
  parts.push(
    `<text x="${Math.max(2, label.box[0])}" y="${ty}" font-family="sans-serif" font-size="16" font-weight="bold" fill="${label.color}" stroke="black" stroke-width="0.6">${esc(label.text)}</text>`,
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${im.width}" height="${im.height}">${parts.join("")}</svg>`;
  const out = path.join(
    ERRORS_DIR,
    `${kind}-${String(idx + 1).padStart(2, "0")}-${im.id}${kind === "fp" ? `-s${entry.det.score.toFixed(2)}` : ""}.png`,
  );
  await sharp(path.join(IMAGES_DIR, im.file))
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(out);
  return out;
}

// ── Tabelas markdown ─────────────────────────────────────────────────────────
const pct = (v) => (v * 100).toFixed(1);
function tableFor(byThr) {
  const lines = [
    "| thr | P all | R all | F1 all | R S | R M | R L | P S | P M | P L | FP vazias (dets) | vazias c/ FP |",
    "|-----|-------|-------|--------|-----|-----|-----|-----|-----|-----|------------------|--------------|",
  ];
  for (const thr of THRESHOLDS) {
    const m = byThr[thr];
    lines.push(
      `| ${thr.toFixed(2)} | ${pct(m.all.p)} | ${pct(m.all.r)} | ${pct(m.all.f1)} | ${pct(m.S.r)} | ${pct(m.M.r)} | ${pct(m.L.r)} | ${pct(m.S.p)} | ${pct(m.M.p)} | ${pct(m.L.p)} | ${m.empty.fpDets} | ${m.empty.imgsWithFp}/${manifest.negatives.length} |`,
    );
  }
  return lines.join("\n");
}

// ── main ─────────────────────────────────────────────────────────────────────
const worker = startWorker();
const info = await worker.ready;
console.error(`worker pronto (modelo ${info.model}) — ${manifest.positives.length}+${manifest.negatives.length} imagens, modos: ${MODES.join(", ")}`);

const results = {
  ranAt: new Date().toISOString(),
  model: path.basename(MODEL),
  pipeline: "server/analysis/worker.js (fork IPC — pipeline de produção)",
  dataset: { positives: manifest.positives.length, negatives: manifest.negatives.length, gtPersons: manifest.positives.reduce((s, p) => s + p.gt.length, 0) },
  iouMatch: IOU_MATCH,
  tiles: TILES,
  modes: {},
};

for (const mode of MODES) {
  const t0 = performance.now();
  const { perImage, avgDecodeMs, avgInferMs } = await runMode(worker, mode);
  const byThr = computeMetrics(perImage);
  results.modes[mode] = {
    avgDecodeMs: +avgDecodeMs.toFixed(1),
    avgInferMs: +avgInferMs.toFixed(1),
    wallMs: Math.round(performance.now() - t0),
    byThreshold: byThr,
  };
  console.log(`\n## Modo ${mode}${mode === "tiled" ? " (2×2, overlap 0.1 — perfil longRange)" : " (640 squash — default de produção)"}`);
  console.log(`(médias/frame: decode ${avgDecodeMs.toFixed(0)}ms · inferência ${avgInferMs.toFixed(0)}ms)\n`);
  console.log(tableFor(byThr));

  if (SAVE_ERRORS && mode === "squash") {
    fs.rmSync(ERRORS_DIR, { recursive: true, force: true });
    fs.mkdirSync(ERRORS_DIR, { recursive: true });
    const { fps, misses } = collectErrors(perImage);
    const files = { fps: [], misses: [] };
    for (let i = 0; i < fps.length; i++) files.fps.push(await renderError("fp", i, fps[i], perImage));
    for (let i = 0; i < misses.length; i++) files.misses.push(await renderError("miss", i, misses[i], perImage));
    results.errors = {
      fps: fps.map((e, i) => ({ file: files.fps[i], image: e.im.file, score: +e.det.score.toFixed(3), emptyImage: !!e.empty })),
      misses: misses.map((e, i) => ({ file: files.misses[i], image: e.im.file, gtArea: Math.round(e.area), sizeBucket: sizeBucket(e.area) })),
    };
    console.log(`\nErros anotados salvos em ${ERRORS_DIR} (${fps.length} FPs, ${misses.length} misses).`);
  }
}

fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 1) + "\n");
console.log(`\nResultados completos: ${RESULTS_PATH}`);
worker.kill();
