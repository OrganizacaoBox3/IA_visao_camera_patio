// Testes do baseline por permutação (shuffle-baseline.ts) — a pergunta do especialista científico:
// quanto da `conflictRate` medida (identity-metrics.ts) é "aritmética do acaso" (o espaço 1-D de
// assinatura — distância radial à estação — já colide sozinho) vs. informação real dos scores?
// Roda o MESMO associador sobre uma versão com os MACs das tags embaralhados (bijeção fixa por
// tick, forma/ruído de cada série intactos) e compara a conflictRate resultante contra a real.
import { describe, expect, it } from "vitest";
import { FUSION_SCENARIOS, replayFusion } from "./replay-fusion";
import { simulateFusionScenario } from "./sim";
import { meanShuffleConflictRate, shuffledScenario } from "./shuffle-baseline";

function scenarioByName(name: string) {
  const sc = FUSION_SCENARIOS.find((s) => s.name === name);
  if (!sc) throw new Error(`cenário "${name}" não está na suíte`);
  return sc;
}

// Seeds de permutação — ≥3 pedido pelo especialista (não depender de sorte de UMA permutação só).
const SHUFFLE_SEEDS = [1, 2, 3, 4, 5];

describe("shuffledScenario — propriedades estruturais", () => {
  it("é pura: não muta o cenário original", () => {
    const { opts, seed } = scenarioByName("canonico");
    const sc = simulateFusionScenario(opts, seed);
    const macsBefore = sc.ticks.map((t) => t.readings.map((r) => r.mac));
    shuffledScenario(sc, 1);
    const macsAfter = sc.ticks.map((t) => t.readings.map((r) => r.mac));
    expect(macsAfter).toEqual(macsBefore);
  });

  it("é determinística: mesmo seed produz o mesmo cenário embaralhado", () => {
    const { opts, seed } = scenarioByName("canonico");
    const sc = simulateFusionScenario(opts, seed);
    const a = shuffledScenario(sc, 7);
    const b = shuffledScenario(sc, 7);
    expect(a).toEqual(b);
  });

  it("preserva H, stationPx e tracks; só troca o MAC das leituras", () => {
    const { opts, seed } = scenarioByName("canonico");
    const sc = simulateFusionScenario(opts, seed);
    const sh = shuffledScenario(sc, 1);
    expect(sh.H).toEqual(sc.H);
    expect(sh.stationPx).toEqual(sc.stationPx);
    expect(sh.ticks.map((t) => t.tracks)).toEqual(sc.ticks.map((t) => t.tracks));
    // rssi/ts preservados por leitura (só o mac muda)
    for (let i = 0; i < sc.ticks.length; i++) {
      expect(sh.ticks[i].readings.map((r) => r.rssi)).toEqual(
        sc.ticks[i].readings.map((r) => r.rssi),
      );
    }
  });

  it("permutação é uma bijeção FIXA: o mapa mac-original→mac-embaralhado não muda entre ticks", () => {
    const { opts, seed } = scenarioByName("canonico");
    const sc = simulateFusionScenario(opts, seed);
    const sh = shuffledScenario(sc, 3);
    // Reconstrói o mapa observado por tick (mesma ordem de leituras em cada tick do sim) e
    // verifica que é CONSISTENTE (mesma correspondência) do início ao fim.
    const seenMap = new Map<string, string>();
    for (let i = 0; i < sc.ticks.length; i++) {
      const before = sc.ticks[i].readings;
      const after = sh.ticks[i].readings;
      expect(after.length).toBe(before.length);
      for (let j = 0; j < before.length; j++) {
        const orig = before[j].mac;
        const shuf = after[j].mac;
        const prev = seenMap.get(orig);
        if (prev === undefined) seenMap.set(orig, shuf);
        else expect(shuf).toBe(prev);
      }
    }
  });

  it("com ≥2 tags, o resultado NUNCA é a identidade (perturbação anti-identidade)", () => {
    const { opts, seed } = scenarioByName("canonico"); // tagged:2 → só 2 permutações possíveis
    const sc = simulateFusionScenario(opts, seed);
    for (const s of SHUFFLE_SEEDS) {
      const sh = shuffledScenario(sc, s);
      const before = sc.ticks[0].readings.map((r) => r.mac);
      const after = sh.ticks[0].readings.map((r) => r.mac);
      expect(after).not.toEqual(before);
    }
  });

  it("âncoras (quando presentes) NÃO são permutadas — ficam de fora da troca", () => {
    const sc = simulateFusionScenario(
      { steps: 20, people: 3, tagged: 2, walk: "waypoint", anchors: true },
      42,
    );
    const sh = shuffledScenario(sc, 1);
    const anchorMacs = new Set((sc.anchors ?? []).map((a) => a.mac));
    for (let i = 0; i < sc.ticks.length; i++) {
      for (let j = 0; j < sc.ticks[i].readings.length; j++) {
        const orig = sc.ticks[i].readings[j];
        if (anchorMacs.has(orig.mac)) expect(sh.ticks[i].readings[j].mac).toBe(orig.mac);
      }
    }
  });
});

describe("shuffle-baseline da conflictRate — canônico vs multidão (predição do especialista)", () => {
  // Predição falseável do especialista: (a) em MULTIDÃO a conflictRate do shuffle fica PRÓXIMA da
  // real (conflito = sobretudo geometria do problema); no CANÔNICO a real fica VISIVELMENTE ABAIXO
  // do shuffle (os scores carregariam informação real que o shuffle destrói).
  //
  // ACHADO (relatado, não desejado — doutrina de honestidade técnica): a predição é FALSEADA nos
  // dois cenários, mas não por "o sinal é fraco" — é bit-a-bit IGUAL em ambos, sempre, para
  // qualquer seed. Não é falta de amostra: é MATEMÁTICO (ver cabeçalho de shuffle-baseline.ts).
  // `Assignment.hadConflict` (e portanto conflictRate) é calculado só a partir da matriz de
  // scores (pista×tag) via margem top-2 por LINHA e por COLUNA — nunca olha o NOME da tag nem a
  // verdade. Uma bijeção fixa de nomes é uma permutação de COLUNAS dessa matriz: os números de
  // cada célula não mudam, só o rótulo onde aparecem — e "máximo da linha", "máximo da coluna" e
  // "há conflito" são invariantes a qualquer permutação de colunas. Logo shuffleConflictRate(sc,
  // seed) === conflictRate real PARA TODO seed, por construção — o experimento, do jeito
  // especificado (só renomear identidade mantendo os scores), é estruturalmente incapaz de
  // separar "aritmética do acaso" de "informação dos scores" para ESTA métrica. Seria preciso
  // quebrar a CORRESPONDÊNCIA FÍSICA entre RSSI e trajetória (não só o nome) para um baseline que
  // de fato testasse a hipótese — fica registrado como pendência/direção futura, não implementado
  // aqui (fora do que foi pedido).
  it("mede e relata: real vs shuffle (5 seeds) em canonico e multidao — e prova a invariância", () => {
    const results: Record<string, { real: number; perSeed: number[] }> = {};
    for (const name of ["canonico", "multidao"]) {
      const { opts, seed } = scenarioByName(name);
      const sc = simulateFusionScenario(opts, seed);
      const real = replayFusion(sc).metrics.conflictRate;
      const perSeed = SHUFFLE_SEEDS.map(
        (s) => replayFusion(shuffledScenario(sc, s)).metrics.conflictRate,
      );
      results[name] = { real, perSeed };
    }

    const shuffleMean = (name: string) => {
      const r = results[name];
      return r.perSeed.reduce((a, b) => a + b, 0) / r.perSeed.length;
    };

    console.log(
      "\nshuffle-baseline da conflictRate (real vs shuffle, 5 seeds de permutação):",
    );
    for (const [name, r] of Object.entries(results)) {
      console.log(
        `  ${name.padEnd(10)} real=${(r.real * 100).toFixed(2)}%  shuffleMean=${(shuffleMean(name) * 100).toFixed(2)}%  ` +
          `perSeed=[${r.perSeed.map((x) => (x * 100).toFixed(2)).join(", ")}]  ` +
          `delta(shuffle-real)=${((shuffleMean(name) - r.real) * 100).toFixed(4)}pp`,
      );
    }
    console.log(
      "  veredito: predição (a) FALSEADA nos dois cenários — shuffle É IGUAL à real (não só " +
        "'próxima'), por invariância matemática de conflictRate a renomeação de tags (ver doc " +
        "de shuffle-baseline.ts). O experimento como especificado não separa acaso de sinal " +
        "para esta métrica.\n",
    );

    // Nunca NaN, sempre em [0,1].
    for (const r of Object.values(results)) {
      expect(Number.isNaN(r.real)).toBe(false);
      expect(r.real).toBeGreaterThanOrEqual(0);
      expect(r.real).toBeLessThanOrEqual(1);
    }

    // O ACHADO em si, como asserção: shuffle === real, EXATO, para TODO seed testado — não
    // "próximo", igual. Isso vale tanto para canonico (poucas tags) quanto multidao (muitas) —
    // contradiz a metade da predição (a) que esperava a real "visivelmente abaixo" no canônico.
    for (const name of ["canonico", "multidao"]) {
      for (const s of results[name].perSeed) expect(s).toBe(results[name].real);
    }
  });

  it("meanShuffleConflictRate (helper) bate com a média calculada manualmente", () => {
    const { opts, seed } = scenarioByName("canonico");
    const sc = simulateFusionScenario(opts, seed);
    const viaHelper = meanShuffleConflictRate(sc, SHUFFLE_SEEDS);
    const manual =
      SHUFFLE_SEEDS.map((s) => replayFusion(shuffledScenario(sc, s)).metrics.conflictRate).reduce(
        (a, b) => a + b,
        0,
      ) / SHUFFLE_SEEDS.length;
    expect(viaHelper).toBeCloseTo(manual, 10);
  });
});
