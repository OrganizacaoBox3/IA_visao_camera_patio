// Testes de predictAlertsPerDay (report/predict.ts).
// PREMISSAS assumidas nos casos sintéticos (alinhadas ao cabeçalho de predict.ts):
//  - baselinePerDay = (soma de alerts da área no histórico) / ds.days;
//  - o histórico foi gerado na sensibilidade PADRÃO 5 (fator 1.0), logo perDay(s=5) == baseline;
//  - scale = sensitivityFactor(s) / sensitivityFactor(5) = 2^((5-s)/4):
//      s<5 (menos sensível) ⇒ scale>1 ⇒ MAIS alertas; s>5 ⇒ scale<1 ⇒ MENOS alertas;
//  - sem dataset / sem dias / sem células da área ⇒ status "no-data".
import { describe, it, expect } from "vitest";
import { predictAlertsPerDay } from "./predict";
import { sensitivityFactor } from "../processors/atividade";
import type { Dataset, Cell } from "./calc";

function cell(over: Partial<Cell>): Cell {
  return {
    area: "Expedição",
    dayIndex: 0,
    hour: 8,
    idleMin: 0,
    alerts: 0,
    activePct: 100,
    ...over,
  };
}

// 2 dias, área "Expedição" com 6 + 4 = 10 alertas ⇒ baseline 5/dia.
function ds(): Dataset {
  return {
    days: 2,
    areas: ["Expedição", "Carga"],
    cameraOf: {},
    startMs: 0,
    cells: [
      cell({ area: "Expedição", dayIndex: 0, alerts: 6 }),
      cell({ area: "Expedição", dayIndex: 1, alerts: 4 }),
      cell({ area: "Carga", dayIndex: 0, alerts: 2 }),
    ],
  };
}

describe("predictAlertsPerDay — casos no-data", () => {
  it("retorna no-data sem dataset", () => {
    // @ts-expect-error: exercita o guard de runtime contra ds nulo
    expect(predictAlertsPerDay(null, "Expedição", 5)).toEqual({ status: "no-data" });
  });
  it("retorna no-data quando days < 1", () => {
    expect(predictAlertsPerDay({ ...ds(), days: 0 }, "Expedição", 5)).toEqual({ status: "no-data" });
  });
  it("retorna no-data quando a área não tem células", () => {
    expect(predictAlertsPerDay(ds(), "Inexistente", 5)).toEqual({ status: "no-data" });
  });
});

describe("predictAlertsPerDay — estimativa e escala por sensibilidade", () => {
  it("na sensibilidade padrão (5) perDay == baseline", () => {
    const r = predictAlertsPerDay(ds(), "Expedição", 5);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.days).toBe(2);
    expect(r.baselinePerDay).toBe(5);
    expect(r.perDay).toBe(5);
  });

  it("sensibilidade menor ⇒ MAIS alertas; maior ⇒ MENOS (monotônico)", () => {
    const low = predictAlertsPerDay(ds(), "Expedição", 1);
    const mid = predictAlertsPerDay(ds(), "Expedição", 5);
    const high = predictAlertsPerDay(ds(), "Expedição", 9);
    if (low.status !== "ok" || mid.status !== "ok" || high.status !== "ok") {
      throw new Error("esperado status ok");
    }
    expect(low.perDay).toBeGreaterThan(mid.perDay);
    expect(mid.perDay).toBeGreaterThan(high.perDay);
    // valores exatos do fator 2^((5-s)/4): s=1 → ×2 = 10; s=9 → ×0.5 = 2.5
    expect(low.perDay).toBeCloseTo(10, 6);
    expect(high.perDay).toBeCloseTo(2.5, 6);
  });

  it("perDay segue baseline × sensitivityFactor (consistência com o modelo)", () => {
    const s = 3;
    const r = predictAlertsPerDay(ds(), "Expedição", s);
    if (r.status !== "ok") throw new Error("esperado ok");
    const expected = Math.round(5 * sensitivityFactor(s) * 10) / 10;
    expect(r.perDay).toBeCloseTo(expected, 6);
  });

  it("baselinePerDay considera apenas a área filtrada", () => {
    const r = predictAlertsPerDay(ds(), "Carga", 5);
    if (r.status !== "ok") throw new Error("esperado ok");
    expect(r.baselinePerDay).toBe(1); // 2 alertas / 2 dias
  });
});
