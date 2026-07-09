// Testes do PAINEL DE PRECISÃO — congela os DEFAULTS calibrados (mudou um número
// sem passar pelo gate do eval, este teste acusa) e prova a derivação do TTL
// (invariante nunca-cego: TTL ≥ probe + margem quando o gate está ligado).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão da pasta).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PRECISION, trackTtlMs } = require("./precision");

describe("PRECISION — defaults calibrados (mudança exige eval antes/depois — D.10)", () => {
  it("detector: piso 0.25 / operação 0.35 / NMS 0.6 / contenção 0.7 / input 640", () => {
    expect(PRECISION.detector.scoreMin).toBe(0.25);
    expect(PRECISION.detector.highScore).toBe(0.35);
    expect(PRECISION.detector.nmsIou).toBe(0.6);
    expect(PRECISION.detector.containment).toBe(0.7);
    expect(PRECISION.detector.input).toBe(640);
    expect(PRECISION.detector.focusInput).toBe(640); // default = input global (opt-in: ANALYSIS_FOCUS_INPUT)
    expect(PRECISION.detector.tiles).toEqual({ cols: 2, rows: 2, overlap: 0.1 });
  });

  it("tracker: associação 0.25 / guarda de nascimento 0.55 / TTL piso 1500 ×3.5 +2s", () => {
    expect(PRECISION.tracker.iouThreshold).toBe(0.25);
    expect(PRECISION.tracker.birthIouThreshold).toBe(0.55);
    expect(PRECISION.tracker.ttlFloorMs).toBe(1500);
    expect(PRECISION.tracker.ttlRoundFactor).toBe(3.5);
    expect(PRECISION.tracker.ttlProbeMarginMs).toBe(2000);
  });

  it("tracker anti-rastro/salto: raio 0.12 / gap máx 2.5s / 1 rodada de graça antes de LOST", () => {
    expect(PRECISION.tracker.reassocDist).toBe(0.12);
    expect(PRECISION.tracker.reassocMaxGapMs).toBe(2500);
    expect(PRECISION.tracker.lostAfterMisses).toBe(1);
  });

  it("counter: espelho de APP_CONFIG.people.track do front (0.01/0.35/800/2)", () => {
    expect(PRECISION.counter).toEqual({
      minMove: 0.01,
      maxDist: 0.35,
      debounceMs: 800,
      minCrossingFrames: 2,
    });
  });

  it("gate: ratio 0.005 / probe 6s / probe focada 2s / pixelDelta 22", () => {
    expect(PRECISION.gate.motionRatio).toBe(0.005);
    expect(PRECISION.gate.probeMs).toBe(6000);
    expect(PRECISION.gate.probeFocusMs).toBe(2000);
    expect(PRECISION.gate.pixelDelta).toBe(22);
  });

  it("painel é CONGELADO (ninguém tuna em runtime — troca de knob passa por env+reboot+gate)", () => {
    expect(Object.isFrozen(PRECISION)).toBe(true);
    expect(Object.isFrozen(PRECISION.detector)).toBe(true);
    expect(Object.isFrozen(PRECISION.tracker)).toBe(true);
    expect(Object.isFrozen(PRECISION.counter)).toBe(true);
    expect(Object.isFrozen(PRECISION.gate)).toBe(true);
    expect(() => {
      "use strict";
      PRECISION.detector.scoreMin = 0;
    }).toThrow();
  });

  it("painel é serializável (viaja p/ log/diagnóstico sem surpresa)", () => {
    expect(() => JSON.stringify(PRECISION)).not.toThrow();
  });
});

describe("trackTtlMs — TTL derivado (nunca-cego acoplado ao probe)", () => {
  it("sem gate: max(piso 1500, roundMs × 3.5)", () => {
    expect(trackTtlMs({ roundMs: 100, gateOn: false })).toBe(1500); // piso vence
    expect(trackTtlMs({ roundMs: 1000, gateOn: false })).toBe(3500); // fator vence
  });

  it("com gate: nunca abaixo de probe + margem (pessoa parada sobrevive entre 2 probes)", () => {
    const ttl = trackTtlMs({ roundMs: 1000, gateOn: true });
    expect(ttl).toBeGreaterThanOrEqual(PRECISION.gate.probeMs + PRECISION.tracker.ttlProbeMarginMs);
    expect(ttl).toBe(8000); // 6000 + 2000 > 3500 > 1500
  });

  it("cadência lentíssima domina o probe (fator ainda manda quando maior)", () => {
    // roundMs 5000 → 17500 > probe+margem 8000
    expect(trackTtlMs({ roundMs: 5000, gateOn: true })).toBe(17_500);
  });
});
