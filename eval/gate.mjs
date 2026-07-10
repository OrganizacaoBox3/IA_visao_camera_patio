// ─────────────────────────────────────────────────────────────────────────────
// eval/gate.mjs — SENSOR DE REGRESSÃO de acurácia (npm run eval).
//
// Roda o MESMO worker de produção (via eval/lib.mjs) sobre o FIXTURE commitado
// (eval/fixture, 29 imagens COCO — 21 com pessoas S/M/L + 8 vazias), no modo
// squash 640 (default do motor), computa P/R/F1 e FP-em-vazias nos pontos de
// operação e COMPARA com os limiares mínimos de eval/thresholds.json.
//   • passa → exit 0.
//   • regride (qualquer check abaixo do mínimo / acima do máximo) → exit 1 + diff.
//
// DETERMINÍSTICO: mesmo modelo + mesmo fixture → mesmos números (CPU EP, squash
// fill, sem aleatoriedade). Não entra em `npm run verify` — é gate manual / CI
// opcional, rode ANTES de trocar modelo/threshold/NMS. Decisão de DEFAULT exige
// também o full-set (run-eval.mjs): o fixture pequeno não decide sozinho
// (evidência: docs/analises/perf-input-size-dfine.md).
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
import { EVAL_DIR, startWorker, matchGreedy, prf, resolveModelPath } from "./lib.mjs";

// Modelo = o MESMO da produção (default S; ANALYSIS_MODEL/ANALYSIS_MODEL_PATH sobrepõem).
const MODEL = resolveModelPath();
const FIXTURE_DIR = path.join(EVAL_DIR, "fixture");
const FIXTURE_IMG = path.join(FIXTURE_DIR, "img");
const FIXTURE_MANIFEST = path.join(FIXTURE_DIR, "manifest-fixture.json");
const THRESHOLDS_PATH = path.join(EVAL_DIR, "thresholds.json");

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
  const acc = { tp: 0, fp: 0, fn: 0 };
  for (const im of manifest.positives) {
    const dets = perImage.get(im.id).filter((d) => d.score >= thr);
    const m = matchGreedy(dets, im.gt);
    for (let i = 0; i < dets.length; i++)
      if (m.det[i] >= 0) acc.tp++;
      else acc.fp++;
    for (let g = 0; g < im.gt.length; g++) if (!m.gt[g]) acc.fn++;
  }
  return prf(acc);
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
const worker = startWorker(MODEL, { fatalExitCode: 2 });
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
