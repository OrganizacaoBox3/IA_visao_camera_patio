// Regressão do anti-leak do Map `pulls` em go2rtc-source.js: um stream que SEMPRE falha
// o pull nunca cria state, então a poda por state (engine.prune) jamais o alcança; sem a
// poda própria, quando o stream some do go2rtc a entrada vazaria p/ sempre. prunePulls()
// poda entradas órfãs (ausentes do go2rtcStreams E sem state) por idade.
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Antes do require: encurta o debounce de descoberta de streams p/ o piso (1000ms) — deixa o
// teste re-descobrir "stream sumiu" rápido sem esperar os 4000ms default. (Só afeta este teste.)
process.env.ANALYSIS_GO2RTC_STREAMS_MS = "1000";
const { createGo2rtcSource } = require("./go2rtc-source");

const tick = () => new Promise((r) => setTimeout(r, 0)); // deixa o refreshStreams (async) assentar

function makeSource({ streamKeys, states = new Map(), running = () => true }) {
  const keys = { current: streamKeys };
  global.fetch = vi.fn(async (url) => {
    if (url.includes("/api/streams")) {
      const o = {};
      for (const k of keys.current) o[k] = {};
      return { ok: true, json: async () => o };
    }
    // frame.jpeg: todo pull FALHA (503) — o caso que gerava o leak.
    return { ok: false, status: 503 };
  });
  const go2rtc = { enabled: () => true, apiTarget: () => ({ host: "h", port: 1 }) };
  const src = createGo2rtcSource({
    go2rtc,
    states,
    createState: (id) => {
      const s = { id, latest: null };
      states.set(id, s);
      return s;
    },
    running,
    roundMs: 1000,
  });
  return { src, keys, states };
}

describe("go2rtc-source — prunePulls não vaza entradas de pull órfãs", () => {
  let logSpy;
  let warnSpy;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("cria uma entrada de pull por stream que falha (o leak em potencial)", async () => {
    const { src } = makeSource({ streamKeys: ["A", "B"] });
    src.pullTick(); // 1º tick: dispara refreshStreams (streamsAt=0 → roda)
    await tick();
    src.pullTick(); // agora go2rtcStreams={A,B} → cria ps p/ A e B (ambos falham)
    await tick();
    expect(src.pullCount()).toBe(2);
    expect(src.stats().streams).toBe(2);
  });

  it("poda a entrada órfã (sumiu do go2rtc, sem state) por idade — leak drenado", async () => {
    const { src, keys } = makeSource({ streamKeys: ["A", "B"] });
    src.pullTick();
    await tick();
    src.pullTick();
    await tick();
    expect(src.pullCount()).toBe(2);

    // A e B somem do go2rtc: refresh passa a devolver {} → go2rtcStreams esvazia.
    keys.current = [];
    src.pullTick(); // este tick ainda vê o cache antigo; dispara refresh (debounce já venceu? não)
    // força o vencimento do debounce (STREAMS_REFRESH_MS, piso 1000ms) e refaz o refresh
    await new Promise((r) => setTimeout(r, 1100));
    src.pullTick();
    await tick();
    expect(src.stats().streams).toBe(0);

    // Sem a poda própria as 2 entradas ficariam presas p/ sempre; com ela, saem por idade (>5min).
    const future = Date.now() + 6 * 60 * 1000;
    src.prunePulls(future);
    expect(src.pullCount()).toBe(0);
  });

  it("NÃO poda entrada cuja câmera ainda tem state vivo (o prune de state é do engine)", async () => {
    const states = new Map();
    const { src, keys } = makeSource({ streamKeys: ["C"], states });
    src.pullTick();
    await tick();
    src.pullTick();
    await tick();
    expect(src.pullCount()).toBe(1);
    // Simula que C ganhou um state (como se um pull tivesse tido sucesso em algum momento).
    states.set("C", { id: "C", latest: null });
    // C some do go2rtc, mas tem state → alive → prunePulls PRESERVA (engine.prune cuida do state).
    keys.current = [];
    await new Promise((r) => setTimeout(r, 1100));
    src.pullTick();
    await tick();
    src.prunePulls(Date.now() + 6 * 60 * 1000);
    expect(src.pullCount()).toBe(1);
  });

  it("dropPull remove a entrada de UMA câmera (chamado pelo engine.prune ao podar o state)", async () => {
    const { src } = makeSource({ streamKeys: ["A", "B"] });
    src.pullTick();
    await tick();
    src.pullTick();
    await tick();
    expect(src.pullCount()).toBe(2);
    src.dropPull("A");
    expect(src.pullCount()).toBe(1);
  });
});

// ── MODO STREAM (incidente 2026-07-26): stream.mjpeg persistente no lugar do snapshot ──
// O snapshot esperava keyframe a cada foto (~2s medido em WHIP) → motor a ~0,5fps → id novo
// a cada rodada + caixa expirando na tela. O stream entrega frames contínuos; estes testes
// travam o parser puro, o ingest fim-a-fim, o anti-dobra e o backoff da queda.
const { extractJpegs } = require("./go2rtc-source");

const JPG = (label) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(`corpo-${label}`), Buffer.from([0xff, 0xd9])]);

describe("extractJpegs — parser PURO do multipart", () => {
  it("dois JPEGs com boundary/lixo entre eles → 2 frames, resto vazio", () => {
    const buf = Buffer.concat([Buffer.from("--boundary\r\nContent-Type: image/jpeg\r\n\r\n"), JPG("a"), Buffer.from("\r\n--boundary\r\n\r\n"), JPG("b")]);
    const { frames, rest } = extractJpegs(buf);
    expect(frames).toHaveLength(2);
    expect(frames[0].equals(JPG("a"))).toBe(true);
    expect(frames[1].equals(JPG("b"))).toBe(true);
    expect(rest.length).toBe(0);
  });

  it("frame PARCIAL (sem EOI ainda) fica no resto e completa no próximo chunk", () => {
    const full = JPG("c");
    const p1 = extractJpegs(full.subarray(0, 5));
    expect(p1.frames).toHaveLength(0);
    const p2 = extractJpegs(Buffer.concat([p1.rest, full.subarray(5)]));
    expect(p2.frames).toHaveLength(1);
    expect(p2.frames[0].equals(full)).toBe(true);
  });

  it("só lixo (sem SOI) → nada e resto vazio (boundary não acumula)", () => {
    const { frames, rest } = extractJpegs(Buffer.from("--boundary sem imagem nenhuma"));
    expect(frames).toHaveLength(0);
    expect(rest.length).toBe(0);
  });
});

// Body fake: web ReadableStream de chunks (o `for await` do streamLoop consome).
function bodyOf(chunks, { close = true } = {}) {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      if (close) c.close();
    },
  });
}

describe("streamLoop via pullTick — ingest contínuo, anti-dobra e backoff", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeStreamSource({ chunks, states = new Map() }) {
    global.fetch = vi.fn(async (url) => {
      if (url.includes("/api/streams")) return { ok: true, json: async () => ({ cam1: {} }) };
      if (url.includes("/api/stream.mjpeg")) return { ok: true, body: bodyOf(chunks) };
      return { ok: false, status: 503 };
    });
    const go2rtc = { enabled: () => true, apiTarget: () => ({ host: "h", port: 1 }) };
    const src = createGo2rtcSource({
      go2rtc,
      states,
      createState: (id) => {
        const s = { id, latest: null, lastFrameAt: 0, lastRelayAt: 0, source: "relay" };
        states.set(id, s);
        return s;
      },
      running: () => true,
      roundMs: 1000,
    });
    return { src, states };
  }

  it("frames do stream alimentam st.latest (último-vence) e marcam source go2rtc", async () => {
    const { src, states } = makeStreamSource({ chunks: [Buffer.concat([JPG("a"), JPG("b")])] });
    src.pullTick(); // descobre
    await tick();
    src.pullTick(); // abre o stream
    await tick();
    await tick();
    const st = states.get("cam1");
    expect(st).toBeTruthy();
    expect(st.source).toBe("go2rtc");
    expect(st.latest.buf.equals(JPG("b"))).toBe(true); // último do chunk vence
  });

  it("stream que FECHA agenda backoff (nextAt no futuro) — reconecta depois, não martela", async () => {
    const { src } = makeStreamSource({ chunks: [JPG("a")] });
    src.pullTick();
    await tick();
    src.pullTick();
    await tick();
    await tick(); // body fechou → catch → backoff
    const stats = src.stats();
    expect(stats.transport).toBe("stream");
    expect(stats.streaming).toBe(0); // conexão caiu
    // reconecta só após o backoff: o próximo tick imediato NÃO reabre (fetch não é chamado de novo p/ mjpeg)
    const calls = global.fetch.mock.calls.filter(([u]) => String(u).includes("stream.mjpeg")).length;
    src.pullTick();
    await tick();
    expect(global.fetch.mock.calls.filter(([u]) => String(u).includes("stream.mjpeg")).length).toBe(calls);
  });

  it("ANTI-DOBRA: relé FRESCO derruba o stream aberto (não paga aquisição dupla)", async () => {
    const { src, states } = makeStreamSource({ chunks: [] }); // stream sem frames (fica aberto? close=true fecha — ok p/ o caso)
    src.pullTick();
    await tick();
    src.pullTick();
    await tick();
    const st = states.get("cam1") || (states.set("cam1", { id: "cam1", latest: null, lastFrameAt: 0, lastRelayAt: 0 }), states.get("cam1"));
    st.lastRelayAt = Date.now(); // relé voltou AGORA
    src.pullTick(); // câmera com relé fresco: stopStream + não reabre
    await tick();
    const mjpegCalls = global.fetch.mock.calls.filter(([u]) => String(u).includes("stream.mjpeg")).length;
    src.pullTick();
    await tick();
    expect(global.fetch.mock.calls.filter(([u]) => String(u).includes("stream.mjpeg")).length).toBe(mjpegCalls);
  });
});
