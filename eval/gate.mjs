// ─────────────────────────────────────────────────────────────────────────────
// eval/gate.mjs — SENSOR DE REGRESSÃO de acurácia (plano-acuracia-modelos §3.3).
//
// Roda o MESMO worker de produção (server/analysis/worker.js) sobre o FIXTURE
// commitado (eval/fixture, 29 imagens COCO — 21 com pessoas S/M/L + 8 vazias),
// no modo squash 640 (default do motor), computa P/R/F1 e FP-em-vazias nos
// pontos de operação e COMPARA com os limiares mínimos de eval/thresholds.json.
//   • passa → exit 0.
//   • regride (qualquer check abaixo do mínimo / acima do máximo) → exit 1 + diff.
//
// DETERMINÍSTICO: mesmo modelo + mesmo fixture → mesmos números (D-FINE-N/CPU EP,
// squash fill, sem aleatoriedade). Não entra em `npm run verify` — é gate manual /
// CI opcional, rode ANTES de trocar modelo/threshold/NMS.
//
// Uso:
//   node eval/gate.mjs               → mede e compara (gate)
//   node eval/gate.mjs --calibrate   → RECALIBRA: reescreve os "min"/"max" de
//                                       thresholds.json a partir da medição atual
//                                       (menos a margem). Use ao TROCAR de modelo.
//   node eval/gate.mjs --json        → imprime as métricas medidas em JSON e sai.
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(EVAL_DIR);
const WORKER = path.join(ROOT, "server", "analysis", "worker.js");
const MODEL =
  process.env.ANALYSIS_MODEL_PATH || path.join(ROOT, "server", "models", "dfine_n_coco.onnx");
const FIXTURE_DIR = path.join(EVAL_DIR, "fixture");
const FIXTURE_IMG = path.join(FIXTURE_DIR, "img");
const FIXTURE_MANIFEST = path.join(FIXTURE_DIR, "manifest-fixture.json");
const THRESHOLDS_PATH = path.join(EVAL_DIR, "thresholds.json");

const IOU_MATCH = 0.5;
const CALIBRATE = process.argv.includes("--calibrate");
const JSON_ONLY = process.argv.includes("--json");

// ── Pré-requisitos com mensagem clara ────────────────────────────────────────
if (!fs.existsSync(MODEL)) {
  console.error(
    `\n[eval] modelo ausente: ${MODEL}\n` +
      `Rode o hub UMA vez com ANALYSIS_ENABLED=1 para baixá-lo (verificação de sha no boot —\n` +
      `ver server/analysis/README.md), ou aponte ANALYSIS_MODEL_PATH para um .onnx local.\n`,
  );
  process.exit(2);
}
if (!fs.existsSync(FIXTURE_MANIFEST) || !fs.existsSync(FIXTURE_IMG)) {
  console.error(`\n[eval] fixture ausente (${FIXTURE_DIR}) — rode: node eval/build-fixture.mjs\n`);
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(FIXTURE_MANIFEST, "utf8"));

// ── Worker de produção via IPC (mesmo contrato do engine.js / run-eval) ──────
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
      console.error("[eval] worker fatal:", m.error);
      process.exit(2);
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

// ── Inferência sobre o fixture (uma passada, dets a 0.25) ────────────────────
async function runFixture(worker) {
  const perImage = new Map();
  const all = [...manifest.positives, ...manifest.negatives];
  for (const im of all) {
    const jpeg = fs.readFileSync(path.join(FIXTURE_IMG, im.file));
    const r = await worker.detect(`sq-${im.id}`, jpeg);
    if (r.error) throw new Error(`worker error em ${im.file}: ${r.error}`);
    const persons = (r.dets || [])
      .filter((d) => d.class === "person")
      .map((d) => ({
        box: [
          d.bbox[0] * im.width,
          d.bbox[1] * im.height,
          d.bbox[2] * im.width,
          d.bbox[3] * im.height,
        ],
        score: d.score,
      }));
    perImage.set(im.id, persons);
  }
  return perImage;
}

// P/R/F1 (bucket "all") num dado threshold sobre as positivas.
function prfAt(perImage, thr) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const im of manifest.positives) {
    const dets = perImage.get(im.id).filter((d) => d.score >= thr);
    const m = matchGreedy(dets, im.gt);
    for (let i = 0; i < dets.length; i++)
      if (m.det[i] >= 0) tp++;
      else fp++;
    for (let g = 0; g < im.gt.length; g++) if (!m.gt[g]) fn++;
  }
  const p = tp + fp ? tp / (tp + fp) : 1;
  const r = tp + fn ? tp / (tp + fn) : 0;
  return { tp, fp, fn, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}

// FP total nas cenas vazias num dado threshold (qualquer det person é FP).
function fpEmptiesAt(perImage, thr) {
  let fp = 0;
  for (const im of manifest.negatives)
    fp += perImage.get(im.id).filter((d) => d.score >= thr).length;
  return fp;
}

function measure(perImage) {
  const at035 = prfAt(perImage, 0.35);
  const at025 = prfAt(perImage, 0.25);
  return {
    "f1_all@0.35": at035.f1,
    "precision_all@0.35": at035.p,
    "recall_all@0.35": at035.r,
    "recall_all@0.25": at025.r,
    "fp_empties@0.50": fpEmptiesAt(perImage, 0.5),
    "fp_empties@0.35": fpEmptiesAt(perImage, 0.35),
  };
}

// ── main ──────────────────────────────────────────────────────────────────────
const worker = startWorker();
const info = await worker.ready;
console.error(
  `[eval] worker pronto (modelo ${info.model}) — fixture ${manifest.positives.length} positivas + ${manifest.negatives.length} vazias, modo squash`,
);
const perImage = await runFixture(worker);
worker.kill();
const measured = measure(perImage);

if (JSON_ONLY) {
  console.log(JSON.stringify(measured, null, 2));
  process.exit(0);
}

const pct = (v) => (v * 100).toFixed(1) + "%";
const isRate = (k) => k.startsWith("f1") || k.startsWith("precision") || k.startsWith("recall");
const fmt = (k, v) => (isRate(k) ? pct(v) : String(v));

// ── Calibração: reescreve os limiares a partir da medição atual ──────────────
if (CALIBRATE) {
  const th = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, "utf8"));
  const marginPp = th._margin_pp ?? 5;
  const margin = marginPp / 100;
  for (const [key, chk] of Object.entries(th.checks)) {
    const m = measured[key];
    if (m == null) throw new Error(`thresholds.json referencia métrica desconhecida: ${key}`);
    chk._measured = isRate(key) ? +(m * 100).toFixed(1) + "%" : m;
    if (chk.type === "min") chk.min = isRate(key) ? +Math.max(0, m - margin).toFixed(4) : m;
    else if (chk.type === "max") chk.max = m; // ex.: FP em vazias — mínimo é o próprio medido (idealmente 0)
  }
  th._calibratedAt = new Date().toISOString();
  th._model = info.model;
  fs.writeFileSync(THRESHOLDS_PATH, JSON.stringify(th, null, 2) + "\n");
  console.log(
    `[eval] thresholds.json RECALIBRADO (margem ${marginPp}pp) a partir do modelo ${info.model}:`,
  );
  for (const [key, chk] of Object.entries(th.checks))
    console.log(
      `  ${key}: medido ${chk._measured} → ${chk.type} ${fmt(key, chk.type === "min" ? chk.min : chk.max)}`,
    );
  process.exit(0);
}

// ── Gate: compara medido × limiares ──────────────────────────────────────────
const th = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, "utf8"));
const rows = [];
let failed = 0;
for (const [key, chk] of Object.entries(th.checks)) {
  const m = measured[key];
  const bound = chk.type === "min" ? chk.min : chk.max;
  const ok = chk.type === "min" ? m >= bound : m <= bound;
  if (!ok) failed++;
  rows.push({
    key,
    measured: fmt(key, m),
    op: chk.type === "min" ? "≥" : "≤",
    bound: fmt(key, bound),
    ok,
    desc: chk._desc || "",
  });
}

const w0 = Math.max(...rows.map((r) => r.key.length), 6);
const w1 = Math.max(...rows.map((r) => r.measured.length), 6);
const w2 = Math.max(...rows.map((r) => r.bound.length), 8);
console.log(
  `\n[eval] Sensor de regressão de acurácia — modelo ${info.model} · fixture ${manifest.positives.length}+${manifest.negatives.length}\n`,
);
console.log(
  `  ${"MÉTRICA".padEnd(w0)}  ${"MEDIDO".padStart(w1)}  LIMITE ${"".padStart(w2)}  STATUS`,
);
for (const r of rows)
  console.log(
    `  ${r.key.padEnd(w0)}  ${r.measured.padStart(w1)}  ${r.op} ${r.bound.padStart(w2)}  ${r.ok ? "OK" : "FALHOU  ←"}`,
  );

if (failed) {
  console.error(
    `\n[eval] REGRESSÃO: ${failed} de ${rows.length} métrica(s) abaixo do mínimo aceitável.`,
  );
  console.error(
    `       Se a mudança de modelo/threshold é INTENCIONAL e o novo patamar é aceitável,`,
  );
  console.error(
    `       recalibre: node eval/gate.mjs --calibrate (e revise o diff de eval/thresholds.json).\n`,
  );
  process.exit(1);
}
console.log(
  `\n[eval] OK — ${rows.length} métricas dentro dos limiares. Sem regressão de acurácia.\n`,
);
process.exit(0);
