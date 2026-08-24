// Gate do AVISO DE PROPRIEDADE no CSV exportado. O relatório é o artefato que sai da empresa e
// circula por e-mail e pasta compartilhada; a nota de titularidade é a única coisa que viaja
// com ele. Nota que desaparece em silêncio é pior que nota nenhuma — daí o teste.
// Racional da posição (1ª linha) no cabeçalho de csv.ts.
import { describe, expect, it } from "vitest";
import { buildCSV, CSV_AVISO_PROPRIEDADE } from "./csv";

const BOM = "﻿";
const linhas = (csv: string) => csv.replace(BOM, "").split("\r\n");

describe("buildCSV — aviso de propriedade", () => {
  it("é a PRIMEIRA linha do arquivo, logo após o BOM", () => {
    const csv = buildCSV([{ title: "Bloco", headers: ["a"], rows: [[1]] }]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(linhas(csv)[0]).toBe(`"${CSV_AVISO_PROPRIEDADE}"`);
  });

  it("aparece mesmo sem nenhuma seção (export vazio ainda é documento nosso)", () => {
    expect(linhas(buildCSV([]))[0]).toContain("Box 3");
  });

  it("declara titularidade e veda redistribuição", () => {
    expect(CSV_AVISO_PROPRIEDADE).toMatch(/Copyright \(c\) 2026 Box 3/);
    expect(CSV_AVISO_PROPRIEDADE).toMatch(/redistribuição vedada/i);
  });

  // O aviso não pode custar a legibilidade no Excel: linha em branco o separa do 1º bloco.
  it("não colide com o primeiro bloco — linha em branco entre eles", () => {
    const l = linhas(buildCSV([{ title: "Indicadores", rows: [["x", 1]] }]));
    expect(l[1]).toBe("");
    expect(l[2]).toBe('"Indicadores"');
  });

  it("preserva o conteúdo das seções (aviso é aditivo, não substitui nada)", () => {
    const l = linhas(buildCSV([{ headers: ["col"], rows: [["v"]] }]));
    expect(l).toContain('"col"');
    expect(l).toContain('"v"');
  });
});
