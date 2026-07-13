import { describe, it, expect } from "vitest";
import { filterByWindow, byShift, PERIOD_DAYS, OUT_OF_SHIFT_KEY } from "./aggregate";

// TURNO: o recorte lê o CARIMBO da linha (shiftId/shift do hub). Só quando não há carimbo é que
// cai no legado 06/14/22 derivado da hora local — por isso os ts abaixo fixam a hora.
function at(daysAgo: number, hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

describe("filterByWindow", () => {
  const rows = [
    { ts: at(0, 8), area: "A" }, // hoje · 08h Manhã (legado)
    { ts: at(2, 15), area: "B" }, // 2 dias atrás · 15h Tarde (legado)
    { ts: at(10, 23), area: "A" }, // 10 dias atrás · 23h Noite (legado)
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

  it("CA-8: dado ANTIGO (sem carimbo) segue filtrável pelo turno legado", () => {
    const out = filterByWindow(rows, "30d", "Noite");
    expect(out).toHaveLength(1);
    expect(new Date(out[0].ts).getHours()).toBe(23);
  });

  it("dado CARIMBADO filtra pelo id do turno — e o carimbo VENCE a hora", () => {
    // 08h seria "Manhã" no legado; o carimbo do hub diz turno "t1" → o legado não decide nada.
    const stamped = [
      { ts: at(1, 8), area: "A", shiftId: "t1", shift: "Turno 1" },
      { ts: at(1, 9), area: "B", shiftId: "t2", shift: "Turno 2" },
    ];
    expect(filterByWindow(stamped, "7d", "t1").map((r) => r.area)).toEqual(["A"]);
    expect(filterByWindow(stamped, "7d", "Manhã")).toHaveLength(0);
  });

  it("linha carimbada FORA de turno (shiftId null) não pertence a turno nenhum (D7)", () => {
    const fora = [{ ts: at(1, 8), area: "A", shiftId: null }];
    expect(filterByWindow(fora, "7d", "Todos")).toHaveLength(1);
    expect(filterByWindow(fora, "7d", "Manhã")).toHaveLength(0);
    expect(filterByWindow(fora, "7d", "t1")).toHaveLength(0);
  });

  it("aplica o filtro extra (ex.: área)", () => {
    const out = filterByWindow(rows, "30d", "Todos", (r) => r.area === "A");
    expect(out.map((r) => r.area)).toEqual(["A", "A"]);
  });
});

describe("byShift", () => {
  it("dado LEGADO: soma por turno derivado da hora e devolve o máximo", () => {
    const cells = [
      { hour: 8, idleMin: 10 }, // Manhã
      { hour: 9, idleMin: 5 }, // Manhã
      { hour: 15, idleMin: 20 }, // Tarde
      { hour: 23, idleMin: 3 }, // Noite
    ];
    const { rows, max } = byShift(cells, (c) => c.idleMin);
    expect(rows).toEqual([
      { key: "Manhã", label: "Manhã", value: 15 },
      { key: "Tarde", label: "Tarde", value: 20 },
      { key: "Noite", label: "Noite", value: 3 },
    ]);
    expect(max).toBe(20);
  });

  it("dado CARIMBADO: as barras são os turnos do CADASTRO, na ordem cadastrada", () => {
    const shifts = [
      { id: "t2", nome: "Tarde-2" },
      { id: "t1", nome: "Madrugada" },
    ];
    const cells = [
      { hour: 3, idleMin: 7, shiftId: "t1" },
      { hour: 16, idleMin: 4, shiftId: "t2" },
      { hour: 16, idleMin: 1, shiftId: "t2" },
    ];
    const { rows } = byShift(cells, (c) => c.idleMin, shifts);
    expect(rows).toEqual([
      { key: "t2", label: "Tarde-2", value: 5 },
      { key: "t1", label: "Madrugada", value: 7 },
    ]);
  });

  it("D7: 'fora de turno' é BARRA PRÓPRIA (nunca somada a um turno) e vai por último", () => {
    const shifts = [{ id: "t1", nome: "Turno 1" }];
    const { rows } = byShift(
      [
        { hour: 3, idleMin: 30, shiftId: null },
        { hour: 8, idleMin: 10, shiftId: "t1" },
      ],
      (c) => c.idleMin,
      shifts,
    );
    expect(rows).toEqual([
      { key: "t1", label: "Turno 1", value: 10 },
      { key: OUT_OF_SHIFT_KEY, label: "Fora de turno", value: 30 },
    ]);
  });

  it("max tem piso 1 quando tudo é zero/vazio", () => {
    const { rows, max } = byShift<{ hour: number }>([], () => 0);
    expect(rows).toEqual([]);
    expect(max).toBe(1);
  });
});

describe("PERIOD_DAYS", () => {
  it("reflete os dias de cada período", () => {
    expect(PERIOD_DAYS).toEqual({ hoje: 1, "7d": 7, "30d": 30 });
  });
});
