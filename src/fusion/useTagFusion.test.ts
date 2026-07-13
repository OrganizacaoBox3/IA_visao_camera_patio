// A REGRA DE PROMOÇÃO do motor multi-fonte, no call-site vivo (fusionConfigFor).
//
// ESTADO DE HOJE (2026-07-13): o torneio `eval/multi-antena.mjs` rodou com régua PINADA A PRIORI e
// disse NÃO PROMOVER — na cadência REAL da tag (~2,5 s), ligar a 2ª antena via soma de Fisher
// PIORA a precisão (51,7% da melhor antena sozinha → 47,1%). Rótulo errado é pior que rótulo
// nenhum ⇒ fica DESLIGADO. Ver o veredito completo (e os 2 regimes) no docstring de
// MULTI_SOURCE_FISHER_PROMOVIDO (useTagFusion.ts).
//
// O teste sela as DUAS faces: (a) hoje a config sai VAZIA sempre — o campo não muda nem um bit;
// (b) a forma da config PROMOVIDA já está exercitada, para o dia em que o torneio passar não
// depender de alguém lembrar de escrever o teste.
import { describe, expect, it } from "vitest";
import { fusionConfigFor } from "./useTagFusion";

const DUAS = { "est-a": { x: 0, y: 1 }, "est-b": { x: 1, y: 1 } };

describe("fusionConfigFor — HOJE: multi-fonte NÃO PROMOVIDA (veredito do torneio)", () => {
  it("config VAZIA em qualquer geometria → DEFAULTS puros, caminho bit-a-bit o de hoje", () => {
    expect(fusionConfigFor(undefined)).toEqual({});
    expect(fusionConfigFor({})).toEqual({});
    expect(fusionConfigFor({ "est-a": { x: 0.5, y: 1 } })).toEqual({});
    expect(fusionConfigFor(DUAS)).toEqual({}); // 2 estações e AINDA ASSIM desligado — é o veredito
  });
});

describe("fusionConfigFor — a forma da config PROMOVIDA (o dia em que o torneio passar)", () => {
  it("≥2 estações calibradas → multiSourceFisher LIGADO (partitionBySource antes do align)", () => {
    expect(fusionConfigFor(DUAS, true)).toEqual({ multiSourceFisher: true });
    expect(fusionConfigFor({ ...DUAS, c: { x: 0.5, y: 0.5 } }, true)).toEqual({
      multiSourceFisher: true,
    });
  });

  it("0 ou 1 estação → segue vazia MESMO promovida (1 fonte não tem o que combinar)", () => {
    expect(fusionConfigFor(undefined, true)).toEqual({});
    expect(fusionConfigFor({}, true)).toEqual({});
    expect(fusionConfigFor({ "est-a": { x: 0.5, y: 1 } }, true)).toEqual({});
  });
});
