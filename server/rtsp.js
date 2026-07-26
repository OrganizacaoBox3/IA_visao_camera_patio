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

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Resolve o binário do ffmpeg de forma robusta, INDEPENDENTE do PATH do shell
// (no Windows o PATH do winget/choco só entra em shells abertos após a instalação).
// Ordem: 1) FFMPEG_PATH explícito · 2) "ffmpeg" no PATH · 3) locais comuns de instalação.
function resolveFfmpegBin() {
  const works = (bin) => {
    try {
      execFileSync(bin, ["-version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH; // override explícito (erro aparece no spawn se inválido)
  if (works("ffmpeg")) return "ffmpeg"; // já no PATH
  // macOS/Linux: locais comuns FORA do PATH de processos launchd/systemd (o Homebrew
  // instala em /opt/homebrew/bin, que shells de login enxergam mas daemons não — foi
  // exatamente assim que o pull do go2rtc cegou o motor em 2026-07-26).
  if (process.platform !== "win32") {
    for (const c of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"])
      if (fs.existsSync(c)) return c;
  }
  if (process.platform === "win32") {
    const cands = [];
    const local = process.env.LOCALAPPDATA;
    if (local) {
      const pkgs = path.join(local, "Microsoft", "WinGet", "Packages");
      try {
        for (const d of fs.readdirSync(pkgs)) {
          if (!/^Gyan\.FFmpeg/i.test(d)) continue;
          const pkgDir = path.join(pkgs, d);
          for (const sub of fs.readdirSync(pkgDir)) {
            if (/^ffmpeg-/i.test(sub)) cands.push(path.join(pkgDir, sub, "bin", "ffmpeg.exe"));
          }
        }
      } catch {
        /* pasta do winget ausente */
      }
      cands.push(path.join(local, "Microsoft", "WinGet", "Links", "ffmpeg.exe"));
    }
    cands.push("C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe");
    if (process.env.USERPROFILE)
      cands.push(path.join(process.env.USERPROFILE, "scoop", "shims", "ffmpeg.exe"));
    cands.push("C:\\ffmpeg\\bin\\ffmpeg.exe");
    for (const c of cands) if (fs.existsSync(c)) return c;
  }
  return "ffmpeg"; // fallback → ENOENT com mensagem útil
}
const FFMPEG_BIN = resolveFfmpegBin();

// Versão do ffmpeg (major.minor). Algumas flags são de versões novas (ex.: -extension_picky
// só existe no ffmpeg 7.1+; no 4.x quebra com "Option not found"). Detecta 1× no boot; se não
// der p/ ler a versão, assume [0,0] → conservador (não usa flags novas). Ubuntu 22.04 = 4.4.
function ffmpegVersion(bin) {
  try {
    const out = execFileSync(bin, ["-version"], { encoding: "utf8" });
    const m = out.match(/ffmpeg version n?(\d+)\.(\d+)/i);
    if (m) return [Number(m[1]), Number(m[2])];
  } catch {
    /* ffmpeg ausente ou parse falhou */
  }
  return [0, 0];
}
const FFMPEG_VER = ffmpegVersion(FFMPEG_BIN);
const ffmpegAtLeast = (maj, min) =>
  FFMPEG_VER[0] > maj || (FFMPEG_VER[0] === maj && FFMPEG_VER[1] >= min);

const SOI = Buffer.from([0xff, 0xd8]); // início de JPEG
const EOI = Buffer.from([0xff, 0xd9]); // fim de JPEG

// Reconexão: backoff exponencial com teto. Health-check derruba stream congelado.
const BASE_DELAY = Number(process.env.RTSP_RECONNECT_BASE_MS ?? 2000); // 1ª espera
const MAX_DELAY = Number(process.env.RTSP_RECONNECT_MAX_MS ?? 30000); // teto do backoff
const MAX_RETRIES = Number(process.env.RTSP_MAX_RETRIES ?? 0); // 0 = ilimitado (delay já é limitado)
const STALE_MS = Number(process.env.RTSP_STALE_MS ?? 15000); // sem frame por tanto tempo = congelado
const STATUS_MS = Number(process.env.RTSP_STATUS_MS ?? 5000); // cadência do refresh de fps/status

// Contexto do hub (injetado em startRtspIngestion). Permite add/remove em runtime.
let ctx = null; // { io, cameras, broadcast }
/** id -> stream handle */
const streams = new Map();

// ── Análise no hub (ADR-009): câmera analisada conta como ESPECTADOR ────────────────────────
// Predicado injetado pelo index.js (analysis.isAnalyzing). Enquanto o motor de análise estiver
// ativo para uma câmera, o shed NÃO pausa o ffmpeg dela (idleSource vira no-op): o motor
// precisa do stream vivo mesmo sem nenhum dashboard aberto — é o requisito central da ADR-009.
let analysisViewer = null;
function setAnalysisViewer(fn) {
  analysisViewer = typeof fn === "function" ? fn : null;
}

/**
 * Defaults globais de captura (env), sobrescritos POR CÂMERA quando informado (campos fps/width/
 * quality no cadastro). Estes valores são a RESOLUÇÃO/COMPRESSÃO da única imagem que o motor de
 * análise vê nas câmeras RTSP — eixo nº 1 de precisão de pessoa deste domínio. Trade-off dos
 * defaults: gargalo é CPU/main-thread, não banda (LAN) → +decode/+banda aceitável (evidência:
 * docs/analises/plano-performance-imagem.md). A qualidade final depende do STREAM da câmera IP —
 * prefira um sub-stream de boa qualidade na URL; o ffmpeg só reamostra/re-encoda o que chega.
 */
function defaultCfg() {
  return {
    fps: Number(process.env.RTSP_FPS ?? 10),
    width: Number(process.env.RTSP_WIDTH ?? 720),
    quality: Number(process.env.RTSP_QUALITY ?? 4), // -q:v do ffmpeg: MENOR = MELHOR
  };
}

/** Fontes RTSP LEGADAS: arquivo server/rtsp.sources.json [{label,url}] OU env RTSP_SOURCES="label=url;label=url". */
function loadSources() {
  const file = path.join(__dirname, "rtsp.sources.json");
  if (fs.existsSync(file)) {
    try {
      const arr = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(arr)) return arr.filter((s) => s && s.url);
    } catch (e) {
      console.error("[rtsp] rtsp.sources.json inválido:", e.message);
    }
  }
  const env = process.env.RTSP_SOURCES;
  if (env) {
    return env
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s, i) => {
        const j = s.indexOf("=");
        return j < 0
          ? { label: `RTSP ${i + 1}`, url: s }
          : { label: s.slice(0, j).trim(), url: s.slice(j + 1).trim() };
      });
  }
  return [];
}

// Redige credenciais embutidas em URL (`//user:pass@host`). GLOBAL (todas as ocorrências) e
// aplicável a texto livre (log do ffmpeg), não só à URL — a userinfo pode aparecer em qualquer
// posição de uma linha de stderr. SEGURANÇA: tudo que vira `lastError` é BROADCAST a todos
// os painéis via `camera-status`; nenhuma senha pode escapar por aí.
function redact(s) {
  return String(s).replace(/\/\/[^/@\s]+@/g, "//***@");
}

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
    if (/\.m3u8(\?|$)/i.test(String(url)) && ffmpegAtLeast(7, 1)) {
      // HLS pode referenciar faixas de legenda (webvtt em .mp4) que o demuxer do ffmpeg 7.1+
      // rejeita pela checagem estrita de extensão. extension_picky=0 desliga essa checagem.
      // A flag SÓ existe no 7.1+; em versões antigas (ex.: 4.4 do Ubuntu 22.04) ela nem é
      // necessária (não há a checagem estrita) e quebraria o ffmpeg — por isso o guard de versão.
      args.push("-extension_picky", "0");
    }
    args.push("-i", url);
  }
  return args;
}

// Modo de ingestão (telemetria — campo ADITIVO no camera-status/statuses):
//  "full"  = fps configurado (tem espectador humano, foco, ou o piso não compensa);
//  "vigil" = fps reduzido ao PISO da análise (sem espectador; motor segue alimentado);
//  "idle"  = ffmpeg pausado pelo shed (sem espectador E sem análise).
function modeOf(st) {
  if (st.idle) return "idle";
  return st.vigilFps != null ? "vigil" : "full";
}

function emitStatus(st) {
  if (!ctx) return;
  ctx.io.to("dashboards").emit("camera-status", {
    id: st.id,
    state: st.state,
    fps: st.fps,
    lastError: st.lastError || null,
    label: st.label,
    kind: "rtsp",
    mode: modeOf(st),
  });
}

function setState(st, state) {
  if (st.state === state) return;
  st.state = state;
  if (state === "online") st.lastError = null;
  emitStatus(st);
}

function spawnFfmpeg(st) {
  if (st.stopped || st.idle) return; // idle (shed): não (re)spawnar sem espectador
  st.lastStderr = ""; // diagnóstico é por tentativa: não misturar erro de um spawn anterior
  const args = [
    // Globais: sem stats de progresso; stderr só com erros REAIS (viabiliza o lastStderr abaixo).
    "-nostats",
    "-loglevel",
    "error",
    // Baixa latência (input, antes do -i): sem buffer de demux/decoder e sondagem mínima do stream
    // — corta 0,5–2s de atraso na conexão e no regime. Convive com -rtsp_transport/-extension_picky
    // (inputArgs), que continuam sendo aplicados por esquema de URL.
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-probesize",
    "500000",
    "-analyzeduration",
    "0",
    ...inputArgs(st),
    "-an",
    "-vf",
    // fps DINÂMICO (perf-round3 frente 1): em vigília o filtro sai reduzido ao piso da
    // análise (−25/−35% do CPU do ffmpeg, medido). O decode do stream nativo não cai com
    // `-vf fps` — p/ cortar o decode a alavanca é o SUB-STREAM da câmera (config, não código).
    `fps=${st.vigilFps ?? st.cfg.fps},scale=${st.cfg.width}:-2`,
    "-f",
    "mjpeg",
    "-q:v",
    String(st.cfg.quality),
    "pipe:1",
  ];
  const proc = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
  st.proc = proc;

  proc.on("error", (e) => {
    if (e.code === "ENOENT") {
      // ffmpeg ausente é um problema global; não adianta reconectar. Marca erro e mantém a câmera listada.
      console.error(
        `[rtsp] ffmpeg não encontrado (tentado: ${FFMPEG_BIN}). Instale o ffmpeg OU defina FFMPEG_PATH=<caminho do ffmpeg.exe>. (câmeras de navegador seguem funcionando)`,
      );
      st.stopped = true;
      st.lastError = "ffmpeg não encontrado (defina FFMPEG_PATH)";
      setState(st, "error");
    } else {
      st.lastError = redact(e.message);
      console.error(`[rtsp:${st.id}] erro:`, redact(e.message));
    }
  });
  proc.stderr.on("data", (d) => {
    // Com -loglevel error o stderr só traz erros reais (raro). Guardamos a ÚLTIMA linha
    // para diagnosticar a queda no "close". SEGURANÇA: a linha é REDIGIDA AQUI, na fonte —
    // `lastStderr` nasce sem credencial e todo consumidor (broadcast/log/"desistiu") herda seguro.
    const line = String(d).trim().split(/\r?\n/).pop();
    if (line) st.lastStderr = redact(line);
  });
  proc.stdout.on("data", (chunk) => {
    if (st.stopped || st.idle) return; // descarta resíduo de um proc morrendo (idle/remoção)
    if (st.proc !== proc) return; // resíduo de um proc trocado por respawn (vigília⇄full)
    st.buf = Buffer.concat([st.buf, chunk]);
    st.buf = drainFrames(st.buf, (jpeg) => {
      st.lastFrameAt = Date.now();
      st.frameCount++;
      if (st.state !== "online") {
        st.attempt = 0;
        setState(st, "online");
      } // 1º frame após (re)conexão = online
      // JPEG binário (mesmo formato dos nós webcam) — socket.io entrega como ArrayBuffer no cliente.
      // VOLATILE (último-vence, como o relé de webcam em index.js): dashboard lento DESCARTA o
      // frame em vez de enfileirar — vídeo prefere o frame mais novo a acumular latência/backlog.
      // Rooms: dashboards novos assistem por câmera (`cam:<id>`); antigos, pela `dash-legacy`.
      ctx.io
        .to(`cam:${st.id}`)
        .to("dash-legacy")
        .volatile.emit("frame", { id: st.id, buf: jpeg, ts: Date.now() });
    });
  });
  proc.on("close", (code) => {
    if (st.proc !== proc) return; // proc antigo (wake já spawnou um novo) — não mexer no estado
    st.proc = null;
    if (st.stopped || st.idle) return; // morte esperada (remoção/shed) — sem reconexão/erro
    // Enriquece o diagnóstico com o erro REAL do ffmpeg (última linha do stderr sob -loglevel error).
    if (st.lastStderr) st.lastError = st.lastStderr;
    st.attempt++;
    if (MAX_RETRIES > 0 && st.attempt > MAX_RETRIES) {
      st.stopped = true;
      st.lastError = `desistiu após ${st.attempt - 1} tentativas${st.lastStderr ? ` — ${st.lastStderr}` : ""}`;
      setState(st, "error");
      console.error(
        `[rtsp:${st.id}] desistindo após ${st.attempt - 1} tentativas (defina RTSP_MAX_RETRIES=0 p/ ilimitado)`,
      );
      return;
    }
    const delay = Math.min(BASE_DELAY * 2 ** (st.attempt - 1), MAX_DELAY);
    setState(st, "connecting");
    console.warn(
      `[rtsp:${st.id}] stream caiu (code=${code}${st.lastStderr ? `: ${st.lastStderr}` : ""}) — reconectando em ${delay}ms (tentativa ${st.attempt})`,
    );
    st.buf = Buffer.alloc(0);
    st.reconnectTimer = setTimeout(() => spawnFfmpeg(st), delay);
  });
}

/** Timer periódico: calcula fps real, detecta congelamento (health-check) e atualiza status. */
function startTimer(st) {
  st.fpsWindowStart = Date.now();
  st.statusTimer = setInterval(() => {
    if (st.idle) return; // em idle (shed) não há frames por design: sem health-check nem refresh
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
      if (st.proc) {
        try {
          st.proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    } else {
      emitStatus(st); // refresh periódico de fps p/ a UI
    }
  }, STATUS_MS);
}

/** Adiciona/inicia uma fonte em runtime. src: { id, label, url, transport?, fps?, width?, quality? } */
function addSource(src) {
  if (!ctx) {
    console.error("[rtsp] addSource antes de startRtspIngestion");
    return null;
  }
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
    idle: false, // shed: pausada por falta de espectador (≠ stopped: religável via wakeSource)
    vigilFps: null, // shed: fps do MODO VIGÍLIA (piso da análise); null = fps configurado (full)
    buf: Buffer.alloc(0),
    attempt: 0,
    lastFrameAt: 0,
    frameCount: 0,
    fpsWindowStart: 0,
    fps: 0,
    state: "connecting",
    lastError: null,
    lastStderr: "", // última linha de erro do ffmpeg (-loglevel error) — diagnóstico do "close"
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
  if (st.proc) {
    try {
      st.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    st.proc = null;
  }
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

// ── Shed por audiência — chamado pelo shed.js, que conta espectadores por room ──────────────

// Re-spawn INTENCIONAL (troca de fps vigília⇄full): mata o proc atual sem acionar a
// reconexão com backoff — st.proc é trocado ANTES do kill, então o "close" do proc antigo
// cai no guard `st.proc !== proc` e vira no-op. O spawn novo sai imediato.
function respawn(st) {
  const old = st.proc;
  st.proc = null; // o "close" do proc antigo não mexe mais no estado
  if (st.reconnectTimer) {
    clearTimeout(st.reconnectTimer);
    st.reconnectTimer = null;
  }
  st.buf = Buffer.alloc(0);
  st.attempt = 0;
  if (old) {
    try {
      old.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  spawnFfmpeg(st);
}

/** Pausa uma fonte SEM espectador: mata o ffmpeg e congela a reconexão, SEM contar como erro
 *  (attempt não incrementa; estado vira "idle" via camera-status p/ transparência). Idempotente. */
function idleSource(id) {
  const st = streams.get(String(id));
  if (!st || st.stopped || st.idle) return false;
  // Análise conta como espectador (ADR-009): motor ativo → stream fica vivo p/ ele.
  // NUNCA-CEGO: o shed rebaixa câmera analisada a VIGÍLIA (vigilSource — piso ≥2× a
  // cadência da análise), nunca a idle; este guard cobre qualquer chamador futuro.
  if (analysisViewer && analysisViewer(String(id))) return false;
  st.idle = true;
  st.vigilFps = null; // idle apaga a vigília: um wake futuro volta direto ao fps configurado
  if (st.reconnectTimer) {
    clearTimeout(st.reconnectTimer);
    st.reconnectTimer = null;
  }
  if (st.proc) {
    try {
      st.proc.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  st.buf = Buffer.alloc(0);
  st.fps = 0;
  st.attempt = 0;
  setState(st, "idle");
  console.log(`[rtsp:${st.id}] idle — sem espectador (ffmpeg pausado)`);
  return true;
}

/** MODO VIGÍLIA (fps dinâmico, perf-round3 frente 1): re-spawna o ffmpeg com `-vf fps=`
 *  reduzido ao PISO da análise (decidido no shed — decideRtspFps). A análise segue
 *  alimentada (nunca-cego); só some o excedente que ninguém consome (−25/−35% de CPU).
 *  Idempotente por fps: chamar de novo com o MESMO piso é no-op; piso novo re-spawna. */
function vigilSource(id, fps) {
  const st = streams.get(String(id));
  if (!st || st.stopped || st.idle) return false;
  const f = Number(fps);
  if (!Number.isFinite(f) || f <= 0) return false;
  if (f >= st.cfg.fps) return false; // piso ≥ configurado: reduzir não ganha nada — segue full
  if (st.vigilFps === f) return false; // já em vigília neste piso
  st.vigilFps = f;
  respawn(st);
  console.log(`[rtsp:${st.id}] vigília @${f}fps — sem espectador (análise segura o piso)`);
  emitStatus(st); // telemetria: modo "vigil" visível já na transição, sem esperar o timer
  return true;
}

/** Religa uma fonte rebaixada pelo shed (ganhou espectador/foco): de "idle" → spawn imediato
 *  com backoff zerado; de "vigília" → re-spawn no fps CONFIGURADO. Idempotente. */
function wakeSource(id) {
  const st = streams.get(String(id));
  if (!st || st.stopped) return false;
  if (st.idle) {
    st.idle = false;
    st.frameCount = 0;
    st.fpsWindowStart = Date.now();
    st.lastFrameAt = 0;
    setState(st, "connecting");
    console.log(`[rtsp:${st.id}] religando — ganhou espectador`);
    spawnFfmpeg(st);
    return true;
  }
  if (st.vigilFps != null) {
    st.vigilFps = null;
    respawn(st);
    console.log(`[rtsp:${st.id}] full @${st.cfg.fps}fps — ganhou espectador/foco`);
    emitStatus(st);
    return true;
  }
  return false;
}

/** fps CONFIGURADO da fonte (cadastro/env) — insumo da decisão de fps dinâmico no shed. */
function captureFps(id) {
  const st = streams.get(String(id));
  return st ? st.cfg.fps : null;
}

/** Snapshot do status de todas as fontes RTSP (para enviar a um dashboard que acabou de conectar). */
function statuses() {
  return [...streams.values()].map((st) => ({
    id: st.id,
    state: st.state,
    fps: st.fps,
    lastError: st.lastError || null,
    label: st.label,
    kind: "rtsp",
    mode: modeOf(st),
  }));
}

/** Boot: injeta o contexto, sobe as fontes LEGADAS (rtsp.sources.json/env — retrocompat) e as DINÂMICAS (cameras.json). */
function startRtspIngestion({ io, cameras, broadcast, dynamicSources = [] }) {
  ctx = { io, cameras, broadcast };

  console.log(
    FFMPEG_BIN === "ffmpeg"
      ? "[rtsp] ffmpeg: usando o do PATH (ou ausente — defina FFMPEG_PATH se a ingestão falhar)"
      : `[rtsp] ffmpeg resolvido: ${FFMPEG_BIN}`,
  );

  const legacy = loadSources();
  legacy.forEach((src, i) =>
    addSource({ id: `rtsp-${i + 1}`, label: src.label || `IP ${i + 1}`, url: src.url }),
  );

  let dyn = 0;
  for (const src of dynamicSources) {
    if (src && src.enabled !== false) {
      addSource(src);
      dyn++;
    }
  }

  if (!legacy.length && !dyn) {
    console.log(
      "[rtsp] nenhuma fonte RTSP configurada (rtsp.sources.json, env RTSP_SOURCES ou cameras.json).",
    );
  }
}

module.exports = {
  startRtspIngestion,
  addSource,
  removeSource,
  restartSource,
  idleSource,
  wakeSource,
  vigilSource,
  captureFps,
  setAnalysisViewer,
  statuses,
  loadSources,
  redact, // exposto p/ teste: é o controle de segurança que impede credencial no camera-status
  // Binário do ffmpeg RESOLVIDO (FFMPEG_PATH > PATH > locais comuns). Consumidor: go2rtc.js
  // prepara o PATH do sidecar com ele — o go2rtc invoca "ffmpeg" do PATH p/ frame.jpeg/MJPEG,
  // e sem isso o pull de análise de câmera WHIP cegava em silêncio (incidente 2026-07-26).
  ffmpegBin: () => FFMPEG_BIN,
  FFMPEG_BIN,
  resolveFfmpegBin,
};
