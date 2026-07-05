// Uso: node scripts/fetch-go2rtc.mjs [--platform <win64|linux-amd64|linux-arm64|all>]
//
// Baixa o binário do go2rtc para <root>/bin/ a fim de EMPACOTAR no release — NÃO é um download
// em runtime. É o mesmo padrão do ensureModel do motor de análise (server/analysis/engine.js:
// catálogo por-artefato → download → verificação sha256 → escrita atômica), mas aqui a intenção é
// PACKAGING (rodar uma vez no build/CI), não boot do hub.
//
// O binário é EMPACOTADO no release e o server/go2rtc.js liga o sidecar pela PRESENÇA do arquivo
// (bin/go2rtc[.exe]) — o cliente não seta GO2RTC_ENABLED nem GO2RTC_BIN. O binário NUNCA é
// versionado no git (bin/ está no .gitignore).
//
// --platform default = plataforma atual (win32→win64, linux x64→linux-amd64, linux arm64→linux-arm64).
//   "all" baixa os três (útil p/ um release multi-plataforma).
//
// Windows: o asset é um .zip contendo go2rtc.exe (extraído via zlib nativo — sem dependência).
// Linux: o asset é o binário cru (recebe chmod +x). Verificação sha256 é SEMPRE do asset baixado.

import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, renameSync, chmodSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BIN_DIR = join(ROOT, "bin");

// ── Catálogo {plataforma → asset do release + sha256 + destino} ──────────────────────────────
// go2rtc v1.9.14 (2026-01-19), Apache-2.0. sha256 do ASSET BAIXADO (zip no Windows, binário cru no
// Linux) — recalcular ao bumpar a versão: baixe o asset e rode `sha256sum <asset>`.
const RELEASE = "v1.9.14";
const BASE = `https://github.com/AlexxIT/go2rtc/releases/download/${RELEASE}`;
const CATALOG = {
  win64: {
    asset: "go2rtc_win64.zip",
    url: `${BASE}/go2rtc_win64.zip`,
    sha256: "dd4167d75cb04abe618855b7c71f8658bd009f60c1a71835d134d2c11c939907",
    zipEntry: "go2rtc.exe", // extrair este arquivo de dentro do zip
    out: "go2rtc.exe",
    exec: false,
  },
  "linux-amd64": {
    asset: "go2rtc_linux_amd64",
    url: `${BASE}/go2rtc_linux_amd64`,
    sha256: "32d616af226bd731678ffde328b94cfb94e30339bfefc469cfb76323144615a6",
    out: "go2rtc",
    exec: true, // chmod +x
  },
  "linux-arm64": {
    asset: "go2rtc_linux_arm64",
    url: `${BASE}/go2rtc_linux_arm64`,
    sha256: "359fabade8a7a51e81a55fe6df6b0ef81764a5e1d63179577534eaaa71904b50",
    out: "go2rtc",
    exec: true,
  },
};

// ── Detecção da plataforma atual (default quando --platform não é passado) ────────────────────
function detectPlatform() {
  if (process.platform === "win32") return "win64";
  if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-amd64";
  throw new Error(
    `plataforma atual (${process.platform}/${process.arch}) sem asset no catálogo — passe --platform win64|linux-amd64|linux-arm64`,
  );
}

// ── Unzip mínimo de UMA entrada nomeada, via zlib nativo (sem dependência externa) ────────────
// Percorre o End of Central Directory → Central Directory → Local File Header para achar o offset
// dos dados comprimidos e inflar (método 8 = deflate) ou copiar (método 0 = stored).
function extractZipEntry(zipBuf, entryName) {
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip inválido: End of Central Directory não encontrado");
  const count = zipBuf.readUInt16LE(eocd + 10);
  let ptr = zipBuf.readUInt32LE(eocd + 16); // offset da central directory
  for (let n = 0; n < count; n++) {
    if (zipBuf.readUInt32LE(ptr) !== 0x02014b50) throw new Error("zip inválido: central directory header");
    const method = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localOff = zipBuf.readUInt32LE(ptr + 42);
    const name = zipBuf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    if (name === entryName) {
      if (zipBuf.readUInt32LE(localOff) !== 0x04034b50) throw new Error("zip inválido: local file header");
      const lNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = zipBuf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(comp);
      if (method === 8) return zlib.inflateRawSync(comp);
      throw new Error(`método de compressão do zip não suportado: ${method}`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entrada "${entryName}" não encontrada no zip`);
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fetchPlatform(key) {
  const spec = CATALOG[key];
  if (!spec) {
    throw new Error(`plataforma desconhecida: ${key} (use ${Object.keys(CATALOG).join(" | ")} | all)`);
  }
  process.stdout.write(`[fetch-go2rtc] baixando ${spec.asset} (${key}) de ${spec.url} …\n`);
  const res = await fetch(spec.url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao baixar ${spec.asset}`);
  const asset = Buffer.from(await res.arrayBuffer());

  const got = sha256(asset);
  if (got !== spec.sha256) {
    throw new Error(`sha256 divergente de ${spec.asset}: ${got} (esperado ${spec.sha256})`);
  }
  process.stdout.write(`[fetch-go2rtc] sha256 ok (${asset.length} bytes)\n`);

  // Zip → extrai a entrada; binário cru → usa o próprio asset.
  const bin = spec.zipEntry ? extractZipEntry(asset, spec.zipEntry) : asset;

  mkdirSync(BIN_DIR, { recursive: true });
  const dest = join(BIN_DIR, spec.out);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, bin); // escrita atômica: nunca deixa um binário truncado em bin/
  renameSync(tmp, dest);
  if (spec.exec) chmodSync(dest, 0o755);

  process.stdout.write(
    `[fetch-go2rtc] gravado ${dest} (${bin.length} bytes${spec.exec ? ", +x" : ""})\n`,
  );
  return dest;
}

async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--platform");
  const requested = pi >= 0 ? args[pi + 1] : null;
  const targets = requested === "all" ? Object.keys(CATALOG) : [requested || detectPlatform()];

  process.stdout.write(`[fetch-go2rtc] go2rtc ${RELEASE} → ${BIN_DIR} · alvos: ${targets.join(", ")}\n`);
  for (const t of targets) await fetchPlatform(t);
  process.stdout.write(`[fetch-go2rtc] concluído (${targets.length} binário(s)). NÃO versionar bin/ no git.\n`);
}

main().catch((e) => {
  process.stderr.write(`[fetch-go2rtc] ERRO: ${e.message}\n`);
  try {
    rmSync(join(BIN_DIR, "go2rtc.exe.tmp"), { force: true });
    rmSync(join(BIN_DIR, "go2rtc.tmp"), { force: true });
  } catch {
    /* nada a limpar */
  }
  process.exit(1);
});
