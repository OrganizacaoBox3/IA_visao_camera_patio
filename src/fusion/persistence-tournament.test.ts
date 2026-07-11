// Torneio da persistência de rótulo (docs/cientifica/escopo-persistencia-rotulo.md, "Regra a
// priori da rodada") — roda a política de memória (label-memory.ts, defaults v1) contra o BASELINE
// sem persistência (a decisão crua do associador, tick a tick) em TODA a suíte fixa de cenários
// (replay-fusion.ts/FUSION_SCENARIOS), na MESMA unidade (tempo — memory-metrics.ts).
//
// ACHADO HONESTO (2026-07-10, PINS medidos — não é o resultado esperado, é o resultado real): os
// defaults v1 (confirmMargin:0.4, confirmTicks:3) NÃO passam a regra a priori em agregado.
// Erro-segundos cai (209000ms → 95500ms, bate a barra) — mas COBERTURA DE EXPERIÊNCIA TAMBÉM CAI
// (20,84% → 13,88%, multiplicador ≈0,67×, viola "≥ N× o baseline"). Causa raiz identificada pela
// decomposição por cenário: em multidão (multidao/ancoras-multidao/ancoras-multidao-bias/
// ancoras-mismatch-n), a barra de confirmação (margem≥0,4 por 3 ticks seguidos) é estrita demais
// pro regime de correlação mais ruidoso — o track NUNCA confirma, e a memória fica ZERADA (0%
// cobertura, 0 erro) onde o baseline por-tick CONSEGUIA acertar ocasionalmente (16-25% de
// cobertura). A decomposição por transição confirma que o canal legítimo existe (abstenção→acerto:
// 239500ms) mas não compensa a perda estrutural nos cenários de multidão. CONCLUSÃO: v1 como está
// NÃO é candidato a default — os parâmetros de confirmação precisam de retuning (ou uma barra
// adaptativa à densidade da cena) antes da próxima rodada de torneio. Registrado em
// PENDENCIAS.md item 9 — não escondido, não forçado a passar.
//
// Este arquivo PINA o estado medido (mesmo espírito de replay-fusion.test.ts): não afirma que a
// regra a priori passa (seria falso); afirma o que RESULTA hoje, pra qualquer mudança futura nos
// parâmetros de label-memory.ts ter que se explicar contra este número, não contra vibes.
import { describe, expect, it } from "vitest";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { simulateFusionScenario } from "./sim";
import { replayWithMemory } from "./persistence-sentinel";
import { computeMemoryMetrics, computeTransitionMs } from "./memory-metrics";
import type { MemoryMetricTick, TransitionTick } from "./memory-metrics";

type ScenarioResult = {
  name: string;
  baseCoveragePct: number;
  memCoveragePct: number;
  baseWrongMs: number;
  memWrongMs: number;
};

function runScenario(def: (typeof FUSION_SCENARIOS)[number]): ScenarioResult {
  const sc = simulateFusionScenario(def.opts, def.seed);
  const rows = replayWithMemory(sc);
  const truthOf = (tickIndex: number) => sc.ticks[tickIndex].truthTagByTrack;

  const baselineTicks: MemoryMetricTick[] = rows.map((row) => ({
    ts: row.ts,
    beliefs: row.assignments.map((a) => ({ trackId: a.trackId, label: a.tag, isFresh: true })),
    truthTagByTrack: truthOf(row.tickIndex),
  }));
  const memoryTicks: MemoryMetricTick[] = rows.map((row) => ({
    ts: row.ts,
    beliefs: row.beliefs,
    truthTagByTrack: truthOf(row.tickIndex),
  }));

  const baseM = computeMemoryMetrics(baselineTicks);
  const memM = computeMemoryMetrics(memoryTicks);
  return {
    name: def.name,
    baseCoveragePct: Math.round(baseM.coverageExperience * 1000) / 10,
    memCoveragePct: Math.round(memM.coverageExperience * 1000) / 10,
    baseWrongMs: baseM.wrongMs,
    memWrongMs: memM.wrongMs,
  };
}

// PINS por cenário — cobertura em %, 1 casa decimal; wrongMs em ms.
// RE-PINADOS 2026-07-11 (minMovement 0,25→0,15, mudança de default por evidência de campo — ver
// DEFAULTS de associate.ts). O quadro QUALITATIVO não mudou: v1 segue NÃO passando a regra a
// priori (ratio de cobertura 0,68 vs 0,67 antes; erro-segundos segue caindo; multidão segue
// zerando a confirmação). Os números originais de 2026-07-10 vivem no git.
const PINS: Record<string, { baseCov: number; memCov: number; baseWrongMs: number; memWrongMs: number }> = {
  canonico: { baseCov: 35.2, memCov: 37.8, baseWrongMs: 6500, memWrongMs: 12500 },
  parado: { baseCov: 0, memCov: 0, baseWrongMs: 0, memWrongMs: 0 },
  bloco: { baseCov: 10.5, memCov: 0.0, baseWrongMs: 2000, memWrongMs: 0 },
  cruzamento: { baseCov: 27.6, memCov: 24.0, baseWrongMs: 23500, memWrongMs: 41500 },
  "ruido-alto": { baseCov: 20.2, memCov: 23.3, baseWrongMs: 12500, memWrongMs: 20000 },
  multidao: { baseCov: 16.6, memCov: 5.3, baseWrongMs: 36500, memWrongMs: 0 },
  "sem-calibracao": { baseCov: 27.0, memCov: 29.8, baseWrongMs: 11000, memWrongMs: 3500 },
  "grade-sem-station": { baseCov: 35.2, memCov: 37.8, baseWrongMs: 6500, memWrongMs: 12500 },
  "ancoras-canonico": { baseCov: 28.2, memCov: 21.0, baseWrongMs: 19500, memWrongMs: 11500 },
  "ancoras-multidao": { baseCov: 18.7, memCov: 7.5, baseWrongMs: 42000, memWrongMs: 0 },
  "ancoras-multidao-bias": { baseCov: 18.7, memCov: 7.5, baseWrongMs: 42000, memWrongMs: 0 },
  "ancoras-mismatch-n": { baseCov: 24.4, memCov: 8.2, baseWrongMs: 21500, memWrongMs: 0 },
};

describe("torneio da persistência — PINS honestos (v1 NÃO passa a regra a priori em agregado)", () => {
  for (const def of FUSION_SCENARIOS) {
    it(`cenário "${def.name}" bate o pin medido`, () => {
      const r = runScenario(def);
      const pin = PINS[def.name];
      expect(pin, `sem pin registrado pro cenário "${def.name}"`).toBeDefined();
      expect(r.baseCoveragePct).toBeCloseTo(pin.baseCov, 1);
      expect(r.memCoveragePct).toBeCloseTo(pin.memCov, 1);
      expect(r.baseWrongMs).toBe(pin.baseWrongMs);
      expect(r.memWrongMs).toBe(pin.memWrongMs);
    });
  }

  it("AGREGADO: erro-segundos cai (bate a regra), mas cobertura de experiência TAMBÉM cai (viola a regra)", () => {
    const baseAgg = { totalMs: 0, correctMs: 0, wrongMs: 0 };
    const memAgg = { totalMs: 0, correctMs: 0, wrongMs: 0 };
    const transAgg = { abstainToCorrect: 0, correctToWrong: 0 };

    for (const def of FUSION_SCENARIOS) {
      const sc = simulateFusionScenario(def.opts, def.seed);
      const rows = replayWithMemory(sc);
      const truthOf = (tickIndex: number) => sc.ticks[tickIndex].truthTagByTrack;

      const baselineTicks: MemoryMetricTick[] = rows.map((row) => ({
        ts: row.ts,
        beliefs: row.assignments.map((a) => ({ trackId: a.trackId, label: a.tag, isFresh: true })),
        truthTagByTrack: truthOf(row.tickIndex),
      }));
      const memoryTicks: MemoryMetricTick[] = rows.map((row) => ({
        ts: row.ts,
        beliefs: row.beliefs,
        truthTagByTrack: truthOf(row.tickIndex),
      }));
      const transitionTicks: TransitionTick[] = rows.map((row) => ({
        ts: row.ts,
        truthTagByTrack: truthOf(row.tickIndex),
        baseline: row.assignments.map((a) => ({ trackId: a.trackId, label: a.tag })),
        withMemory: row.beliefs.map((b) => ({ trackId: b.trackId, label: b.label })),
      }));

      const baseM = computeMemoryMetrics(baselineTicks);
      const memM = computeMemoryMetrics(memoryTicks);
      const trans = computeTransitionMs(transitionTicks);

      baseAgg.totalMs += baseM.totalMs;
      baseAgg.correctMs += baseM.correctMs;
      baseAgg.wrongMs += baseM.wrongMs;
      memAgg.totalMs += memM.totalMs;
      memAgg.correctMs += memM.correctMs;
      memAgg.wrongMs += memM.wrongMs;
      transAgg.abstainToCorrect += trans.abstainToCorrect;
      transAgg.correctToWrong += trans.correctToWrong;
    }

    const baseCoverage = baseAgg.correctMs / baseAgg.totalMs;
    const memCoverage = memAgg.correctMs / memAgg.totalMs;

    // Regra a priori, eixo 1 (erro-segundos ≤ baseline): PASSA.
    expect(memAgg.wrongMs).toBeLessThanOrEqual(baseAgg.wrongMs);
    expect(memAgg.wrongMs).toBe(101500);
    expect(baseAgg.wrongMs).toBe(223500);

    // Regra a priori, eixo 2 (cobertura ≥ N× baseline, N≥1): FALHA — registrado, não escondido.
    // v1 como está reduz a cobertura agregada pra ~0,68× o baseline (multidão zera cobertura que o
    // baseline por-tick conseguia ocasionalmente) — não é candidato a default sem retuning.
    expect(memCoverage).toBeLessThan(baseCoverage);
    expect(Math.round((memCoverage / baseCoverage) * 100) / 100).toBe(0.68);

    // Decomposição (regra institucionalizada): o canal legítimo (abstenção→acerto) É maior que a
    // regressão grave (correto→errado) — o ganho onde existe é genuíno, só não é suficiente.
    expect(transAgg.abstainToCorrect).toBeGreaterThan(transAgg.correctToWrong * 10);
  });
});
