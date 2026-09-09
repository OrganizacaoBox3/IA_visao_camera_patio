// Testes da janela de CUSTO por rodada (cost.js) — o instrumento que separa "o modelo está
// caro" de "o transporte está caro". Sem essa decomposição, otimizar é chute: decode e
// inferência têm remédios opostos (tier/input/threads × resolução/tiling/sharp).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createCostWindow, percentil } = require("./cost");

const T0 = 1_000_000;

describe("percentil — nearest-rank, sem inventar valor", () => {
  it("lista vazia devolve null (não zero: 'não medi' ≠ 'custou zero')", () => {
    expect(percentil([], 50)).toBeNull();
  });

  it("p50 e p95 de uma lista conhecida", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentil(xs, 50)).toBe(50);
    expect(percentil(xs, 95)).toBe(100);
    expect(percentil(xs, 10)).toBe(10);
  });

  it("um único valor é o seu próprio percentil", () => {
    expect(percentil([42], 50)).toBe(42);
    expect(percentil([42], 95)).toBe(42);
  });
});

describe("createCostWindow", () => {
  it("sem amostra devolve n=0 e nulos — nunca 0ms falso", () => {
    const w = createCostWindow();
    expect(w.resumo(T0)).toEqual({ n: 0, decodeMs: null, inferMs: null, totalMs: null, rodadasPorS: 0 });
  });

  it("separa decode de inferência e soma o total", () => {
    const w = createCostWindow();
    w.observe(T0, 100, 700);
    w.observe(T0 + 1000, 120, 900);
    const r = w.resumo(T0 + 1000);
    expect(r.n).toBe(2);
    expect(r.decodeMs.p50).toBe(100);
    expect(r.inferMs.p50).toBe(700);
    expect(r.totalMs.p50).toBe(800);
    expect(r.totalMs.p95).toBe(1020);
  });

  // Propriedade do percentil que importa ao LER o relatório: um evento raro isolado fica ACIMA
  // do p95 (nearest-rank) e NÃO aparece nele — o p95 mede a cauda RECORRENTE, que é a que
  // dimensiona a capacidade. Ler "p95 baixo" como "não há rodada lenta" seria o erro.
  it("um outlier ISOLADO não move o p95 (ele mede cauda recorrente, não acidente)", () => {
    const w = createCostWindow();
    for (let i = 0; i < 19; i++) w.observe(T0 + i * 100, 50, 500);
    w.observe(T0 + 1900, 50, 3000); // 1 em 20 = acima do p95
    const r = w.resumo(T0 + 1900);
    expect(r.inferMs.p50).toBe(500);
    expect(r.inferMs.p95).toBe(500);
  });

  it("cauda RECORRENTE (≥5% da janela) aparece no p95 — é ela que enche a fila do worker", () => {
    const w = createCostWindow();
    for (let i = 0; i < 18; i++) w.observe(T0 + i * 100, 50, 500);
    w.observe(T0 + 1800, 50, 3000);
    w.observe(T0 + 1900, 50, 3000); // 2 em 20 = 10% → o p95 pega
    const r = w.resumo(T0 + 1900);
    expect(r.inferMs.p50).toBe(500); // o típico não se move
    expect(r.inferMs.p95).toBe(3000); // a cauda aparece
  });

  it("poda por TEMPO: amostra velha sai da janela", () => {
    const w = createCostWindow({ janelaMs: 10_000 });
    w.observe(T0, 999, 999);
    w.observe(T0 + 5000, 10, 20);
    expect(w.resumo(T0 + 5000).n).toBe(2);
    // 11s depois da primeira → só a segunda sobrevive
    expect(w.resumo(T0 + 11_000).n).toBe(1);
    expect(w.resumo(T0 + 11_000).inferMs.p50).toBe(20);
  });

  it("rodadasPorS deriva da janela (é a vazão medida, não o alvo configurado)", () => {
    const w = createCostWindow({ janelaMs: 60_000 });
    for (let i = 0; i < 30; i++) w.observe(T0 + i * 1000, 10, 10);
    expect(w.resumo(T0 + 29_000).rodadasPorS).toBe(0.5); // 30 rodadas / 60s
  });

  it("valores ausentes/negativos não quebram nem poluem (entram como 0)", () => {
    const w = createCostWindow();
    w.observe(T0, undefined, null);
    w.observe(T0 + 10, -5, NaN);
    const r = w.resumo(T0 + 10);
    expect(r.n).toBe(2);
    expect(r.totalMs.p50).toBe(0);
  });

  it("reset esvazia (usado no respawn do worker — custo do processo morto não conta)", () => {
    const w = createCostWindow();
    w.observe(T0, 100, 100);
    w.reset();
    expect(w.resumo(T0).n).toBe(0);
  });
});

describe("amostras — base do agregado da frota", () => {
  it("devolve as amostras podadas, para reordenar JUNTAS (percentil não é aditivo)", () => {
    const a = createCostWindow();
    const b = createCostWindow();
    a.observe(T0, 10, 100);
    b.observe(T0, 20, 900);
    const junto = createCostWindow();
    for (const w of [a, b]) for (const s of w.amostras(T0)) junto.observe(s.t, s.decodeMs, s.inferMs);
    const r = junto.resumo(T0);
    expect(r.n).toBe(2);
    expect(r.inferMs.p95).toBe(900); // a cauda de UM worker aparece no agregado
  });

  it("é cópia: mutar o retorno não corrompe a janela", () => {
    const w = createCostWindow();
    w.observe(T0, 10, 20);
    const s = w.amostras(T0);
    s[0].inferMs = 99999;
    expect(w.resumo(T0).inferMs.p50).toBe(20);
  });

  it("poda antes de devolver (não vaza amostra fora da janela)", () => {
    const w = createCostWindow({ janelaMs: 5000 });
    w.observe(T0, 1, 1);
    expect(w.amostras(T0 + 6000)).toHaveLength(0);
  });
});
