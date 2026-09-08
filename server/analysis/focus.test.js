// Testes do FOCO do operador: cadência dedicada à câmera FOCADA (aberta em tela cheia).
//   • pickRoundMs — cálculo PURO da cadência efetiva por precedência (foco > linha > normal).
//   • focusUnion  — união PURA dos ids focados a partir do registro socketId→cameraId.
//   • setFocus/clearFocus — a UNIÃO entre sockets (add/remove por socket, disconnect limpa),
//     observada pelo contrato de status() (focused[]). Determinístico — não sobe worker/IPC.
// vitest é ESM; engine.js é CommonJS → createRequire (padrão de worker-host.test.js).
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("./engine");
const { pickRoundMs, idleRoundMs, focusUnion } = engine;

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


// ── CADENCIA OCIOSA DERIVADA (2026-09-08) ────────────────────────────────────────────────────
// POR QUE ESTE BLOCO EXISTE: a prioridade declarada (foco > linha > normal) NUNCA era entregue
// sob saturacao. MEDIDO em producao: 17 cameras / 2-3 workers = capacidade ~4 inferencias/s
// contra ~26/s de demanda declarada => toda camera nivelada em capacidade÷n, e a FOCADA
// recebendo 0,25 de 6 analises/s. Sem cadencia nao ha contagem de linha (a mesma pessoa tem de
// ser amostrada dos dois lados). Tambem MEDIDO: ordenar a fila por prioridade nao realoca nada
// (0,84 -> 0,85) — quem realoca e REDUZIR a demanda de quem nao precisa de cadencia.
describe("pickRoundMs — classe OCIOSA e a protecao da zona proibida", () => {
  const R = { focus: 167, line: 500, normal: 1000, idle: 10_000 };

  it("foco vence tudo, inclusive linha", () => {
    expect(pickRoundMs({ focused: true, hasLine: true, hasProib: true }, R)).toBe(167);
  });

  it("linha vence proibida e ociosa", () => {
    expect(pickRoundMs({ hasLine: true, hasProib: true }, R)).toBe(500);
  });

  it("zona PROIBIDA nunca cai na cadencia ociosa (cadencia ali e SEGURANCA)", () => {
    expect(pickRoundMs({ hasProib: true }, R)).toBe(1000);
  });

  it("sem linha, sem foco e sem proibida -> cadencia OCIOSA", () => {
    expect(pickRoundMs({}, R)).toBe(10_000);
  });

  it("`idle` ausente = comportamento ANTERIOR (retrocompativel)", () => {
    expect(pickRoundMs({}, { focus: 167, line: 500, normal: 1000 })).toBe(1000);
  });
});

describe("idleRoundMs — deriva da capacidade MEDIDA (nao e numero solto)", () => {
  const base = { roundMsNormal: 1000, tetoMs: 20_000 };

  it("pool SOBRANDO devolve o normal — frota pequena nao paga nada", () => {
    expect(idleRoundMs({ capacidadeFps: 10, demandaProtegidaFps: 2, nOciosas: 2, ...base })).toBe(1000);
  });

  it("o cenario REAL da frota: 14 ociosas, capacidade 4/s, protegida 10/s => teto", () => {
    expect(idleRoundMs({ capacidadeFps: 4, demandaProtegidaFps: 10, nOciosas: 14, ...base })).toBe(20_000);
  });

  it("capacidade parcial reparte a sobra entre as ociosas", () => {
    expect(idleRoundMs({ capacidadeFps: 4, demandaProtegidaFps: 2, nOciosas: 10, ...base })).toBe(5000);
  });

  it("sem ociosas ou sem medicao de capacidade, NAO mexe (degrada p/ o normal)", () => {
    expect(idleRoundMs({ capacidadeFps: 4, demandaProtegidaFps: 1, nOciosas: 0, ...base })).toBe(1000);
    expect(idleRoundMs({ capacidadeFps: 0, demandaProtegidaFps: 0, nOciosas: 14, ...base })).toBe(1000);
  });

  it("e monotona: mais ociosas na mesma capacidade nunca ACELERA a classe ociosa", () => {
    const f = (n) => idleRoundMs({ capacidadeFps: 4, demandaProtegidaFps: 2, nOciosas: n, ...base });
    for (let n = 1; n < 30; n++) expect(f(n + 1)).toBeGreaterThanOrEqual(f(n));
  });

  it("respeita o teto (nunca cala uma camera para sempre — a saude precisa ve-la)", () => {
    expect(idleRoundMs({ capacidadeFps: 0.5, demandaProtegidaFps: 10, nOciosas: 50, ...base })).toBe(20_000);
  });
});
