// A REGRA DE PROMOÇÃO do motor multi-fonte, no call-site vivo (fusionConfigFor).
//
// ESTADO DE HOJE (2026-07-13): o torneio `eval/multi-antena.mjs` rodou com régua PINADA A PRIORI e
// disse NÃO PROMOVER — na cadência REAL da tag (~2,5 s), ligar a 2ª antena via soma de Fisher
// PIORA a precisão (51,7% da melhor antena sozinha → 47,1%). Rótulo errado é pior que rótulo
// nenhum ⇒ fica DESLIGADO. Ver o veredito completo (e os 2 regimes) no docstring de
// MULTI_SOURCE_FISHER_PROMOVIDO (useTagFusion.ts).
//
// O teste sela as faces: (a) a config viva SEMPRE carrega windowMs: 18000 (a janela que o dono
// ligou em 2026-07-14 — LIVE_WINDOW_MS; os pinos de replay-fusion.test.ts seguem em 8 s no DEFAULTS);
// (b) o multiSourceFisher segue DESLIGADO (veredito do torneio); (c) a forma PROMOVIDA já está
// exercitada, para o dia em que o torneio passar não depender de alguém lembrar de escrever o teste.
import { describe, expect, it } from "vitest";
import { fusionConfigFor, LIVE_WINDOW_MS } from "./useTagFusion";

const DUAS = { "est-a": { x: 0, y: 1 }, "est-b": { x: 1, y: 1 } };

describe("fusionConfigFor — janela viva de 18 s + multi-fonte NÃO PROMOVIDA (veredito do torneio)", () => {
  it("a janela viva (18 s) vai SEMPRE na config, em qualquer geometria; multiSourceFisher desligado", () => {
    expect(LIVE_WINDOW_MS).toBe(18000);
    expect(fusionConfigFor(undefined)).toEqual({ windowMs: LIVE_WINDOW_MS });
    expect(fusionConfigFor({})).toEqual({ windowMs: LIVE_WINDOW_MS });
    expect(fusionConfigFor({ "est-a": { x: 0.5, y: 1 } })).toEqual({ windowMs: LIVE_WINDOW_MS });
    // 2 estações e AINDA ASSIM multi-fonte desligado — é o veredito (só a janela muda).
    expect(fusionConfigFor(DUAS)).toEqual({ windowMs: LIVE_WINDOW_MS });
  });
});

describe("fusionConfigFor — a forma da config PROMOVIDA (o dia em que o torneio passar)", () => {
  it("≥2 estações calibradas → multiSourceFisher LIGADO junto da janela viva", () => {
    expect(fusionConfigFor(DUAS, true)).toEqual({
      windowMs: LIVE_WINDOW_MS,
      multiSourceFisher: true,
    });
    expect(fusionConfigFor({ ...DUAS, c: { x: 0.5, y: 0.5 } }, true)).toEqual({
      windowMs: LIVE_WINDOW_MS,
      multiSourceFisher: true,
    });
  });

  it("0 ou 1 estação → só a janela viva MESMO promovida (1 fonte não tem o que combinar)", () => {
    expect(fusionConfigFor(undefined, true)).toEqual({ windowMs: LIVE_WINDOW_MS });
    expect(fusionConfigFor({}, true)).toEqual({ windowMs: LIVE_WINDOW_MS });
    expect(fusionConfigFor({ "est-a": { x: 0.5, y: 1 } }, true)).toEqual({
      windowMs: LIVE_WINDOW_MS,
    });
  });
});
