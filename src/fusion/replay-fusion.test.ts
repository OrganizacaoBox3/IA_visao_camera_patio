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
 * — torneio medido de 2026-07-10, números antes/depois no cabeçalho de associate.ts), o fix de
 * OCLUSÃO do scan da guarda (concorrentes vêm da janela inteira, não só do último frame — ver
 * assign()) E a EVIDÊNCIA ABSOLUTA v4 — MEDIDA E RETIRADA DOS DEFAULTS (revisão adversarial de
 * 2026-07-10 provou circularidade sim↔fit; ver cabeçalho de associate.ts). `maxDistRatio` e
 * `distWeight` ficam DESLIGADOS por default (0) — os pinos abaixo são o associador SÓ com
 * correlação + a EXCLUSÃO de âncoras (`excludeTags`, imune a viés — o ganho real). Os 8 cenários
 * SEM âncoras têm números IDÊNTICOS aos anteriores à v4 (sem distM/metric nada muda). Os
 * `ancoras-*` medem o associador COM a exclusão no ar: `ancoras-canonico`/`ancoras-multidao` são
 * o caso normal; `ancoras-multidao-bias` (−6 dB de atenuação corporal só nas tags de PESSOA) e
 * `ancoras-mismatch-n` (expoente do canal 3,0 ≠ 2,2 do modelo) são as SENTINELAS DE VIÉS — com
 * os knobs desligados elas se comportam como o cenário normal (a exclusão de âncoras não lê
 * distM, é imune por construção); qualquer futura re-adoção do gate/blend terá que continuar
 * saudável nelas (ver o teste "knobs v4" abaixo, que mede o custo de ligá-los).
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
  "ancoras-canonico": {
    precision: 0.832,
    coverage: 0.336,
    wrongRate: 0.0453,
    falseLabels: 12,
    idSwitches: 0,
  },
  "ancoras-multidao": {
    precision: 0.713,
    coverage: 0.22,
    wrongRate: 0.0589,
    falseLabels: 22,
    idSwitches: 1,
  },
  "ancoras-multidao-bias": {
    precision: 0.713,
    coverage: 0.22,
    wrongRate: 0.0589,
    falseLabels: 22,
    idSwitches: 1,
  },
  "ancoras-mismatch-n": {
    precision: 0.866,
    coverage: 0.289,
    wrongRate: 0.0298,
    falseLabels: 16,
    idSwitches: 0,
  },
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
    expect(rows).toHaveLength(12); // 8 legados + ancoras-canonico/multidao + 2 sentinelas de viés
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

  it("knobs v4 (gate+blend) são OPCIONAIS e desligados por default — ligá-los é um trade-off, não graça", () => {
    // DEFAULT hoje é OFF (maxDistRatio:0, distWeight:0) — a linha de base já é o associador
    // "sem v4"; este teste mede o CUSTO/BENEFÍCIO de ligar os knobs explicitamente (o que
    // qualquer futura re-adoção terá de enfrentar). Medido em 2026-07-10 (maxDistRatio:2.5 +
    // distWeight:0.3): nos 2 cenários NORMAIS com âncoras a precisão sobe um pouco
    // (ancoras-canonico 83,2%→87,3%; ancoras-multidao 71,3%→77,0%) com leve custo de cobertura.
    // Mas nas SENTINELAS DE VIÉS a cobertura DESPENCA: ancoras-multidao-bias (−6 dB corporal)
    // 22,0%→10,2% (quase METADE) e ancoras-mismatch-n (canal com n≠modelo) 28,9%→18,5% — a razão
    // exata pela qual os knobs ficam OFF (ver cabeçalho de associate.ts: circularidade sim↔fit).
    // Os 8 cenários SEM âncoras não mudam NADA (sem distM/metric o mecanismo é inerte).
    const rowsOff = runFusionBenchmark(); // default
    const rowsOn = runFusionBenchmark({ maxDistRatio: 2.5, distWeight: 0.3 });

    const multOff = metricsOf(rowsOff, "ancoras-multidao");
    const multOn = metricsOf(rowsOn, "ancoras-multidao");
    expect(multOn.precision).toBeGreaterThan(multOff.precision); // ganho no caso normal…

    const biasOff = metricsOf(rowsOff, "ancoras-multidao-bias");
    const biasOn = metricsOf(rowsOn, "ancoras-multidao-bias");
    // …mas sob viés corporal real (sentinela) a cobertura desaba MUITO mais que no caso normal —
    // o preço que só aparece com dado que o sim honesto injeta de propósito.
    const coverageDropNormal = multOff.coverage - multOn.coverage;
    const coverageDropBias = biasOff.coverage - biasOn.coverage;
    expect(coverageDropBias).toBeGreaterThan(coverageDropNormal * 2);

    for (const name of ["canonico", "bloco", "multidao", "sem-calibracao", "grade-sem-station"])
      expect(metricsOf(rowsOn, name), `${name}: v4 deve ser inerte sem distM`).toEqual(
        metricsOf(rowsOff, name),
      );
  });

  describe("reliability diagram SEM o corte de minMargin (pedido do especialista científico)", () => {
    // reliabilityBins já existe (identity-metrics.ts) e roda hoje com a guarda de PRODUÇÃO ligada
    // (minMargin default 0.1) — o especialista quer a curva com a margem CRUA (minMargin:0, TODA
    // decisão fala, mesmo margem baixíssima) para ver o formato completo e onde o corte de 0.1
    // "cai" nela. Não precisa NENHUMA mudança de código: computeIdentityMetrics já aceita qualquer
    // config; só roda o benchmark duas vezes (produção vs cru) e relata as duas curvas lado a lado.
    const scenarios = ["canonico", "multidao", "bloco"];

    function fmtCurve(bins: { marginMin: number; marginMax: number; correct: number; wrong: number; accuracy: number }[]): string {
      return bins
        .map(
          (b) =>
            `[${b.marginMin.toFixed(1)}-${b.marginMax.toFixed(1)}) n=${b.correct + b.wrong} ` +
            `(c=${b.correct},w=${b.wrong}) acc=${(b.accuracy * 100).toFixed(1)}%`,
        )
        .join("  |  ");
    }

    it("mede e relata: curva crua (minMargin:0) vs curva de produção (minMargin:0.1) em canonico/multidao/bloco", () => {
      const rowsProd = runFusionBenchmark(); // minMargin default (0.1)
      const rowsCru = runFusionBenchmark({ minMargin: 0 }); // guarda desligada — fala sempre

      console.log("\nreliability diagram — cru (minMargin:0) vs produção (minMargin:0.1):");
      for (const name of scenarios) {
        const cru = metricsOf(rowsCru, name).reliabilityBins;
        const prod = metricsOf(rowsProd, name).reliabilityBins;
        console.log(`  ${name}:`);
        console.log(`    cru      : ${fmtCurve(cru)}`);
        console.log(`    produção : ${fmtCurve(prod)}`);

        // Nunca NaN, sempre 5 bins, em ambas as curvas.
        expect(cru).toHaveLength(5);
        expect(prod).toHaveLength(5);
        for (const b of [...cru, ...prod]) expect(Number.isNaN(b.accuracy)).toBe(false);

        // A curva de produção é a curva CRUA restrita às decisões com margem ≥ 0.1 — logo os
        // bins 1..4 (margem ≥0.2, onde o corte de 0.1 não filtra nada dentro do bin) devem ter os
        // MESMOS contadores nas duas curvas; só o bin 0 ([0,0.2)) pode diferir, porque é o único
        // que contém tanto decisões abaixo de 0.1 (censuradas na produção) quanto entre
        // [0.1,0.2) (mantidas). Prova estrutural de que "produção" = "cru" menos o que o corte
        // tirou do bin 0 (nunca ADICIONA decisão que o cru não tinha).
        for (let i = 1; i < 5; i++) {
          expect(prod[i].correct).toBe(cru[i].correct);
          expect(prod[i].wrong).toBe(cru[i].wrong);
        }
        expect(prod[0].correct + prod[0].wrong).toBeLessThanOrEqual(cru[0].correct + cru[0].wrong);
      }

      console.log(
        "\n  veredito: ver o relato completo devolvido pelo teste (console acima) — " +
          "checar monotonicidade bin-a-bin da curva crua e onde a accuracy cruza a faixa " +
          "que minMargin:0.1 corta (bin 0, [0,0.2)).\n",
      );
    });
  });
});
