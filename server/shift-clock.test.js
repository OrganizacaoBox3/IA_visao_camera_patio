// Testes da resolução de turno (shift-clock.js) — os CAs críticos da spec-turnos-por-zona §5:
// CA-1 (overnight: businessDate = dia em que INICIA), CA-4 (borda meio-aberta [início, fim)),
// CA-6 (resolução pelo fuso do SITE, não do processo) + pausas (D3, base do CA-3 no gate).
// Datas concretas: 2026-07-15 é uma QUARTA-feira; America/Sao_Paulo = UTC-3 fixo (sem DST).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const clock = require("./shift-clock");

const TZ = "America/Sao_Paulo";
const SEG_SEX = [1, 2, 3, 4, 5];
// epoch-ms de um wall-clock de São Paulo (UTC-3): 03:00 local = 06:00 UTC.
const sp = (y, m, d, hh, mm, ss = 0, ms = 0) => Date.UTC(y, m - 1, d, hh + 3, mm, ss, ms);

const noturno = {
  id: "sh-noturno",
  nome: "Noturno",
  dias: SEG_SEX, // dias em que INICIA (D1/D5)
  inicio: "22:00",
  fim: "06:00", // fim ≤ início ⇒ +1 dia (D2)
  pausas: [],
  ativo: true,
};

describe("shift-clock — CA-1 overnight (D1/D2: businessDate = dia em que inicia)", () => {
  it("quarta 03:00 dentro do 22–06 seg-sex → businessDate TERÇA", () => {
    const r = clock.resolveShift(sp(2026, 7, 15, 3, 0), [noturno], TZ);
    expect(r).toEqual({ shiftId: "sh-noturno", businessDate: "2026-07-14", inPause: false });
  });

  it("quarta 23:00 (turno recém-iniciado) → businessDate a PRÓPRIA quarta", () => {
    const r = clock.resolveShift(sp(2026, 7, 15, 23, 0), [noturno], TZ);
    expect(r).toEqual({ shiftId: "sh-noturno", businessDate: "2026-07-15", inPause: false });
  });

  it("sábado 03:00 pertence ao turno que iniciou SEXTA (sexta ∈ dias)", () => {
    const r = clock.resolveShift(sp(2026, 7, 18, 3, 0), [noturno], TZ);
    expect(r).toEqual({ shiftId: "sh-noturno", businessDate: "2026-07-17", inPause: false });
  });

  it("domingo 03:00 é fora de turno (sábado ∉ dias → nenhum turno iniciou)", () => {
    expect(clock.resolveShift(sp(2026, 7, 19, 3, 0), [noturno], TZ)).toBeNull();
  });

  it("turno inativo não resolve", () => {
    expect(clock.resolveShift(sp(2026, 7, 15, 3, 0), [{ ...noturno, ativo: false }], TZ)).toBeNull();
  });
});

describe("shift-clock — CA-4 borda (D4: janela [início, fim); a borda pertence a quem inicia)", () => {
  const A = { id: "A", nome: "Manhã", dias: [3], inicio: "06:00", fim: "14:00", pausas: [], ativo: true };
  const B = { id: "B", nome: "Tarde", dias: [3], inicio: "14:00", fim: "22:00", pausas: [], ativo: true };

  it("exatamente 14:00:00.000 pertence a B (turno que inicia)", () => {
    const r = clock.resolveShift(sp(2026, 7, 15, 14, 0), [A, B], TZ);
    expect(r?.shiftId).toBe("B");
  });

  it("13:59:59.999 ainda é de A", () => {
    const r = clock.resolveShift(sp(2026, 7, 15, 13, 59, 59, 999), [A, B], TZ);
    expect(r?.shiftId).toBe("A");
  });

  it("exatamente no início do próprio turno (06:00) já resolve", () => {
    const r = clock.resolveShift(sp(2026, 7, 15, 6, 0), [A, B], TZ);
    expect(r?.shiftId).toBe("A");
  });

  it("exatamente no fim da grade (22:00) é fora de turno", () => {
    expect(clock.resolveShift(sp(2026, 7, 15, 22, 0), [A, B], TZ)).toBeNull();
  });
});

describe("shift-clock — CA-6 fuso (D6: resolve pelo SITE_TZ, nunca pelo relógio do processo)", () => {
  // 03:00 UTC = 00:00 em São Paulo — o MESMO instante cai dentro/fora do turno conforme o tz.
  const madrugada = { id: "M", nome: "M", dias: [3], inicio: "01:00", fim: "05:00", pausas: [], ativo: true };
  const ts = Date.UTC(2026, 6, 15, 3, 0);

  it("o mesmo ts resolve em UTC (03:00) e NÃO resolve em São Paulo (00:00)", () => {
    expect(clock.resolveShift(ts, [madrugada], "UTC")?.shiftId).toBe("M");
    expect(clock.resolveShift(ts, [madrugada], TZ)).toBeNull();
  });

  it("businessDate também segue o fuso do site (00:00 SP ainda é dia 14 em Denver)", () => {
    // 2026-07-15 00:30 SP = 03:30 UTC = 21:30 do dia 14 em America/Denver (UTC-6, DST).
    const t2 = Date.UTC(2026, 6, 15, 3, 30);
    const noite = { id: "N", nome: "N", dias: [2], inicio: "21:00", fim: "23:00", pausas: [], ativo: true };
    const r = clock.resolveShift(t2, [noite], "America/Denver");
    expect(r).toEqual({ shiftId: "N", businessDate: "2026-07-14", inPause: false });
  });
});

describe("shift-clock — pausas (D3: janela [início, fim) relativa ao turno, overnight incluso)", () => {
  it("dentro da pausa 12:00+60min → inPause true; 13:00 (fim exclusivo) → false", () => {
    const t = {
      id: "T", nome: "T", dias: [3], inicio: "06:00", fim: "14:00",
      pausas: [{ inicio: "12:00", duracaoMin: 60 }], ativo: true,
    };
    expect(clock.resolveShift(sp(2026, 7, 15, 12, 10), [t], TZ)?.inPause).toBe(true);
    expect(clock.resolveShift(sp(2026, 7, 15, 13, 0), [t], TZ)?.inPause).toBe(false);
  });

  it("pausa na MADRUGADA de turno overnight (02:00 do dia seguinte ao início)", () => {
    const t = { ...noturno, pausas: [{ inicio: "02:00", duracaoMin: 30 }] };
    const r = clock.resolveShift(sp(2026, 7, 16, 2, 15), [t], TZ); // quinta 02:15 → iniciou quarta
    expect(r).toEqual({ shiftId: "sh-noturno", businessDate: "2026-07-15", inPause: true });
  });
});

describe("shift-clock — helpers (parseHM/durationMin, base do CA-7 no cadastro)", () => {
  it('parseHM aceita "HH:MM" (e "H:MM"); rejeita 24:00/60min/lixo', () => {
    expect(clock.parseHM("06:00")).toBe(360);
    expect(clock.parseHM("7:05")).toBe(425);
    expect(clock.parseHM("23:59")).toBe(1439);
    expect(clock.parseHM("24:00")).toBeNull();
    expect(clock.parseHM("12:60")).toBeNull();
    expect(clock.parseHM("")).toBeNull();
    expect(clock.parseHM(null)).toBeNull();
  });

  it("durationMin: diurno, overnight e o caso degenerado 0 (fim == início)", () => {
    expect(clock.durationMin(clock.parseHM("06:00"), clock.parseHM("14:00"))).toBe(480);
    expect(clock.durationMin(clock.parseHM("22:00"), clock.parseHM("06:00"))).toBe(480);
    expect(clock.durationMin(clock.parseHM("08:00"), clock.parseHM("08:00"))).toBe(0);
  });
});
