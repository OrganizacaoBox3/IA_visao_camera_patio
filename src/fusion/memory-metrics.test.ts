import { describe, expect, it } from "vitest";
import { computeCorrectionLatencies, computeMemoryMetrics } from "./memory-metrics";
import type { MemoryMetricTick } from "./memory-metrics";
import { buildConfirmationSentinel, buildMemoriaSentinel, replayWithMemory } from "./persistence-sentinel";
import type { SimOpts } from "./sim";

function tick(
  ts: number,
  beliefs: { trackId: number; label: string | null; isFresh: boolean }[],
  truth: Record<number, string | null>,
): MemoryMetricTick {
  return { ts, beliefs, truthTagByTrack: truth };
}

describe("computeMemoryMetrics", () => {
  it("cobertura de experiência: correto o tempo todo → 1", () => {
    const ticks = [
      tick(0, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T1" }),
      tick(1000, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T1" }),
      tick(2000, [{ trackId: 1, label: "T1", isFresh: false }], { 1: "T1" }),
    ];
    const m = computeMemoryMetrics(ticks);
    expect(m.totalMs).toBe(2000); // 2 intervalos de 1000ms (N ticks → N-1 intervalos)
    expect(m.correctMs).toBe(2000);
    expect(m.wrongMs).toBe(0);
    expect(m.coverageExperience).toBe(1);
  });

  it("decompõe erro-segundos por estado de origem (fresco × memória) — Mordida 2", () => {
    const ticks = [
      tick(0, [{ trackId: 1, label: "T2", isFresh: true }], { 1: "T1" }), // errado, FRESCO
      tick(1000, [{ trackId: 1, label: "T2", isFresh: false }], { 1: "T1" }), // errado, MEMÓRIA
      tick(2000, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T1" }), // corrige
    ];
    const m = computeMemoryMetrics(ticks);
    expect(m.wrongMsFresh).toBe(1000); // intervalo [0,1000) — fresco
    expect(m.wrongMsMemoria).toBe(1000); // intervalo [1000,2000) — memória
    expect(m.wrongMs).toBe(2000);
    expect(m.correctMs).toBe(0);
  });

  it("abstenção (candidata, label:null) não conta em certo nem errado", () => {
    const ticks = [
      tick(0, [{ trackId: 1, label: null, isFresh: false }], { 1: "T1" }),
      tick(1000, [{ trackId: 1, label: null, isFresh: false }], { 1: "T1" }),
    ];
    const m = computeMemoryMetrics(ticks);
    expect(m.abstainedMs).toBe(1000);
    expect(m.correctMs).toBe(0);
    expect(m.wrongMs).toBe(0);
    expect(m.coverageExperience).toBe(0);
  });

  it("pessoa SEM tag (truth:null) ou track fantasma (sem entrada) ficam fora da cobertura", () => {
    const ticks = [
      tick(0, [{ trackId: 1, label: "T9", isFresh: true }], { 1: null }), // sem tag — falso-rótulo, fora do escopo desta métrica
      tick(1000, [{ trackId: 2, label: "T9", isFresh: true }], {}), // fantasma — sem entrada de verdade
      tick(2000, [], {}),
    ];
    const m = computeMemoryMetrics(ticks);
    expect(m.totalMs).toBe(0);
    expect(m.coverageExperience).toBe(0);
  });

  it("intervalo com dt<=0 (ts não-monotônico) é ignorado, nunca soma duração negativa", () => {
    const ticks = [
      tick(1000, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T1" }),
      tick(500, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T1" }), // ts voltou — descartado
    ];
    const m = computeMemoryMetrics(ticks);
    expect(m.totalMs).toBe(0);
  });
});

describe("computeCorrectionLatencies", () => {
  it("mede a duração de um episódio de rótulo errado até a correção", () => {
    const ticks = [
      tick(0, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T1" }), // certo
      tick(1000, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T2" }), // verdade mudou — mentira começa
      tick(3000, [{ trackId: 1, label: "T1", isFresh: false }], { 1: "T2" }), // segue mentindo (memória)
      tick(5000, [{ trackId: 1, label: "T2", isFresh: true }], { 1: "T2" }), // corrige
    ];
    const lat = computeCorrectionLatencies(ticks);
    expect(lat).toEqual([{ trackId: 1, fromTs: 1000, toTs: 5000, latencyMs: 4000 }]);
  });

  it("abstenção (volta a candidata) também encerra o episódio — mentira parou, mesmo sem corrigir", () => {
    const ticks = [
      tick(0, [{ trackId: 1, label: "T1", isFresh: true }], { 1: "T2" }), // já nasce errado
      tick(1000, [{ trackId: 1, label: null, isFresh: false }], { 1: "T2" }), // quebra pra candidata
    ];
    const lat = computeCorrectionLatencies(ticks);
    expect(lat).toEqual([{ trackId: 1, fromTs: 0, toTs: 1000, latencyMs: 1000 }]);
  });

  it("tracks independentes não interferem entre si", () => {
    const ticks = [
      tick(0, [
        { trackId: 1, label: "T1", isFresh: true },
        { trackId: 2, label: "T5", isFresh: true },
      ], { 1: "T2", 2: "T5" }),
      tick(1000, [
        { trackId: 1, label: "T2", isFresh: true },
        { trackId: 2, label: "T5", isFresh: true },
      ], { 1: "T2", 2: "T5" }),
    ];
    const lat = computeCorrectionLatencies(ticks);
    expect(lat).toEqual([{ trackId: 1, fromTs: 0, toTs: 1000, latencyMs: 1000 }]);
  });
});

describe("integração: as métricas confirmam QUANTITATIVAMENTE a previsão da Mordida 2", () => {
  // Mesmos cenário/seed determinísticos de persistence-sentinel.test.ts. Números medidos (não
  // achados por sorte — reproduzíveis por qualquer um rodando os mesmos parâmetros): a sentinela
  // durante-memória produz MAIS que o DOBRO de erro-segundos-em-memória que a sentinela na
  // confirmação (14,5s vs 6s) — exatamente a direção que o especialista previu (memória é o pior
  // caso, porque tem mais tempo pra exibir o rótulo errado sem nenhum mecanismo de correção precoce).
  const OPTS: SimOpts = { steps: 240, people: 2, tagged: 2, walk: "cruzamento" };

  function metricsFor(scenario: ReturnType<typeof buildConfirmationSentinel>) {
    const r = scenario!;
    const rows = replayWithMemory(r.scenario);
    const ticks: MemoryMetricTick[] = rows.map((row) => ({
      ts: row.ts,
      beliefs: row.beliefs,
      truthTagByTrack: r.scenario.ticks[row.tickIndex].truthTagByTrack,
    }));
    return computeMemoryMetrics(ticks);
  }

  it("erro-segundos em memória: sentinela durante-memória > sentinela na confirmação", () => {
    const confirmacao = metricsFor(buildConfirmationSentinel(OPTS, 1, 0, 1));
    const memoria = metricsFor(buildMemoriaSentinel(OPTS, 1, 0, 1, 4));
    expect(confirmacao.wrongMsMemoria).toBe(6000);
    expect(memoria.wrongMsMemoria).toBe(14500);
    expect(memoria.wrongMsMemoria).toBeGreaterThan(confirmacao.wrongMsMemoria);
    expect(memoria.wrongMs).toBeGreaterThan(confirmacao.wrongMs);
  });
});
