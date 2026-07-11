// Testes da infraestrutura de famílias paramétricas (families.ts — Fase 3 da bancada,
// docs/cientifica/simulador.md §7.1/§8). Três garantias:
// (a) determinismo bit-a-bit: mesma família + mesmos seeds ⇒ resultado idêntico;
// (b) o bootstrap devolve IC coerente (lo ≤ média ≤ hi) — nunca NaN;
// (c) a família concreta FAMILY_PRECISION_VS_PEOPLE roda ponta-a-ponta.
// No CI, (c) roda com eixo REDUZIDO (people 2..4) e 5 seeds pra não estourar o tempo; a curva
// COMPLETA (§7.1: 6 pontos × 20 seeds) fica atrás da env var FAMILY_FULL=1:
//   FAMILY_FULL=1 npx vitest run src/fusion/families.test.ts
// Curvas novas NÃO nascem pinadas ("ganham pinos próprios quando estabilizarem", §7.1) — aqui só
// sanidade estrutural + log da curva pra diagnóstico humano (console.log em teste é praxe da casa).
import { describe, expect, it } from "vitest";
import { bootstrapCi, runFamily, FAMILY_PRECISION_VS_PEOPLE } from "./families";
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
      // Taxas vivem em [0,1]; contadores da decomposição nunca negativos.
      expect(p.precision.lo).toBeGreaterThanOrEqual(0);
      expect(p.precision.hi).toBeLessThanOrEqual(1);
      expect(p.coverage.lo).toBeGreaterThanOrEqual(0);
      expect(p.coverage.hi).toBeLessThanOrEqual(1);
      expect(p.wrong.lo).toBeGreaterThanOrEqual(0);
      expect(p.falseLabels.lo).toBeGreaterThanOrEqual(0);
      expect(p.idSwitches.lo).toBeGreaterThanOrEqual(0);
    }
  });
});

/** Curva em texto pra diagnóstico humano (o log é o instrumento, não console.log de produção). */
function fmtCurve(r: ReturnType<typeof runFamily>): string {
  const lines = r.points.map(
    (p) =>
      `  ${r.axisName}=${p.axisValue}: precisão ${(p.precision.mean * 100).toFixed(1)}% ` +
      `[${(p.precision.lo * 100).toFixed(1)}, ${(p.precision.hi * 100).toFixed(1)}]  ` +
      `cobertura ${(p.coverage.mean * 100).toFixed(1)}%  ` +
      `wrong ${p.wrong.mean.toFixed(1)}  falseLabels ${p.falseLabels.mean.toFixed(1)}  ` +
      `idSwitches ${p.idSwitches.mean.toFixed(1)}`,
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
      // O associador tem de FALAR alguma coisa avaliável em cada ponto (cobertura > 0) — um zero
      // aqui indicaria cenário quebrado (ex.: nenhum tick processado), não densidade alta.
      expect(p.coverage.mean).toBeGreaterThan(0);
    }
  });

  // Curva COMPLETA do §7.1 (6 pontos × 20 seeds × 240 passos) — cara demais pro CI de todo push;
  // roda sob demanda com FAMILY_FULL=1 (documentado no cabeçalho). É ela que responde a previsão
  // falseável (b) do escopo §8 (joelho vs declive linear) — a leitura é humana, sobre o log.
  it.runIf(process.env.FAMILY_FULL === "1")(
    "curva completa (FAMILY_FULL=1): people 2..7, 20 seeds/ponto",
    () => {
      const r = runFamily(FAMILY_PRECISION_VS_PEOPLE);
      console.log(`\n${fmtCurve(r)}\n`);
      expect(r.points).toHaveLength(6);
      for (const p of r.points) {
        expect(p.seeds).toHaveLength(20);
        ciIsCoherent(p.precision);
      }
    },
    120_000,
  );
});
