// SUÍTE DE CENÁRIOS + BENCHMARK (ADR-012, Fase 2). O gate de hoje mede o motor num ÚNICO cenário
// (seed 42): responde "a fusão bate o baseline AQUI", não "a fusão é melhor NO GERAL". Aqui varremos
// várias condições — ruído do GPS, alcance BLE, seeds e horizonte temporal — combinando SÓ os `opts` que
// `simulate.ts` já expõe (não tocamos o simulador). O objetivo é HONESTO (doutrina §5): revelar onde cada
// motor ganha E onde perde, não fabricar uma vitória. Tudo puro/determinístico — mesma entrada, mesma tabela.
import type { LocalizationEngine } from "./engine";
import { replay } from "./replay";
import { type ScenarioOpts, simulateScenario } from "./simulate";

/** Um cenário nomeado = os `opts` do simulador + o seed, com um rótulo legível para a tabela. */
export type NamedScenario = { name: string; opts: ScenarioOpts; seed: number };

/**
 * Presets que varrem o espaço de condições SÓ com opts existentes:
 * - ruído do GPS (2 / 5 / 10 m): quão "sujo" é o sinal do coletor;
 * - alcance BLE (20 / 30 / 50 m): quão perto o coletor precisa estar p/ ver a tag (curto = poucas leituras
 *   mas SEMPRE de perto; longo = muitas leituras, várias de longe);
 * - seed (42 / 7 / 123): a mesma condição sob sorteios de ruído diferentes — testa robustez, não sorte;
 * - horizonte (60 / 120 steps): série curta × longa.
 * O baseline serve de referência fixa; a fusão precisa provar valor NA MÉDIA destas condições, não numa só.
 */
export const SCENARIOS: NamedScenario[] = [
  { name: "canonico-seed42", opts: { steps: 60, gpsNoiseM: 5, rangeM: 30 }, seed: 42 },
  { name: "ruido-baixo", opts: { steps: 60, gpsNoiseM: 2, rangeM: 30 }, seed: 42 },
  { name: "ruido-alto", opts: { steps: 60, gpsNoiseM: 10, rangeM: 30 }, seed: 42 },
  { name: "alcance-curto", opts: { steps: 60, gpsNoiseM: 5, rangeM: 20 }, seed: 42 },
  { name: "alcance-longo", opts: { steps: 60, gpsNoiseM: 5, rangeM: 50 }, seed: 42 },
  { name: "seed-7", opts: { steps: 60, gpsNoiseM: 5, rangeM: 30 }, seed: 7 },
  { name: "seed-123", opts: { steps: 60, gpsNoiseM: 5, rangeM: 30 }, seed: 123 },
  { name: "horizonte-longo", opts: { steps: 120, gpsNoiseM: 5, rangeM: 30 }, seed: 42 },
  { name: "ruido-alto-alcance-longo", opts: { steps: 60, gpsNoiseM: 10, rangeM: 50 }, seed: 7 },
];

/** Uma linha do benchmark: o resultado de UM motor num cenário. */
export type BenchRow = { scenario: string; engine: string; rmseM: number; coverage: number };

/**
 * Roda cada (cenário × motor) pelo harness de replay e coleta RMSE + cobertura. PURA e determinística:
 * gera o cenário uma vez por preset (mesmas evidências p/ todos os motores → comparação justa) e replaya
 * cada motor sobre ele. A ordem de saída segue cenário externo, motor interno — estável para snapshots/testes.
 */
export function runBenchmark(
  engines: Record<string, LocalizationEngine>,
  scenarios: NamedScenario[] = SCENARIOS,
): BenchRow[] {
  const rows: BenchRow[] = [];
  for (const sc of scenarios) {
    const recording = simulateScenario(sc.opts, sc.seed);
    for (const [engineName, engine] of Object.entries(engines)) {
      const m = replay(recording, engine);
      rows.push({
        scenario: sc.name,
        engine: engineName,
        rmseM: m.positionRmseM,
        coverage: m.coverage,
      });
    }
  }
  return rows;
}

/** Tabela texto legível (cenário × motor → RMSE/cobertura) — só p/ diagnóstico humano, não é contrato. */
export function formatTable(rows: BenchRow[]): string {
  const header = ["cenario", "motor", "rmse(m)", "cobertura"];
  const body = rows.map((r) => [
    r.scenario,
    r.engine,
    r.rmseM.toFixed(2),
    (r.coverage * 100).toFixed(0) + "%",
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
}
