// Sidecar go2rtc — transporte de vídeo WebRTC/MSE/HLS (Fase 1 do retrofit de performance).
//
// go2rtc (Apache-2.0, 1 binário Go) faz codec-copy (0 re-encode) das câmeras RTSP/HLS e serve
// WebRTC ao navegador. Este módulo NÃO substitui o relé MJPEG do rtsp.js — os dois vivem em
// paralelo (rollback). O front escolhe o transporte por câmera (camcfg.transport).
//
// DESLIGADO POR DEFAULT (invariante do incremento): sem GO2RTC_ENABLED=1 OU sem GO2RTC_BIN
// existente, este módulo é INERTE — nada é gerado, nenhum processo sobe, o hub segue idêntico.
//
// Responsabilidades:
//  (a) GERAR um go2rtc.yaml a partir das câmeras atuais — o NOME de cada stream é o ID da câmera
//      (contrato com o front: `/go2rtc/api/ws?src=<cameraId>`). Regenera quando a lista muda.
//  (b) SUPERVISIONAR o processo go2rtc: spawn, restart com backoff exponencial, log.
//  (c) PROXY reverso same-origin: /go2rtc/* -> 127.0.0.1:1984 (HTTP + upgrade WebSocket /api/ws).
//
// LGPD/ADR-002: go2rtc só relaya/remuxa — NENHUM módulo `record:` é configurado, frames seguem
// efêmeros. O YAML gerado pode conter credenciais (URL rtsp://user:pass@...) → é escrito FORA do
// repositório (ao lado do binário, ex.: /opt/go2rtc em prod), nunca versionado.

const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");

// ── Configuração por ambiente (tudo com default seguro; OFF por ausência) ────────────────────
const ENABLED = /^(1|true|yes|on)$/i.test(String(process.env.GO2RTC_ENABLED || ""));
const BIN = String(process.env.GO2RTC_BIN || "").trim();
const API_HOST = "127.0.0.1"; // proxy same-origin: go2rtc só escuta local; nginx/hub expõem /go2rtc/
const API_PORT = Number(process.env.GO2RTC_API_PORT ?? 1984);
const RTSP_PORT = Number(process.env.GO2RTC_RTSP_PORT ?? 8554);
const WEBRTC_PORT = Number(process.env.GO2RTC_WEBRTC_PORT ?? 8555);
// Candidatos WebRTC (necessário só p/ acesso FORA da LAN): "10.0.0.20:8555,stun:8555".
const WEBRTC_CANDIDATES = String(process.env.GO2RTC_WEBRTC_CANDIDATES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// YAML gerado: por default ao LADO do binário (fora do repo). Nunca versionar (pode ter credenciais).
const YAML_PATH =
  String(process.env.GO2RTC_YAML || "").trim() ||
  (BIN ? path.join(path.dirname(BIN), "go2rtc.gen.yaml") : path.join(__dirname, "go2rtc.gen.yaml"));

// Reconexão do processo: backoff exponencial com teto (espelha a doutrina do rtsp.js).
const BASE_DELAY = Number(process.env.GO2RTC_RESTART_BASE_MS ?? 2000);
const MAX_DELAY = Number(process.env.GO2RTC_RESTART_MAX_MS ?? 30000);
const SYNC_DEBOUNCE_MS = Number(process.env.GO2RTC_SYNC_DEBOUNCE_MS ?? 800);
const UPTIME_RESET_MS = 15000; // rodou > 15s sem cair → zera o contador de backoff

let proc = null; // ChildProcess atual (ou null)
let stopped = false; // shutdown intencional — não religar
let attempt = 0; // tentativas de restart consecutivas (backoff)
let restartTimer = null;
let syncTimer = null;
let uptimeTimer = null;
let getSources = null; // callback do hub: () => [{ id, url }]
let lastYaml = ""; // conteúdo já escrito — evita restart sem mudança real
let started = false; // init() já rodou

function binExists() {
  return Boolean(BIN) && fs.existsSync(BIN);
}
/** O feature-flag está ligado E o binário existe? (proxy e supervisor só agem se sim.) */
function enabled() {
  return ENABLED && binExists();
}
/** Helper p/ o proxy saber a base do go2rtc. */
function apiTarget() {
  return { host: API_HOST, port: API_PORT };
}
function apiBase() {
  return `${API_HOST}:${API_PORT}`;
}

// ── (a) Geração do go2rtc.yaml ───────────────────────────────────────────────────────────────
// YAML válido via aspas duplas (superset de JSON string): JSON.stringify escapa `"` e `\`,
// cobrindo URLs com credenciais/query-strings e ids arbitrários sem quebrar o parser.
function q(s) {
  return JSON.stringify(String(s));
}

/** Monta o texto do go2rtc.yaml. sources: [{ id, url }] — id vira o NOME do stream (contrato). */
function generateYaml(sources) {
  const seen = new Set();
  const lines = [];
  lines.push("# GERADO por server/go2rtc.js — NÃO editar à mão (regenerado quando as câmeras mudam).");
  lines.push("# LGPD: sem módulo de gravação (record) — go2rtc só relaya/remuxa, frames efêmeros.");
  lines.push("api:");
  lines.push(`  listen: ${q(`:${API_PORT}`)}`);
  // origin "*" libera o handshake WebSocket (/api/ws) cross-origin — OBRIGATÓRIO atrás do
  // reverse-proxy /go2rtc/: o browser envia Origin = origem do app (≠ go2rtc 127.0.0.1:1984), e
  // sem isto o go2rtc responde 403 no upgrade → o tile WebRTC fica VAZIO. go2rtc só escuta local,
  // então "*" não expõe nada além do que o proxy já intermedia. (Confirmado por teste Playwright.)
  lines.push(`  origin: ${q("*")}`);
  lines.push("rtsp:");
  lines.push(`  listen: ${q(`:${RTSP_PORT}`)}`);
  lines.push("webrtc:");
  lines.push(`  listen: ${q(`:${WEBRTC_PORT}`)}`);
  if (WEBRTC_CANDIDATES.length) {
    lines.push("  candidates:");
    for (const c of WEBRTC_CANDIDATES) lines.push(`    - ${q(c)}`);
  }
  lines.push("log:");
  lines.push(`  level: ${q(process.env.GO2RTC_LOG_LEVEL || "info")}`);

  const valid = (Array.isArray(sources) ? sources : [])
    .filter((s) => s && s.id && s.url && !seen.has(String(s.id)))
    .filter((s) => seen.add(String(s.id)) || true); // dedup por id (primeiro vence)

  if (!valid.length) {
    lines.push("streams: {}");
  } else {
    lines.push("streams:");
    for (const s of valid) {
      // codec-copy (0 re-encode): passa a URL crua. Transcode pontual (HEVC→h264) é opt-in
      // por câmera no futuro; aqui mantemos o caminho barato por default.
      lines.push(`  ${q(s.id)}:`);
      lines.push(`    - ${q(s.url)}`);
    }
  }
  return { text: lines.join("\n") + "\n", count: valid.length };
}

/** Coleta as fontes atuais via callback do hub. Nunca lança (falha → lista vazia). */
function currentSources() {
  try {
    const arr = typeof getSources === "function" ? getSources() : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error("[go2rtc] falha ao coletar câmeras:", e.message);
    return [];
  }
}

// ── (b) Supervisão do processo ───────────────────────────────────────────────────────────────
function logChunk(prefix, d) {
  const line = String(d).trim();
  if (line) console.log(`[go2rtc]${prefix} ${line.split(/\r?\n/).slice(-1)[0]}`);
}

function scheduleUptimeReset(child) {
  if (uptimeTimer) clearTimeout(uptimeTimer);
  uptimeTimer = setTimeout(() => {
    if (proc === child) attempt = 0; // sobreviveu → backoff volta ao zero
  }, UPTIME_RESET_MS);
}

function spawnProc() {
  if (stopped || !enabled()) return;
  let child;
  try {
    child = spawn(BIN, ["-config", YAML_PATH], {
      cwd: path.dirname(YAML_PATH),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (e) {
    console.error("[go2rtc] spawn falhou:", e.message);
    return;
  }
  proc = child;
  child.stdout.on("data", (d) => logChunk("", d));
  child.stderr.on("data", (d) => logChunk("", d)); // go2rtc loga no stderr por padrão
  child.on("error", (e) => {
    console.error("[go2rtc] erro do processo:", e.message);
  });
  child.on("exit", (code, signal) => {
    if (proc !== child) return; // já substituído por um restart() — ignorar
    proc = null;
    if (stopped) return;
    attempt++;
    const delay = Math.min(BASE_DELAY * 2 ** (attempt - 1), MAX_DELAY);
    console.warn(
      `[go2rtc] processo saiu (code=${code} signal=${signal}) — reiniciando em ${delay}ms (tentativa ${attempt})`,
    );
    restartTimer = setTimeout(spawnProc, delay);
  });
  scheduleUptimeReset(child);
  console.log(`[go2rtc] iniciado (pid ${child.pid}) · api ${apiBase()} · rtsp :${RTSP_PORT} · webrtc :${WEBRTC_PORT}`);
}

/** Reinicia limpando o backoff. Aguarda o processo antigo LIBERAR a porta antes de subir o novo. */
function restart() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (!proc) {
    attempt = 0;
    spawnProc();
    return;
  }
  const old = proc;
  proc = null; // destaca: o "exit" do spawnProc vê proc!==old e não agenda backoff
  const relaunch = () => {
    attempt = 0;
    spawnProc();
  };
  old.once("exit", relaunch);
  try {
    old.kill();
  } catch {
    old.removeListener("exit", relaunch);
    relaunch();
  }
}

// ── (a+b) Sincronização: regenera o YAML e reinicia se o conteúdo mudou (debounced) ──────────
function doSync() {
  syncTimer = null;
  if (!enabled()) return;
  const { text, count } = generateYaml(currentSources());
  if (text === lastYaml && proc) return; // nada mudou e já está no ar
  const changed = text !== lastYaml;
  lastYaml = text;
  try {
    fs.writeFileSync(YAML_PATH, text);
  } catch (e) {
    console.error("[go2rtc] falha ao escrever", YAML_PATH, "-", e.message);
    return;
  }
  if (changed) console.log(`[go2rtc] go2rtc.yaml regenerado (${count} stream(s)) → ${YAML_PATH}`);
  restart();
}

/** Chamado quando a lista de câmeras muda (hook em index.js). No-op se desligado. Debounced. */
function sync() {
  if (!enabled() || stopped) return;
  if (syncTimer) return; // já agendado — coalesce rajadas de CRUD
  syncTimer = setTimeout(doSync, SYNC_DEBOUNCE_MS);
}

// ── (c) Proxy reverso same-origin: /go2rtc/* -> 127.0.0.1:1984 ───────────────────────────────
function upstreamPath(url) {
  // "/go2rtc/api/ws?src=x" -> "/api/ws?src=x"; "/go2rtc" -> "/"
  const p = String(url).slice("/go2rtc".length);
  return p === "" ? "/" : p;
}

/** Proxy de requisições HTTP (UI, /api, /api/frame.jpeg, /api/streams, HLS, MJPEG fallback). */
function proxyRequest(req, res) {
  if (!enabled()) {
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("go2rtc desligado");
    return;
  }
  const up = http.request(
    {
      host: API_HOST,
      port: API_PORT,
      method: req.method,
      path: upstreamPath(req.url),
      headers: req.headers,
    },
    (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("go2rtc indisponível");
  });
  req.pipe(up);
}

/** Proxy do upgrade WebSocket (/go2rtc/api/ws — sinalização WebRTC). Túnel TCP cru. */
function proxyUpgrade(req, socket, head) {
  if (!enabled()) {
    socket.destroy();
    return;
  }
  const up = net.connect(API_PORT, API_HOST, () => {
    let reqLine = `${req.method} ${upstreamPath(req.url)} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      reqLine += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    reqLine += "\r\n";
    up.write(reqLine);
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

// ── Ciclo de vida ────────────────────────────────────────────────────────────────────────────
/** Sobe o supervisor (idempotente). getSources: () => [{ id, url }] das câmeras atuais. */
function init(opts) {
  if (started) return;
  started = true;
  getSources = opts && typeof opts.getSources === "function" ? opts.getSources : null;
  if (!ENABLED) {
    console.log("[go2rtc] desligado (defina GO2RTC_ENABLED=1 para ligar) — hub segue no MJPEG");
    return;
  }
  if (!binExists()) {
    console.warn(
      `[go2rtc] GO2RTC_ENABLED=1 mas binário ausente (GO2RTC_BIN=${BIN || "não definido"}) — supervisor inerte, hub segue no MJPEG`,
    );
    return;
  }
  // Encerramento limpo: não deixar o go2rtc órfão quando o hub cai.
  const onExit = () => stop();
  process.once("exit", onExit);
  process.once("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stop();
    process.exit(0);
  });
  // Gera o YAML inicial e sobe o processo já.
  const { text, count } = generateYaml(currentSources());
  lastYaml = text;
  try {
    fs.writeFileSync(YAML_PATH, text);
    console.log(`[go2rtc] go2rtc.yaml gerado (${count} stream(s)) → ${YAML_PATH}`);
  } catch (e) {
    console.error("[go2rtc] falha ao escrever YAML inicial:", e.message);
    return;
  }
  spawnProc();
}

/** Mata o processo e para o supervisor (shutdown/teste). Idempotente. */
function stop() {
  stopped = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (syncTimer) clearTimeout(syncTimer);
  if (uptimeTimer) clearTimeout(uptimeTimer);
  restartTimer = syncTimer = uptimeTimer = null;
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* já morto */
    }
    proc = null;
  }
}

module.exports = {
  init,
  stop,
  sync,
  enabled,
  apiTarget,
  apiBase,
  proxyRequest,
  proxyUpgrade,
  generateYaml, // exportado p/ teste/unit
  isRunning: () => Boolean(proc),
};
