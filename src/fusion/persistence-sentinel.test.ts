import { describe, expect, it } from "vitest";
import {
  buildConfirmationSentinel,
  buildMemoriaSentinel,
  replayWithMemory,
} from "./persistence-sentinel";
import type { SimOpts } from "./sim";

// "cruzamento": duas pessoas em vaivém oposto que se cruzam periodicamente — o cenário certo pra
// achar um instante fisicamente próximo (a condição "sem salto" da Mordida 2). seed=1 é
// DETERMINÍSTICO e explorado manualmente (ver commit): confirmationSentinel injeta no tick 6,
// memoriaSentinel (sustain=4) injeta no tick 76 — números fixos, não mágicos: vêm da física do
// cenário, reproduzíveis por qualquer um rodando os mesmos parâmetros.
const OPTS: SimOpts = { steps: 240, people: 2, tagged: 2, walk: "cruzamento" };
const SEED = 1;

describe("persistence-sentinel — sentinela 1 (id-switch na confirmação)", () => {
  it("injeta a troca no instante certo (determinístico, seed fixo)", () => {
    const r = buildConfirmationSentinel(OPTS, SEED, 0, 1);
    expect(r).not.toBeNull();
    expect(r!.injectedAtTick).toBe(6);
    expect([r!.tagA, r!.tagB].sort()).toEqual(["AA:AA", "BB:BB"]);
  });

  it("MORDIDA 2 comprovada: a crença CONFIRMA e persiste ERRADA vários ticks depois da troca silenciosa", () => {
    const r = buildConfirmationSentinel(OPTS, SEED, 0, 1)!;
    const rows = replayWithMemory(r.scenario);
    // A troca acontece a MEIO da janela de 3 ticks que confirma o track 0 — a crença nasce JÁ
    // errada: confirma tagA (tick injectedAtTick+1, achado da exploração) enquanto a verdade do
    // track 0 já é tagB desde o próprio tick da injeção. Não é ruído: é o pior caso descrito na
    // Mordida 2 acontecendo de fato — a evidência que confirma vem majoritariamente de ANTES da
    // troca, então a crença "nasce" apontando pra pessoa errada.
    expect(r.scenario.ticks[r.injectedAtTick].truthTagByTrack[0]).toBe(r.tagB);
    const justConfirmed = rows.find((row) => row.tickIndex === r.injectedAtTick + 1)!;
    const bornWrong = justConfirmed.beliefs.find((b) => b.trackId === 0);
    expect(bornWrong?.state).toBe("confirmada");
    expect(bornWrong?.label).toBe(r.tagA); // confirma o rótulo ERRADO — a verdade real é r.tagB

    // Vários ticks depois (ainda dentro da janela em que o track 0 segue vivo), a crença SEGUE
    // errada — não é um blip de 1 tick, é persistência de verdade (o ponto central da Mordida 2).
    const stillWrong = rows.find((row) => row.tickIndex === r.injectedAtTick + 4)!;
    const b = stillWrong.beliefs.find((x) => x.trackId === 0);
    expect(b?.label).toBe(r.tagA); // errado — verdade real é r.tagB
    expect(r.scenario.ticks[stillWrong.tickIndex].truthTagByTrack[0]).toBe(r.tagB);
  });
});

describe("persistence-sentinel — sentinela 2 (id-switch durante a memória, o pior caso)", () => {
  it("injeta a troca só depois de sustentar memória por N ticks (determinístico, seed fixo)", () => {
    const r = buildMemoriaSentinel(OPTS, SEED, 0, 1, 4);
    expect(r).not.toBeNull();
    expect(r!.injectedAtTick).toBe(76);
  });

  it("MORDIDA 2 (pior caso): crença persiste errada por MAIS TEMPO que a sentinela de confirmação", () => {
    const r = buildMemoriaSentinel(OPTS, SEED, 0, 1, 4)!;
    const rows = replayWithMemory(r.scenario);
    expect(r.scenario.ticks[r.injectedAtTick].truthTagByTrack[0]).toBe(r.tagB);

    // 10 ticks depois (5s) — bem além do que a sentinela de confirmação sustentou errado — a
    // crença AINDA diz o rótulo velho. Achado da exploração: aqui a correção só chega no tick 95
    // (19 ticks/9,5s depois da injeção em 76) — bem mais devagar que a sentinela 1.
    const stillWrongLater = rows.find((row) => row.tickIndex === r.injectedAtTick + 10)!;
    const b = stillWrongLater.beliefs.find((x) => x.trackId === 0);
    expect(b?.label).toBe(r.tagA); // errado — verdade real é r.tagB
  });
});

describe("persistence-sentinel — condições de falha honestas (não força instante ruim)", () => {
  it("devolve null quando personA/personB estão fora do range de tags (sem verdade pra medir)", () => {
    expect(buildConfirmationSentinel(OPTS, SEED, 0, 5)).toBeNull();
    expect(buildMemoriaSentinel(OPTS, SEED, 0, 5, 4)).toBeNull();
  });

  it("devolve null sem H calibrada (sem posição-mundo, sem como medir proximidade)", () => {
    const uncalibrated: SimOpts = { ...OPTS, uncalibrated: true };
    expect(buildConfirmationSentinel(uncalibrated, SEED, 0, 1)).toBeNull();
  });
});
