// Gate do harness de replay da fusão (replay-fusion.ts): mede o associador DE PRODUÇÃO em
// cenários sintéticos determinísticos e PINA números MEDIDOS (não desejados — doutrina de
// honestidade técnica: rodou, olhou, pinou o real). TODOS os cenários da suíte são gate: cada um
// tem pisos (precision/coverage) e tetos (wrongRate/falseLabels/idSwitches) medidos. Mudança de
// knob/heurística que mexa nos números quebra aqui e obriga re-medição consciente (rodar, olhar
// a tabela do teste de diagnóstico, re-pinar), nunca regressão silenciosa.
import { describe, expect, it } from "vitest";
import { formatIdentityTable } from "./identity-metrics";
import { runFusionBenchmark } from "./replay-fusion";

/** Métricas de um cenário da suíte (falha explícita se o nome sumir da suíte). */
function metricsOf(rows: ReturnType<typeof runFusionBenchmark>, scenario: string) {
  const row = rows.find((r) => r.scenario === scenario);
  if (!row) throw new Error(`cenário "${scenario}" não está na suíte`);
  return row.m;
}

// Margem sobre as TAXAS medidas: o pipeline é determinístico, então o pino é justo — a margem só
// absorve o arredondamento do pino, não "variação de execução" (que não existe aqui).
const RATE_MARGIN = 0.02;

/**
 * Pinos MEDIDOS em 2026-07-10 (seed/opts da suíte FUSION_SCENARIOS, 240 passos), APÓS: ruído
 * multiplicativo σ=5% na altura da caixa (sim.ts), sem-calibracao com stationAtCamera:true e o
 * cenário novo grade-sem-station. Piso: precision/coverage ≥ pino−RATE_MARGIN. Teto:
 * wrongRate ≤ pino+RATE_MARGIN; falseLabels/idSwitches ≤ valor medido (contadores exatos).
 */
const PINS: Record<
  string,
  { precision: number; coverage: number; wrongRate: number; falseLabels: number; idSwitches: number }
> = {
  canonico: { precision: 0.814, coverage: 0.419, wrongRate: 0.064, falseLabels: 33, idSwitches: 1 },
  parado: { precision: 1, coverage: 0, wrongRate: 0, falseLabels: 0, idSwitches: 0 },
  bloco: { precision: 0.608, coverage: 0.335, wrongRate: 0.147, falseLabels: 15, idSwitches: 20 },
  cruzamento: { precision: 0.784, coverage: 0.283, wrongRate: 0.078, falseLabels: 0, idSwitches: 1 },
  "ruido-alto": { precision: 0.689, coverage: 0.216, wrongRate: 0.066, falseLabels: 28, idSwitches: 0 },
  multidao: { precision: 0.498, coverage: 0.306, wrongRate: 0.205, falseLabels: 88, idSwitches: 31 },
  "sem-calibracao": { precision: 0.718, coverage: 0.302, wrongRate: 0.08, falseLabels: 28, idSwitches: 4 },
  "grade-sem-station": { precision: 0.492, coverage: 0.207, wrongRate: 0.144, falseLabels: 43, idSwitches: 2 },
};

describe("replay-fusion (harness do associador de produção)", () => {
  it("é determinístico: duas rodadas da suíte produzem números idênticos", () => {
    expect(runFusionBenchmark()).toEqual(runFusionBenchmark());
  });

  it("parado: o guarda minMovement abstém SEMPRE — zero rótulo errado", () => {
    // Invariante do dono comprovada: sem movimento não há correlação confiável, e rótulo errado é
    // pior que rótulo nenhum. wrong>0 aqui = guarda furado (ou ruído de pixel inflando a variância).
    const m = metricsOf(runFusionBenchmark(), "parado");
    expect(m.wrong).toBe(0);
    expect(m.correct).toBe(0); // parado não tem como acertar — só abster
    expect(m.abstained).toBeGreaterThan(0); // e de fato houve decisões (não é vácuo)
  });

  it("gate: TODOS os cenários respeitam os pinos medidos (pisos e tetos por cenário)", () => {
    const rows = runFusionBenchmark();
    // Suíte e tabela de pinos andam juntas: cenário novo sem pino (ou pino órfão) quebra aqui.
    expect(rows.map((r) => r.scenario).sort()).toEqual(Object.keys(PINS).sort());
    for (const [scenario, pin] of Object.entries(PINS)) {
      const m = metricsOf(rows, scenario);
      expect(m.precision, `${scenario}: precision abaixo do piso`).toBeGreaterThanOrEqual(
        pin.precision - RATE_MARGIN,
      );
      expect(m.coverage, `${scenario}: coverage abaixo do piso`).toBeGreaterThanOrEqual(
        pin.coverage - RATE_MARGIN,
      );
      expect(m.wrongRate, `${scenario}: wrongRate acima do teto`).toBeLessThanOrEqual(
        pin.wrongRate + RATE_MARGIN,
      );
      expect(m.falseLabels, `${scenario}: falseLabels acima do teto`).toBeLessThanOrEqual(
        pin.falseLabels,
      );
      expect(m.idSwitches, `${scenario}: idSwitches acima do teto`).toBeLessThanOrEqual(
        pin.idSwitches,
      );
    }
  });

  it("bloco: registra o resultado sem forçar vitória (andar em bloco é fisicamente ambíguo)", () => {
    // O ACHADO do harness (não um bug do teste): o associador FALA no caso fisicamente ambíguo em
    // vez de abster — precisão medida 60,8% (linha de base honesta; era ~57% antes do ruído de bh,
    // mesma física com outra realização do RNG). O gate acima impede a regressão silenciosa; este
    // teste preserva o registro humano do número.
    const m = metricsOf(runFusionBenchmark(), "bloco");
    console.log("bloco (medido):", JSON.stringify(m));
    expect(Number.isFinite(m.precision)).toBe(true);
    expect(Number.isFinite(m.wrongRate)).toBe(true);
  });

  it("diagnóstico: tabela completa da suíte (leitura humana)", () => {
    const rows = runFusionBenchmark();
    console.log(`\n${formatIdentityTable(rows)}\n`);
    expect(rows).toHaveLength(8);
  });

  it("knobs são plugáveis: minConfidence 0.9 derruba a cobertura do canonico", () => {
    // Prova que o harness serve p/ tuning MEDIDO: mudar o knob muda os números da mesma suíte.
    const padrao = metricsOf(runFusionBenchmark(), "canonico");
    const estrito = metricsOf(runFusionBenchmark({ minConfidence: 0.9 }), "canonico");
    expect(estrito.coverage).toBeLessThan(padrao.coverage);
    expect(estrito).not.toEqual(padrao);
  });
});
