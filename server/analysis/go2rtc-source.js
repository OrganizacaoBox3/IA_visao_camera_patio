// ─────────────────────────────────────────────────────────────────────────────
// go2rtc-source.js — Fonte alternativa de frames: pull de frame.jpeg do go2rtc
// (ADITIVO, OFF por default). Dona do estado de aquisição puxada (Set de streams
// + Map de pulls/backoff); o engine injeta deps via createGo2rtcSource.
//
// O motor PUXA frames (GET /api/frame.jpeg?src=<cameraId>) a ~ANALYSIS_FPS e
// alimenta o MESMO pipeline do relé (st.latest, último-vence). Cobre a câmera
// WHIP que não manda relé. QUEM é puxada:
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
const PULL_TIMEOUT_MS = Math.max(500, Number(process.env.ANALYSIS_GO2RTC_TIMEOUT_MS) || 2000);
const STREAMS_REFRESH_MS = Math.max(1000, Number(process.env.ANALYSIS_GO2RTC_STREAMS_MS) || 4000);
const PULL_BACKOFF_BASE_MS = 2000;
const PULL_BACKOFF_MAX_MS = 30_000;
// Entrada órfã de `pulls` (sem stream conhecido nem state) é podada após isto sem toque.
const PULL_PRUNE_MS = 5 * 60_000;

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

  /** Ronda de pull (@ROUND_MS): descobre streams e puxa as câmeras elegíveis (relay-less OU força). */
  function pullTick() {
    if (!pullActive()) return;
    void refreshStreams(); // debounced internamente (@STREAMS_REFRESH_MS)
    if (!go2rtcStreams.size) return;
    const now = Date.now();
    for (const id of go2rtcStreams) {
      const st = states.get(id);
      // ANTI-DOBRA: no modo relay-less, câmera com relé FRESCO não é puxada (já recebe frame de graça).
      // Em ANALYSIS_SOURCE=go2rtc força-se o pull de todas (custo de aquisição redundante assumido).
      if (!PULL_FORCE_ALL && st && now - st.lastRelayAt < PULL_STALE_MS) continue;
      // CADÊNCIA/CONTENÇÃO: se já há frame pronto p/ a próxima rodada, não acumula (o worker consome
      // a ~ROUND_MS via tick — pull mais rápido só sobrescreveria st.latest e gastaria rede à toa).
      if (st && st.latest) continue;
      let ps = pulls.get(id);
      if (!ps) pulls.set(id, (ps = { inflight: false, nextAt: 0, fails: 0, lastAt: now }));
      ps.lastAt = now; // marca atividade recente (stream ainda conhecido/elegível) p/ o prunePulls
      if (ps.inflight || now < ps.nextAt) continue; // um pull por câmera em voo; respeita o backoff
      void pullFrame(id, ps);
    }
  }

  /** Descarta o estado de pull de UMA câmera (chamado quando o engine poda o state). */
  function dropPull(id) {
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

  /** Estado do pull p/ status()/diagnóstico (aditivo — mesmo shape de antes). */
  function stats() {
    return { active: pullActive(), mode: PULL_FORCE_ALL ? "all" : "relay-less", streams: go2rtcStreams.size };
  }

  /** Nº de câmeras com estado de pull vivo — observabilidade do anti-leak p/ diagnóstico/teste. */
  function pullCount() {
    return pulls.size;
  }

  return { pullActive, pullTick, dropPull, prunePulls, stats, pullCount };
}

module.exports = { createGo2rtcSource };
