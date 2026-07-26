// AMOSTRA ZERO NUNCA VIRA "OPERAÇÃO SAUDÁVEL" (auditoria 2026-07-26, A2 — `okPct: samples ? … :
// 100`). Um período sem NENHUMA amostra afirmava 100% do tempo sem alerta, no KPI de SEGURANÇA.
// Falso-OK é pior que erro: aqui o gate é teste, não comentário.
import { describe, it, expect } from "vitest";
import {
  fadigaKpis,
  fadigaInsights,
  fadigaEvolution,
  type FadigaCell,
  type FadigaDataset,
} from "./fadiga";

const cell = (over: Partial<FadigaCell>): FadigaCell => ({
  posto: "Posto 1",
  dayIndex: 0,
  hour: 8,
  samples: 0,
  ok: 0,
  fadiga: 0,
  celular: 0,
  duplo: 0,
  earSum: 0,
  earSamples: 0,
  ...over,
});

describe("fadigaKpis — sem amostra não existe percentual", () => {
  it("recorte VAZIO devolve null (nunca 100/0) em okPct, alertPct e avgEar", () => {
    const k = fadigaKpis([]);
    expect(k.okPct).toBeNull();
    expect(k.okPct).not.toBe(100);
    expect(k.alertPct).toBeNull();
    expect(k.avgEar).toBeNull();
    expect(k.samples).toBe(0);
    expect(k.alertSamples).toBe(0);
  });

  it("células presentes com samples=0 também devolvem null", () => {
    expect(fadigaKpis([cell({}), cell({ hour: 9 })]).okPct).toBeNull();
  });

  it("com amostra os percentuais voltam a existir (caminho normal intacto)", () => {
    const k = fadigaKpis([
      cell({ samples: 100, ok: 90, fadiga: 6, celular: 4, earSum: 60, earSamples: 200 }),
    ]);
    expect(k.alertPct).toBe(10);
    expect(k.okPct).toBe(90);
    expect(k.avgEar).toBe(0.3);
    expect(k.samples).toBe(100);
    expect(k.alertSamples).toBe(10);
  });
});

describe("fadigaInsights — sem amostra, sem frase (regra 10)", () => {
  it("recorte vazio não gera NENHUM insight (nada de 'Operação saudável')", () => {
    const tips = fadigaInsights(fadigaKpis([]), 0, 0);
    expect(tips).toEqual([]);
    expect(tips.join(" ")).not.toMatch(/saudável|100%/);
  });

  it("sem NENHUMA amostra de risco não inventa 'pico às 00h'", () => {
    const tips = fadigaInsights(fadigaKpis([cell({ samples: 3600, ok: 3600 })]), 0, 0);
    expect(tips.join(" ")).not.toMatch(/Pico de risco/);
    expect(tips[0]).toMatch(/Operação saudável: 100% do tempo sem alerta/); // aqui é MEDIDO
  });

  it("com risco medido o pico volta, na hora certa", () => {
    const tips = fadigaInsights(
      fadigaKpis([cell({ hour: 14, samples: 100, fadiga: 30 }), cell({ hour: 8, samples: 100 })]),
      2,
      1,
    );
    expect(tips.join(" ")).toMatch(/Pico de risco às 14h/);
  });
});

describe("fadigaEvolution — dia sem amostra é declarado, não desenhado como 0%", () => {
  it("cada barra carrega o n do dia (0 ⇒ quem desenha diz 'sem dado')", () => {
    const ds: FadigaDataset = {
      days: 2,
      postos: ["Posto 1"],
      startMs: Date.UTC(2026, 6, 20),
      cells: [cell({ dayIndex: 0, samples: 100, fadiga: 20 })], // dia 1 sem NENHUM bucket
    };
    const { bars } = fadigaEvolution(ds, { period: "7d", shift: "Todos", posto: "Todos" }, 14);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toMatchObject({ pct: 20, samples: 100 });
    expect(bars[1]).toMatchObject({ pct: 0, samples: 0 }); // 0% COM n=0 — a UI não pode afirmar
  });
});
