// byAtividade — ranking por atividade (movido do memo inline do ReportPage p/ o pacote calc,
// junto das agregações irmãs). Lógica pura extraída nasce com teste ao lado (CLAUDE.md §6).
// shiftRuler — o KPI na RÉGUA DO TURNO (spec-turnos-por-zona §4.3 + D7).
import { describe, it, expect } from "vitest";
import { byAtividade, shiftRuler, type Cell } from "./atividade";

const cell = (over: Partial<Cell>): Cell => ({
  area: "Doca",
  dayIndex: 0,
  hour: 8,
  idleMin: 0,
  alerts: 0,
  activePct: 0,
  ...over,
});

describe("byAtividade — ranking por atividade", () => {
  it("agrega idleMin/alerts por atividade e ordena por tempo parado (desc)", () => {
    const r = byAtividade([
      cell({ atividade: "Picking", idleMin: 10, alerts: 1 }),
      cell({ atividade: "Picking", idleMin: 5, alerts: 0 }),
      cell({ atividade: "Carga", idleMin: 40, alerts: 2 }),
    ]);
    expect(r.rows).toEqual([
      { atividade: "Carga", idleMin: 40, alerts: 2 },
      { atividade: "Picking", idleMin: 15, alerts: 1 },
    ]);
    expect(r.max).toBe(40);
  });

  it("célula sem atividade agrega em 'Indefinida'; linha sem ociosidade sai do ranking", () => {
    const r = byAtividade([
      cell({ atividade: undefined, idleMin: 7 }),
      cell({ atividade: "Zerada", idleMin: 0, alerts: 3 }), // idleMin 0 → não entra
    ]);
    expect(r.rows).toEqual([{ atividade: "Indefinida", idleMin: 7, alerts: 0 }]);
  });

  it("vazio → rows [] e max com piso 1 (escala das barras)", () => {
    expect(byAtividade([])).toEqual({ rows: [], max: 1 });
  });
});

describe("shiftRuler — ocupação na régua do TURNO (não ÷ 24h)", () => {
  it("sem carimbo do hub, a régua NÃO EXISTE (stamped=false) — nada de número inventado", () => {
    const r = shiftRuler([cell({ hour: 8, idleMin: 30, samples: 100, activeSamples: 40 })]);
    expect(r.stamped).toBe(false);
    expect(r.occupancyPct).toBeNull();
    expect(r.unknownHours).toBe(1);
    expect(r.idleMinInShift).toBe(0); // dado sem carimbo não entra na conta do turno
  });

  it("ocupação = amostras ATIVAS ÷ amostras DO TURNO (a hora fora do turno não dilui)", () => {
    const r = shiftRuler([
      // dentro do turno: 100 amostras, 80 ativas → 80%
      cell({ hour: 8, shiftId: "t1", samples: 100, activeSamples: 80, idleMin: 12, alerts: 2 }),
      // FORA do turno (madrugada vazia): 100 amostras, 0 ativas — se entrasse no denominador,
      // a ocupação despencaria para 40%. É exatamente a conta errada que o D7 proíbe.
      cell({ hour: 3, shiftId: null, samples: 100, activeSamples: 0, idleMin: 60, alerts: 5 }),
    ]);
    expect(r.stamped).toBe(true);
    expect(r.occupancyPct).toBe(80); // ÷ turno, NUNCA ÷ 24h
    expect(r.idleMinInShift).toBe(12);
    expect(r.alertsInShift).toBe(2);
    expect(r.hoursInShift).toBe(1);
  });

  it("D7 — a atividade FORA do turno é linha PRÓPRIA, jamais somada à ocupação", () => {
    const r = shiftRuler([
      cell({ hour: 8, shiftId: "t1", samples: 10, activeSamples: 10, idleMin: 0 }),
      cell({ hour: 2, shiftId: null, samples: 10, activeSamples: 5, idleMin: 40, alerts: 3 }),
      cell({ hour: 3, shiftId: null, samples: 10, activeSamples: 0, idleMin: 60 }),
    ]);
    expect(r.occupancyPct).toBe(100); // a atividade da madrugada não sobe nem desce a do turno
    expect(r.offActivePct).toBe(25); // 5 ativas ÷ 20 amostras fora do turno
    expect(r.offActiveHours).toBe(1); // só a hora 02 teve movimento
    expect(r.offIdleMin).toBe(100);
    expect(r.offAlerts).toBe(3);
  });

  it("PAUSA (D3) sai do numerador E do denominador — vazio esperado não é ociosidade", () => {
    const r = shiftRuler([
      cell({ hour: 8, shiftId: "t1", samples: 10, activeSamples: 9 }),
      // almoço: zona vazia, mas era pra estar vazia. Se entrasse, a ocupação cairia p/ 45%.
      cell({ hour: 12, shiftId: "t1", inPause: true, samples: 10, activeSamples: 0, idleMin: 55 }),
    ]);
    expect(r.occupancyPct).toBe(90);
    expect(r.idleMinInShift).toBe(0);
    expect(r.pauseHours).toBe(1);
    expect(r.hoursInShift).toBe(1);
  });

  it("hub sem amostras cruas: degrada p/ média do activePct (não zera o KPI)", () => {
    const r = shiftRuler([
      cell({ hour: 8, shiftId: "t1", activePct: 60 }),
      cell({ hour: 9, shiftId: "t1", activePct: 40 }),
    ]);
    expect(r.occupancyPct).toBe(50);
  });

  it("dado MISTO (migração): o antigo fica em 'unknown', sem contaminar a régua", () => {
    const r = shiftRuler([
      cell({ hour: 8, shiftId: "t1", samples: 10, activeSamples: 7, idleMin: 5 }),
      cell({ hour: 8, idleMin: 50, samples: 10, activeSamples: 0 }), // dado pré-turnos
    ]);
    expect(r.stamped).toBe(true);
    expect(r.occupancyPct).toBe(70);
    expect(r.idleMinInShift).toBe(5);
    expect(r.unknownHours).toBe(1);
  });
});
