// GRADE (P*, K) do retuning da persistência de rótulo — exploração de FORMA no sintético
// (prescrição do especialista pós-torneio v1; ver persistence-tournament.test.ts, "ACHADO
// HONESTO", e o desenho novo em regime-reliability.ts + label-memory.ts "RETUNING v2").
//
// O que roda: para cada célula (P*, K) ∈ {0,90; 0,95; 0,98} × {2; 3; 4}, com cleanWindow:true
// (emenda v2 — janela limpa), o MESMO torneio de persistence-tournament.test.ts (baseline
// por-tick × com-memória, computeMemoryMetrics, os 12 cenários da suíte fixa), trocando a barra
// de confirmação v1 pela barra condicionada ao regime.
//
// CALIBRAÇÃO SINTÉTICA (ressalva DECLARADA, instrução do especialista): a curva estratificada é
// construída a partir do PRÓPRIO replay da suíte (as decisões do associador + verdade, todos os
// cenários juntos) — mesma distribuição que as células consomem. Isso é EXPLORAÇÃO DE FORMA
// ("o desenho fecha os dois eixos em algum lugar do espaço?"), não validação: a curva calibrada
// e avaliada na mesma suíte sintética é otimista por construção. NENHUM default é promovido a
// label-memory.ts a partir daqui — promoção exige âncora REAL na curva (dados de campo).
//
// A regra a priori da rodada (mesma unidade de tempo nos dois eixos):
//   eixo 1: erro-segundos (wrongMs) ≤ baseline;  eixo 2: cobertura de experiência ≥ baseline.
// O teste IMPRIME a tabela 3×3 e assevera SÓ estrutura (números finitos, baseline consistente
// com o torneio v1) — NÃO força célula vencedora: o resultado é o que for, medido.
//
// CUSTO (por que não precisou do gate GRID_FULL previsto na especificação): o associador é
// determinístico e a camada de memória é PURA sobre o stream de assignments — o replay do
// associador roda 1× por cenário (via replayWithMemory, o mesmo do torneio) e as 9 células só
// re-rodam a política de memória sobre as linhas guardadas. Custo total ≈ torneio v1 (~2s),
// muito abaixo dos 20s que justificariam o gate.
import { describe, expect, it } from "vitest";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { simulateFusionScenario } from "./sim";
import { replayWithMemory } from "./persistence-sentinel";
import { LabelMemoryPolicy } from "./label-memory";
import type { ConfirmPolicy } from "./label-memory";
import { buildRegimeReliabilityCurve, formatRegimeCurve } from "./regime-reliability";
import type { RegimeReliabilityCurve } from "./regime-reliability";
import { computeMemoryMetrics } from "./memory-metrics";
import type { MemoryMetricTick } from "./memory-metrics";
import type { IdentityTick } from "./identity-metrics";
import type { Assignment } from "./associate";

const P_STARS = [0.9, 0.95, 0.98] as const;
const KS = [2, 3, 4] as const;

type ScenarioRows = {
  name: string;
  rows: { ts: number; assignments: Assignment[] }[];
  truthByRow: Record<number, string | null>[];
};

/** Replay do associador 1× por cenário (a MESMA alimentação do torneio v1 — replayWithMemory);
 *  os beliefs v1 são descartados, só o stream de assignments + verdade é guardado p/ as células. */
function loadScenarios(): ScenarioRows[] {
  return FUSION_SCENARIOS.map((def) => {
    const sc = simulateFusionScenario(def.opts, def.seed);
    const rows = replayWithMemory(sc);
    return {
      name: def.name,
      rows: rows.map((r) => ({ ts: r.ts, assignments: r.assignments })),
      truthByRow: rows.map((r) => sc.ticks[r.tickIndex].truthTagByTrack),
    };
  });
}

type Agg = { totalMs: number; correctMs: number; wrongMs: number };

function aggregate(into: Agg, m: { totalMs: number; correctMs: number; wrongMs: number }): void {
  into.totalMs += m.totalMs;
  into.correctMs += m.correctMs;
  into.wrongMs += m.wrongMs;
}

/** Torneio de UMA célula: roda a política v2 sobre o stream guardado, mesma matemática do v1. */
function runCell(scenarios: ScenarioRows[], confirmPolicy: ConfirmPolicy): Agg {
  const agg: Agg = { totalMs: 0, correctMs: 0, wrongMs: 0 };
  for (const sc of scenarios) {
    const mem = new LabelMemoryPolicy({ confirmPolicy });
    const memoryTicks: MemoryMetricTick[] = sc.rows.map((row, i) => ({
      ts: row.ts,
      // regime do tick = nº de candidatos avaliáveis = tamanho do array (observável em produção)
      beliefs: mem.step(row.ts, row.assignments, { candidates: row.assignments.length }),
      truthTagByTrack: sc.truthByRow[i],
    }));
    aggregate(agg, computeMemoryMetrics(memoryTicks));
  }
  return agg;
}

describe("grade (P*, K) — retuning da persistência com barra condicionada ao regime (sintético)", () => {
  it("roda as 9 células, imprime a tabela 3×3 e assevera estrutura (não força vencedora)", () => {
    const scenarios = loadScenarios();

    // Curva de calibração SINTÉTICA: decisões do associador de TODOS os cenários (ver header).
    const curveTicks: IdentityTick[] = scenarios.flatMap((sc) =>
      sc.rows.map((row, i) => ({
        ts: row.ts,
        assignments: row.assignments,
        truthTagByTrack: sc.truthByRow[i],
      })),
    );
    const curve: RegimeReliabilityCurve = buildRegimeReliabilityCurve(curveTicks);

    // Baseline por-tick (idêntico ao torneio v1: a decisão crua do associador, isFresh:true).
    const base: Agg = { totalMs: 0, correctMs: 0, wrongMs: 0 };
    for (const sc of scenarios) {
      const baselineTicks: MemoryMetricTick[] = sc.rows.map((row, i) => ({
        ts: row.ts,
        beliefs: row.assignments.map((a) => ({ trackId: a.trackId, label: a.tag, isFresh: true })),
        truthTagByTrack: sc.truthByRow[i],
      }));
      aggregate(base, computeMemoryMetrics(baselineTicks));
    }
    const baseCov = base.correctMs / base.totalMs;

    // Consistência com o torneio v1 (mesma alimentação → mesmo baseline pinado lá).
    expect(base.wrongMs).toBe(223500);

    type CellResult = {
      pStar: number;
      k: number;
      wrongMs: number;
      cov: number;
      errRatio: number;
      covRatio: number;
      errPass: boolean;
      covPass: boolean;
    };
    const cells: CellResult[] = [];
    for (const pStar of P_STARS) {
      for (const k of KS) {
        const agg = runCell(scenarios, { curve, pStar, k, cleanWindow: true });
        expect(agg.totalMs).toBe(base.totalMs); // mesmo denominador — mesma unidade nos 2 eixos
        const cov = agg.correctMs / agg.totalMs;
        cells.push({
          pStar,
          k,
          wrongMs: agg.wrongMs,
          cov,
          errRatio: agg.wrongMs / base.wrongMs,
          covRatio: cov / baseCov,
          errPass: agg.wrongMs <= base.wrongMs,
          covPass: cov >= baseCov,
        });
      }
    }

    // Estrutura: 9 células, tudo finito (nunca NaN — a regra da casa das métricas).
    expect(cells).toHaveLength(9);
    for (const c of cells) {
      expect(Number.isFinite(c.wrongMs)).toBe(true);
      expect(Number.isFinite(c.cov)).toBe(true);
      expect(c.wrongMs).toBeGreaterThanOrEqual(0);
      expect(c.cov).toBeGreaterThanOrEqual(0);
      expect(c.cov).toBeLessThanOrEqual(1);
    }

    // Tabela 3×3 pra diagnóstico humano (console.log em teste é praxe da casa).
    const header = [
      "P*",
      "K",
      "erro-seg (ms)",
      "err/base",
      "cobertura %",
      "cov/base",
      "eixo-erro",
      "eixo-cob",
      "veredito",
    ];
    const rows = cells.map((c) => [
      c.pStar.toFixed(2),
      String(c.k),
      String(c.wrongMs),
      c.errRatio.toFixed(2),
      (c.cov * 100).toFixed(1),
      c.covRatio.toFixed(2),
      c.errPass ? "passa" : "FALHA",
      c.covPass ? "passa" : "FALHA",
      c.errPass && c.covPass ? "PASSA" : "falha",
    ]);
    const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (r: string[]) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ");
    console.log(
      [
        "",
        "curva de calibração SINTÉTICA (replay da suíte — ressalva declarada, ver header):",
        formatRegimeCurve(curve),
        "",
        `baseline: erro-seg ${base.wrongMs}ms, cobertura ${(baseCov * 100).toFixed(1)}%`,
        fmt(header),
        fmt(widths.map((w) => "-".repeat(w))),
        ...rows.map(fmt),
        "",
      ].join("\n"),
    );
  });
});
