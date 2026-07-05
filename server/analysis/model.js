// ─────────────────────────────────────────────────────────────────────────────
// model.js — Catálogo de modelos + provisionamento (verificação sha256 + download).
//
// Extraído de engine.js (R5/retrofit): a lógica de "qual .onnx e como garanti-lo no
// disco" é uma responsabilidade própria (YAGNI: uma responsabilidade por unidade).
// O engine consome via getModelPath()/getModelSpec() — o caminho e o spec são MUTÁVEIS
// porque ensureModel() faz fallback S→N quando o download do grande falha (mantém o
// comportamento byte-a-byte do original).
//
// Modelo: catálogo N/S/M (D-FINE, MESMA arquitetura → drop-in — eval/MODELS.md).
// Resolução por env ANALYSIS_MODEL = n|s|m (default "s"). O default de PRODUÇÃO é o
// D-FINE-S obj2coco: no fixture/full-set (eval/MODELS.md) o recall de pessoa média/pequena
// ~DOBRA vs o N — exatamente o gargalo que travava a contagem de linha
// (analises/acuracia-modelos.md §3) — a ~2.4× o CPU (~0.9 câmera/core @1fps no S vs ~2.2 no
// N; ~7 vs ~17 câmeras/core). CPU-bound? ANALYSIS_MODEL=n volta ao nano (recall menor, mais
// câmeras/core). Todos onnx-community/*-ONNX, Apache-2.0, fp32; baixados no boot com sha256.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MODELS = {
  n: {
    file: "dfine_n_coco.onnx",
    url: "https://huggingface.co/onnx-community/dfine_n_coco-ONNX/resolve/main/onnx/model.onnx",
    sha256: "0f684f409618ee8a822410e754a29caa817d1aa16283ce89cad936d0a48e2f35",
    bytes: 15_258_358, // 14,55 MB
    label: "D-FINE-N coco",
  },
  s: {
    file: "dfine_s_obj2coco.onnx",
    url: "https://huggingface.co/onnx-community/dfine_s_obj2coco-ONNX/resolve/main/onnx/model.onnx",
    sha256: "b9e2e76610053aeeac3b2f1f685d8f9a1182a93a338f624b6c8cb7fb390cb532",
    bytes: 41_535_197, // 39,6 MB
    label: "D-FINE-S obj2coco",
  },
  m: {
    file: "dfine_m_obj2coco.onnx",
    url: "https://huggingface.co/onnx-community/dfine_m_obj2coco-ONNX/resolve/main/onnx/model.onnx",
    sha256: "347f2faba93248c2e7500c9e604317fb391706c58a04802dd908573376dc1323",
    bytes: 78_624_257, // 75,0 MB
    label: "D-FINE-M obj2coco",
  },
};
// ANALYSIS_MODEL_PATH fixa o arquivo explicitamente (usado pelo eval/): sem catálogo/fallback.
const MODEL_OVERRIDE = process.env.ANALYSIS_MODEL_PATH || "";
const MODEL_KEY = (process.env.ANALYSIS_MODEL || "s").toLowerCase();
let modelSpec = MODELS[MODEL_KEY] || MODELS.s; // default de produção: S
let MODEL_PATH = MODEL_OVERRIDE || path.join(__dirname, "..", "models", modelSpec.file);

// ── Modelo: verificação + download com sha256 ────────────────────────────────
function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function modelOk() {
  try {
    const st = fs.statSync(MODEL_PATH);
    if (MODEL_OVERRIDE) return st.size > 0; // path fixado pelo operador → confia (não força sha do catálogo)
    if (st.size !== modelSpec.bytes) return false;
    return sha256File(MODEL_PATH) === modelSpec.sha256;
  } catch {
    return false;
  }
}

async function downloadModel() {
  console.log(`[analysis] baixando modelo ${modelSpec.label} (${(modelSpec.bytes / 1e6).toFixed(1)} MB) de ${modelSpec.url} …`);
  const res = await fetch(modelSpec.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar o modelo`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== modelSpec.bytes)
    throw new Error(`tamanho inesperado: ${buf.length} bytes (esperado ${modelSpec.bytes})`);
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha !== modelSpec.sha256) throw new Error(`sha256 divergente: ${sha} (esperado ${modelSpec.sha256})`);
  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
  fs.writeFileSync(MODEL_PATH + ".tmp", buf); // escrita atômica: nunca deixa modelo truncado
  fs.renameSync(MODEL_PATH + ".tmp", MODEL_PATH);
  console.log(`[analysis] modelo salvo em ${MODEL_PATH} (sha256 ok)`);
}

async function ensureModel(allowDownload) {
  if (modelOk()) return true;
  if (fs.existsSync(MODEL_PATH))
    console.warn("[analysis] modelo existente com tamanho/sha divergente — será rebaixado");
  if (!allowDownload) return false;
  try {
    await downloadModel();
    return true;
  } catch (e) {
    console.error(`[analysis] download de ${modelSpec.label} FALHOU: ${e.message}`);
    // Fallback: modelo grande (S/M) indisponível e SEM path fixado → cai p/ o N (recall
    // menor, mas o hub SEGUE analisando). Ajuste ANALYSIS_MODEL=n p/ evitar este caminho.
    if (!MODEL_OVERRIDE && modelSpec !== MODELS.n) {
      modelSpec = MODELS.n;
      MODEL_PATH = path.join(__dirname, "..", "models", modelSpec.file);
      console.warn(`[analysis] fallback → ${modelSpec.label} (recall menor que o default S)`);
      if (modelOk()) return true;
      try {
        await downloadModel();
        return true;
      } catch (e2) {
        console.error(`[analysis] fallback ${modelSpec.label} também FALHOU: ${e2.message} — motor DESLIGADO (hub segue normal)`);
        return false;
      }
    }
    console.error("[analysis] motor de análise DESLIGADO (hub segue normal)");
    return false;
  }
}

// getModelPath()/getModelSpec(): o engine lê o estado ATUAL (pode ter mudado por fallback).
function getModelPath() {
  return MODEL_PATH;
}
function getModelSpec() {
  return modelSpec;
}

module.exports = {
  MODELS,
  sha256File,
  modelOk,
  downloadModel,
  ensureModel,
  getModelPath,
  getModelSpec,
};
