// Benchmark multi-cenário (ADR-012, Fases 2–3): a pergunta "o motor é melhor?" respondida sobre a SUÍTE
// inteira, não um seed. Assere o AGREGADO honesto (média de RMSE) — não força vitória em TODO cenário,
// porque onde um motor PERDE é sinal a preservar, não a esconder (doutrina §5, honestidade técnica).
import { describe, expect, it } from "vitest";
import { baselineEngine } from "./engine";
import { fusionEngine } from "./fusion-engine";
import { motionEngine } from "./motion-engine";
import { guardedEngine } from "./guarded-engine";
import { SCENARIOS, type BenchRow, formatTable, runBenchmark } from "./scenarios";

const engines = {
  baseline: baselineEngine,
  fusion: fusionEngine,
  motion: motionEngine,
  guarded: guardedEngine,
};

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

describe("benchmark de localização (baseline → v1 → v2 → v3) na suíte de cenários", () => {
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

  it("agregado: a fusão v1 é o ganho ROBUSTO (~40% vs baseline); o v3 guarded refina de fato", () => {
    const rows = runBenchmark(engines);
    const base = meanRmse(rows, "baseline");
    const fusion = meanRmse(rows, "fusion");
    const motion = meanRmse(rows, "motion");
    const guarded = meanRmse(rows, "guarded");
    // A FUSÃO v1 é o salto real e robusto: ~40% melhor que o baseline na média da suíte.
    expect(fusion).toBeLessThan(base * 0.7);
    // O v2 (movimento, ganho fixo) só EMPATA com o v1 — registramos, não escondemos (dentro de 10%).
    expect(Math.abs(motion - fusion)).toBeLessThan(fusion * 0.1);
    // O v3 (guarded, ganho adaptativo por resíduo × confiança da base) supera o v1 no agregado — o refino
    // que o v2 não deu. Ganho MODESTO (~3–4%) e sobre dado SINTÉTICO; carece de validação em campo (ADR-012).
    expect(guarded).toBeLessThan(fusion);
  });

  it("REVELA honestamente onde cada motor perde + o TETO de 4 cenários (diagnóstico, não assert)", () => {
    const rows = runBenchmark(engines);
    const map = byScenario(rows);
    const fusionPerde = [...map.entries()].filter(([, v]) => v.fusion >= v.baseline).map(([s]) => s);
    const guardedPerde = [...map.entries()].filter(([, v]) => v.guarded >= v.fusion).map(([s]) => s);
    // Visível com `vitest --reporter=verbose` / no CI.
    console.log("\n" + formatTable(rows));
    if (fusionPerde.length) console.log(`fusão não bate baseline em: ${fusionPerde.join(", ")}`);
    // O guarded perde do v1 nos MESMOS ~4 cenários onde a extrapolação tem ganho ótimo = 0 (teto provado por
    // varredura de ganho fixo): alcance/horizonte-longos + ruído-alto-alcance-longo. Não é falha de tuning —
    // é o limite físico de 1 estação + RSSI. O caminho além disso é âncora/multi-estação, não mais extrapolação.
    if (guardedPerde.length) console.log(`guarded (v3) não bate v1 em: ${guardedPerde.join(", ")} (teto físico)`);
    expect(map.size).toBe(SCENARIOS.length);
  });
});
