import { describe, it, expect } from "vitest";
import { simulateScenario } from "./simulate";
import { replay } from "./replay";
import { baselineEngine, emptyState, type LocalizationEngine } from "./engine";

// Gate de acurácia do MOTOR de localização (análogo ao eval/ p/ detecção): um cenário sintético fixo,
// o motor-baseline, e métricas pinadas. Regressão no motor OU no simulador quebra o pino — de propósito.
describe("harness de replay — Fase 0 (de-risco do motor de localização)", () => {
  const rec = simulateScenario({ steps: 60, gpsNoiseM: 5, rangeM: 30 }, 42);

  it("roda um motor sobre a gravação e devolve métricas DETERMINÍSTICAS", () => {
    const a = replay(rec, baselineEngine);
    const b = replay(rec, baselineEngine);
    expect(a).toEqual(b); // seed fixo, sem Date.now/Math.random
    expect(a.samples).toBe(120); // 60 instantes × 2 tags
    expect(a.coverage).toBe(1); // o coletor patrulha todo o alcance → ambas as tags sempre têm estimativa
  });

  it("baseline: RMSE pinado (24,4 m) e dentro do teto de sanidade (< alcance BLE)", () => {
    const m = replay(rec, baselineEngine);
    // Pino de regressão: o AirTag estampa o GPS do coletor → erro ≈ dist. coletor↔tag + ruído do GPS.
    // Mudou o motor/simulador? Atualize o pino DELIBERADAMENTE (é o sinal, não o ruído).
    expect(m.positionRmseM).toBeCloseTo(24.4, 1);
    // Sanidade: a estimativa fica abaixo do alcance da observação — barra um motor que "perde" a tag.
    expect(m.positionRmseM).toBeLessThan(30);
  });

  it("motor PLUGÁVEL: um motor que nunca localiza → cobertura 0 (o harness distingue)", () => {
    const dumb: LocalizationEngine = () => emptyState();
    const m = replay(rec, dumb);
    expect(m.coverage).toBe(0);
    expect(Number.isFinite(m.positionRmseM)).toBe(false); // sem amostras → RMSE = Infinity
  });
});
