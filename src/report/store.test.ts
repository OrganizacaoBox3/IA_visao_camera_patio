// Testes das lógicas PURAS do store do relatório: a geometria de JANELA extraída do boilerplate
// repetido nos load*Dataset (deriveWindow/cellTime) e o pico de pessoas do painel Atividade
// (peoplePeakOf). As agregações do fluxo vivem (com seus testes) em calc/flow. As funções de I/O
// (record*/load*/clearAll) dependem de fetch/API → cobertas pelo e2e, não aqui.
import { describe, it, expect } from "vitest";
import { deriveWindow, cellTime, peoplePeakOf, type AtivCell } from "./store";

const DAY = 86_400_000;
const midnight = (offsetDays = 0) =>
  Math.floor(Date.now() / DAY) * DAY + offsetDays * DAY; // meia-noite UTC de hoje + offset

describe("deriveWindow — dia-base e nº de dias (extraído do boilerplate 5×)", () => {
  it("startMs é a meia-noite do bucket MAIS ANTIGO; days cobre até `now`", () => {
    const start = 3 * DAY; // meia-noite exata
    const now = start + 2 * DAY + 5 * 3_600_000; // 2 dias e 5h depois
    const w = deriveWindow([start + 3_600_000, start + 10 * 3_600_000, start], now);
    expect(w.startMs).toBe(start); // trunca p/ a meia-noite do menor hourStart
    expect(w.days).toBe(3); // ceil(2d5h) = 3 dias
  });

  it("garante days ≥ 1 mesmo quando todos os buckets são de hoje", () => {
    const start = 10 * DAY;
    expect(deriveWindow([start + 3_600_000], start + 3_600_000).days).toBe(1);
  });

  it("trunca hourStart não-alinhado à meia-noite anterior", () => {
    const start = 5 * DAY;
    const w = deriveWindow([start + 23 * 3_600_000], start + 23 * 3_600_000);
    expect(w.startMs).toBe(start);
  });
});

describe("cellTime — posição do bucket na janela", () => {
  it("dayIndex conta dias desde startMs; hour é a hora local do bucket", () => {
    const start = midnight(0);
    const d2 = cellTime(start + 2 * DAY + 9 * 3_600_000, start);
    expect(d2.dayIndex).toBe(2);
    expect(d2.hour).toBe(new Date(start + 2 * DAY + 9 * 3_600_000).getHours());
  });

  it("bucket no próprio startMs → dia 0", () => {
    const start = midnight(0);
    expect(cellTime(start, start).dayIndex).toBe(0);
  });
});

const ac = (peoplePeak?: number): AtivCell => ({
  area: "Doca",
  dayIndex: 0,
  hour: 8,
  idleMin: 0,
  alerts: 0,
  activePct: 0,
  peoplePeak,
});

describe("peoplePeakOf — pico de pessoas no recorte", () => {
  it("devolve o MAIOR peoplePeak entre as células", () => {
    expect(peoplePeakOf([ac(2), ac(7), ac(3)])).toBe(7);
  });

  it("ignora células sem peoplePeak (campo opcional/aditivo)", () => {
    expect(peoplePeakOf([ac(undefined), ac(4), ac(undefined)])).toBe(4);
  });

  it("recorte vazio ou tudo ausente → 0", () => {
    expect(peoplePeakOf([])).toBe(0);
    expect(peoplePeakOf([ac(undefined)])).toBe(0);
  });
});
