// Uso: node scripts/validate-streams.mjs [caminho-do-json]
//
// Valida conectividade dos feeds de câmera demo do MVP.
// Lê server/rtsp.sources.json (ou o arquivo passado como argumento) e, para
// cada fonte, usa ffprobe (com fallback para ffmpeg) para testar a conexão e
// reportar OK/FALHA com tempo de resposta e resolução detectada.
//
// Exemplos:
//   node scripts/validate-streams.mjs
//   node scripts/validate-streams.mjs server/rtsp.sources.extra.example.json
//
// Degrada graciosamente: se ffprobe/ffmpeg não estiverem no PATH, avisa e sai
// sem quebrar (o restante do MVP — câmeras de navegador — não depende disto).

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, isAbsolute } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// Timeout por fonte (ms). Configurável via env PROBE_TIMEOUT_MS.
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 20000);

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

function log(...a) { console.log(...a); }
function redact(url) { return String(url).replace(/\/\/([^@/]+)@/, "//***@"); }

/** Verifica se um executável existe no PATH rodando `<bin> -version`. */
function hasBinary(bin) {
  return new Promise((res) => {
    const p = spawn(bin, ["-version"], { stdio: "ignore" });
    p.on("error", () => res(false));
    p.on("close", (code) => res(code === 0));
  });
}

/** Roda um comando, devolve { code, stdout, stderr, timedOut } com timeout/kill. */
function run(bin, args, timeoutMs) {
  return new Promise((res) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      try { p.kill("SIGKILL"); } catch { /* noop */ }
    }, timeoutMs);
    p.on("error", (e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      res({ code: -1, stdout, stderr: stderr + e.message, timedOut, spawnError: e });
    });
    p.stdout?.on("data", (d) => { stdout += d.toString(); });
    p.stderr?.on("data", (d) => { stderr += d.toString(); });
    p.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      res({ code, stdout, stderr, timedOut });
    });
  });
}

/** Argumentos comuns de transporte/timeout para RTSP vs HLS/MJPEG (HTTP). */
function transportArgs(url) {
  const args = [];
  if (/^rtsp:\/\//i.test(url)) {
    args.push("-rtsp_transport", "tcp");
  }
  // -timeout em microssegundos (rede). Cobre RTSP/HTTP travados.
  args.push("-timeout", String(PROBE_TIMEOUT_MS * 1000));
  return args;
}

/** Testa via ffprobe — retorna { ok, width, height, codec, note }. */
async function probeWithFfprobe(url) {
  const args = [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,codec_name",
    "-of", "default=noprint_wrappers=1:nokey=0",
    ...transportArgs(url),
    "-i", url,
  ];
  const r = await run("ffprobe", args, PROBE_TIMEOUT_MS);
  if (r.timedOut) return { ok: false, note: `timeout (${PROBE_TIMEOUT_MS}ms)` };
  if (r.code !== 0) {
    const firstLine = (r.stderr || "").split("\n").map((s) => s.trim()).filter(Boolean)[0];
    return { ok: false, note: firstLine || `ffprobe saiu com código ${r.code}` };
  }
  const out = r.stdout;
  const width = (out.match(/width=(\d+)/) || [])[1];
  const height = (out.match(/height=(\d+)/) || [])[1];
  const codec = (out.match(/codec_name=(\S+)/) || [])[1];
  if (!width || !height) return { ok: false, note: "conectou mas sem stream de vídeo detectado" };
  return { ok: true, width, height, codec };
}

/** Fallback: ffmpeg captura 1 frame e lê a resolução do stderr. */
async function probeWithFfmpeg(url) {
  const args = [
    ...transportArgs(url),
    "-i", url,
    "-frames:v", "1",
    "-f", "null", "-",
  ];
  const r = await run("ffmpeg", args, PROBE_TIMEOUT_MS);
  if (r.timedOut) return { ok: false, note: `timeout (${PROBE_TIMEOUT_MS}ms)` };
  const res = (r.stderr.match(/,\s*(\d{2,5})x(\d{2,5})/) || []);
  const width = res[1], height = res[2];
  if (r.code === 0 || (width && height)) {
    if (width && height) return { ok: true, width, height };
    return { ok: true, note: "conectou (resolução não detectada)" };
  }
  const firstErr = (r.stderr || "").split("\n").map((s) => s.trim())
    .filter((s) => s && !s.startsWith("ffmpeg version") && !s.startsWith("built with") && !s.startsWith("configuration"))
    .pop();
  return { ok: false, note: firstErr || `ffmpeg saiu com código ${r.code}` };
}

function resolveSourcesPath(arg) {
  if (arg) return isAbsolute(arg) ? arg : resolve(process.cwd(), arg);
  return resolve(PROJECT_ROOT, "server", "rtsp.sources.json");
}

async function main() {
  const sourcesPath = resolveSourcesPath(process.argv[2]);

  log(`${C.bold}Validador de feeds demo — Visão Computacional MVP${C.reset}`);
  log(`${C.dim}Arquivo: ${sourcesPath}${C.reset}\n`);

  if (!existsSync(sourcesPath)) {
    log(`${C.red}ERRO:${C.reset} arquivo não encontrado. Crie server/rtsp.sources.json (veja rtsp.sources.example.json).`);
    process.exit(2);
  }

  let sources;
  try {
    sources = JSON.parse(readFileSync(sourcesPath, "utf8"));
  } catch (e) {
    log(`${C.red}ERRO:${C.reset} JSON inválido em ${sourcesPath}: ${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(sources)) {
    log(`${C.red}ERRO:${C.reset} o JSON deve ser um array [{ "label", "url" }].`);
    process.exit(2);
  }
  sources = sources.filter((s) => s && s.url);
  if (!sources.length) {
    log(`${C.yellow}Nenhuma fonte com 'url' no arquivo.${C.reset}`);
    process.exit(0);
  }

  // Detecta ferramentas disponíveis (degradação graciosa).
  const ffprobeOk = await hasBinary("ffprobe");
  const ffmpegOk = await hasBinary("ffmpeg");

  if (!ffprobeOk && !ffmpegOk) {
    log(`${C.red}ffprobe/ffmpeg não encontrados no PATH.${C.reset}`);
    log(`Instale o ffmpeg (inclui ffprobe) para validar os streams:`);
    log(`  - Windows: winget install Gyan.FFmpeg   (ou choco install ffmpeg)`);
    log(`  - macOS:   brew install ffmpeg`);
    log(`  - Linux:   sudo apt install ffmpeg`);
    log(`\n${C.dim}As câmeras de navegador do MVP funcionam sem ffmpeg; ele só é necessário para feeds RTSP/HLS/MJPEG.${C.reset}`);
    process.exit(3);
  }

  const tool = ffprobeOk ? "ffprobe" : "ffmpeg (fallback)";
  log(`${C.dim}Ferramenta: ${tool} · timeout: ${PROBE_TIMEOUT_MS}ms · fontes: ${sources.length}${C.reset}\n`);

  let okCount = 0, failCount = 0;
  const results = [];

  for (const src of sources) {
    const label = src.label || "(sem label)";
    const tag = src.verified === true ? `${C.cyan}[verificado]${C.reset} `
      : src.verified === false ? `${C.yellow}[não verificado]${C.reset} ` : "";
    process.stdout.write(`${C.bold}• ${label}${C.reset} ${tag}\n  ${C.dim}${redact(src.url)}${C.reset}\n`);

    const t0 = Date.now();
    const r = ffprobeOk ? await probeWithFfprobe(src.url) : await probeWithFfmpeg(src.url);
    const ms = Date.now() - t0;

    if (r.ok) {
      okCount++;
      const reso = r.width && r.height ? `${r.width}x${r.height}` : "?";
      const codec = r.codec ? ` ${r.codec}` : "";
      log(`  ${C.green}OK${C.reset}  ${ms}ms  resolução ${reso}${codec}${r.note ? ` ${C.dim}(${r.note})${C.reset}` : ""}\n`);
    } else {
      failCount++;
      log(`  ${C.red}FALHA${C.reset}  ${ms}ms  ${r.note || "erro desconhecido"}\n`);
    }
    results.push({ label, ok: r.ok, ms, reso: r.width ? `${r.width}x${r.height}` : "", note: r.note || "" });
  }

  log(`${C.bold}Resumo:${C.reset} ${C.green}${okCount} OK${C.reset} · ${C.red}${failCount} FALHA${C.reset} (de ${sources.length})`);
  // Código de saída: 0 se tudo OK, 1 se houve alguma falha (útil em CI/smoke test).
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erro inesperado:", e);
  process.exit(2);
});
