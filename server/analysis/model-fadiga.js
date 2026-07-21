// ─────────────────────────────────────────────────────────────────────────────
// model-fadiga.js — catálogo/provisionamento dos modelos do pipeline de FADIGA
// no hub (F1a, spec-fadiga-no-hub): YuNet (detector de rosto) + FaceMesh V2
// (478 landmarks). Mesmo padrão do model.js do D-FINE (sha256 + escrita
// atômica), com uma diferença: a origem (PINTO model zoo, Apache-2.0) publica
// TARBALLs — o download extrai o .onnx de dentro do tar.gz (zlib nativo, sem
// dependência) e verifica o sha256 do ARQUIVO FINAL (o que o ORT carrega).
// Medições do spike F0 (2026-07-21): FaceMesh 7,4ms/inferência CPU 2 threads.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const MODELS_DIR = path.join(__dirname, "..", "models");

const FADIGA_MODELS = {
  yunet: {
    file: "face_detection_yunet_2023mar.onnx",
    tarUrl: "https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/387_YuNetV2/resources.tar.gz",
    entry: "face_detection_yunet_2023mar.onnx", // basename dentro do tar
    sha256: "6f5104237c5b73247675496a554df3534a6bd0379aafb949b4567a03867c3070",
    bytes: 232_560,
    label: "YuNet 2023mar (detector de rosto)",
  },
  facemesh: {
    file: "face_landmarks_detector_1x3x256x256.onnx",
    tarUrl: "https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/410_FaceMeshV2/resources.tar.gz",
    entry: "face_landmarks_detector_1x3x256x256.onnx",
    sha256: "70fe4e14169ca084b03b8103077a4051296e07939a19c1fdfd1f18b3792b4048",
    bytes: 4_955_225,
    label: "FaceMesh V2 (478 landmarks)",
  },
};

function sha256Buf(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Extrai UM arquivo (por basename) de um tar.gz em memória. Formato tar clássico:
 * blocos de 512B — header (name@0..99, size octal@124..135, typeflag@156) + dados
 * em blocos de 512 arredondados. Entradas PAX/GNU-longname são puladas pelos
 * próprios tamanhos. Devolve Buffer ou null se não achar.
 */
function extractFromTarGz(gzBuf, basename) {
  const tar = zlib.gunzipSync(gzBuf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.toString("utf8", off, off + 100).replace(/\0.*$/, "");
    if (!name) break; // dois blocos de zeros = fim do arquivo tar
    const sizeStr = tar.toString("utf8", off + 124, off + 136).replace(/[\0 ].*$/, "");
    const size = parseInt(sizeStr, 8) || 0;
    const type = tar[off + 156];
    const dataStart = off + 512;
    // typeflag '0' (48) ou NUL = arquivo comum
    if ((type === 48 || type === 0) && path.posix.basename(name) === basename) {
      return tar.subarray(dataStart, dataStart + size);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function fadigaModelPath(key) {
  return path.join(MODELS_DIR, FADIGA_MODELS[key].file);
}

function fadigaModelOk(key) {
  const spec = FADIGA_MODELS[key];
  try {
    const p = fadigaModelPath(key);
    const st = fs.statSync(p);
    if (st.size !== spec.bytes) return false;
    return sha256Buf(fs.readFileSync(p)) === spec.sha256;
  } catch {
    return false;
  }
}

async function downloadFadigaModel(key) {
  const spec = FADIGA_MODELS[key];
  console.log(`[fadiga-hub] baixando ${spec.label} (tarball) de ${spec.tarUrl} …`);
  const res = await fetch(spec.tarUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar tarball de ${spec.label}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const onnx = extractFromTarGz(gz, spec.entry);
  if (!onnx) throw new Error(`entrada "${spec.entry}" não encontrada no tarball de ${spec.label}`);
  if (onnx.length !== spec.bytes)
    throw new Error(`tamanho inesperado: ${onnx.length} bytes (esperado ${spec.bytes})`);
  const sha = sha256Buf(onnx);
  if (sha !== spec.sha256) throw new Error(`sha256 divergente: ${sha} (esperado ${spec.sha256})`);
  const p = fadigaModelPath(key);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + ".tmp", onnx); // escrita atômica — nunca deixa .onnx truncado
  fs.renameSync(p + ".tmp", p);
  console.log(`[fadiga-hub] ${spec.label} salvo em ${p} (sha256 ok)`);
}

/** Garante os DOIS modelos no disco. false = pipeline de fadiga não liga (hub segue normal). */
async function ensureFadigaModels(allowDownload) {
  for (const key of Object.keys(FADIGA_MODELS)) {
    if (fadigaModelOk(key)) continue;
    if (!allowDownload) return false;
    try {
      await downloadFadigaModel(key);
    } catch (e) {
      console.error(`[fadiga-hub] download de ${FADIGA_MODELS[key].label} FALHOU: ${e.message} — fadiga no hub DESLIGADA (hub segue normal)`);
      return false;
    }
  }
  return true;
}

module.exports = { FADIGA_MODELS, fadigaModelPath, fadigaModelOk, ensureFadigaModels, extractFromTarGz };
