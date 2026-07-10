// Benchmark multi-cenário (ADR-012, Fase 2): a pergunta "o motor é melhor?" respondida sobre a SUÍTE
// inteira, não um seed. Assere o AGREGADO honesto (média de RMSE) — não força vitória em TODO cenário,
// porque onde um motor PERDE é sinal a preservar, não a esconder (doutrina §5, honestidade técnica).
import { describe, expect, it } from "vitest";
import { baselineEngine } from "./engine";
import { fusionEngine } from "./fusion-engine";
import { motionEngine } from "./motion-engine";
import { SCENARIOS, type BenchRow, formatTable, runBenchmark } from "./scenarios";

const engines = { baseline: baselineEngine, fusion: fusionEngine, motion: motionEngine };

/** Média aritmética do RMSE sobre as linhas de um dado motor. */
function meanRmse(rows: BenchRow[], engine: string): number {
  const xs = rows.filter((r) => r.engine === engine).map((r) => r.rmseM);
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Mapa cenário → RMSE de cada motor, p/ comparação emparelhada. */
function byScenario(rows: BenchRow[]): Map<string, Record<string, number>> {
  const m = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const e = m.get(r.scenario) ?? {};
    e[r.engine] = r.rmseM;
    m.set(r.scenario, e);
  }
  return m;
}

describe("benchmark de localização (baseline × fusão × movimento) na suíte de cenários", () => {
  it("é determinístico — duas rodadas produzem a MESMA tabela", () => {
    expect(runBenchmark(engines)).toEqual(runBenchmark(engines));
  });

  it("toda linha tem cobertura > 0 e RMSE finito", () => {
    const rows = runBenchmark(engines);
    expect(rows.length).toBe(SCENARIOS.length * Object.keys(engines).length);
    for (const r of rows) {
      expect(r.coverage).toBeGreaterThan(0);
      expect(Number.isFinite(r.rmseM)).toBe(true);
    }
  });

  it("agregado HONESTO: fusão << baseline (ganho robusto); movimento ≈ fusão (empate regime-dependente)", () => {
    const rows = runBenchmark(engines);
    const base = meanRmse(rows, "baseline");
    const fusion = meanRmse(rows, "fusion");
    const motion = meanRmse(rows, "motion");
    // A FUSÃO (v1) é o ganho real e robusto: ~40% melhor que o baseline na média da suíte.
    expect(fusion).toBeLessThan(base * 0.7);
    // O MOVIMENTO (v2) NÃO é vitória limpa sobre o v1: empata no agregado (ganha onde o lag de
    // movimento/ruído domina — canônico, ruído-alto; perde em alcance-longo/horizonte-longo por overshoot
    // da extrapolação). Registramos o EMPATE (dentro de 10%), não forçamos um salto que não existe. O ganho
    // decisivo do v2 exige ganho adaptativo por confiança da velocidade — fase futura (ADR-012).
    expect(Math.abs(motion - fusion)).toBeLessThan(fusion * 0.1);
  });

  it("REVELA honestamente onde cada motor perde (diagnóstico, não assert)", () => {
    const rows = runBenchmark(engines);
    const map = byScenario(rows);
    const fusionPerde = [...map.entries()].filter(([, v]) => v.fusion >= v.baseline).map(([s]) => s);
    const motionPerde = [...map.entries()].filter(([, v]) => v.motion >= v.fusion).map(([s]) => s);
    // Visível com `vitest --reporter=verbose` / no CI.
    console.log("\n" + formatTable(rows));
    if (fusionPerde.length) console.log(`fusão não bate baseline em: ${fusionPerde.join(", ")}`);
    if (motionPerde.length) console.log(`movimento não bate fusão em: ${motionPerde.join(", ")}`);
    expect(map.size).toBe(SCENARIOS.length);
  });
});
