// byAtividade — ranking por atividade (movido do memo inline do ReportPage p/ o pacote calc,
// junto das agregações irmãs). Lógica pura extraída nasce com teste ao lado (CLAUDE.md §6).
import { describe, it, expect } from "vitest";
import { byAtividade, type Cell } from "./atividade";

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
