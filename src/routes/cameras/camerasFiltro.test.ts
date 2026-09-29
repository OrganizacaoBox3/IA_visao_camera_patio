import { describe, it, expect } from "vitest";
import { passaFiltro, resumo, FILTRO_CAMERAS_DEFAULT, type LinhaFiltravel } from "./camerasFiltro";

const linha = (over: Partial<LinhaFiltravel> = {}): LinhaFiltravel => ({
  id: "cam-doca",
  label: "Doca 1",
  online: true,
  estado: "producao",
  utilidade: "ok",
  ...over,
});
const F = FILTRO_CAMERAS_DEFAULT;

describe("passaFiltro — busca", () => {
  it("sem filtro, tudo passa", () => expect(passaFiltro(linha(), F)).toBe(true));
  it("por nome, sem diferenciar caixa", () =>
    expect(passaFiltro(linha(), { ...F, busca: "DOCA" })).toBe(true));
  it("por id", () => expect(passaFiltro(linha(), { ...F, busca: "cam-doc" })).toBe(true));
  it("sem diferenciar acento (portaria acha Portária)", () =>
    expect(passaFiltro(linha({ label: "Portária" }), { ...F, busca: "portaria" })).toBe(true));
  it("não casa → fora", () =>
    expect(passaFiltro(linha(), { ...F, busca: "expedição" })).toBe(false));
});

describe("passaFiltro — conexão e estado", () => {
  it("online/offline", () => {
    expect(passaFiltro(linha({ online: false }), { ...F, conexao: "offline" })).toBe(true);
    expect(passaFiltro(linha({ online: true }), { ...F, conexao: "offline" })).toBe(false);
    expect(passaFiltro(linha({ online: false }), { ...F, conexao: "online" })).toBe(false);
  });
  it("estado operacional exato", () => {
    expect(passaFiltro(linha({ estado: "teste" }), { ...F, estado: "teste" })).toBe(true);
    expect(passaFiltro(linha({ estado: "producao" }), { ...F, estado: "teste" })).toBe(false);
  });
});

describe("passaFiltro — utilidade (câmeras inúteis)", () => {
  it("'problema' junta inútil + atenção", () => {
    const f = { ...F, utilidade: "problema" as const };
    expect(passaFiltro(linha({ utilidade: "inutil" }), f)).toBe(true);
    expect(passaFiltro(linha({ utilidade: "atencao" }), f)).toBe(true);
    expect(passaFiltro(linha({ utilidade: "ok" }), f)).toBe(false);
    expect(passaFiltro(linha({ utilidade: "desativada" }), f)).toBe(false);
  });
  it("filtro exato", () => {
    expect(passaFiltro(linha({ utilidade: "inutil" }), { ...F, utilidade: "inutil" })).toBe(true);
    expect(passaFiltro(linha({ utilidade: "atencao" }), { ...F, utilidade: "inutil" })).toBe(false);
  });
  it("sem diagnóstico não aparece como 'ok' (desconhecido não é útil)", () => {
    expect(passaFiltro(linha({ utilidade: null }), { ...F, utilidade: "ok" })).toBe(false);
  });
  it("sem filtro de utilidade, câmera sem diagnóstico aparece normalmente", () => {
    expect(passaFiltro(linha({ utilidade: null }), F)).toBe(true);
  });
});

describe("resumo", () => {
  it("conta total, offline, inúteis e atenção", () => {
    expect(
      resumo([
        linha(),
        linha({ online: false, utilidade: "inutil" }),
        linha({ utilidade: "inutil" }),
        linha({ utilidade: "atencao" }),
      ]),
    ).toEqual({ total: 4, offline: 1, inuteis: 2, atencao: 1 });
  });
});
