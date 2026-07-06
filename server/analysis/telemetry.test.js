// Testes da montagem do /api/analysis/status (telemetry.js) — o shape é CONTRATO
// ADITIVO consumido pelo front/diagnóstico: aqui congelamos os campos existentes
// e a agregação por câmera (fps real, dets1m, poda do skipLog, auto-máscara).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão da pasta).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildStatus } = require("./telemetry");
const { createAutoMask, AM_COLS, AM_ROWS, AUTOMASK_MODE } = require("./automask");

const NOW = 100_000;

function fakeSt(over = {}) {
  return {
    busy: false,
    latest: null,
    rounds: [],
    detsLog: [],
    skipLog: [],
    skipped: 0,
    motionRatio: 0,
    lastMs: 0,
    longRange: false,
    fadiga: false,
    source: "relay",
    autoMask: null,
    ...over,
  };
}

function snapWith(states, over = {}) {
  return {
    now: NOW,
    states,
    focusedCams: new Set(),
    targetFpsOf: () => 1,
    enabled: true,
    modelFile: "dfine_s_obj2coco.onnx",
    fps: { normal: 1, line: 2, focus: 6 },
    motionGate: { enabled: true, ratio: 0.005, probeMs: 6000, probeFocusMs: 2000, thumb: "64x48" },
    autoscale: { mode: "auto", tier: "s", pin: null, choked: 0, idle: 0, lastSwitchAt: 0 },
    worker: { ready: true, size: 2 },
    go2rtcPull: { active: false, mode: "relay-less", streams: 0 },
    ...over,
  };
}

describe("buildStatus — shape global (contrato aditivo do /api/analysis/status)", () => {
  it("expõe os campos existentes com os valores do snapshot", () => {
    const s = buildStatus(snapWith(new Map()));
    expect(s.enabled).toBe(true);
    expect(s.model).toBe("dfine_s_obj2coco.onnx");
    expect(s.targetFps).toBe(1);
    expect(s.lineFps).toBe(2);
    expect(s.focusFps).toBe(6);
    expect(s.focused).toEqual([]);
    expect(s.autoMask).toEqual({ mode: AUTOMASK_MODE });
    expect(s.motionGate).toEqual({
      enabled: true,
      ratio: 0.005,
      probeMs: 6000,
      probeFocusMs: 2000,
      thumb: "64x48",
      skipped1m: 0,
      skippedTotal: 0,
    });
    expect(s.autoscale).toEqual({ mode: "auto", tier: "s", pin: null, choked: 0, idle: 0, lastSwitchAt: 0 });
    expect(s.worker).toEqual({ ready: true, size: 2 });
    expect(s.go2rtcPull).toEqual({ active: false, mode: "relay-less", streams: 0 });
    expect(s.perCamera).toEqual({});
  });

  it("focused reflete a união de câmeras focadas (ids em array)", () => {
    const s = buildStatus(snapWith(new Map(), { focusedCams: new Set(["cam2"]) }));
    expect(s.focused).toEqual(["cam2"]);
  });
});

describe("buildStatus — agregação por câmera", () => {
  it("fps real (rounds/60), dets1m/excluded1m somados do detsLog, queue e flags", () => {
    const st = fakeSt({
      rounds: [95_000, 96_000, 97_000, 98_000, 99_000, 99_500], // 6 rodadas → 0.1 fps
      detsLog: [
        { t: 95_000, n: 2, x: 1, a: 0 },
        { t: 96_000, n: 3, x: 0, a: 0 },
      ],
      busy: true,
      latest: { buf: Buffer.alloc(0), ts: 99_000 },
      motionRatio: 0.12345,
      lastMs: 380,
      longRange: true,
      source: "go2rtc",
    });
    const s = buildStatus(snapWith(new Map([["cam1", st]]), { focusedCams: new Set(["cam1"]) }));
    expect(s.perCamera.cam1).toEqual({
      fps: 0.1,
      targetFps: 1,
      focused: true,
      queue: 2, // busy + latest pendente
      skipped1m: 0,
      skippedTotal: 0,
      motion: 0.1235, // arredondado a 4 casas
      lastMs: 380,
      dets1m: 5,
      excluded1m: 1,
      longRange: true,
      fadiga: false,
      source: "go2rtc",
    });
  });

  it("poda o skipLog além de 60s (mutação deliberada) e agrega skipped no motionGate", () => {
    const st = fakeSt({ skipLog: [30_000, 50_000, 90_000], skipped: 7 }); // cutoff = 40_000
    const s = buildStatus(snapWith(new Map([["cam1", st]])));
    expect(st.skipLog).toEqual([50_000, 90_000]); // 30_000 podado NO estado
    expect(s.perCamera.cam1.skipped1m).toBe(2);
    expect(s.perCamera.cam1.skippedTotal).toBe(7);
    expect(s.motionGate.skipped1m).toBe(2); // agregado de todas as câmeras
    expect(s.motionGate.skippedTotal).toBe(7);
  });

  it("câmera COM auto-máscara ganha automasked1m + autoMask (rects via automask.statusOf)", () => {
    const am = createAutoMask();
    const cell = 9 * AM_COLS + 12;
    am.suggestions = [{ cell, presentPct: 1, jitter: 0 }];
    am.suppressed = new Set([cell]);
    const st = fakeSt({ autoMask: am, detsLog: [{ t: 95_000, n: 0, x: 0, a: 4 }] });
    const s = buildStatus(snapWith(new Map([["cam1", st]])));
    expect(s.perCamera.cam1.automasked1m).toBe(4);
    expect(s.perCamera.cam1.autoMask.mode).toBe(AUTOMASK_MODE);
    expect(s.perCamera.cam1.autoMask.suggestions[0]).toMatchObject({
      x: 12 / AM_COLS,
      y: 9 / AM_ROWS,
      w: 1 / AM_COLS,
      h: 1 / AM_ROWS,
    });
  });

  it("câmera SEM auto-máscara não expõe os campos de auto-máscara (aditivo)", () => {
    const s = buildStatus(snapWith(new Map([["cam1", fakeSt()]])));
    expect(s.perCamera.cam1).not.toHaveProperty("autoMask");
    expect(s.perCamera.cam1).not.toHaveProperty("automasked1m");
  });

  it("câmera COM tracker.stats expõe tracker { reassoc1m, reassocTotal, lost }; sem, não (aditivo)", () => {
    const st = fakeSt({
      detsLog: [
        { t: 95_000, n: 1, x: 0, a: 0, r: 2 }, // rodada com 2 re-associações (salto recuperado)
        { t: 96_000, n: 1, x: 0, a: 0 }, // rodada sem o campo (retrocompatível)
      ],
      tracker: { stats: () => ({ reassociations: 7, lost: 1 }) },
    });
    const s = buildStatus(snapWith(new Map([["cam1", st]])));
    expect(s.perCamera.cam1.tracker).toEqual({ reassoc1m: 2, reassocTotal: 7, lost: 1 });
    const s2 = buildStatus(snapWith(new Map([["cam2", fakeSt()]])));
    expect(s2.perCamera.cam2).not.toHaveProperty("tracker");
  });
});
