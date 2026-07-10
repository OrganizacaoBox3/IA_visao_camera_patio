// Gate do motor de fusão v2 (motion-engine): ele tem de BATER o v1 (fusion-engine) no MESMO cenário-gate,
// medido pelo MESMO harness (replay + métricas). O v1 é o centroide ponderado por RSSI (bom p/ tag parada,
// mas ATRASADO p/ tag em deslocamento); o v2 estima a velocidade e extrapola, removendo o lag. Aqui rodamos
// os DOIS motores lado a lado e afirmamos, com número, que o v2 tem RMSE de posição menor.
import { describe, expect, it } from "vitest";
import { simulateScenario } from "./simulate";
import { replay } from "./replay";
import { fusionEngine } from "./fusion-engine";
import { motionEngine } from "./motion-engine";

// Cenário-gate canônico do ADR-012: tag parada "AA" + tag em deslocamento "BB" (0→80 m), coletor em vaivém.
// Mesmos parâmetros e seed do gate do v1 — comparação honesta, uma variável (o motor).
const SCENARIO = { steps: 60, gpsNoiseM: 5, rangeM: 30 } as const;
const SEED = 42;

describe("motionEngine (fusão v2 com modelo de movimento)", () => {
  it("bate o v1 (fusionEngine) no RMSE de posição do cenário-gate", () => {
    const rec = simulateScenario(SCENARIO, SEED);
    const v1 = replay(rec, fusionEngine).positionRmseM;
    const v2 = replay(rec, motionEngine).positionRmseM;

    // (a) Estritamente melhor que o v1 — a extrapolação pela velocidade remove o lag da tag em movimento.
    expect(v2).toBeLessThan(v1);
    // E abaixo do número histórico do v1 (12,29 m), o alvo explícito da Fase 2.
    expect(v2).toBeLessThan(12.29);
  });

  it("pina o RMSE atingido (regressão numérica reprodutível)", () => {
    const rec = simulateScenario(SCENARIO, SEED);
    const v2 = replay(rec, motionEngine).positionRmseM;
    // Valor MEDIDO do v2 no gate (≈ 11,28 m). Se mexer no motor e este número andar, é regressão consciente.
    expect(v2).toBeCloseTo(11.28, 1);
  });

  it("é determinístico (duas rodadas idênticas — sem relógio nem aleatório)", () => {
    const rec = simulateScenario(SCENARIO, SEED);
    const a = replay(rec, motionEngine);
    const b = replay(rec, motionEngine);
    expect(a).toEqual(b);
  });
});
