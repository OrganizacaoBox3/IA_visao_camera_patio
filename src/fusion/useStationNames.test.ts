// Testes do núcleo PURO do resolvedor id→nome (src/fusion/useStationNames.ts). O critério de aceite
// da costura é DEGRADAÇÃO SEGURA: a UI NUNCA fica vazia — na falta do registro (hub antigo, fetch
// falhado, estação não cadastrada) o rótulo cai no PRÓPRIO id técnico.
import { describe, it, expect } from "vitest";
import { stationNameOf, stationLabelOf } from "./useStationNames";
import type { BtStation } from "../api";

const st = (id: string, nome: string, ativo = true): BtStation => ({
  id,
  nome,
  ativo,
  primeiraVezEm: 1,
  ultimaVezEm: 2,
});

const REGISTRO: BtStation[] = [st("tc22-a1b2", "Doca 3"), st("tc99-zzzz", "tc99-zzzz")];

describe("stationNameOf — o NOME substitui o id técnico", () => {
  it("estação batizada → o nome do cadastro", () => {
    expect(stationNameOf(REGISTRO, "tc22-a1b2")).toBe("Doca 3");
  });

  it("estação PENDENTE (nome semeado com o id no back) → o próprio id", () => {
    expect(stationNameOf(REGISTRO, "tc99-zzzz")).toBe("tc99-zzzz");
  });

  it("FALLBACK: id fora do registro (postou, mas o registro ainda não chegou) → o próprio id", () => {
    expect(stationNameOf(REGISTRO, "tc77-novo")).toBe("tc77-novo");
  });

  it("FALLBACK: registro VAZIO (hub antigo / fetch falhou) → o próprio id, nunca vazio", () => {
    expect(stationNameOf([], "tc22-a1b2")).toBe("tc22-a1b2");
  });

  it("FALLBACK: nome em branco no registro → o próprio id", () => {
    expect(stationNameOf([st("tc22-a1b2", "   ")], "tc22-a1b2")).toBe("tc22-a1b2");
  });

  it("id vazio (fonte única implícita, retrocompat) → \"\" — quem chama decide o texto de ausência", () => {
    expect(stationNameOf(REGISTRO, "")).toBe("");
  });

  it("estação DESATIVADA continua tendo nome (o ponto dela segue marcado na calibração)", () => {
    expect(stationNameOf([st("tc22-a1b2", "Doca 3", false)], "tc22-a1b2")).toBe("Doca 3");
  });
});

describe("stationLabelOf — o par {id, nome} que a UI exibe", () => {
  it("batizada: nome em 1º plano, id preservado (é o que o operador digita no app)", () => {
    expect(stationLabelOf(REGISTRO, "tc22-a1b2")).toEqual({ id: "tc22-a1b2", nome: "Doca 3" });
  });

  it("pendente: nome == id (a UI não repete o id duas vezes)", () => {
    expect(stationLabelOf(REGISTRO, "tc99-zzzz")).toEqual({ id: "tc99-zzzz", nome: "tc99-zzzz" });
  });
});
