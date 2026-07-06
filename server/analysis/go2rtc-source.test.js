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
