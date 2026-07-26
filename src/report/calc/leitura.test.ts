// AMOSTRA ZERO NUNCA VIRA 100% (auditoria 2026-07-26, A2 — `ratePct: passages ? … : 100`).
// Este arquivo existe por causa de um número errado que foi PARA A TELA: um período sem nenhuma
// passagem renderizava "Taxa de leitura de 100% — excelente cobertura". Regressão vira teste.
import { describe, it, expect } from "vitest";
import {
  readingKpis,
  readingRanking,
  readingInsights,
  type ReadingCell,
  type ReadingKpis,
} from "./leitura";

const cell = (over: Partial<ReadingCell>): ReadingCell => ({
  ponto: "Expedição",
  dayIndex: 0,
  hour: 8,
  boxes: 0,
  reads: 0,
  multiReads: 0,
  passages: 0,
  perCamera: {},
  ...over,
});

describe("readingKpis — sem denominador não existe taxa", () => {
  it("recorte VAZIO devolve null (nunca 100) em taxa e multi", () => {
    const k = readingKpis([]);
    expect(k.ratePct).toBeNull();
    expect(k.multiPct).toBeNull();
    expect(k.ratePct).not.toBe(100);
    expect(k.boxes).toBe(0);
    expect(k.passages).toBe(0);
  });

  it("células presentes mas SEM passagem (tudo zerado) também devolvem null", () => {
    const k = readingKpis([cell({}), cell({ hour: 9 })]);
    expect(k.ratePct).toBeNull();
    expect(k.multiPct).toBeNull();
  });

  it("com passagem medida a taxa volta a ser número (o caminho normal não regrediu)", () => {
    const k = readingKpis([cell({ boxes: 90, reads: 120, multiReads: 45, passages: 100 })]);
    expect(k.ratePct).toBe(90);
    expect(k.multiPct).toBe(50);
    expect(k.noReads).toBe(10);
  });

  it("leitura perfeita REAL segue 100% — o gate não apaga o caso legítimo", () => {
    const k = readingKpis([cell({ boxes: 50, reads: 50, passages: 50 })]);
    expect(k.ratePct).toBe(100);
  });
});

describe("readingRanking — nenhuma linha exibida pode nascer de denominador zero", () => {
  it("ponto sem passagem NÃO entra no ranking (e portanto não exibe taxa alguma)", () => {
    const r = readingRanking([cell({ ponto: "Doca" })], ["Doca", "Expedição"]);
    expect(r.rows).toEqual([]);
  });

  it("nenhuma linha do ranking exibe 100% sem caixa lida", () => {
    const r = readingRanking(
      [
        cell({ ponto: "Doca", boxes: 0, passages: 20 }),
        cell({ ponto: "Expedição", boxes: 8, passages: 10 }),
      ],
      ["Doca", "Expedição"],
    );
    const doca = r.rows.find((x) => x.ponto === "Doca");
    expect(doca?.ratePct).toBe(0); // 0 caixas em 20 passagens — 100% seria a mentira antiga
    expect(r.rows.find((x) => x.ponto === "Expedição")?.ratePct).toBe(80);
  });
});

describe("readingInsights — sem amostra, sem frase (regra 10)", () => {
  const kpisOf = (over: Partial<ReadingKpis>): ReadingKpis => ({ ...readingKpis([]), ...over });

  it("recorte vazio não gera NENHUM insight (nada de 'excelente cobertura')", () => {
    const tips = readingInsights(readingKpis([]));
    expect(tips).toEqual([]);
    expect(tips.join(" ")).not.toMatch(/cobertura|100%/);
  });

  it("sem caixa lida não diagnostica cobertura de ângulo ('Sem multi-leitura')", () => {
    // passagens medidas, zero leitura: a taxa (0%) é fato; o diagnóstico de multi-leitura não.
    const tips = readingInsights(kpisOf({ ratePct: 0, multiPct: null, noReads: 20 }));
    expect(tips.join(" ")).not.toMatch(/multi-leitura/);
    expect(tips[0]).toMatch(/Taxa de leitura de 0%/);
  });

  it("com dado real as frases voltam (incluindo a de excelência quando é verdade)", () => {
    const tips = readingInsights(
      readingKpis([cell({ boxes: 100, passages: 100, multiReads: 30 })]),
    );
    expect(tips[0]).toMatch(/100% — excelente cobertura/);
    expect(tips.some((t) => /30% das caixas/.test(t))).toBe(true);
  });
});
