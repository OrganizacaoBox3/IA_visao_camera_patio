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
 * multiplicativo σ=5% na altura da caixa (sim.ts), sem-calibracao com stationAtCamera:true, o
 * cenário novo grade-sem-station, o DEFAULT NOVO `minMargin: 0.1` (guarda de ambiguidade top-2
 * — torneio medido de 2026-07-10, números antes/depois no cabeçalho de associate.ts) E o fix de
 * OCLUSÃO do scan da guarda (concorrentes vêm da janela inteira, não só do último frame — ver
 * assign()). O fix moveu a suíte: wrong 344→332, correct 734→723, falsos rótulos 148→142 —
 * regra do torneio segue satisfeita (wrong ≤70% de 612; correct ≥70% de 1014).
 * Piso: precision/coverage ≥ pino−RATE_MARGIN. Teto: wrongRate ≤ pino+RATE_MARGIN;
 * falseLabels/idSwitches ≤ valor medido (contadores exatos).
 */
const PINS: Record<
  string,
  { precision: number; coverage: number; wrongRate: number; falseLabels: number; idSwitches: number }
> = {
  canonico: { precision: 0.825, coverage: 0.34, wrongRate: 0.048, falseLabels: 23, idSwitches: 1 },
  parado: { precision: 1, coverage: 0, wrongRate: 0, falseLabels: 0, idSwitches: 0 },
  bloco: { precision: 0.82, coverage: 0.116, wrongRate: 0.017, falseLabels: 7, idSwitches: 0 },
  cruzamento: { precision: 0.784, coverage: 0.283, wrongRate: 0.078, falseLabels: 0, idSwitches: 1 },
  "ruido-alto": { precision: 0.705, coverage: 0.184, wrongRate: 0.051, falseLabels: 22, idSwitches: 0 },
  multidao: { precision: 0.598, coverage: 0.173, wrongRate: 0.077, falseLabels: 29, idSwitches: 3 },
  "sem-calibracao": { precision: 0.713, coverage: 0.265, wrongRate: 0.072, falseLabels: 24, idSwitches: 1 },
  "grade-sem-station": { precision: 0.459, coverage: 0.158, wrongRate: 0.125, falseLabels: 37, idSwitches: 0 },
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
    // HISTÓRICO do achado: o associador original FALAVA no caso fisicamente ambíguo (precisão
    // 60,8%, 20 id-switches — a violação da invariante que o harness revelou). A guarda de
    // ambiguidade top-2 (minMargin 0.1, default desde o torneio de 2026-07-10) o fez ABSTER:
    // precisão 80,3% (82,0% após o fix de oclusão do scan da guarda), id-switch 0 — pagando
    // cobertura (33,5%→12,3%→11,6%), o trade-off certo pela invariante do dono. Este teste
    // preserva o registro humano do número medido.
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

  it("knob desligável: minMargin 0 devolve o comportamento antigo no bloco (fala mais, erra mais)", () => {
    // Retrocompat MEDIDA da guarda de ambiguidade: desligada, o bloco volta a falar (cobertura
    // sobe) ao preço da invariante (precisão cai, id-switches voltam) — 60,8%/33,5%/20 vs
    // 82,0%/11,6%/0 com o default (pós-fix de oclusão; era 80,3%/12,3%/0 no torneio).
    const comGuarda = metricsOf(runFusionBenchmark(), "bloco");
    const semGuarda = metricsOf(runFusionBenchmark({ minMargin: 0 }), "bloco");
    expect(semGuarda.coverage).toBeGreaterThan(comGuarda.coverage);
    expect(semGuarda.precision).toBeLessThan(comGuarda.precision);
    expect(semGuarda.idSwitches).toBeGreaterThan(comGuarda.idSwitches);
  });
});
