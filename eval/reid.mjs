// ─────────────────────────────────────────────────────────────────────────────
// eval/reid.mjs — HARNESS de ReID visual (Fase 0 do docs/analises/spec-reid-visual.md).
//
// Duas perguntas, um só arquivo (molde de eval/gate.mjs / eval/counting.mjs):
//
//   1. CUSTO (mensurável AGORA, sem dado anotado) — `node eval/reid.mjs --cost`:
//      quanto custa UM embedding OSNet na CPU, em ms/crop de pessoa, e a conta N×
//      (N pessoas em quadro × custo) somada ao D-FINE que já roda. Decide METADE do
//      ir/não-ir do spec §3 ("se o embedding N× estourar o orçamento de CPU do hub,
//      ReID não roda como default"). É o único número que este arquivo PRODUZ hoje.
//
//   2. RANK-1 SOB UNIFORME (a métrica-que-mata) — `node eval/reid.mjs --rank1`:
//      EXIGE a caminhada anotada #4 (protocolo-teste-campo-indoor.md), que AINDA
//      NÃO EXISTE. O caminho está TODO fiado (crop→embedding→galeria→cosine→rank-1),
//      mas inerte: sem REID_DATASET aponta o que falta e sai 0. NÃO invente esse
//      número — abaixo da cadência do dado ele não é observável (CLAUDE.md, Regra 9).
//
// PARIDADE COM PRODUÇÃO: o crop reusa o MESMO mecanismo do worker (sharp.extract
// sobre o raw já decodificado — worker.js:219-261 detectTiled) e o D-FINE-âncora é
// o worker REAL de produção (via eval/lib.mjs startWorker). O embedding roda no
// MESMO runtime do hub (onnxruntime-node, CPU EP).
//
// MODELO (REID_MODEL_PATH): um OSNet .onnx. Ausente → o modo custo diz EXATAMENTE o
// que baixar e sai 0 (CI-safe; nada aqui entra em `npm run verify`). Ver §"o que falta".
//
// LGPD (spec §1.5 / ADR-002): embedding é adjacente a biométrico. Aqui ele é
// EFÊMERO em memória — nunca escrito em disco, nunca logado (só métricas agregadas).
//
// Uso:
//   node eval/reid.mjs --cost      → mede ms/embedding + conta N× + cabe-no-orçamento
//   node eval/reid.mjs --rank1     → rank-1 sob uniforme (SÓ com REID_DATASET; senão skip)
//   node eval/reid.mjs --selftest  → asserts das funções puras (sem modelo, sem rede)
// ─────────────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { resolveModelPath, startWorker } from "./lib.mjs";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const sharp = require("sharp");

// Threads intra-op do ORT: o MESMO default do worker de produção (worker.js:50).
const INTRA_THREADS = Number(process.env.ANALYSIS_INTRA_THREADS ?? 2);
// Caminho do OSNet .onnx — runtime/gitignored, NUNCA commitado (LGPD-adjacente + peso).
const REID_MODEL_PATH = process.env.REID_MODEL_PATH || "";
// Manifesto da caminhada anotada #4 (quando existir). Formato esperado em loadDataset().
const REID_DATASET = process.env.REID_DATASET || "";

// ── Núcleo REUTILIZÁVEL (a Fase 1 importa daqui; nada reimplementado depois) ─────

/** L2-normaliza um vetor (cópia). Cosine entre normalizados = produto interno. */
export function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** Similaridade cosseno de dois vetores JÁ L2-normalizados. */
export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Galeria id→embedding MÉDIO (protótipo por identidade), L2-normalizado.
 * @param {Array<{id:string, emb:Float32Array}>} samples embeddings de referência
 * @returns {Map<string, Float32Array>} id → protótipo normalizado
 */
export function buildGallery(samples) {
  const sum = new Map();
  const cnt = new Map();
  for (const { id, emb } of samples) {
    let acc = sum.get(id);
    if (!acc) sum.set(id, (acc = new Float32Array(emb.length)));
    for (let i = 0; i < emb.length; i++) acc[i] += emb[i];
    cnt.set(id, (cnt.get(id) || 0) + 1);
  }
  const gallery = new Map();
  for (const [id, acc] of sum) {
    const c = cnt.get(id) || 1;
    for (let i = 0; i < acc.length; i++) acc[i] /= c;
    gallery.set(id, l2normalize(acc));
  }
  return gallery;
}

/**
 * Rank-1: para cada query, o id do protótipo de galeria mais próximo (cosine) é o
 * verdadeiro? Retorna acertos/total (a MÉTRICA-QUE-MATA quando a query é sob uniforme).
 * @param {Array<{id:string, emb:Float32Array}>} queries
 * @param {Map<string, Float32Array>} gallery
 * @returns {{hits:number, total:number}}
 */
export function rank1(queries, gallery) {
  let hits = 0;
  for (const q of queries) {
    let bestId = null;
    let bestSim = -Infinity;
    for (const [id, proto] of gallery) {
      const s = cosine(q.emb, proto);
      if (s > bestSim) {
        bestSim = s;
        bestId = id;
      }
    }
    if (bestId === q.id) hits++;
  }
  return { hits, total: queries.length };
}

/** Intervalo de Wilson 95% (CLAUDE.md: "13/13 NÃO é 100%"). Retorna [lo,hi] em 0..1. */
export function wilsonInterval(k, n, z = 1.96) {
  if (n === 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [(center - half) / denom, (center + half) / denom];
}

// ── Extração de crop → tensor (paridade worker.js:239-244) ───────────────────────
// OSNet: entrada RGB 256×128 (H×W), rescale 1/255 + normalização ImageNet
// (torchreid pixel_mean/std). A norma NÃO afeta o CUSTO (mesmo compute); importa
// para o rank-1 correto quando o dataset chegar.
const IMAGENET_MEAN = [0.485, 0.456, 0.406];
const IMAGENET_STD = [0.229, 0.224, 0.225];

/**
 * Crop de pessoa (raw RGB decodificado 1×) → tensor CHW fp32 [1,3,H,W] normalizado.
 * Reusa sharp.extract sobre o raw — o MESMO caminho do detectTiled do worker.
 * @param {Buffer} rawRgb frame já decodificado (channels=3)
 * @param {{width:number, height:number}} frame dimensões do raw
 * @param {[number,number,number,number]} box [x,y,w,h] em PIXELS
 * @param {{h:number, w:number}} inShape entrada do modelo (H,W)
 */
export async function cropToTensor(rawRgb, frame, box, inShape) {
  const left = Math.max(0, Math.min(frame.width - 1, Math.round(box[0])));
  const top = Math.max(0, Math.min(frame.height - 1, Math.round(box[1])));
  const width = Math.max(1, Math.min(frame.width - left, Math.round(box[2])));
  const height = Math.max(1, Math.min(frame.height - top, Math.round(box[3])));
  const { data } = await sharp(rawRgb, { raw: { width: frame.width, height: frame.height, channels: 3 } })
    .extract({ left, top, width, height })
    .resize(inShape.w, inShape.h, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = inShape.h * inShape.w;
  const f = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    f[i] = (data[i * 3] / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0];
    f[n + i] = (data[i * 3 + 1] / 255 - IMAGENET_MEAN[1]) / IMAGENET_STD[1];
    f[2 * n + i] = (data[i * 3 + 2] / 255 - IMAGENET_MEAN[2]) / IMAGENET_STD[2];
  }
  return f; // [3,H,W] em ordem CHW, sem dim de batch (o batch é montado no embed)
}

/** Carrega a sessão OSNet e devolve {session, inName, outName, batch, h, w, dim}. */
async function loadReid(modelPath) {
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ["cpu"],
    intraOpNumThreads: INTRA_THREADS,
    graphOptimizationLevel: "all",
  });
  const inName = session.inputNames[0];
  const outName = session.outputNames[0];
  const md = session.inputMetadata[0];
  const shape = md.shape || md.dimensions || [1, 3, 256, 128];
  // [B,C,H,W]; B pode vir FIXO (ex.: 16 no export anriha/osnet_x0_25_msmt17) ou simbólico.
  const batch = Number.isInteger(shape[0]) && shape[0] > 0 ? shape[0] : 1;
  const h = Number.isInteger(shape[2]) && shape[2] > 0 ? shape[2] : 256;
  const w = Number.isInteger(shape[3]) && shape[3] > 0 ? shape[3] : 128;
  return { session, inName, outName, batch, h, w };
}

/**
 * Embedding de um lote de crops (cada crop = Float32Array [3,H,W]). Monta o batch,
 * roda o forward, L2-normaliza cada linha. Retorna Float32Array[] (efêmero).
 */
export async function embedBatch(reid, crops) {
  const { session, inName, outName, batch, h, w } = reid;
  const per = 3 * h * w;
  const data = new Float32Array(batch * per);
  for (let i = 0; i < Math.min(batch, crops.length); i++) data.set(crops[i], i * per);
  const feed = { [inName]: new ort.Tensor("float32", data, [batch, 3, h, w]) };
  const out = await session.run(feed);
  const t = out[outName];
  const dim = t.dims[1];
  const flat = t.data;
  const embs = [];
  for (let i = 0; i < crops.length && i < batch; i++) {
    embs.push(l2normalize(flat.subarray(i * dim, (i + 1) * dim)));
  }
  return embs;
}

// ── Estatística de tempo ─────────────────────────────────────────────────────
function stats(samples) {
  const t = [...samples].sort((a, b) => a - b);
  const n = t.length;
  const mean = t.reduce((a, b) => a + b, 0) / n;
  return { n, mean, median: t[Math.floor(n / 2)], p90: t[Math.floor(n * 0.9)], min: t[0], max: t[n - 1] };
}
const ms = (v) => `${v.toFixed(1)}ms`;

// ══════════════════════════════════════════════════════════════════════════════
// MODO CUSTO — o entregável mensurável hoje
// ══════════════════════════════════════════════════════════════════════════════
async function runCost() {
  const cpu = os.cpus()[0]?.model || "desconhecida";
  console.log(`\n[eval/reid] CUSTO do embedding — CPU ${cpu} · ${os.cpus().length} cores · intraOp ${INTRA_THREADS} threads\n`);

  if (!REID_MODEL_PATH || !fs.existsSync(REID_MODEL_PATH)) {
    console.log("[eval/reid] MODELO OSNet ausente (REID_MODEL_PATH não aponta um .onnx).");
    console.log("            O harness está pronto; falta só o peso. O QUE BAIXAR:");
    console.log("            • OSNet x0_25 MSMT17 (proxy leve, ~886 KB, entrada 256×128, batch fixo 16, emb 512):");
    console.log("              https://huggingface.co/anriha/osnet_x0_25_msmt17 → osnet_x0_25_msmt17.onnx");
    console.log("            • CANDIDATO real do spec: OSNet x1_0 Market-1501 (94,8% rank-1) — NÃO há .onnx");
    console.log("              público no HF; exige export do torchreid (.pth→.onnx). Ver §'o que falta'.");
    console.log("            Depois: REID_MODEL_PATH=/caminho/osnet.onnx node eval/reid.mjs --cost\n");
    process.exit(0);
  }

  // 1) ÂNCORA: D-FINE de PRODUÇÃO (worker real via IPC). É o denominador do orçamento.
  const dfineModel = resolveModelPath();
  let dfineMs = null;
  if (fs.existsSync(dfineModel)) {
    const worker = startWorker(dfineModel, { fatalExitCode: 2 });
    const info = await worker.ready;
    const jpeg = await sharp({ create: { width: 1280, height: 720, channels: 3, background: { r: 90, g: 110, b: 130 } } })
      .jpeg().toBuffer();
    for (let i = 0; i < 3; i++) await worker.detect(`warm-${i}`, jpeg); // aquecer
    const samples = [];
    for (let i = 0; i < 15; i++) {
      const r = await worker.detect(`d-${i}`, jpeg);
      if (r.inferMs != null) samples.push(r.inferMs);
    }
    worker.kill();
    const s = stats(samples);
    dfineMs = s.median;
    console.log(`  ÂNCORA D-FINE (${info.model}) @${process.env.ANALYSIS_INPUT || 640} — forward de produção:`);
    console.log(`    n=${s.n}  mediana=${ms(s.median)}  média=${ms(s.mean)}  [${ms(s.min)}..${ms(s.max)}]\n`);
  } else {
    console.log(`  ÂNCORA D-FINE ausente (${dfineModel}) — pulando; conta N× sai só em % relativa não computável.\n`);
  }

  // 2) EMBEDDING OSNet isolado (Regra 11: o custo do DELTA, não o agregado).
  const reid = await loadReid(REID_MODEL_PATH);
  console.log(`  MODELO OSNet: ${path.basename(REID_MODEL_PATH)} — entrada ${reid.h}×${reid.w}, batch ${reid.batch}`);
  // crop dummy do tamanho certo (custo não depende do conteúdo do pixel)
  const dummyRaw = Buffer.alloc(1280 * 720 * 3);
  for (let i = 0; i < dummyRaw.length; i++) dummyRaw[i] = (i * 37) & 255;
  const crop = await cropToTensor(dummyRaw, { width: 1280, height: 720 }, [300, 100, 200, 400], reid);
  const crops = Array.from({ length: reid.batch }, () => crop);
  for (let i = 0; i < 5; i++) await embedBatch(reid, crops); // aquecer
  const fwd = [];
  for (let i = 0; i < 40; i++) {
    const a = performance.now();
    await embedBatch(reid, crops);
    fwd.push(performance.now() - a);
  }
  const fs2 = stats(fwd);
  const perEmb = fs2.median / reid.batch;
  console.log(`    forward batch=${reid.batch}: n=${fs2.n} mediana=${ms(fs2.median)} média=${ms(fs2.mean)} [${ms(fs2.min)}..${ms(fs2.max)}]`);
  console.log(`    → POR EMBEDDING (÷${reid.batch}): ${perEmb.toFixed(2)}ms  (isolado, sem crop)\n`);

  // 3) CROP (sharp.extract+resize por pessoa) — parte do custo por pessoa no worker.
  const ct = [];
  for (let i = 0; i < 10; i++) await cropToTensor(dummyRaw, { width: 1280, height: 720 }, [300, 100, 200, 400], reid);
  for (let i = 0; i < 60; i++) {
    const a = performance.now();
    await cropToTensor(dummyRaw, { width: 1280, height: 720 }, [300, 100, 200, 400], reid);
    ct.push(performance.now() - a);
  }
  const cs = stats(ct);
  const perPerson = perEmb + cs.median;
  console.log(`  CROP (sharp extract+resize → 256×128): mediana=${ms(cs.median)}/pessoa`);
  console.log(`  CUSTO POR PESSOA = crop ${ms(cs.median)} + embedding ${perEmb.toFixed(2)}ms ≈ ${ms(perPerson)}\n`);

  // 4) CONTA N× + veredito de orçamento.
  console.log("  CONTA N× (N pessoas em quadro → custo ReID somado por rodada):");
  const isFixedBatch = reid.batch > 1;
  for (const N of [1, 3, 5, 8]) {
    // com batch FIXO B: 1 forward cobre até B pessoas (paga o forward inteiro); crop é por pessoa.
    const forwards = isFixedBatch ? Math.ceil(N / reid.batch) : N;
    const embCost = isFixedBatch ? forwards * fs2.median : N * perEmb;
    const total = N * cs.median + embCost;
    const rel = dfineMs != null ? ` = +${((total / dfineMs) * 100).toFixed(0)}% do D-FINE` : "";
    console.log(`    N=${N}: crop ${ms(N * cs.median)} + emb ${ms(embCost)} = ${ms(total)}${rel}`);
  }
  if (isFixedBatch) {
    console.log(`    (⚠ batch FIXO ${reid.batch}: para N<${reid.batch} paga-se o forward inteiro; um re-export com`);
    console.log(`     eixo de batch DINÂMICO daria custo ≈ N×${perEmb.toFixed(1)}ms — ver §'o que falta'.)`);
  }

  console.log("\n  VEREDITO DE ORÇAMENTO (spec §3, piso de custo):");
  if (dfineMs != null) {
    const nEmb8 = isFixedBatch ? Math.ceil(8 / reid.batch) * fs2.median : 8 * perEmb;
    const add8 = 8 * cs.median + nEmb8;
    const pct8 = (add8 / dfineMs) * 100;
    console.log(`    Câmera de LINHA roda a 2fps (ANALYSIS_FPS_LINE=2 → 500ms/rodada, engine.js:52).`);
    console.log(`    A rodada já gasta ~${ms(dfineMs)} no D-FINE; ReID a N=8 soma ~${ms(add8)} (+${pct8.toFixed(0)}%).`);
    if (pct8 <= 35) {
      console.log(`    → CABE com folga (este modelo/CPU): o delta N× é modesto. (Ressalva de VARIANTE abaixo.)`);
    } else if (pct8 <= 100) {
      console.log(`    → APERTADO: some ~${pct8.toFixed(0)}% de trabalho/rodada — cabe só se a rodada tinha folga.`);
    } else {
      console.log(`    → ESTOURA: ReID a N=8 custa mais que o próprio D-FINE — não roda como default (só amostrado).`);
    }
  } else {
    console.log("    (sem âncora D-FINE nesta corrida — rode com o modelo D-FINE presente p/ o veredito relativo.)");
  }
  console.log("\n  RESSALVA DE VARIANTE (honestidade obrigatória):");
  console.log("    O número acima é da VARIANTE medida. OSNet x0_25 (~0,2M params, ~0,08 GFLOPs) é a mais");
  console.log("    LEVE — é PISO de custo. O candidato do spec é OSNet x1_0 (~2,2M params, ~0,98 GFLOPs,");
  console.log("    o 94,8% de Market): ~12× os FLOPs → estimativa grosseira ~5–8× o custo/embedding na CPU");
  console.log("    (depthwise é memory-bound, não escala em FLOP). Extrapolação, NÃO medição — some x1_0 ao");
  console.log("    orçamento antes de decidir. INT8: NÃO medido (falta quantizer/onnxruntime.quantization).\n");
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// MODO RANK-1 — a métrica-que-mata (inerte até a caminhada #4 existir)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * PONTO DE ENTRADA DO DATASET ANOTADO (plugar aqui quando a caminhada #4 existir).
 * Formato esperado de REID_DATASET (JSON manifesto):
 *   {
 *     frames: [{ file:"f001.jpg", persons:[{ id:"op-A", box:[x,y,w,h], clothes:"uniforme" }] }],
 *     split:  { gallery:["op-A", ...], query:["op-A", ...] }   // ou por-frame
 *   }
 * onde `clothes` permite separar rank-1 MESMA-ROUPA vs UNIFORME (spec §3, Regra 11).
 */
function loadDataset(manifestPath) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!raw.frames || !Array.isArray(raw.frames)) throw new Error("manifesto sem `frames[]`");
  return raw;
}

async function runRank1() {
  if (!REID_DATASET || !fs.existsSync(REID_DATASET)) {
    console.log("\n[eval/reid] RANK-1 sob uniforme — a MÉTRICA-QUE-MATA (spec §3).");
    console.log("  NÃO MENSURÁVEL AGORA: exige a caminhada anotada #4 (operadores de uniforme real,");
    console.log("  protocolo-teste-campo-indoor.md) — ela ainda NÃO existe. O harness está fiado:");
    console.log("    crop → embedding → galeria id→médio → cosine → rank-1 (com Wilson 95%).");
    console.log("  Quando a #4 existir: REID_DATASET=/caminho/manifest.json REID_MODEL_PATH=/…/osnet.onnx \\");
    console.log("                       node eval/reid.mjs --rank1");
    console.log("  Reportar rank-1 UNIFORME vs MESMA-ROUPA na MESMA gravação (Regra 11) + n + Wilson.");
    console.log("  Ponto de não-ir (escrito ANTES do número): rank-1 sob uniforme < ~50% ⇒ ReID não resolve.\n");
    process.exit(0);
  }
  if (!REID_MODEL_PATH || !fs.existsSync(REID_MODEL_PATH)) {
    console.error("[eval/reid] --rank1 exige REID_MODEL_PATH (o OSNet .onnx). Ausente — abortando.");
    process.exit(2);
  }
  // CAMINHO REAL (roda quando o dataset chegar). Efêmero: nada persistido (LGPD).
  const ds = loadDataset(REID_DATASET);
  const reid = await loadReid(REID_MODEL_PATH);
  const imgDir = path.dirname(REID_DATASET);
  const embOf = async (file, box) => {
    const jpeg = fs.readFileSync(path.join(imgDir, file));
    const { data, info } = await sharp(jpeg).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const crop = await cropToTensor(data, { width: info.width, height: info.height }, box, reid);
    const [emb] = await embedBatch(reid, [crop]);
    return emb;
  };
  // Galeria: 1ª aparição de cada id; query: as demais. (Refinar com o split real do #4.)
  const gallerySamples = [];
  const queries = [];
  const seen = new Set();
  const byClothes = { uniforme: [], "mesma-roupa": [] };
  for (const fr of ds.frames) {
    for (const p of fr.persons || []) {
      const emb = await embOf(fr.file, p.box);
      if (!seen.has(p.id)) {
        seen.add(p.id);
        gallerySamples.push({ id: p.id, emb });
      } else {
        const q = { id: p.id, emb };
        queries.push(q);
        (byClothes[p.clothes] || (byClothes[p.clothes] = [])).push(q);
      }
    }
  }
  const gallery = buildGallery(gallerySamples);
  const report = (label, qs) => {
    const { hits, total } = rank1(qs, gallery);
    const [lo, hi] = wilsonInterval(hits, total);
    const pct = total ? ((hits / total) * 100).toFixed(1) : "—";
    console.log(`  rank-1 ${label.padEnd(14)}: ${hits}/${total} = ${pct}%  (Wilson95 ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%)`);
  };
  console.log(`\n[eval/reid] RANK-1 — galeria ${gallery.size} ids · ${queries.length} queries\n`);
  report("GERAL", queries);
  for (const [c, qs] of Object.entries(byClothes)) if (qs.length) report(c, qs);
  console.log("");
  process.exit(0);
}

// ── Selftest das funções puras (sem modelo/rede — evidência de que a lógica fecha) ──
function runSelftest() {
  const assert = (c, m) => { if (!c) { console.error("FALHOU:", m); process.exit(1); } };
  const a = l2normalize(new Float32Array([3, 4]));
  assert(Math.abs(Math.hypot(a[0], a[1]) - 1) < 1e-6, "l2normalize → norma 1");
  assert(Math.abs(cosine(a, a) - 1) < 1e-6, "cosine(v,v)=1");
  const g = buildGallery([
    { id: "A", emb: new Float32Array([1, 0]) },
    { id: "A", emb: new Float32Array([0.6, 0.8]) },
    { id: "B", emb: new Float32Array([0, 1]) },
  ]);
  assert(g.size === 2, "galeria com 2 ids");
  const r = rank1(
    [{ id: "A", emb: l2normalize(new Float32Array([0.9, 0.1])) }, { id: "B", emb: l2normalize(new Float32Array([0.1, 0.9])) }],
    g,
  );
  assert(r.hits === 2 && r.total === 2, "rank-1 casa protótipos óbvios");
  const [lo, hi] = wilsonInterval(13, 13);
  assert(lo > 0.75 && lo < 0.78 && hi <= 1, "Wilson 13/13 → ~[0.77,1] (não 100%)");
  const [lo6] = wilsonInterval(6, 6);
  assert(lo6 > 0.6 && lo6 < 0.62, "Wilson 6/6 → lo ~0.61");
  console.log("[eval/reid] selftest OK — l2normalize/cosine/buildGallery/rank1/wilson.");
  process.exit(0);
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
const mode = process.argv.find((a) => ["--cost", "--rank1", "--selftest"].includes(a)) || "--cost";
if (mode === "--selftest") runSelftest();
else if (mode === "--rank1") await runRank1();
else await runCost();
