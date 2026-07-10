// Gate do motor de fusão v1 (ADR-012, Fase 1): PROVA numérica de que o motor BATE o baseline no
// cenário-gate sintético. Mede pelo MESMO harness da Fase 0 (replay + simulateScenario), seed fixo.
import { describe, it, expect } from "vitest";
import { replay } from "./replay";
import { simulateScenario } from "./simulate";
import { baselineEngine } from "./engine";
import { fusionEngine } from "./fusion-engine";

// Cenário-gate canônico, seed 42 — o mesmo que fixa o baseline em ~24,4 m.
const scenario = () => simulateScenario({ steps: 60, gpsNoiseM: 5, rangeM: 30 }, 42);

describe("fusionEngine — cenário-gate", () => {
  it("bate o baseline: RMSE estritamente menor que 24,4 m", () => {
    const m = replay(scenario(), fusionEngine);
    expect(m.positionRmseM).toBeLessThan(24.4);
  });

  it("é estritamente melhor que o baselineEngine no mesmo cenário", () => {
    const base = replay(scenario(), baselineEngine);
    const fus = replay(scenario(), fusionEngine);
    expect(fus.positionRmseM).toBeLessThan(base.positionRmseM);
  });

  it("cobertura total (uma posição para cada tag em cada instante observável)", () => {
    const m = replay(scenario(), fusionEngine);
    expect(m.coverage).toBe(1);
  });

  it("determinístico: duas rodadas idênticas", () => {
    const a = replay(scenario(), fusionEngine);
    const b = replay(scenario(), fusionEngine);
    expect(a).toEqual(b);
  });

  it("pino do RMSE atingido (regressão): ~12,3 m", () => {
    const m = replay(scenario(), fusionEngine);
    // Ponderação: centroide das últimas 8 posições do coletor, peso 1/(dEst²+1), dEst=-rssi-40.
    expect(m.positionRmseM).toBeCloseTo(12.3, 1);
  });
});
