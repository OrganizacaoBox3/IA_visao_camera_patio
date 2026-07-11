// Testes da infraestrutura de famílias paramétricas (families.ts — Fase 3 da bancada,
// docs/cientifica/simulador.md §7.1/§8). Garantias:
// (a) determinismo bit-a-bit: mesma família + mesmos seeds ⇒ resultado idêntico;
// (b) o bootstrap devolve IC coerente (lo ≤ média ≤ hi) — nunca NaN;
// (c) cada família concreta roda ponta-a-ponta (pessoas, ruído, viés corporal, erro de âncora);
// (d) a PREVISÃO FALSEÁVEL (c) do §8 do escopo é COBRADA em CI: erro de posição de âncora não
//     pode mover a precisão de identidade — se mover, o teste FALHA e isso é um ACHADO
//     (acoplamento escondido), não um bug do teste. NÃO enfraquecer.
// No CI, cada família roda com eixo REDUZIDO e poucos seeds pra não estourar o tempo; a curva
// COMPLETA (§7.1: ≥20 seeds/ponto) fica atrás da env var FAMILY_FULL=1:
//   FAMILY_FULL=1 npx vitest run src/fusion/families.test.ts
// (ou por família, via o comando do aceite §9.3: `npm run family -- <nome>` → scripts/family.mjs).
// Curvas novas NÃO nascem pinadas ("ganham pinos próprios quando estabilizarem", §7.1) — aqui só
// sanidade estrutural + log da curva pra diagnóstico humano (console.log em teste é praxe da casa).
// CONTRATO com scripts/family.mjs: todo teste de curva completa chama-se
// "curva completa <nome-da-família> (FAMILY_FULL=1): ..." — é esse prefixo que o CLI filtra via -t.
import { describe, expect, it } from "vitest";
import {
  bootstrapCi,
  runFamily,
  FAMILY_PRECISION_VS_PEOPLE,
  FAMILY_PRECISION_VS_NOISE,
  FAMILY_PRECISION_VS_BODY_BIAS,
  FAMILY_PRECISION_VS_ANCHOR_ERROR,
} from "./families";
import type { BootstrapCi, ParametricFamily } from "./families";

/** Família mínima pros testes de infraestrutura — barata (80 passos, 2 pontos). */
const TINY_FAMILY: ParametricFamily = {
  name: "tiny",
  axisName: "people",
  axis: [2, 3],
  scenario: (people) => ({ steps: 80, people, tagged: people - 1, walk: "waypoint" }),
};

function ciIsCoherent(ci: BootstrapCi): void {
  expect(Number.isFinite(ci.mean)).toBe(true);
  expect(Number.isFinite(ci.lo)).toBe(true);
  expect(Number.isFinite(ci.hi)).toBe(true);
  expect(ci.lo).toBeLessThanOrEqual(ci.mean);
  expect(ci.mean).toBeLessThanOrEqual(ci.hi);
}

describe("runFamily — infraestrutura", () => {
  it("(a) mesma família + mesmos seeds ⇒ resultado idêntico bit-a-bit", () => {
    const a = runFamily(TINY_FAMILY, { seedsPerPoint: 3, bootstrapResamples: 200 });
    const b = runFamily(TINY_FAMILY, { seedsPerPoint: 3, bootstrapResamples: 200 });
    // toEqual compara números por igualdade estrita — com pipeline determinístico (LCG seedado
    // ponta a ponta, zero Math.random) isso É bit-a-bit.
    expect(b).toEqual(a);
  });

  it("(a2) seeds são determinísticos 1..N", () => {
    const r = runFamily(TINY_FAMILY, { seedsPerPoint: 4, bootstrapResamples: 100 });
    for (const p of r.points) expect(p.seeds).toEqual([1, 2, 3, 4]);
  });

  it("(b) bootstrap devolve IC com lo ≤ média ≤ hi (inclusive casos degenerados)", () => {
    // Rng determinístico simples pro teste da função isolada (não precisa ser o LCG da produção).
    let s = 12345;
    const rng = () => {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 4294967296;
    };
    ciIsCoherent(bootstrapCi([0.1, 0.5, 0.9, 0.3, 0.7], rng, 500));
    // Amostra constante → IC degenerado honesto (lo = média = hi; toBeCloseTo pelo float:
    // (0,4+0,4+0,4)/3 dá 0,4000000000000001 em IEEE-754, e está certo assim).
    const constant = bootstrapCi([0.4, 0.4, 0.4], rng, 500);
    expect(constant.mean).toBeCloseTo(0.4, 12);
    expect(constant.lo).toBe(constant.mean);
    expect(constant.hi).toBe(constant.mean);
    // Amostra vazia → zeros, nunca NaN (mesma postura de identity-metrics.ts).
    expect(bootstrapCi([], rng, 500)).toEqual({ mean: 0, lo: 0, hi: 0 });
  });

  it("(b2) todos os ICs de um run real são coerentes", () => {
    const r = runFamily(TINY_FAMILY, { seedsPerPoint: 3, bootstrapResamples: 200 });
    for (const p of r.points) {
      ciIsCoherent(p.precision);
      ciIsCoherent(p.coverage);
      ciIsCoherent(p.wrong);
      ciIsCoherent(p.falseLabels);
      ciIsCoherent(p.idSwitches);
      ciIsCoherent(p.wrongRate);
      ciIsCoherent(p.swap);
      ciIsCoherent(p.opportunities);
      // Taxas vivem em [0,1]; contadores da decomposição nunca negativos.
      expect(p.precision.lo).toBeGreaterThanOrEqual(0);
      expect(p.precision.hi).toBeLessThanOrEqual(1);
      expect(p.coverage.lo).toBeGreaterThanOrEqual(0);
      expect(p.coverage.hi).toBeLessThanOrEqual(1);
      expect(p.wrongRate.lo).toBeGreaterThanOrEqual(0);
      expect(p.wrongRate.hi).toBeLessThanOrEqual(1);
      expect(p.wrong.lo).toBeGreaterThanOrEqual(0);
      expect(p.falseLabels.lo).toBeGreaterThanOrEqual(0);
      expect(p.idSwitches.lo).toBeGreaterThanOrEqual(0);
      // swap = wrong−falseLabels por seed; como falseLabels ⊂ wrong, nunca negativo.
      expect(p.swap.lo).toBeGreaterThanOrEqual(0);
      expect(p.opportunities.lo).toBeGreaterThanOrEqual(0);
    }
  });
});

/**
 * Curva em texto pra diagnóstico humano (o log é o instrumento, não console.log de produção).
 * wrongRate (taxa, com IC) e swap (pessoa↔pessoa real) entram junto das contagens — achado C1:
 * contagem absoluta em eixo que muda o nº de oportunidades engana a leitura (ver families.ts).
 * CONTRATO com scripts/family.mjs: o parser do CLI reconhece o bloco pela linha-título
 * "<nome> (N seeds/ponto):" + linhas indentadas (2+ espaços) — mudou o formato, atualize lá junto.
 */
function fmtCurve(r: ReturnType<typeof runFamily>): string {
  const lines = r.points.map(
    (p) =>
      `  ${r.axisName}=${p.axisValue}: precisão ${(p.precision.mean * 100).toFixed(1)}% ` +
      `[${(p.precision.lo * 100).toFixed(1)}, ${(p.precision.hi * 100).toFixed(1)}]  ` +
      `cobertura ${(p.coverage.mean * 100).toFixed(1)}%  ` +
      `wrongRate ${(p.wrongRate.mean * 100).toFixed(1)}% ` +
      `[${(p.wrongRate.lo * 100).toFixed(1)}, ${(p.wrongRate.hi * 100).toFixed(1)}]  ` +
      `wrong ${p.wrong.mean.toFixed(1)}  swap ${p.swap.mean.toFixed(1)}  ` +
      `falseLabels ${p.falseLabels.mean.toFixed(1)}  idSwitches ${p.idSwitches.mean.toFixed(1)}  ` +
      `oportunidades ${p.opportunities.mean.toFixed(1)}`,
  );
  return [`${r.name} (${r.points[0]?.seeds.length ?? 0} seeds/ponto):`, ...lines].join("\n");
}

describe("FAMILY_PRECISION_VS_PEOPLE — ponta a ponta", () => {
  it("(c) eixo reduzido (people 2..4, 5 seeds) roda e produz curva coerente", () => {
    const r = runFamily(FAMILY_PRECISION_VS_PEOPLE, { axis: [2, 3, 4], seedsPerPoint: 5 });
    console.log(`\n${fmtCurve(r)}\n`);
    expect(r.name).toBe("precisao-vs-pessoas");
    expect(r.points.map((p) => p.axisValue)).toEqual([2, 3, 4]);
    for (const p of r.points) {
      expect(p.seeds).toEqual([1, 2, 3, 4, 5]);
      ciIsCoherent(p.precision);
      ciIsCoherent(p.coverage);
      ciIsCoherent(p.wrongRate);
      ciIsCoherent(p.swap);
      ciIsCoherent(p.opportunities);
      // O associador tem de FALAR alguma coisa avaliável em cada ponto (cobertura > 0) — um zero
      // aqui indicaria cenário quebrado (ex.: nenhum tick processado), não densidade alta.
      expect(p.coverage.mean).toBeGreaterThan(0);
    }
  });

  // Curva COMPLETA do §7.1 (6 pontos × 20 seeds × 240 passos) — cara demais pro CI de todo push;
  // roda sob demanda com FAMILY_FULL=1 (documentado no cabeçalho). É ela que responde a previsão
  // falseável (b) do escopo §8 (joelho vs declive linear) — a leitura é humana, sobre o log.
  it.runIf(process.env.FAMILY_FULL === "1")(
    "curva completa precisao-vs-pessoas (FAMILY_FULL=1): people 2..7, 20 seeds/ponto",
    () => {
      const r = runFamily(FAMILY_PRECISION_VS_PEOPLE);
      console.log(`\n${fmtCurve(r)}\n`);
      expect(r.points).toHaveLength(6);
      for (const p of r.points) {
        expect(p.seeds).toHaveLength(20);
        ciIsCoherent(p.precision);
        ciIsCoherent(p.wrongRate);
        ciIsCoherent(p.swap);
        ciIsCoherent(p.opportunities);
      }
    },
    120_000,
  );
});

describe("FAMILY_PRECISION_VS_NOISE — ponta a ponta", () => {
  it("(c) eixo reduzido (rssiNoiseDb 2/6/12, 5 seeds) roda e produz curva coerente", () => {
    const r = runFamily(FAMILY_PRECISION_VS_NOISE, { axis: [2, 6, 12], seedsPerPoint: 5 });
    console.log(`\n${fmtCurve(r)}\n`);
    expect(r.name).toBe("precisao-vs-ruido");
    expect(r.points.map((p) => p.axisValue)).toEqual([2, 6, 12]);
    for (const p of r.points) {
      expect(p.seeds).toEqual([1, 2, 3, 4, 5]);
      ciIsCoherent(p.precision);
      ciIsCoherent(p.coverage);
      ciIsCoherent(p.wrongRate);
      ciIsCoherent(p.swap);
      ciIsCoherent(p.opportunities);
      expect(p.coverage.mean).toBeGreaterThan(0); // ver nota no teste de pessoas
    }
  }, 30_000);

  it.runIf(process.env.FAMILY_FULL === "1")(
    "curva completa precisao-vs-ruido (FAMILY_FULL=1): rssiNoiseDb 2..12, 20 seeds/ponto",
    () => {
      const r = runFamily(FAMILY_PRECISION_VS_NOISE);
      console.log(`\n${fmtCurve(r)}\n`);
      expect(r.points).toHaveLength(6);
      for (const p of r.points) {
        expect(p.seeds).toHaveLength(20);
        ciIsCoherent(p.precision);
        ciIsCoherent(p.wrongRate);
        ciIsCoherent(p.swap);
        ciIsCoherent(p.opportunities);
      }
    },
    120_000,
  );
});

describe("FAMILY_PRECISION_VS_BODY_BIAS — ponta a ponta", () => {
  it("(c) eixo reduzido (peakDb 0/12/24, 5 seeds) roda e produz curva coerente", () => {
    const r = runFamily(FAMILY_PRECISION_VS_BODY_BIAS, { axis: [0, 12, 24], seedsPerPoint: 5 });
    console.log(`\n${fmtCurve(r)}\n`);
    expect(r.name).toBe("precisao-vs-vies-corporal");
    expect(r.points.map((p) => p.axisValue)).toEqual([0, 12, 24]);
    for (const p of r.points) {
      expect(p.seeds).toEqual([1, 2, 3, 4, 5]);
      ciIsCoherent(p.precision);
      ciIsCoherent(p.coverage);
      ciIsCoherent(p.wrongRate);
      ciIsCoherent(p.swap);
      ciIsCoherent(p.opportunities);
      expect(p.coverage.mean).toBeGreaterThan(0);
    }
  }, 30_000);

  it.runIf(process.env.FAMILY_FULL === "1")(
    "curva completa precisao-vs-vies-corporal (FAMILY_FULL=1): peakDb 0..24, 20 seeds/ponto",
    () => {
      const r = runFamily(FAMILY_PRECISION_VS_BODY_BIAS);
      console.log(`\n${fmtCurve(r)}\n`);
      expect(r.points).toHaveLength(7);
      for (const p of r.points) {
        expect(p.seeds).toHaveLength(20);
        ciIsCoherent(p.precision);
        ciIsCoherent(p.wrongRate);
        ciIsCoherent(p.swap);
        ciIsCoherent(p.opportunities);
      }
    },
    180_000,
  );
});

describe("FAMILY_PRECISION_VS_ANCHOR_ERROR — previsão falseável (c) do escopo (§8)", () => {
  // A previsão registrada ANTES do experimento (docs/cientifica/simulador.md §8): "erro de posição
  // de âncora move auditoria e anéis, NÃO a precisão de identidade — a associação por correlação
  // não consome posição de âncora. Se mover, há acoplamento escondido (bug ou suposição não
  // documentada) e a bancada terá pago por si só." Este teste RODA em CI (eixo reduzido: só os
  // extremos 0 m e 2 m) e cobra a previsão comparando os ICs de precisão dos dois extremos.
  it("(c) precisão de identidade NÃO se move com o erro de âncora (ICs de 0 m e 2 m se sobrepõem)", () => {
    const r = runFamily(FAMILY_PRECISION_VS_ANCHOR_ERROR, { axis: [0, 2], seedsPerPoint: 8 });
    console.log(`\n${fmtCurve(r)}\n`);
    expect(r.name).toBe("precisao-vs-erro-ancora");
    const [p0, pMax] = r.points;
    for (const p of r.points) {
      ciIsCoherent(p.precision);
      ciIsCoherent(p.coverage);
      ciIsCoherent(p.wrongRate);
      ciIsCoherent(p.swap);
      ciIsCoherent(p.opportunities);
      expect(p.coverage.mean).toBeGreaterThan(0);
    }
    // PODER DO TESTE — nota honesta (revisão adversarial da Fase 4, 2026-07-11): exigir
    // NÃO-sobreposição de dois IC95 é um critério muito conservador (≈ p<0,01), e com n=8 seeds
    // os ICs são largos — este sentinela só detecta acoplamento GROSSEIRO; um acoplamento
    // moderado (que desloca a média menos do que a largura dos ICs) PASSARIA despercebido.
    // O sinal forte de verdade é a decomposição de erro BIT-IDÊNTICA entre os extremos do eixo
    // (verificada na leitura humana da curva completa), não este overlap. Mantido como sentinela
    // barato de CI: "verde" ≠ prova de desacoplamento fino, "vermelho" = achado grosseiro real.
    // ICs 95% se sobrepõem ⇔ nenhuma evidência de que o erro de cadastro move a identidade.
    const overlap = p0.precision.lo <= pMax.precision.hi && pMax.precision.lo <= p0.precision.hi;
    expect(
      overlap,
      `PREVISÃO (c) DO ESCOPO VIOLADA (docs/cientifica/simulador.md §8): a precisão de identidade ` +
        `MUDOU com o erro de posição de âncora — há acoplamento escondido entre posição cadastrada ` +
        `e associação (bug ou suposição não documentada). Isto é um ACHADO da bancada, não um bug ` +
        `do teste — NÃO enfraquecer; investigar o caminho distM→associador. ` +
        `anchorPosErrorM=0: precisão ${(p0.precision.mean * 100).toFixed(1)}% ` +
        `[${(p0.precision.lo * 100).toFixed(1)}, ${(p0.precision.hi * 100).toFixed(1)}]; ` +
        `anchorPosErrorM=2: precisão ${(pMax.precision.mean * 100).toFixed(1)}% ` +
        `[${(pMax.precision.lo * 100).toFixed(1)}, ${(pMax.precision.hi * 100).toFixed(1)}].`,
    ).toBe(true);
  }, 60_000);

  it.runIf(process.env.FAMILY_FULL === "1")(
    "curva completa precisao-vs-erro-ancora (FAMILY_FULL=1): anchorPosErrorM 0..2, 20 seeds/ponto",
    () => {
      const r = runFamily(FAMILY_PRECISION_VS_ANCHOR_ERROR);
      console.log(`\n${fmtCurve(r)}\n`);
      expect(r.points).toHaveLength(5);
      for (const p of r.points) {
        expect(p.seeds).toHaveLength(20);
        ciIsCoherent(p.precision);
        ciIsCoherent(p.wrongRate);
        ciIsCoherent(p.swap);
        ciIsCoherent(p.opportunities);
      }
    },
    180_000,
  );
});
