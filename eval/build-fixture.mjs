// ─────────────────────────────────────────────────────────────────────────────
// eval/build-fixture.mjs — monta o FIXTURE commitável do sensor de regressão
// (plano-acuracia-modelos §3.3). Seleciona um SUBCONJUNTO determinístico do
// eval/manifest.json (dataset COCO completo) e copia só essas imagens para
// eval/fixture/img/ (versionadas — ~5MB), com o GT embutido em
// eval/fixture/manifest-fixture.json (mesmo formato do manifest, bbox em pixels).
//
// Pré-requisito: node eval/fetch-dataset.mjs (as imagens fonte vivem em
// eval/data/images/, gitignored). Rode isto só para (re)gerar o fixture — o
// gate (eval/gate.mjs) consome o resultado já commitado, não precisa disto.
//
// Seleção (determinística, sem PRNG — o manifest já vem embaralhado com seed 42):
//   • positivas: N_PER_BUCKET por tamanho S/M/L, por STRIDE uniforme sobre a
//     lista do bucket (que o fetch ordenou solo→multidão) → varia de indivíduo
//     a grupo em cada tamanho.
//   • negativas (cena sem pessoa): as N_NEG primeiras por id → falso positivo puro.
//
// Uso:  node eval/build-fixture.mjs
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_IMAGES = path.join(EVAL_DIR, "data", "images");
const MANIFEST = path.join(EVAL_DIR, "manifest.json");
const FIXTURE_DIR = path.join(EVAL_DIR, "fixture");
const FIXTURE_IMG = path.join(FIXTURE_DIR, "img");
const FIXTURE_MANIFEST = path.join(FIXTURE_DIR, "manifest-fixture.json");

const N_PER_BUCKET = 7; // 3 × 7 = 21 positivas
const N_NEG = 8; // 8 cenas vazias

if (!fs.existsSync(MANIFEST)) throw new Error(`manifest ausente (${MANIFEST}) — rode node eval/fetch-dataset.mjs`);
if (!fs.existsSync(SRC_IMAGES)) throw new Error(`imagens fonte ausentes (${SRC_IMAGES}) — rode node eval/fetch-dataset.mjs`);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));

// STRIDE uniforme sobre uma lista já ordenada (mesma técnica do fetch-dataset).
function stride(list, k) {
  if (list.length <= k) return list.slice();
  const picked = new Set();
  const out = [];
  for (let i = 0; i < k; i++) {
    let idx = Math.round((i * (list.length - 1)) / (k - 1));
    while (picked.has(idx)) idx++;
    picked.add(idx);
    out.push(list[idx]);
  }
  return out;
}

const positives = [];
for (const bucket of ["S", "M", "L"]) {
  const inBucket = manifest.positives.filter((p) => p.bucket === bucket);
  positives.push(...stride(inBucket, N_PER_BUCKET));
}
const negatives = manifest.negatives.slice().sort((a, b) => a.id - b.id).slice(0, N_NEG);

// copia as imagens escolhidas para o diretório commitável
fs.rmSync(FIXTURE_IMG, { recursive: true, force: true });
fs.mkdirSync(FIXTURE_IMG, { recursive: true });
let bytes = 0;
for (const im of [...positives, ...negatives]) {
  const src = path.join(SRC_IMAGES, im.file);
  if (!fs.existsSync(src)) throw new Error(`imagem fonte ausente: ${im.file} — rode node eval/fetch-dataset.mjs`);
  const dst = path.join(FIXTURE_IMG, im.file);
  fs.copyFileSync(src, dst);
  bytes += fs.statSync(dst).size;
}

const fixture = {
  source: manifest.source,
  seed: manifest.seed,
  note:
    "Subconjunto commitável do eval/manifest.json (sensor de regressão §3.3). GT em pixels [x,y,w,h]. Regenere com node eval/build-fixture.mjs.",
  sizeBuckets: manifest.sizeBuckets,
  positives,
  negatives,
};
fs.writeFileSync(FIXTURE_MANIFEST, JSON.stringify(fixture, null, 1) + "\n");

const gtPersons = positives.reduce((s, p) => s + p.gt.length, 0);
console.log(
  `fixture: ${positives.length} positivas (${gtPersons} pessoas GT) + ${negatives.length} vazias = ${positives.length + negatives.length} imagens, ${(bytes / 1e6).toFixed(2)} MB em ${FIXTURE_IMG}`,
);
