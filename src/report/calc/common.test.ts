// Testes da leitura de TURNO no cliente (calc/common). O que está sob teste é a REGRA que
// substituiu o `shiftOf` hardcoded: o front NÃO resolve turno — ele lê o carimbo do servidor e
// só cai no legado (06/14/22) quando não há carimbo nenhum (retrocompat CA-8).
import { describe, it, expect } from "vitest";
import {
  ALL_SHIFTS,
  LEGACY_SHIFTS,
  legacyShiftOf,
  shiftStateOf,
  shiftKeyOf,
  inShift,
  shiftLabelOf,
  legacyShiftsIn,
  shiftOptions,
} from "./common";

const CADASTRO = [
  { id: "t1", nome: "Turno 1" },
  { id: "t2", nome: "Turno 2" },
  { id: "t3", nome: "Madrugada", ativo: false },
];

describe("shiftStateOf — 'sem carimbo' NÃO é 'fora de turno'", () => {
  it("shiftId string ⇒ dentro; null ⇒ fora; ausente ⇒ sem-carimbo", () => {
    expect(shiftStateOf({ shiftId: "t1" })).toBe("dentro");
    expect(shiftStateOf({ shiftId: null })).toBe("fora");
    expect(shiftStateOf({})).toBe("sem-carimbo");
    // hub antigo manda a string legada, mas nenhum id: continua SEM carimbo de turno cadastrado
    expect(shiftStateOf({ shift: "Manhã" })).toBe("sem-carimbo");
  });
});

describe("shiftKeyOf — precedência: carimbo do servidor > rótulo gravado > hora (legado)", () => {
  it("o carimbo do hub VENCE a hora do navegador (mata a armadilha do fuso)", () => {
    // 8h seria "Manhã" no hardcode antigo; o hub carimbou "t2" → a hora não decide nada.
    expect(shiftKeyOf({ hour: 8, shiftId: "t2", shift: "Turno 2" })).toBe("t2");
  });

  it("sem shiftId, usa o rótulo gravado na linha (dado do hub em dupla escrita)", () => {
    expect(shiftKeyOf({ hour: 23, shift: "Tarde" })).toBe("Tarde"); // o gravado vence a hora
  });

  it("sem carimbo nenhum, cai no legado pela hora (CA-8) — bucket (hour) e evento (ts)", () => {
    expect(shiftKeyOf({ hour: 8 })).toBe("Manhã");
    const ts = new Date();
    ts.setHours(15, 30, 0, 0);
    expect(shiftKeyOf({ ts: ts.getTime() })).toBe("Tarde");
  });

  it("FORA de turno (D7) não tem chave de turno — é null, não uma barra a mais", () => {
    expect(shiftKeyOf({ hour: 3, shiftId: null })).toBeNull();
  });

  it("linha sem âncora temporal alguma ⇒ null (não inventa turno)", () => {
    expect(shiftKeyOf({})).toBeNull();
  });
});

describe("legacyShiftOf — o hardcode 06/14/22 sobrevive SÓ como decodificador de dado antigo", () => {
  it("06–14 Manhã · 14–22 Tarde · resto Noite (bordas incluídas)", () => {
    expect(legacyShiftOf(6)).toBe("Manhã");
    expect(legacyShiftOf(13)).toBe("Manhã");
    expect(legacyShiftOf(14)).toBe("Tarde");
    expect(legacyShiftOf(21)).toBe("Tarde");
    expect(legacyShiftOf(22)).toBe("Noite");
    expect(legacyShiftOf(5)).toBe("Noite");
    expect(legacyShiftOf(0)).toBe("Noite");
  });
});

describe("inShift — o filtro do relatório", () => {
  it("'Todos' passa tudo, inclusive a linha fora de turno", () => {
    expect(inShift({ hour: 8 }, ALL_SHIFTS)).toBe(true);
    expect(inShift({ hour: 3, shiftId: null }, ALL_SHIFTS)).toBe(true);
  });

  it("filtro por id casa só com o carimbo; filtro legado casa só com dado legado (CA-8)", () => {
    const novo = { hour: 8, shiftId: "t1", shift: "Turno 1" };
    const antigo = { hour: 8 };
    expect(inShift(novo, "t1")).toBe(true);
    expect(inShift(novo, "Manhã")).toBe(false); // carimbado não é "Manhã" só porque são 8h
    expect(inShift(antigo, "Manhã")).toBe(true); // dado antigo continua funcionando
    expect(inShift(antigo, "t1")).toBe(false);
  });
});

describe("shiftLabelOf — a chave é o id; o que se EXIBE é o nome", () => {
  it("resolve o nome do cadastro; dado antigo exibe a própria string", () => {
    expect(shiftLabelOf("t1", CADASTRO)).toBe("Turno 1");
    expect(shiftLabelOf("Manhã", CADASTRO)).toBe("Manhã");
    expect(shiftLabelOf(ALL_SHIFTS, CADASTRO)).toBe("todos");
    expect(shiftLabelOf(null, CADASTRO)).toBe("fora de turno");
  });

  it("id órfão (turno apagado do cadastro) exibe a chave crua — nunca quebra", () => {
    expect(shiftLabelOf("t9", CADASTRO)).toBe("t9");
  });
});

describe("legacyShiftsIn / shiftOptions — o filtro sai do CADASTRO, não de 3 strings fixas", () => {
  it("só oferece os legados que EXISTEM no dado carregado", () => {
    expect(legacyShiftsIn([{ hour: 8 }, { hour: 9 }])).toEqual(["Manhã"]);
    expect(legacyShiftsIn([{ hour: 8 }, { hour: 23 }])).toEqual(["Manhã", "Noite"]); // ordem canônica
  });

  it("dado 100% carimbado ⇒ NENHUMA opção legada (as 3 strings mortas somem)", () => {
    expect(
      legacyShiftsIn([
        { hour: 8, shiftId: "t1" },
        { hour: 3, shiftId: null },
      ]),
    ).toEqual([]);
  });

  it("opções = turnos ATIVOS do cadastro + legados do dado (com sufixo p/ desambiguar)", () => {
    const opts = shiftOptions(CADASTRO, ["Manhã"]);
    expect(opts).toEqual([
      { value: "t1", label: "Turno 1" },
      { value: "t2", label: "Turno 2" },
      // "Madrugada" tem ativo:false → fora do filtro
      { value: "Manhã", label: "Manhã (legado)" },
    ]);
  });

  it("sem cadastro (hub antigo), o legado é o turno — sem sufixo", () => {
    expect(shiftOptions([], LEGACY_SHIFTS)).toEqual([
      { value: "Manhã", label: "Manhã" },
      { value: "Tarde", label: "Tarde" },
      { value: "Noite", label: "Noite" },
    ]);
  });
});
