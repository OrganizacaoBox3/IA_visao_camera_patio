// TORNEIO de recalibração dos gates (2026-07-11 — prescrição do especialista científico; ver
// cabeçalho de associate.ts): roda o harness DE PRODUÇÃO (runFusionBenchmark, 12 cenários) com
// as combinações de knobs de PESQUISA e IMPRIME a tabela comparativa. O teste NÃO afirma
// vencedor — a promoção de default é decisão humana POSTERIOR, com os pinos re-derivados
// conscientemente (o rito da casa: evidência primeiro, default depois). As asserções são só as
// INVARIANTES DURAS:
//  - `parado` NUNCA fala (correct+wrong = 0) em TODAS as configs — a invariante do dono
//    (rótulo errado é pior que rótulo nenhum; gente parada é fisicamente ambígua);
//  - config A (defaults) é BYTE-IDÊNTICA com os knobs explicitamente OFF (aditividade — os 12
//    pinos de replay-fusion.test.ts seguem sendo o gate da config A, intocados).
// GATING: o torneio completo são 7×runFusionBenchmark (~5 s a frio, mas esta suíte já estourou
// timeout sob contenção de CPU — ver nota em replay-fusion.test.ts); roda inteiro só com
// GATES_FULL=1. No CI roda o subset rápido (A byte-compat + 2 configs ON) com as mesmas
// invariantes.
import { describe, expect, it } from "vitest";
import type { FusionConfig } from "./associate";
import type { IdentityMetrics } from "./identity-metrics";
import { formatIdentityTable } from "./identity-metrics";
import { runFusionBenchmark } from "./replay-fusion";

type Rows = { scenario: string; m: IdentityMetrics }[];

const GATES_FULL = process.env.GATES_FULL === "1";

// ρ=0,7: autocorrelação medida na mineração (0,49–0,94@2s, inter-arrival ~2,06 s) — o valor da
// prescrição. minNeff 5: o piso "~5-6" prescrito. zCrit 1,96 (5%) e 1,645 (10%) bicaudais.
const SIG_196 = { zCrit: 1.96, rho: 0.7, minNeff: 5 };
const SIG_164 = { zCrit: 1.645, rho: 0.7, minNeff: 5 };

/** As combinações prescritas: A=vigente, B=variável log, C=B+gate adimensional (3 limiares),
 *  D=C(0,15)+teste de significância (2 zCrit). */
const TOURNAMENT: { name: string; cfg?: FusionConfig }[] = [
  { name: "A defaults" },
  { name: "B log", cfg: { useLogDistance: true } },
  { name: "C log+dec0.12", cfg: { useLogDistance: true, minMovementDecades: 0.12 } },
  { name: "C log+dec0.15", cfg: { useLogDistance: true, minMovementDecades: 0.15 } },
  { name: "C log+dec0.18", cfg: { useLogDistance: true, minMovementDecades: 0.18 } },
  {
    name: "D C15+sig z1.96",
    cfg: { useLogDistance: true, minMovementDecades: 0.15, significanceGate: SIG_196 },
  },
  {
    name: "D C15+sig z1.645",
    cfg: { useLogDistance: true, minMovementDecades: 0.15, significanceGate: SIG_164 },
  },
];

function metricsOf(rows: Rows, scenario: string): IdentityMetrics {
  const row = rows.find((r) => r.scenario === scenario);
  if (!row) throw new Error(`cenário "${scenario}" não está na suíte`);
  return row.m;
}

/** A invariante do dono, POR CONFIG: gente parada é fisicamente ambígua — falar é chutar. */
function expectParadoMute(rows: Rows, name: string): void {
  const m = metricsOf(rows, "parado");
  expect(m.correct + m.wrong, `${name}: parado FALOU (invariante violada)`).toBe(0);
  expect(m.falseLabels, `${name}: parado rotulou quem não tinha tag`).toBe(0);
}

/** Uma linha da tabela do torneio: agregados da suíte + os cenários-sentinela pedidos. */
function summarize(name: string, rows: Rows): string[] {
  const precMean = rows.reduce((s, r) => s + r.m.precision, 0) / rows.length;
  const correct = rows.reduce((s, r) => s + r.m.correct, 0);
  const wrong = rows.reduce((s, r) => s + r.m.wrong, 0);
  const parado = metricsOf(rows, "parado");
  const bloco = metricsOf(rows, "bloco");
  const mult = metricsOf(rows, "multidao");
  const pc = (m: IdentityMetrics) =>
    `${(m.precision * 100).toFixed(1)}/${(m.coverage * 100).toFixed(1)}`;
  return [
    name,
    (precMean * 100).toFixed(1),
    String(correct),
    String(wrong),
    String(parado.correct + parado.wrong),
    pc(bloco),
    pc(mult),
  ];
}

const HEADER = [
  "config",
  "prec̄ %",
  "correct",
  "wrong",
  "parado-falas",
  "bloco p/c %",
  "multidão p/c %",
];

function printTable(lines: string[][]): void {
  const all = [HEADER, ...lines];
  const widths = HEADER.map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(
    `\ntorneio de recalibração dos gates (${lines.length} configs × 12 cenários):\n` +
      `${fmt(HEADER)}\n${fmt(widths.map((w) => "-".repeat(w)))}\n` +
      lines.map(fmt).join("\n") +
      "\n(sem vencedor declarado — promoção é rodada humana posterior, re-pinando consciente)\n",
  );
}

describe("gates-recalibration — torneio no harness (knobs de PESQUISA, ver associate.ts)", () => {
  it(
    "aditividade dura: knobs explicitamente OFF = byte-idêntico ao default (os 12 pinos são a config A)",
    () => {
      // toEqual sobre TODAS as métricas de TODOS os cenários — qualquer desvio dos knobs em OFF
      // quebraria também os pinos de replay-fusion.test.ts; aqui o erro aparece com nome certo.
      expect(runFusionBenchmark({ useLogDistance: false, minMovementDecades: 0 })).toEqual(
        runFusionBenchmark(),
      );
    },
    60000,
  );

  it(
    "subset rápido (CI): invariante do parado nas configs de ponta (B e D z1.96) + tabela parcial",
    () => {
      const subset = [TOURNAMENT[0], TOURNAMENT[1], TOURNAMENT[5]]; // A, B, D z1.96
      const lines: string[][] = [];
      for (const { name, cfg } of subset) {
        const rows = runFusionBenchmark(cfg);
        expectParadoMute(rows, name);
        lines.push(summarize(name, rows));
      }
      printTable(lines);
    },
    120000,
  );

  it.runIf(GATES_FULL)(
    "TORNEIO COMPLETO (GATES_FULL=1): tabela das 7 configs + invariante do parado em todas",
    () => {
      const lines: string[][] = [];
      for (const { name, cfg } of TOURNAMENT) {
        const rows = runFusionBenchmark(cfg);
        expectParadoMute(rows, name); // a ÚNICA asserção de mérito: a invariante dura
        lines.push(summarize(name, rows));
        // Detalhe por cenário (diagnóstico humano — só no modo completo, é verboso de propósito).
        console.log(`\n[${name}]\n${formatIdentityTable(rows)}`);
      }
      printTable(lines);
    },
    300000,
  );
});
