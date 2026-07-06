// ─────────────────────────────────────────────────────────────────────────────
// model.js — Catálogo de modelos D-FINE (N/S/M, mesma arquitetura → drop-in) +
// provisionamento: verificação sha256, download com escrita atômica, fallback
// S/M→N e troca de tier em runtime (autoscale). Racional da escolha de tier e
// medições de recall/CPU: README.md §Modelo + eval/MODELS.md.
//
// CONTRATO com o engine: getModelPath()/getModelSpec() leem estado MUTÁVEL — o
// caminho/spec mudam por fallback (ensureModel) ou troca de tier (setActiveTier,
// ATÔMICO: só assume o novo tier com o arquivo garantido no disco; em falha,
// REVERTE — o worker nunca aponta p/ modelo ausente, o motor nunca fica cego).
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

// getActiveTier(): a KEY ("n"|"s"|"m") do modelSpec ATIVO — usado pelo autoscale p/ saber
// de onde parte e por status()/diagnóstico. null quando o path foi fixado por override
// (ANALYSIS_MODEL_PATH — eval/): fora do catálogo, sem tier nominal.
function getActiveTier() {
  if (MODEL_OVERRIDE) return null;
  for (const k of Object.keys(MODELS)) if (MODELS[k] === modelSpec) return k;
  return null;
}

// setTier(key): repointa o modelSpec/MODEL_PATH SEM baixar (setter síncrono). Usado no
// BOOT — pelo pin (ANALYSIS_MODEL=n|s|m) e pelo pick de startup do autoscale — ANTES do
// ensureModel() (que baixa o tier corrente com fallback S→N do catálogo). No-op sob
// override de path (eval/ fixa o .onnx). Devolve true se trocou p/ um tier válido.
function setTier(key) {
  if (MODEL_OVERRIDE) return false;
  const spec = MODELS[String(key || "").toLowerCase()];
  if (!spec) return false;
  modelSpec = spec;
  MODEL_PATH = path.join(__dirname, "..", "models", spec.file);
  return true;
}

// setActiveTier(key, allowDownload): troca de tier em RUNTIME (autoscale) de forma ATÔMICA.
// Só assume o novo tier DEPOIS de garanti-lo no disco; se o download falhar, REVERTE p/ o
// tier anterior (que já estava funcionando). Garantia de SEGURANÇA: o worker nunca passa a
// apontar p/ um modelo ausente — o motor nunca fica cego por causa do autoscale. Devolve
// true se o tier ativo virou `key`; false se manteve o anterior (inválido/override/falha).
async function setActiveTier(key, allowDownload) {
  if (MODEL_OVERRIDE) return false; // path fixado pelo operador — autoscale não troca
  const spec = MODELS[String(key || "").toLowerCase()];
  if (!spec) return false;
  if (spec === modelSpec) return true; // já é o tier ativo
  const prevSpec = modelSpec;
  const prevPath = MODEL_PATH;
  modelSpec = spec;
  MODEL_PATH = path.join(__dirname, "..", "models", spec.file);
  if (modelOk()) return true; // já no disco (baixado num pico anterior) — troca imediata
  if (!allowDownload) {
    modelSpec = prevSpec; // não pode baixar → NUNCA fica sem modelo: reverte
    MODEL_PATH = prevPath;
    return false;
  }
  try {
    await downloadModel();
    return true;
  } catch (e) {
    console.error(
      `[analysis] troca de tier p/ ${spec.label} FALHOU: ${e.message} — mantém ${prevSpec.label} (motor segue analisando)`,
    );
    modelSpec = prevSpec; // REVERTE: worker continua no modelo que já estava vivo
    MODEL_PATH = prevPath;
    return false;
  }
}

module.exports = {
  MODELS,
  sha256File,
  modelOk,
  downloadModel,
  ensureModel,
  getModelPath,
  getModelSpec,
  getActiveTier,
  setTier,
  setActiveTier,
};
