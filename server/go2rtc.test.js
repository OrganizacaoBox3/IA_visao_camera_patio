// Regressão do CACHE do binExists (server/go2rtc.js) — perf round 3, frente 3, achado g:
// `enabled()` roda ~6×/s no event loop (pullTick do analysis/go2rtc-source) e cada
// fs.existsSync custava 0,57 ms ≈ 5-9% do CPU do hub. O stat agora é cacheado com TTL de 60s.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";

// DISABLED é lido do env no require do módulo — fixa "ligado" antes de carregar (determinismo).
process.env.GO2RTC_ENABLED = "1";
const require = createRequire(import.meta.url);
const go2rtc = require("./go2rtc");

// Época-base longe de 0 e de qualquer Date.now() real anterior (cache do módulo é global).
const BASE = Date.parse("2100-01-01T00:00:00Z");

describe("enabled()/binExists — stat cacheado com TTL de 60s", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("faz 1 stat, serve do cache dentro do TTL e revalida após 60s", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);

    expect(go2rtc.enabled()).toBe(true); // 1ª chamada → stat real
    expect(spy).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 12; i++) go2rtc.enabled(); // ~2s de pullTick (6×/s) → zero stat novo
    vi.setSystemTime(BASE + 59_000);
    expect(go2rtc.enabled()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1); // dentro do TTL: cache

    vi.setSystemTime(BASE + 61_000);
    expect(go2rtc.enabled()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2); // TTL vencido: revalida

    // O valor revalidado é respeitado (binário sumiu — caso raro, coberto pelo TTL).
    spy.mockReturnValue(false);
    vi.setSystemTime(BASE + 122_000);
    expect(go2rtc.enabled()).toBe(false);
  });
});

// generateYaml — INGEST RTMP: câmera que só faz PUSH (Intelbras/Dahua) entra pela URL do cadastro
// apontando pro PRÓPRIO republish do go2rtc (rtsp://127.0.0.1:8554/<nome>) → liga listener RTMP :1935
// + cria o canal VAZIO <nome> que aceita o publish. Sem env/config no servidor.
describe("generateYaml — ingest RTMP (câmera que só faz PUSH)", () => {
  it("câmera RTSP normal (pull): nenhum bloco rtmp — comportamento inalterado", () => {
    const { text, count } = go2rtc.generateYaml([{ id: "cam1", url: "rtsp://user:pass@10.0.0.5:554/cam" }]);
    expect(text).not.toContain("rtmp:");
    expect(text).toContain('  "cam1":');
    expect(text).toContain('    - "rtsp://user:pass@10.0.0.5:554/cam"');
    expect(count).toBe(1);
  });

  it("URL apontando pro republish do go2rtc: liga listener RTMP + canal de ingest VAZIO", () => {
    const { text } = go2rtc.generateYaml([{ id: "cam-abc", url: "rtsp://127.0.0.1:8554/causei_cam2" }]);
    expect(text).toContain("rtmp:");
    expect(text).toContain('listen: ":1935"');
    expect(text).toContain('  "cam-abc":'); // stream normal da câmera (source = o republish)
    expect(text).toContain('    - "rtsp://127.0.0.1:8554/causei_cam2"');
    expect(text).toMatch(/\n {2}"causei_cam2":\n/); // canal de ingest VAZIO (sem source abaixo)
  });

  it("aceita localhost e múltiplos canais de ingest com UM só listener", () => {
    const { text } = go2rtc.generateYaml([
      { id: "cA", url: "rtsp://localhost:8554/causei_cam2" },
      { id: "cB", url: "rtsp://127.0.0.1:8554/causei_cam3" },
    ]);
    expect((text.match(/rtmp:/g) || []).length).toBe(1); // um bloco só
    expect(text).toMatch(/\n {2}"causei_cam2":\n/);
    expect(text).toMatch(/\n {2}"causei_cam3":\n/);
  });

  it("sem câmeras: streams vazio e sem rtmp", () => {
    const { text } = go2rtc.generateYaml([]);
    expect(text).toContain("streams: {}");
    expect(text).not.toContain("rtmp:");
  });
});
