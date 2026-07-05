// Testes da onda Flow-Focus: cadência dedicada à câmera FOCADA (aberta em tela cheia).
//   • pickRoundMs — cálculo PURO da cadência efetiva por precedência (foco > linha > normal).
//   • focusUnion  — união PURA dos ids focados a partir do registro socketId→cameraId.
//   • setFocus/clearFocus — a UNIÃO entre sockets (add/remove por socket, disconnect limpa),
//     observada pelo contrato de status() (focused[]). Determinístico — não sobe worker/IPC.
// vitest é ESM; engine.js é CommonJS → createRequire (padrão de worker-host.test.js).
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("./engine");
const { pickRoundMs, focusUnion } = engine;

// round-ms sintéticos (não dependem dos env do módulo) p/ os testes puros.
const ROUNDS = { normal: 1000, line: 500, focus: 167 };

describe("pickRoundMs — cadência efetiva por PRECEDÊNCIA (foco > linha > normal)", () => {
  it("sem foco e sem linha → cadência normal", () => {
    expect(pickRoundMs({ focused: false, hasLine: false }, ROUNDS)).toBe(1000);
  });

  it("com linha (sem foco) → cadência de linha", () => {
    expect(pickRoundMs({ focused: false, hasLine: true }, ROUNDS)).toBe(500);
  });

  it("focada (sem linha) → cadência de FOCO", () => {
    expect(pickRoundMs({ focused: true, hasLine: false }, ROUNDS)).toBe(167);
  });

  it("focada COM linha → FOCO tem precedência sobre a linha", () => {
    expect(pickRoundMs({ focused: true, hasLine: true }, ROUNDS)).toBe(167);
  });
});

describe("focusUnion — união dos ids focados entre sockets", () => {
  it("agrega ids distintos e deduplica ids iguais entre sockets", () => {
    const reg = new Map([
      ["sA", "cam1"],
      ["sB", "cam1"], // mesmo alvo → 1 só na união
      ["sC", "cam2"],
    ]);
    expect([...focusUnion(reg)].sort()).toEqual(["cam1", "cam2"]);
  });

  it("ignora sockets sem foco (id null/vazio)", () => {
    const reg = new Map([
      ["sA", null],
      ["sB", ""],
      ["sC", "cam9"],
    ]);
    expect([...focusUnion(reg)]).toEqual(["cam9"]);
  });

  it("registro vazio → união vazia", () => {
    expect(focusUnion(new Map()).size).toBe(0);
  });

  it("normaliza cameraId p/ string", () => {
    expect([...focusUnion(new Map([["sA", 42]]))]).toEqual(["42"]);
  });
});

describe("setFocus/clearFocus — união POR SOCKET + disconnect limpa (via status().focused)", () => {
  const focused = () => new Set(engine.status().focused);
  // Ids de socket próprios deste bloco; limpa-os ao fim p/ não vazar no singleton do engine.
  const SOCKS = ["t_sockA", "t_sockB", "t_sockC"];
  afterEach(() => {
    for (const s of SOCKS) engine.clearFocus(s);
  });

  it("focar registra a câmera na união", () => {
    engine.setFocus("t_sockA", "camX");
    expect(focused().has("camX")).toBe(true);
  });

  it("dois sockets na MESMA câmera → 1 entrada; um libera, a câmera segue focada pelo outro", () => {
    engine.setFocus("t_sockA", "camY");
    engine.setFocus("t_sockB", "camY");
    expect([...focused()].filter((c) => c === "camY")).toEqual(["camY"]); // sem duplicar
    engine.setFocus("t_sockA", null); // A libera; B ainda olha camY
    expect(focused().has("camY")).toBe(true);
    engine.setFocus("t_sockB", null); // B libera → camY sai
    expect(focused().has("camY")).toBe(false);
  });

  it("sockets em câmeras distintas → união com ambas", () => {
    engine.setFocus("t_sockA", "cam1");
    engine.setFocus("t_sockB", "cam2");
    const u = focused();
    expect(u.has("cam1")).toBe(true);
    expect(u.has("cam2")).toBe(true);
  });

  it("trocar de câmera no mesmo socket move o foco (não acumula)", () => {
    engine.setFocus("t_sockC", "camOld");
    engine.setFocus("t_sockC", "camNew");
    const u = focused();
    expect(u.has("camNew")).toBe(true);
    expect(u.has("camOld")).toBe(false);
  });

  it("clearFocus (disconnect) remove a contribuição daquele socket", () => {
    engine.setFocus("t_sockA", "camZ");
    expect(focused().has("camZ")).toBe(true);
    engine.clearFocus("t_sockA"); // socket desconectou
    expect(focused().has("camZ")).toBe(false);
  });

  it("clearFocus de socket sem foco é no-op (não quebra a união existente)", () => {
    engine.setFocus("t_sockB", "camK");
    engine.clearFocus("t_sockA"); // nunca focou nada
    expect(focused().has("camK")).toBe(true);
  });
});
