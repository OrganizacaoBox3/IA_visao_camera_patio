// Ingestão de câmeras IP/RTSP no hub.
// O navegador NÃO reproduz RTSP. Aqui o ffmpeg lê o RTSP/HLS/MJPEG e produz frames JPEG (MJPEG),
// que são emitidos como o MESMO evento "frame" das câmeras de navegador → o dashboard
// trata uma câmera IP como qualquer outra (zonas, análise, histórico) sem mudança no front.
// Requer ffmpeg no PATH. Caminho de produção de baixa latência: WebRTC (go2rtc/mediamtx).
//
// Esta versão suporta:
//  - ciclo de vida por stream em runtime (addSource/removeSource/restartSource) — sem reiniciar o hub;
//  - reconexão com BACKOFF EXPONENCIAL (limitado) + HEALTH-CHECK de stream congelado;
//  - status por câmera via evento socket "camera-status" { id, state, fps, lastError };
//  - transporte flexível: rtsp (tcp/udp/http/auto), HLS (.m3u8) e MJPEG (http) — detectado pela URL.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const SOI = Buffer.from([0xff, 0xd8]); // início de JPEG
const EOI = Buffer.from([0xff, 0xd9]); // fim de JPEG

// Reconexão: backoff exponencial com teto. Health-check derruba stream congelado.
const BASE_DELAY = Number(process.env.RTSP_RECONNECT_BASE_MS ?? 2000);  // 1ª espera
const MAX_DELAY = Number(process.env.RTSP_RECONNECT_MAX_MS ?? 30000);   // teto do backoff
const MAX_RETRIES = Number(process.env.RTSP_MAX_RETRIES ?? 0);          // 0 = ilimitado (delay já é limitado)
const STALE_MS = Number(process.env.RTSP_STALE_MS ?? 15000);           // sem frame por tanto tempo = congelado
const STATUS_MS = Number(process.env.RTSP_STATUS_MS ?? 5000);          // cadência do refresh de fps/status

// Contexto do hub (injetado em startRtspIngestion). Permite add/remove em runtime.
let ctx = null; // { io, cameras, broadcast }
/** id -> stream handle */
const streams = new Map();

/** Defaults globais de captura (env), sobrescritos por câmera quando informado. */
function defaultCfg() {
  return {
    fps: Number(process.env.RTSP_FPS ?? 8),
    width: Number(process.env.RTSP_WIDTH ?? 480),
    quality: Number(process.env.RTSP_QUALITY ?? 7),
  };
}

/** Fontes RTSP LEGADAS: arquivo server/rtsp.sources.json [{label,url}] OU env RTSP_SOURCES="label=url;label=url". */
function loadSources() {
  const file = path.join(__dirname, "rtsp.sources.json");
  if (fs.existsSync(file)) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(arr)) return arr.filter((s) => s && s.url);
    } catch (e) { console.error("[rtsp] rtsp.sources.json inválido:", e.message); }
  }
  const env = process.env.RTSP_SOURCES;
  if (env) {
    return env.split(";").map((s) => s.trim()).filter(Boolean).map((s, i) => {
      const j = s.indexOf("=");
      return j < 0 ? { label: `RTSP ${i + 1}`, url: s } : { label: s.slice(0, j).trim(), url: s.slice(j + 1).trim() };
    });
  }
  return [];
}

function redact(url) { return String(url).replace(/\/\/([^@/]+)@/, "//***@"); }

/** Extrai JPEGs completos (FFD8..FFD9) do buffer; devolve o resto (parcial). */
function drainFrames(buf, onFrame) {
  for (;;) {
    const start = buf.indexOf(SOI);
    if (start === -1) return Buffer.alloc(0);
    const end = buf.indexOf(EOI, start + 2);
    if (end === -1) return buf.subarray(start); // mantém parcial a partir do SOI
    onFrame(buf.subarray(start, end + 2));
    buf = buf.subarray(end + 2);
  }
}

/** Monta os args de INPUT do ffmpeg conforme o esquema da URL (transporte flexível). */
function inputArgs(st) {
  const url = st.url;
  const scheme = (String(url).match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];
  const args = [];
  if (scheme && /^rtsps?$/i.test(scheme)) {
    // RTSP/RTSPS: NÃO forçar TCP incondicionalmente. transport: tcp|udp|http|auto (auto = deixa o ffmpeg decidir).
    const t = String(st.transport || "tcp").toLowerCase();
    if (t === "tcp" || t === "udp" || t === "http") args.push("-rtsp_transport", t);
    args.push("-i", url);
  } else {
    // HLS (.m3u8), MJPEG ou HTTP(S) genérico / arquivo: ffmpeg autodetecta o formato de entrada.
    if (/\.m3u8(\?|$)/i.test(String(url))) {
      // HLS pode referenciar faixas de legenda (webvtt em .mp4) que o demuxer do ffmpeg 7.1+
      // rejeita pela checagem estrita de extensão. extension_picky=0 desliga essa checagem.
      args.push("-extension_picky", "0");
    }
    args.push("-i", url);
  }
  return args;
}

function emitStatus(st) {
  if (!ctx) return;
  ctx.io.to("dashboards").emit("camera-status", {
    id: st.id, state: st.state, fps: st.fps, lastError: st.lastError || null, label: st.label, kind: "rtsp",
  });
}

function setState(st, state) {
  if (st.state === state) return;
  st.state = state;
  if (state === "online") st.lastError = null;
  emitStatus(st);
}

function spawnFfmpeg(st) {
  if (st.stopped) return;
  const args = [
    ...inputArgs(st),
    "-an",
    "-vf", `fps=${st.cfg.fps},scale=${st.cfg.width}:-2`,
    "-f", "mjpeg", "-q:v", String(st.cfg.quality), "pipe:1",
  ];
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  st.proc = proc;

  proc.on("error", (e) => {
    if (e.code === "ENOENT") {
      // ffmpeg ausente é um problema global; não adianta reconectar. Marca erro e mantém a câmera listada.
      console.error("[rtsp] ffmpeg não encontrado no PATH. Instale o ffmpeg para ingestão RTSP. (câmeras de navegador seguem funcionando)");
      st.stopped = true;
      st.lastError = "ffmpeg não encontrado no PATH";
      setState(st, "error");
    } else {
      st.lastError = e.message;
      console.error(`[rtsp:${st.id}] erro:`, e.message);
    }
  });
  proc.stderr.on("data", () => { /* logs verbosos do ffmpeg — silenciados */ });
  proc.stdout.on("data", (chunk) => {
    st.buf = Buffer.concat([st.buf, chunk]);
    st.buf = drainFrames(st.buf, (jpeg) => {
      st.lastFrameAt = Date.now();
      st.frameCount++;
      if (st.state !== "online") { st.attempt = 0; setState(st, "online"); } // 1º frame após (re)conexão = online
      // JPEG binário (mesmo formato dos nós webcam) — socket.io entrega como ArrayBuffer no cliente.
      ctx.io.to("dashboards").emit("frame", { id: st.id, buf: jpeg, ts: Date.now() });
    });
  });
  proc.on("close", (code) => {
    st.proc = null;
    if (st.stopped) return;
    st.attempt++;
    if (MAX_RETRIES > 0 && st.attempt > MAX_RETRIES) {
      st.stopped = true;
      st.lastError = `desistiu após ${st.attempt - 1} tentativas`;
      setState(st, "error");
      console.error(`[rtsp:${st.id}] desistindo após ${st.attempt - 1} tentativas (defina RTSP_MAX_RETRIES=0 p/ ilimitado)`);
      return;
    }
    const delay = Math.min(BASE_DELAY * 2 ** (st.attempt - 1), MAX_DELAY);
    setState(st, "connecting");
    console.warn(`[rtsp:${st.id}] stream caiu (code=${code}) — reconectando em ${delay}ms (tentativa ${st.attempt})`);
    st.buf = Buffer.alloc(0);
    st.reconnectTimer = setTimeout(() => spawnFfmpeg(st), delay);
  });
}

/** Timer periódico: calcula fps real, detecta congelamento (health-check) e atualiza status. */
function startTimer(st) {
  st.fpsWindowStart = Date.now();
  st.statusTimer = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - st.fpsWindowStart) / 1000;
    st.fps = elapsed > 0 ? Math.round((st.frameCount / elapsed) * 10) / 10 : 0;
    st.frameCount = 0;
    st.fpsWindowStart = now;

    if (st.state === "online" && st.lastFrameAt && now - st.lastFrameAt > STALE_MS) {
      // Stream congelado: ffmpeg vivo mas sem frames novos. Mata o processo → o "close" reconecta com backoff.
      st.lastError = `sem frames há ${Math.round((now - st.lastFrameAt) / 1000)}s (stream congelado)`;
      st.fps = 0;
      setState(st, "error");
      console.warn(`[rtsp:${st.id}] congelado (${STALE_MS}ms sem frame) — reiniciando ffmpeg`);
      if (st.proc) { try { st.proc.kill("SIGKILL"); } catch { /* ignore */ } }
    } else {
      emitStatus(st); // refresh periódico de fps p/ a UI
    }
  }, STATUS_MS);
}

/** Adiciona/inicia uma fonte em runtime. src: { id, label, url, transport?, fps?, width?, quality? } */
function addSource(src) {
  if (!ctx) { console.error("[rtsp] addSource antes de startRtspIngestion"); return null; }
  if (!src || !src.url) return null;
  const id = String(src.id || `rtsp-${streams.size + 1}`);
  if (streams.has(id)) removeSource(id); // restart implícito se já existia

  const def = defaultCfg();
  const st = {
    id,
    label: src.label || id,
    url: src.url,
    transport: src.transport,
    cfg: {
      fps: Number(src.fps ?? def.fps),
      width: Number(src.width ?? def.width),
      quality: Number(src.quality ?? def.quality),
    },
    proc: null,
    stopped: false,
    buf: Buffer.alloc(0),
    attempt: 0,
    lastFrameAt: 0,
    frameCount: 0,
    fpsWindowStart: 0,
    fps: 0,
    state: "connecting",
    lastError: null,
    reconnectTimer: null,
    statusTimer: null,
  };
  streams.set(id, st);
  ctx.cameras.set(id, { id, label: st.label, kind: "rtsp" });
  ctx.broadcast();
  emitStatus(st); // estado inicial "connecting"
  startTimer(st);
  spawnFfmpeg(st);
  console.log(`[rtsp+] ${st.label} (${id}) ← ${redact(st.url)}`);
  return st;
}

/** Para e remove uma fonte em runtime (mata ffmpeg, timers e emite estado "stopped"). */
function removeSource(id) {
  const st = streams.get(String(id));
  if (!st) return false;
  st.stopped = true;
  if (st.reconnectTimer) clearTimeout(st.reconnectTimer);
  if (st.statusTimer) clearInterval(st.statusTimer);
  if (st.proc) { try { st.proc.kill("SIGKILL"); } catch { /* ignore */ } st.proc = null; }
  streams.delete(st.id);
  if (ctx) {
    ctx.cameras.delete(st.id);
    st.state = "stopped";
    st.fps = 0;
    emitStatus(st);
    ctx.broadcast();
  }
  console.log(`[rtsp-] ${st.label} (${st.id}) removido`);
  return true;
}

/** Reinicia uma fonte (ex.: mudou url/transporte/perfil). */
function restartSource(src) {
  removeSource(src.id);
  return addSource(src);
}

/** Snapshot do status de todas as fontes RTSP (para enviar a um dashboard que acabou de conectar). */
function statuses() {
  return [...streams.values()].map((st) => ({
    id: st.id, state: st.state, fps: st.fps, lastError: st.lastError || null, label: st.label, kind: "rtsp",
  }));
}

/** Boot: injeta o contexto, sobe as fontes LEGADAS (rtsp.sources.json/env — retrocompat) e as DINÂMICAS (cameras.json). */
function startRtspIngestion({ io, cameras, broadcast, dynamicSources = [] }) {
  ctx = { io, cameras, broadcast };

  const legacy = loadSources();
  legacy.forEach((src, i) => addSource({ id: `rtsp-${i + 1}`, label: src.label || `IP ${i + 1}`, url: src.url }));

  let dyn = 0;
  for (const src of dynamicSources) {
    if (src && src.enabled !== false) { addSource(src); dyn++; }
  }

  if (!legacy.length && !dyn) {
    console.log("[rtsp] nenhuma fonte RTSP configurada (rtsp.sources.json, env RTSP_SOURCES ou cameras.json).");
  }
}

module.exports = { startRtspIngestion, addSource, removeSource, restartSource, statuses, loadSources };
