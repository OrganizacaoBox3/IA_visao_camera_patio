// ─────────────────────────────────────────────────────────────────────────────
// go2rtc-source.js — Fonte alternativa de frames: pull do go2rtc (ADITIVO, OFF
// por default). Dona do estado de aquisição puxada (Set de streams + Map de
// pulls/backoff/conexões); o engine injeta deps via createGo2rtcSource.
//
// DOIS transportes (incidente 2026-07-26 — ver STREAM_MODE):
//   • STREAM (default): UMA conexão stream.mjpeg persistente por câmera —
//     frames contínuos na cadência da fonte; stall watchdog + backoff.
//   • SNAPSHOT (ANALYSIS_GO2RTC_STREAM=0): GET frame.jpeg por rodada (legado —
//     espera keyframe a cada foto, MEDIDO ~2s/frame em WHIP; ficou de fallback).
// Ambos alimentam o MESMO pipeline do relé (st.latest, último-vence). Cobre a
// câmera WHIP que não manda relé. QUEM é puxada:
//   • só quando go2rtc está habilitado (go2rtc.enabled()) — logo, OFF por default;
//   • câmera que o go2rtc conhece (GET /api/streams) E cujo RELÉ está PARADO
//     (sem `onFrame` há PULL_STALE_MS) → evita puxar E receber relé (dobraria a aquisição);
//   • ANALYSIS_SOURCE=go2rtc força o pull de TODAS as streams do go2rtc.
// CONTENÇÃO: o pull respeita a cadência do worker e faz BACKOFF exponencial por câmera.
// INVARIANTE anti-leak: entrada de pull ÓRFÃ (sem stream conhecido nem state) é
// podada por idade em prunePulls() — sem isso, stream que só falha cresce sem teto.
// LGPD: JPEG puxado é EFÊMERO em memória, alimenta o worker por IPC e nada é gravado.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// ANALYSIS_SOURCE=go2rtc → puxa TODAS as streams do go2rtc (força); ausente/qualquer
// outro valor → modo "relay-less" (puxa só quem não manda relé). ANALYSIS_GO2RTC_PULL=0
// desliga o pull mesmo com go2rtc ligado (escape hatch).
const PULL_FORCE_ALL = String(process.env.ANALYSIS_SOURCE || "").toLowerCase() === "go2rtc";
const PULL_OPT_OUT = /^(0|false|off|no)$/i.test(String(process.env.ANALYSIS_GO2RTC_PULL || ""));
// MODO STREAM (default ON; ANALYSIS_GO2RTC_STREAM=0 volta ao snapshot) — incidente 2026-07-26:
// o snapshot frame.jpeg espera KEYFRAME a cada foto (MEDIDO ~2,0s/frame na câmera WHIP) →
// motor limitado a ~0,5fps, acima do gap de re-associação do tracker (2,5s) → cada rodada
// virava ID NOVO ("aparece outra caixa") e o interpolador expirava antes do próximo payload
// ("fica na tela"). O stream.mjpeg mantém UMA conexão por câmera (um ffmpeg contínuo no
// go2rtc) e entrega frames na cadência da fonte — o engine consome no ritmo dele (último-
// vence). Custo declarado: transcode MJPEG contínuo no go2rtc por câmera puxada (só câmera
// relay-less/WHIP paga; CFTV RTSP segue no relé ffmpeg do hub).
const STREAM_MODE = !/^(0|false|off|no)$/i.test(String(process.env.ANALYSIS_GO2RTC_STREAM || ""));
// Timeout do fetch: 2000→5000 default (MEDIDO: o snapshot leva ~2,0s esperando keyframe —
// timeout IGUAL ao tempo de serviço abortava na borda e jogava a câmera em backoff eterno).
const PULL_TIMEOUT_MS = Math.max(500, Number(process.env.ANALYSIS_GO2RTC_TIMEOUT_MS) || 5000);
// Stream sem frame novo há tanto = travado → derruba e reconecta com backoff (nunca-cego).
const STREAM_STALL_MS = 10_000;
// Acumulador do parser sem EOI além disto = lixo/corrompido → reseta (anti-OOM).
const STREAM_BUF_CAP = 8 * 1024 * 1024;
const STREAMS_REFRESH_MS = Math.max(1000, Number(process.env.ANALYSIS_GO2RTC_STREAMS_MS) || 4000);
const PULL_BACKOFF_BASE_MS = 2000;
const PULL_BACKOFF_MAX_MS = 30_000;
// Entrada órfã de `pulls` (sem stream conhecido nem state) é podada após isto sem toque.
const PULL_PRUNE_MS = 5 * 60_000;

const SOI = Buffer.from([0xff, 0xd8]); // início de JPEG (mesma técnica do rtsp.js)
const EOI = Buffer.from([0xff, 0xd9]); // fim de JPEG

/**
 * PURO (contrato de teste): extrai JPEGs completos de um acumulador de bytes do
 * stream.mjpeg (multipart). Os headers de boundary entre frames são descartados
 * naturalmente pela âncora no SOI. Devolve { frames, rest } — `rest` é o resíduo
 * (frame parcial) a concatenar com o próximo chunk. Lixo antes do 1º SOI cai fora.
 */
function extractJpegs(buf) {
  const frames = [];
  let cur = buf;
  for (;;) {
    const s = cur.indexOf(SOI);
    if (s < 0) return { frames, rest: Buffer.alloc(0) }; // nem SOI: tudo é lixo/boundary
    const e = cur.indexOf(EOI, s + 2);
    if (e < 0) return { frames, rest: s > 0 ? cur.subarray(s) : cur }; // frame parcial: guarda do SOI em diante
    frames.push(cur.subarray(s, e + 2));
    cur = cur.subarray(e + 2);
  }
}

/**
 * @param {object} deps
 * @param {object} deps.go2rtc           módulo go2rtc (enabled(), apiTarget())
 * @param {Map} deps.states              câmeraId → estado (decisão anti-dobra do pull)
 * @param {(id) => object} deps.createState  materializa a câmera puxada (mesmo do relé)
 * @param {() => boolean} deps.running   true enquanto o motor está ligado (enabled && !stopping)
 * @param {number} deps.roundMs          ROUND_MS — base do PULL_STALE_MS
 */
function createGo2rtcSource({ go2rtc, states, createState, running, roundMs }) {
  // Relé considerado PARADO após isto sem onFrame → câmera vira elegível ao pull. Maior que
  // ROUND_MS p/ um relé só levemente atrasado não disparar pull redundante.
  const PULL_STALE_MS = Math.max(3000, roundMs * 3);

  // ── Fonte go2rtc: descoberta de streams + estado de pull por câmera ──────────
  let go2rtcStreams = new Set(); // ids que o go2rtc conhece agora (cache, refrescado @STREAMS_REFRESH_MS)
  let streamsAt = 0; // epoch ms da última TENTATIVA de refresh
  let streamsInflight = false; // um GET /api/streams em voo
  let streamsFails = 0; // refreshes seguidos falhos (limpa o cache após alguns)
  /** cameraId → { inflight, nextAt, fails, lastAt } — controle de pull/backoff por câmera */
  const pulls = new Map();

  /** Pull ativo? Só com o motor ligado, go2rtc habilitado e sem opt-out. OFF por default (go2rtc é OFF). */
  function pullActive() {
    return running() && !PULL_OPT_OUT && go2rtc.enabled();
  }

  /** Frame PUXADO do go2rtc: mesmo destino do relé (st.latest, último-vence). NÃO mexe em lastRelayAt. */
  function ingestPulled(cameraId, buf) {
    if (!running()) return;
    const id = String(cameraId);
    const st = states.get(id) || createState(id);
    const now = Date.now();
    st.lastFrameAt = now;
    st.source = "go2rtc";
    st.latest = { buf, ts: now };
  }

  /** GET /api/streams → conjunto de ids que o go2rtc conhece (RTSP do yaml + WHIP dinâmicos). */
  async function refreshStreams() {
    if (streamsInflight) return;
    const now = Date.now();
    if (now - streamsAt < STREAMS_REFRESH_MS) return;
    streamsInflight = true;
    streamsAt = now;
    const { host, port } = go2rtc.apiTarget();
    try {
      const res = await fetch(`http://${host}:${port}/api/streams`, { signal: AbortSignal.timeout(PULL_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      go2rtcStreams = new Set(data && typeof data === "object" ? Object.keys(data) : []);
      streamsFails = 0;
    } catch {
      // go2rtc fora/subindo: mantém o cache por algumas tentativas, depois esvazia (para de puxar fantasmas)
      streamsFails += 1;
      if (streamsFails >= 3) go2rtcStreams = new Set();
    } finally {
      streamsInflight = false;
    }
  }

  /** Puxa 1 frame.jpeg do go2rtc p/ a câmera e alimenta o pipeline. Backoff por câmera em falha. */
  async function pullFrame(id, ps) {
    ps.inflight = true;
    const { host, port } = go2rtc.apiTarget();
    try {
      const res = await fetch(`http://${host}:${port}/api/frame.jpeg?src=${encodeURIComponent(id)}`, {
        signal: AbortSignal.timeout(PULL_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ab = await res.arrayBuffer();
      if (!ab.byteLength) throw new Error("frame vazio");
      ps.fails = 0;
      ps.nextAt = 0;
      ingestPulled(id, Buffer.from(ab)); // JPEG efêmero → worker por IPC → nada gravado (LGPD)
    } catch (e) {
      ps.fails += 1;
      const delay = Math.min(PULL_BACKOFF_BASE_MS * 2 ** (ps.fails - 1), PULL_BACKOFF_MAX_MS);
      ps.nextAt = Date.now() + delay; // stream ainda sem produtor / go2rtc reiniciando → espaça as tentativas
      if (ps.fails <= 2 || ps.fails % 20 === 0)
        console.warn(`[analysis:${id}] pull go2rtc falhou (${ps.fails}): ${e && e.message ? e.message : e}`);
    } finally {
      ps.inflight = false;
    }
  }

  // ── MODO STREAM: uma conexão stream.mjpeg persistente por câmera elegível ────
  // O loop lê chunks, extrai JPEGs (extractJpegs) e alimenta st.latest (último-
  // vence — o engine consome na cadência DELE; frame extra custa só a atribuição).
  // Falha/fechamento → backoff exponencial (mesma régua do snapshot); parada
  // INTENCIONAL (relé voltou/engine parou) não conta como falha.
  async function streamLoop(id, ps) {
    ps.streaming = true;
    ps.stopping = false;
    ps.lastFrameAt = Date.now();
    const ctrl = new AbortController();
    ps.ctrl = ctrl;
    const { host, port } = go2rtc.apiTarget();
    try {
      const res = await fetch(`http://${host}:${port}/api/stream.mjpeg?src=${encodeURIComponent(id)}`, {
        signal: ctrl.signal, // SEM timeout global: a conexão é longa por desenho; o stall watchdog cobre
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let acc = Buffer.alloc(0);
      for await (const chunk of res.body) {
        acc = acc.length ? Buffer.concat([acc, Buffer.from(chunk)]) : Buffer.from(chunk);
        const { frames, rest } = extractJpegs(acc);
        acc = rest.length > STREAM_BUF_CAP ? Buffer.alloc(0) : rest; // anti-OOM: resíduo gigante = lixo
        if (frames.length) {
          ps.fails = 0;
          ps.nextAt = 0;
          ps.lastFrameAt = Date.now();
          ingestPulled(id, Buffer.from(frames[frames.length - 1])); // último-vence já aqui (frames velhos do mesmo chunk não interessam)
        }
      }
      throw new Error("stream encerrou"); // fim normal do body sem abort = go2rtc fechou → reconecta
    } catch (e) {
      if (ps.stopping) return; // parada intencional (relé voltou / dropPull / motor parou): sem backoff
      ps.fails += 1;
      const delay = Math.min(PULL_BACKOFF_BASE_MS * 2 ** (ps.fails - 1), PULL_BACKOFF_MAX_MS);
      ps.nextAt = Date.now() + delay;
      if (ps.fails <= 2 || ps.fails % 20 === 0)
        console.warn(`[analysis:${id}] stream go2rtc caiu (${ps.fails}): ${e && e.message ? e.message : e}`);
    } finally {
      ps.streaming = false;
      ps.ctrl = null;
    }
  }

  /** Aborta o stream de UMA câmera sem penalizar (parada intencional). */
  function stopStream(ps) {
    if (!ps || !ps.streaming) return;
    ps.stopping = true;
    try {
      ps.ctrl?.abort();
    } catch {
      /* já fechado */
    }
  }

  /** Ronda de pull (@ROUND_MS): descobre streams e puxa as câmeras elegíveis (relay-less OU força). */
  function pullTick() {
    if (!pullActive()) return;
    void refreshStreams(); // debounced internamente (@STREAMS_REFRESH_MS)
    if (!go2rtcStreams.size) return;
    const now = Date.now();
    for (const id of go2rtcStreams) {
      const st = states.get(id);
      let ps = pulls.get(id);
      // ANTI-DOBRA: no modo relay-less, câmera com relé FRESCO não é puxada (já recebe frame de graça).
      // Em ANALYSIS_SOURCE=go2rtc força-se o pull de todas (custo de aquisição redundante assumido).
      if (!PULL_FORCE_ALL && st && now - st.lastRelayAt < PULL_STALE_MS) {
        if (ps) stopStream(ps); // stream aberto de câmera cujo relé VOLTOU: solta a conexão
        continue;
      }
      if (!ps) pulls.set(id, (ps = { inflight: false, nextAt: 0, fails: 0, lastAt: now, streaming: false, stopping: false, ctrl: null, lastFrameAt: 0 }));
      ps.lastAt = now; // marca atividade recente (stream ainda conhecido/elegível) p/ o prunePulls
      if (STREAM_MODE) {
        if (ps.streaming) {
          // STALL WATCHDOG (nunca-cego): conexão viva sem frame novo → derruba; o catch agenda backoff.
          if (now - ps.lastFrameAt > STREAM_STALL_MS) {
            try {
              ps.ctrl?.abort();
            } catch {
              /* já fechado */
            }
          }
          continue;
        }
        if (now < ps.nextAt) continue; // respeita o backoff da última queda
        void streamLoop(id, ps);
        continue;
      }
      // ── modo SNAPSHOT (legado — ANALYSIS_GO2RTC_STREAM=0) ──
      // CADÊNCIA/CONTENÇÃO: se já há frame pronto p/ a próxima rodada, não acumula (o worker consome
      // a ~ROUND_MS via tick — pull mais rápido só sobrescreveria st.latest e gastaria rede à toa).
      if (st && st.latest) continue;
      if (ps.inflight || now < ps.nextAt) continue; // um pull por câmera em voo; respeita o backoff
      void pullFrame(id, ps);
    }
  }

  /** Descarta o estado de pull de UMA câmera (chamado quando o engine poda o state). */
  function dropPull(id) {
    stopStream(pulls.get(id)); // solta a conexão persistente junto com o estado
    pulls.delete(id);
  }

  /**
   * Poda entradas órfãs de `pulls` (ausentes do go2rtcStreams E sem state) não tocadas
   * há PULL_PRUNE_MS — o stream que só falha nunca cria state, então a poda por state
   * do engine jamais o alcança (invariante anti-leak; observável em pullCount()).
   */
  function prunePulls(now) {
    for (const [id, ps] of pulls) {
      const alive = go2rtcStreams.has(id) || states.has(id);
      if (!alive && now - (ps.lastAt || 0) > PULL_PRUNE_MS) pulls.delete(id);
    }
  }

  /** Estado do pull p/ status()/diagnóstico (aditivo — campos novos: transport/streaming). */
  function stats() {
    let streaming = 0;
    for (const ps of pulls.values()) if (ps.streaming) streaming += 1;
    return {
      active: pullActive(),
      mode: PULL_FORCE_ALL ? "all" : "relay-less",
      streams: go2rtcStreams.size,
      transport: STREAM_MODE ? "stream" : "snapshot", // aditivo — incidente 2026-07-26
      streaming, // conexões stream.mjpeg vivas agora (aditivo)
    };
  }

  /** Nº de câmeras com estado de pull vivo — observabilidade do anti-leak p/ diagnóstico/teste. */
  function pullCount() {
    return pulls.size;
  }

  return { pullActive, pullTick, dropPull, prunePulls, stats, pullCount };
}

module.exports = { createGo2rtcSource, extractJpegs };
