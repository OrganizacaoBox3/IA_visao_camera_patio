// ─────────────────────────────────────────────────────────────────────────────
// bytetrack.parity.test.ts — LADO FRONT do GOLDEN VECTOR de paridade TS↔JS.
// Espelho exato de server/analysis/bytetrack.parity.test.js: os dois leem a MESMA
// fixture (src/vision/bytetrack-parity-fixtures.json), rodam o tracker do SEU lado
// e comparam com a expectativa gravada nela.
//
// POR QUE ELE EXISTE: bytetrack.ts e server/analysis/bytetrack.js são ports 1:1
// DECLARADOS — e o cabeçalho dos dois admitia "NÃO há teste cross-language TS↔JS:
// a paridade é mantida por revisão em par, não por sensor". Era o débito nº 1 de
// manutenção do projeto: dois trackers obrigados a concordar, com zero sensor. Este
// arquivo (+ o gêmeo do hub) É o sensor. bytetrack.test.ts segue cobrindo o
// comportamento DESTE lado; aqui só se testa PARIDADE.
//
// ── O CONTRATO (o que ESTE teste garante) ────────────────────────────────────
// Sob os MESMOS opts, os dois lados emitem o MESMO resultado. Por RODADA compara-se
// o que update() EMITE — e só o que é contrato do consumidor (overlay/ocupação/
// contagem): `id`, `bbox` OBSERVADA e `stationary`, ordenados por id.
//
// A PARIDADE É DE POLÍTICA, NÃO DE NÚMERO: cada caso da fixture declara os 13 knobs
// EXPLICITAMENTE (e o teste ASSERTA isso, caso a caso). É o que separa "mesma
// política" de "mesmo número" — e o que torna este sensor capaz de distinguir
// divergência ACIDENTAL de divergência INTENCIONAL.
//
// ── O QUE **NÃO** É COMPARADO (de propósito) ─────────────────────────────────
// • DEFAULTS dos knobs. Eles DIVERGEM por decisão: stationaryEnterRounds é 3 AQUI
//   (rodada ≈ 350 ms ⇒ ~1 s de imobilidade) e 2 no hub (sob o gate, 2 probes ≈ 12 s).
//   Um default vazado para dentro de um caso viraria falso vermelho — daí a exigência
//   de opts completos. RESIDUAL DECLARADO: um default alterado por engano em UM lado
//   NÃO é pego por este sensor (nenhum caso roda com opts omitidos); é o preço de não
//   petrificar a divergência intencional. O mesmo vale p/ um knob NOVO criado só de um
//   lado — opts desconhecidos são ignorados silenciosamente pelos dois.
// • Campos DERIVADOS: cx/cy/foot (função pura do bbox) e score/firstSeen/lastSeen
//   (cópia da entrada) — comparar seria testar o mesmo fato duas vezes.
// • tracks() (snapshot INTERNO, inclui LOST ocultos) e stats() (telemetria): estado
//   interno, não contrato de emissão.
// • A ORDEM de emissão: os dois lados ordenam por id antes de comparar.
//
// ── COMO ACRESCENTAR UM CASO ─────────────────────────────────────────────────
// Edite SÓ a fixture (o driver abaixo é genérico — nenhum dos dois testes muda):
//   1. `name` + `contract` (o comportamento PROMETIDO que o caso discrimina) +
//      `opts` com os 13 knobs de `knobs`;
//   2. `rounds`: [{ t, dets, highScore? }] SEM o `expect`;
//   3. rode UM dos lados e grave o `expect` emitido;
//   4. RODE O OUTRO. Não bateu ⇒ você achou uma DIVERGÊNCIA REAL: PARE, NÃO ajuste a
//      fixture p/ o teste passar (isso petrifica o bug) — documente e leve a quem
//      entende o porquê de cada lado;
//   5. o caso tem de DISCRIMINAR: monte a geometria de modo que SÓ o mecanismo alvo
//      explique o resultado (ex.: `reassocDist: 0` isola a predição do 2º estágio).
//      Caso que passaria com o mecanismo DESLIGADO não é sensor.
// Poucos casos ROBUSTOS > muitos frágeis: um caso que quebra por mudança legítima
// destrói a confiança no sensor inteiro.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createByteTracker, type ByteTrackerOptions, type TrackerDet } from "./bytetrack";

/** Uma linha da expectativa: o que é CONTRATO de um track emitido. */
type ExpectedTrack = { id: number; bbox: [number, number, number, number]; stationary: boolean };
type Round = { t: number; highScore?: number; dets: TrackerDet[]; expect: ExpectedTrack[] };
type ParityCase = {
  name: string;
  contract: string;
  opts: Record<string, number>;
  rounds: Round[];
};
type ParityFixture = { knobs: string[]; cases: ParityCase[] };

// A MESMA fixture do hub (server/analysis/bytetrack.parity.test.js a lê por require).
const FIX: ParityFixture = JSON.parse(
  readFileSync(new URL("./bytetrack-parity-fixtures.json", import.meta.url), "utf8"),
);

// Formata a emissão de UMA rodada. Os dois lados usam o MESMO formatador: o diff da
// falha mostra a rodada inteira (não um campo solto), e o toFixed(6) tira qualquer
// fragilidade de ponto flutuante da comparação — o bbox emitido é CÓPIA da entrada
// (zero aritmética), então 6 casas é folga, não tolerância disfarçada.
function fmtRound(rows: ReadonlyArray<ExpectedTrack>): string {
  if (rows.length === 0) return "(nenhum track emitido)";
  return rows
    .map((r) => {
      const bbox = r.bbox.map((n) => n.toFixed(6)).join(", ");
      return `#${r.id}${r.stationary ? " PARADO" : ""} [${bbox}]`;
    })
    .join(" | ");
}

describe("bytetrack — GOLDEN VECTOR de paridade TS↔JS (lado FRONT)", () => {
  it("a fixture tem casos e a lista de knobs", () => {
    expect(FIX.cases.length).toBeGreaterThan(0);
    expect(FIX.knobs.length).toBeGreaterThan(0);
  });

  for (const c of FIX.cases) {
    describe(c.name, () => {
      // Sem isto o teste mediria "mesmo NÚMERO" e não "mesma POLÍTICA": um knob
      // omitido cairia no default de CADA lado — e eles divergem de propósito.
      it("declara TODOS os knobs (paridade é de política, não de default)", () => {
        expect(Object.keys(c.opts).sort()).toEqual([...FIX.knobs].sort());
      });

      it(c.contract, () => {
        const tk = createByteTracker(c.opts as ByteTrackerOptions);
        for (const r of c.rounds) {
          const emitted =
            r.highScore === undefined
              ? tk.update(r.dets, r.t)
              : tk.update(r.dets, r.t, r.highScore);
          const got: ExpectedTrack[] = emitted
            .map((t) => ({
              id: t.id,
              bbox: [...t.bbox] as [number, number, number, number],
              stationary: t.stationary,
            }))
            .sort((a, b) => a.id - b.id);
          expect(`t=${r.t} → ${fmtRound(got)}`).toBe(`t=${r.t} → ${fmtRound(r.expect)}`);
        }
      });
    });
  }
});
