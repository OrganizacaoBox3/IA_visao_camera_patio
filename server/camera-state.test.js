// Estado operacional da câmera — a MIGRAÇÃO é o que este arquivo protege.
//
// O cadastro em disco (cameras.json) é de produção e nunca foi versionado: ele tem registros
// escritos ANTES de o campo `estado` existir, com apenas `enabled: true|false`. Ler esses
// registros errado tem consequência assimétrica e feia: um `enabled:true` lido como
// "desativada" silenciaria em massa câmeras que estão vigiando de verdade — e o silêncio não
// deixa rastro na tela, só a ausência do alarme que era para ter chegado.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  ESTADOS,
  ESTADO_LABEL,
  ESTADO_NOTA,
  estadoDe,
  deveriaEstarVendo,
  podeNotificar,
  contaParaCobertura,
} = require("./camera-state");

describe("estadoDe — migração do `enabled` legado", () => {
  it("registro ANTIGO sem estado: enabled:true → produção, false → desativada", () => {
    expect(estadoDe({ enabled: true })).toBe("producao");
    expect(estadoDe({ enabled: false })).toBe("desativada");
  });

  it("registro antigo SEM `enabled` nenhum é produção (é o que o create sempre fez)", () => {
    expect(estadoDe({ id: "cam-1", url: "rtsp://x" })).toBe("producao");
  });

  it("`estado` explícito vence o `enabled` (durante a convivência dos dois campos)", () => {
    expect(estadoDe({ estado: "manutencao", enabled: true })).toBe("manutencao");
    expect(estadoDe({ estado: "producao", enabled: false })).toBe("producao");
  });

  it("estado inválido/corrompido cai em PRODUÇÃO — na dúvida, o alarme sai", () => {
    expect(estadoDe({ estado: "ligada" })).toBe("producao");
    expect(estadoDe({ estado: "" })).toBe("producao");
    expect(estadoDe({ estado: 7 })).toBe("producao");
    expect(estadoDe(null)).toBe("producao");
    expect(estadoDe(undefined)).toBe("producao");
  });
});

describe("as três perguntas que o estado responde", () => {
  it("quem DEVERIA estar vendo: todas menos a desativada", () => {
    expect(deveriaEstarVendo({ estado: "producao" })).toBe(true);
    expect(deveriaEstarVendo({ estado: "teste" })).toBe(true);
    expect(deveriaEstarVendo({ estado: "manutencao" })).toBe(true);
    expect(deveriaEstarVendo({ estado: "desativada" })).toBe(false);
  });

  it("quem pode NOTIFICAR: só produção", () => {
    expect(podeNotificar({ estado: "producao" })).toBe(true);
    for (const estado of ["teste", "manutencao", "desativada"])
      expect(podeNotificar({ estado })).toBe(false);
  });

  it("quem conta para COBERTURA: a desativada não — não é 'não medimos', é 'não era p/ medir'", () => {
    expect(contaParaCobertura({ estado: "manutencao" })).toBe(true); // era p/ medir, e falhou
    expect(contaParaCobertura({ estado: "desativada" })).toBe(false);
  });
});

describe("vocabulário completo (a UI nunca fica sem texto para exibir)", () => {
  it("todo estado tem rótulo e uma nota que explica a CONSEQUÊNCIA", () => {
    for (const e of ESTADOS) {
      expect(ESTADO_LABEL[e]).toBeTruthy();
      expect(ESTADO_NOTA[e].length).toBeGreaterThan(30);
    }
  });

  it("são exatamente quatro — crescer a lista é decisão de produto, não refactor", () => {
    expect(ESTADOS).toEqual(["producao", "teste", "manutencao", "desativada"]);
  });
});
