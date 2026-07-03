// ─────────────────────────────────────────────────────────────────────────────
// eval/fetch-dataset.mjs — ONDA 1 (plano-acuracia-modelos §1.2): monta o dataset
// de ground truth REAL a partir do COCO val2017.
//
// O que faz (idempotente — roda de novo só baixa o que falta):
//   1. Baixa instances_val2017.json (anotações oficiais) — mirror HF leve (~20MB)
//      com fallback para o zip oficial (~241MB, extrai só o JSON via tar bsd).
//   2. Seleciona 300 imagens DETERMINÍSTICAS (seed fixa) e grava eval/manifest.json
//      (COMMITÁVEL — ids + GT em pixels; o run-eval não precisa mais das anotações):
//        • 150 COM pessoas (sem iscrowd): 50 por tamanho dominante S/M/L (padrão
//          COCO por área de bbox: <32², 32²–96², >96²), amostradas por STRIDE sobre
//          a lista ordenada por nº de pessoas → varre de indivíduo a multidão.
//        • 150 SEM pessoa nenhuma (medem falso positivo puro).
//   3. Baixa SÓ essas 300 imagens (images.cocodataset.org/val2017/<file>) para
//      eval/data/images/ (gitignored, ~50MB).
//
// Uso:  node eval/fetch-dataset.mjs [--rebuild-manifest]
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(EVAL_DIR, "data");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const ANN_PATH = path.join(DATA_DIR, "instances_val2017.json");
const MANIFEST_PATH = path.join(EVAL_DIR, "manifest.json");

const ANN_MIRRORS = [
  // mirror leve no HF (só o JSON de instances do val2017)
  "https://huggingface.co/datasets/merve/coco/resolve/main/annotations/instances_val2017.json",
];
const ANN_ZIP_OFFICIAL = "http://images.cocodataset.org/annotations/annotations_trainval2017.zip";
const IMG_BASE = "http://images.cocodataset.org/val2017/";

const N_PER_BUCKET = 50; // 3 buckets × 50 = 150 positivas
const N_NEGATIVES = 150;
const SEED = 42;

// COCO: área (px²) <32² pequena · 32²–96² média · >96² grande (aqui: área do bbox)
const SMALL_MAX = 32 * 32;
const MEDIUM_MAX = 96 * 96;
const sizeBucket = (area) => (area < SMALL_MAX ? "S" : area < MEDIUM_MAX ? "M" : "L");

// PRNG determinística (mulberry32) — seleção reprodutível sem depender de lib.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffled(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".tmp";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
  return buf.length;
}

async function ensureAnnotations() {
  if (fs.existsSync(ANN_PATH)) return;
  for (const url of ANN_MIRRORS) {
    try {
      console.log(`Baixando anotações (mirror leve): ${url}`);
      const n = await downloadTo(url, ANN_PATH);
      console.log(`  ok — ${(n / 1e6).toFixed(1)} MB`);
      return;
    } catch (e) {
      console.warn(`  mirror falhou (${e.message}); tentando próximo…`);
    }
  }
  // Fallback: zip oficial (241MB) — extrai só o instances_val2017.json (tar do
  // Windows/macOS/Linux moderno é bsdtar e lê zip).
  console.log(`Baixando zip oficial de anotações (~241MB): ${ANN_ZIP_OFFICIAL}`);
  const zipPath = path.join(DATA_DIR, "annotations_trainval2017.zip");
  await downloadTo(ANN_ZIP_OFFICIAL, zipPath);
  execFileSync("tar", ["-xf", zipPath, "-C", DATA_DIR, "annotations/instances_val2017.json"]);
  fs.renameSync(path.join(DATA_DIR, "annotations", "instances_val2017.json"), ANN_PATH);
  fs.rmSync(zipPath, { force: true });
}

function buildManifest() {
  console.log("Lendo anotações…");
  const coco = JSON.parse(fs.readFileSync(ANN_PATH, "utf8"));
  if (!Array.isArray(coco.images) || coco.images.length !== 5000)
    throw new Error(
      `anotações inesperadas: ${coco.images?.length ?? 0} imagens (esperado 5000 do val2017) — apague eval/data/instances_val2017.json e rode de novo p/ cair no fallback oficial`,
    );
  const personCat = coco.categories.find((c) => c.name === "person");
  if (!personCat) throw new Error("categoria 'person' não encontrada nas anotações");

  const imgById = new Map(coco.images.map((im) => [im.id, im]));
  // person anns por imagem (e flag de crowd); demais categorias só marcam "tem algo"
  const personsByImg = new Map();
  const crowdImgs = new Set();
  for (const a of coco.annotations) {
    if (a.category_id !== personCat.id) continue;
    if (a.iscrowd) {
      crowdImgs.add(a.image_id);
      continue;
    }
    let arr = personsByImg.get(a.image_id);
    if (!arr) personsByImg.set(a.image_id, (arr = []));
    arr.push(a.bbox); // [x,y,w,h] em pixels
  }

  // Positivas: ≥1 pessoa, SEM região iscrowd (crowd não permite matching 1-1 honesto).
  const posCandidates = [];
  for (const [imgId, boxes] of personsByImg) {
    if (crowdImgs.has(imgId)) continue;
    const counts = { S: 0, M: 0, L: 0 };
    for (const b of boxes) counts[sizeBucket(b[2] * b[3])]++;
    // bucket dominante da imagem (empate favorece o menor — S é o caso difícil)
    const dom = ["S", "M", "L"].reduce((best, k) => (counts[k] > counts[best] ? k : best), "S");
    posCandidates.push({ imgId, boxes, n: boxes.length, dom });
  }

  const rng = mulberry32(SEED);
  const positives = [];
  for (const bucket of ["S", "M", "L"]) {
    const cands = shuffled(
      posCandidates.filter((c) => c.dom === bucket),
      rng,
    ).sort((a, b) => a.n - b.n || a.imgId - b.imgId);
    if (cands.length < N_PER_BUCKET) throw new Error(`só ${cands.length} candidatas no bucket ${bucket}`);
    // stride sobre a lista ordenada por nº de pessoas → varre solo → multidão
    const picked = new Set();
    for (let i = 0; i < N_PER_BUCKET; i++) {
      let idx = Math.round((i * (cands.length - 1)) / (N_PER_BUCKET - 1));
      while (picked.has(idx)) idx++;
      picked.add(idx);
      const c = cands[idx];
      const im = imgById.get(c.imgId);
      positives.push({
        id: c.imgId,
        file: im.file_name,
        width: im.width,
        height: im.height,
        bucket,
        gt: c.boxes.map((b) => b.map((v) => Math.round(v * 100) / 100)),
      });
    }
  }

  // Negativas: NENHUMA anotação de person (nem crowd).
  const negCandidates = coco.images
    .filter((im) => !personsByImg.has(im.id) && !crowdImgs.has(im.id))
    .map((im) => im.id)
    .sort((a, b) => a - b);
  const negatives = shuffled(negCandidates, rng)
    .slice(0, N_NEGATIVES)
    .map((id) => {
      const im = imgById.get(id);
      return { id, file: im.file_name, width: im.width, height: im.height };
    });

  const manifest = {
    source: "COCO val2017 (instances oficiais) — person",
    seed: SEED,
    sizeBuckets: { S: `área bbox < ${SMALL_MAX}px²`, M: `${SMALL_MAX}–${MEDIUM_MAX}px²`, L: `> ${MEDIUM_MAX}px²` },
    note: "positivas excluem imagens com person iscrowd=1; negativas não têm NENHUMA anotação person",
    positives,
    negatives,
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 1) + "\n");
  const totGt = positives.reduce((s, p) => s + p.gt.length, 0);
  console.log(
    `manifest.json: ${positives.length} positivas (${totGt} pessoas GT) + ${negatives.length} negativas`,
  );
  return manifest;
}

async function downloadImages(manifest) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  const all = [...manifest.positives, ...manifest.negatives].filter(
    (im) => !fs.existsSync(path.join(IMAGES_DIR, im.file)),
  );
  if (!all.length) {
    console.log("imagens: todas já baixadas.");
    return;
  }
  console.log(`Baixando ${all.length} imagens de ${IMG_BASE} …`);
  let done = 0;
  let failed = 0;
  const CONC = 8;
  const queue = all.slice();
  await Promise.all(
    Array.from({ length: CONC }, async () => {
      for (;;) {
        const im = queue.shift();
        if (!im) return;
        try {
          await downloadTo(IMG_BASE + im.file, path.join(IMAGES_DIR, im.file));
          if (++done % 50 === 0) console.log(`  ${done}/${all.length}`);
        } catch (e) {
          failed++;
          console.warn(`  FALHOU ${im.file}: ${e.message}`);
        }
      }
    }),
  );
  console.log(`imagens: ${done} baixadas, ${failed} falhas.`);
  if (failed) process.exitCode = 1;
}

const rebuild = process.argv.includes("--rebuild-manifest");
if (!fs.existsSync(MANIFEST_PATH) || rebuild) await ensureAnnotations();
const manifest =
  !rebuild && fs.existsSync(MANIFEST_PATH)
    ? JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"))
    : buildManifest();
await downloadImages(manifest);
console.log("fetch-dataset: pronto.");
