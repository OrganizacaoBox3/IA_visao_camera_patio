// Testes das métricas de identidade (src/fusion/identity-metrics.ts) com ticks montados à mão.
// Cobre: contadores (correct/wrong/abstained/trueAbstain/falseLabels), warmup excluindo ticks,
// id-switches (só não-null→não-null DIFERENTE; rótulo→null→mesmo rótulo = 0), track fantasma
// ignorado, entradas vazias sem NaN e precision=1 quando o associador só se abstém.
import { describe, it, expect } from "vitest";
import type { Assignment } from "./associate";
import {
  computeIdentityMetrics,
  formatIdentityTable,
  type IdentityTick,
} from "./identity-metrics";

/** Atalhos de construção (confiança irrelevante para a métrica — fixa em 0.9). */
const asg = (trackId: number, tag: string | null): Assignment => ({ trackId, tag, confidence: 0.9 });
/** Atalho com margin/hadConflict explícitos, para os testes de reliability/conflictRate. */
const asgM = (
  trackId: number,
  tag: string | null,
  margin: number,
  hadConflict = false,
): Assignment => ({ trackId, tag, confidence: 0.9, margin, hadConflict });
const tick = (
  ts: number,
  assignments: Assignment[],
  truthTagByTrack: Record<number, string | null>,
): IdentityTick => ({ ts, assignments, truthTagByTrack });

describe("computeIdentityMetrics — contadores", () => {
  it("classifica correct/wrong/abstained/trueAbstain/falseLabels num tick misto", () => {
    const truth: Record<number, string | null> = { 1: "AA", 2: "BB", 3: "CC", 4: null, 5: null };
    const m = computeIdentityMetrics([
      tick(10000, [
        asg(1, "AA"), // tinha "AA", disse "AA" → correct
        asg(2, "XX"), // tinha "BB", disse "XX" → wrong
        asg(3, null), // tinha "CC", disse "não sei" → abstained (honesto)
        asg(4, null), // não tinha tag, disse "não sei" → trueAbstain
        asg(5, "ZZ"), // não tinha tag, rotulou → falseLabels E wrong (erro grave)
      ], truth),
    ]);

    expect(m.ticksEvaluated).toBe(1);
    expect(m.opportunities).toBe(3); // só quem TINHA tag (tracks 1, 2 e 3)
    expect(m.correct).toBe(1);
    expect(m.wrong).toBe(2); // o "XX" errado + o falso-rótulo do track 5
    expect(m.abstained).toBe(1);
    expect(m.trueAbstain).toBe(1);
    expect(m.falseLabels).toBe(1);
    expect(m.precision).toBeCloseTo(1 / 3); // correct/(correct+wrong)
    expect(m.coverage).toBeCloseTo(1 / 3); // correct/opportunities
    expect(m.wrongRate).toBeCloseTo(2 / 5); // wrong/(3 opp + 1 trueAbstain + 1 falseLabel)
  });

  it("track fantasma (sem entrada na verdade) é ignorado por completo", () => {
    const m = computeIdentityMetrics([
      tick(9000, [asg(1, "AA"), asg(99, "BB")], { 1: "AA" }), // 99 não existe na verdade
    ]);
    expect(m.opportunities).toBe(1);
    expect(m.correct).toBe(1);
    expect(m.wrong).toBe(0);
    expect(m.falseLabels).toBe(0);
    expect(m.trueAbstain).toBe(0);
  });
});

describe("computeIdentityMetrics — warmup", () => {
  it("ignora ticks com ts < warmupMs (default 8000)", () => {
    const truth: Record<number, string | null> = { 1: "AA" };
    const m = computeIdentityMetrics([
      tick(0, [asg(1, "XX")], truth), // pré-warmup: o erro NÃO conta
      tick(7999, [asg(1, "XX")], truth), // ainda pré-warmup (limite exclusivo)
      tick(8000, [asg(1, "AA")], truth), // avaliado
      tick(8500, [asg(1, "AA")], truth), // avaliado
    ]);
    expect(m.ticksEvaluated).toBe(2);
    expect(m.correct).toBe(2);
    expect(m.wrong).toBe(0);
    expect(m.precision).toBe(1);
  });

  it("respeita warmupMs customizado", () => {
    const truth: Record<number, string | null> = { 1: "AA" };
    const m = computeIdentityMetrics(
      [tick(500, [asg(1, "AA")], truth), tick(1500, [asg(1, "AA")], truth)],
      { warmupMs: 1000 },
    );
    expect(m.ticksEvaluated).toBe(1);
    expect(m.correct).toBe(1);
  });
});

describe("computeIdentityMetrics — idSwitches", () => {
  const truth: Record<number, string | null> = { 1: "AA" };

  it("conta a troca não-null → OUTRO não-null (AA→AA→BB→BB = 1 troca)", () => {
    const m = computeIdentityMetrics([
      tick(9000, [asg(1, "AA")], truth),
      tick(9500, [asg(1, "AA")], truth),
      tick(10000, [asg(1, "BB")], truth),
      tick(10500, [asg(1, "BB")], truth),
    ]);
    expect(m.idSwitches).toBe(1);
  });

  it("rótulo→null→mesmo rótulo NÃO conta (AA→null→AA = 0 trocas)", () => {
    const m = computeIdentityMetrics([
      tick(9000, [asg(1, "AA")], truth),
      tick(9500, [asg(1, null)], truth),
      tick(10000, [asg(1, "AA")], truth),
    ]);
    expect(m.idSwitches).toBe(0);
  });

  it("null→rótulo e rótulo→null não contam; AA→BB→AA conta 2", () => {
    const m = computeIdentityMetrics([
      tick(9000, [asg(1, null)], truth), // null→AA a seguir: não conta
      tick(9500, [asg(1, "AA")], truth),
      tick(10000, [asg(1, "BB")], truth), // AA→BB: conta
      tick(10500, [asg(1, "AA")], truth), // BB→AA: conta
      tick(11000, [asg(1, null)], truth), // AA→null: não conta
    ]);
    expect(m.idSwitches).toBe(2);
  });

  it("só transições entre ticks AVALIADOS: rótulo pré-warmup não semeia troca", () => {
    const m = computeIdentityMetrics([
      tick(0, [asg(1, "AA")], truth), // pré-warmup: fora da sequência
      tick(9000, [asg(1, "BB")], truth),
      tick(9500, [asg(1, "BB")], truth),
    ]);
    expect(m.idSwitches).toBe(0);
  });

  it("trocas são contadas por track, independentes entre si", () => {
    const truth2: Record<number, string | null> = { 1: "AA", 2: "BB" };
    const m = computeIdentityMetrics([
      tick(9000, [asg(1, "AA"), asg(2, "BB")], truth2),
      tick(9500, [asg(1, "BB"), asg(2, "BB")], truth2), // troca só no track 1
    ]);
    expect(m.idSwitches).toBe(1);
  });
});

describe("computeIdentityMetrics — bordas sem NaN", () => {
  it("entrada vazia → zeros, precision 1 e coverage 0 (nunca NaN)", () => {
    const m = computeIdentityMetrics([]);
    expect(m.ticksEvaluated).toBe(0);
    expect(m.opportunities).toBe(0);
    expect(m.correct).toBe(0);
    expect(m.wrong).toBe(0);
    expect(m.abstained).toBe(0);
    expect(m.trueAbstain).toBe(0);
    expect(m.falseLabels).toBe(0);
    expect(m.idSwitches).toBe(0);
    expect(m.precision).toBe(1);
    expect(m.coverage).toBe(0);
    expect(m.wrongRate).toBe(0);
    for (const v of Object.values(m)) expect(Number.isNaN(v)).toBe(false);
  });

  it("só abstenções → precision 1 (abster-se sempre é honesto, não é erro)", () => {
    const truth: Record<number, string | null> = { 1: "AA", 2: null };
    const m = computeIdentityMetrics([
      tick(9000, [asg(1, null), asg(2, null)], truth),
      tick(9500, [asg(1, null), asg(2, null)], truth),
    ]);
    expect(m.precision).toBe(1);
    expect(m.coverage).toBe(0);
    expect(m.wrongRate).toBe(0);
    expect(m.abstained).toBe(2);
    expect(m.trueAbstain).toBe(2);
  });
});

describe("computeIdentityMetrics — reliabilityBins (calibração da margem)", () => {
  it("classifica decisões faladas no bin certo por margem e calcula accuracy por bin", () => {
    const truth: Record<number, string | null> = { 1: "AA", 2: "BB", 3: "CC", 4: "DD" };
    const m = computeIdentityMetrics([
      tick(9000, [
        asgM(1, "AA", 0.95), // certo, bin [0.8,1.0]
        asgM(2, "XX", 0.9), // errado (verdade BB), bin [0.8,1.0]
        asgM(3, "CC", 0.1), // certo, bin [0,0.2)
        asgM(4, "ZZ", 0.05), // errado (verdade DD), bin [0,0.2)
      ], truth),
    ]);
    expect(m.reliabilityBins).toHaveLength(5);
    const [bin0, , , , bin4] = m.reliabilityBins;
    expect(bin0.marginMin).toBe(0);
    expect(bin0.marginMax).toBeCloseTo(0.2);
    expect(bin0.correct).toBe(1);
    expect(bin0.wrong).toBe(1);
    expect(bin0.accuracy).toBeCloseTo(0.5);
    expect(bin4.marginMin).toBeCloseTo(0.8);
    expect(bin4.marginMax).toBe(1);
    expect(bin4.correct).toBe(1);
    expect(bin4.wrong).toBe(1);
    expect(bin4.accuracy).toBeCloseTo(0.5);
  });

  it("abstenções (tag null) NÃO entram no reliability diagram, só decisões faladas", () => {
    const truth: Record<number, string | null> = { 1: "AA" };
    const m = computeIdentityMetrics([tick(9000, [asgM(1, null, 0.05, true)], truth)]);
    const total = m.reliabilityBins.reduce((s, b) => s + b.correct + b.wrong, 0);
    expect(total).toBe(0);
  });

  it("bin vazio tem accuracy 0, nunca NaN", () => {
    const truth: Record<number, string | null> = { 1: "AA" };
    const m = computeIdentityMetrics([tick(9000, [asgM(1, "AA", 0.95)], truth)]);
    for (const b of m.reliabilityBins) {
      expect(Number.isNaN(b.accuracy)).toBe(false);
      if (b.correct + b.wrong === 0) expect(b.accuracy).toBe(0);
    }
  });

  it("margin ausente (Assignment antigo, sem instrumentação) cai no bin [0,0.2) sem quebrar", () => {
    const truth: Record<number, string | null> = { 1: "AA" };
    const m = computeIdentityMetrics([tick(9000, [asg(1, "AA")], truth)]);
    expect(m.reliabilityBins[0].correct).toBe(1);
  });

  it("margem no limite exato do bin (0.2, 0.4, ...) cai no bin SUPERIOR (left-closed)", () => {
    const truth: Record<number, string | null> = { 1: "AA" };
    const m = computeIdentityMetrics([tick(9000, [asgM(1, "AA", 0.2)], truth)]);
    expect(m.reliabilityBins[0].correct).toBe(0);
    expect(m.reliabilityBins[1].correct).toBe(1);
  });

  it("margem 1.0 exata cai no último bin (fechado nos dois lados)", () => {
    const truth: Record<number, string | null> = { 1: "AA" };
    const m = computeIdentityMetrics([tick(9000, [asgM(1, "AA", 1.0)], truth)]);
    expect(m.reliabilityBins[4].correct).toBe(1);
  });
});

describe("computeIdentityMetrics — conflictRate", () => {
  it("conta a fração de ticks com PELO MENOS UM assignment em conflito", () => {
    const truth: Record<number, string | null> = { 1: "AA", 2: "BB" };
    const m = computeIdentityMetrics([
      tick(9000, [asgM(1, "AA", 0.9, false), asgM(2, "BB", 0.9, false)], truth), // sem conflito
      tick(9500, [asgM(1, null, 0.05, true), asgM(2, "BB", 0.9, false)], truth), // 1 em conflito
      tick(10000, [asgM(1, "AA", 0.9, false), asgM(2, null, 0.05, true)], truth), // 1 em conflito
    ]);
    expect(m.conflictRate).toBeCloseTo(2 / 3);
  });

  it("sem ticks avaliados → conflictRate 0 (nunca NaN)", () => {
    const m = computeIdentityMetrics([]);
    expect(m.conflictRate).toBe(0);
  });

  it("track fantasma com hadConflict não conta (ignorado como o resto das métricas)", () => {
    const m = computeIdentityMetrics([
      tick(9000, [asgM(99, "AA", 0.05, true)], {}), // 99 não existe na verdade
    ]);
    expect(m.conflictRate).toBe(0);
  });
});

describe("formatIdentityTable", () => {
  it("contém os nomes dos cenários e os cabeçalhos, sem lançar", () => {
    const a = computeIdentityMetrics([
      tick(9000, [asg(1, "AA")], { 1: "AA" }),
    ]);
    const b = computeIdentityMetrics([]);
    const table = formatIdentityTable([
      { scenario: "duas-pessoas-cruzando", m: a },
      { scenario: "vazio", m: b },
    ]);
    expect(table).toContain("duas-pessoas-cruzando");
    expect(table).toContain("vazio");
    for (const col of ["cenário", "opp", "certo", "errado", "absteve", "falso-rótulo", "precisão %", "cobertura %", "id-switch"]) {
      expect(table).toContain(col);
    }
    // header + linha de traços + 2 linhas de dados
    expect(table.split("\n")).toHaveLength(4);
  });

  it("não lança com lista vazia de linhas", () => {
    expect(() => formatIdentityTable([])).not.toThrow();
  });
});
