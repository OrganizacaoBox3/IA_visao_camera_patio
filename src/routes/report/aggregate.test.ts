import { describe, it, expect } from "vitest";
import { filterByWindow, byShift, PERIOD_DAYS } from "./aggregate";

// shiftOf: 6–14 Manhã · 14–22 Tarde · resto Noite (ver report/calc/common.ts). O turno é
// derivado da HORA LOCAL do próprio ts — por isso os timestamps são fixados numa hora concreta.
function at(daysAgo: number, hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

describe("filterByWindow", () => {
  const rows = [
    { ts: at(0, 8), area: "A" }, // hoje · 08h Manhã
    { ts: at(2, 15), area: "B" }, // 2 dias atrás · 15h Tarde
    { ts: at(10, 23), area: "A" }, // 10 dias atrás · 23h Noite
  ];

  it("recorta pelo período (hoje = últimas 24h)", () => {
    const out = filterByWindow(rows, "hoje", "Todos");
    expect(out).toHaveLength(1);
    expect(out[0].area).toBe("A");
  });

  it("inclui 7d mas exclui o que passou da janela", () => {
    expect(filterByWindow(rows, "7d", "Todos")).toHaveLength(2);
    expect(filterByWindow(rows, "30d", "Todos")).toHaveLength(3);
  });

  it("filtra por turno (derivado da hora do ts)", () => {
    const out = filterByWindow(rows, "30d", "Noite");
    expect(out).toHaveLength(1);
    expect(new Date(out[0].ts).getHours()).toBe(23);
  });

  it("aplica o filtro extra (ex.: área)", () => {
    const out = filterByWindow(rows, "30d", "Todos", (r) => r.area === "A");
    expect(out.map((r) => r.area)).toEqual(["A", "A"]);
  });
});

describe("byShift", () => {
  it("soma a métrica por turno e devolve o máximo", () => {
    const cells = [
      { hour: 8, idleMin: 10 }, // Manhã
      { hour: 9, idleMin: 5 }, // Manhã
      { hour: 15, idleMin: 20 }, // Tarde
      { hour: 23, idleMin: 3 }, // Noite
    ];
    const { m, max } = byShift(cells, (c) => c.idleMin);
    expect(m).toEqual({ Manhã: 15, Tarde: 20, Noite: 3 });
    expect(max).toBe(20);
  });

  it("max tem piso 1 quando tudo é zero/vazio", () => {
    const { m, max } = byShift<{ hour: number }>([], () => 0);
    expect(m).toEqual({ Manhã: 0, Tarde: 0, Noite: 0 });
    expect(max).toBe(1);
  });
});

describe("PERIOD_DAYS", () => {
  it("reflete os dias de cada período", () => {
    expect(PERIOD_DAYS).toEqual({ hoje: 1, "7d": 7, "30d": 30 });
  });
});
