// Testes da supressão de duplicatas (nms.ts) — lógica PURA extraída de detect.ts.
// Cobrem o BUG DE CAMPO "mais de uma pessoa onde só há uma": a caixa PARCIAL de um
// tile vizinho (IoU baixo com a caixa inteira — união grande) sobrevivia ao NMS por
// IoU e virava uma segunda pessoa. A CONTENÇÃO (interseção/área_menor) a mata.
import { describe, it, expect } from "vitest";
import { iouXYWH, containment, suppressDuplicates, coveredByAny, type NormDet } from "./nms";

const person = (
  bbox: [number, number, number, number],
  score: number,
  cls = "person",
): NormDet => ({ cls, score, bbox });

describe("iouXYWH", () => {
  it("1 para caixas idênticas; 0 sem interseção", () => {
    expect(iouXYWH([0.1, 0.1, 0.2, 0.2], [0.1, 0.1, 0.2, 0.2])).toBeCloseTo(1, 6);
    expect(iouXYWH([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1])).toBe(0);
  });
});

describe("containment (interseção / área da caixa MENOR)", () => {
  it("caixa menor TOTALMENTE dentro da maior → 1 (mesmo com IoU baixo)", () => {
    const inteira: [number, number, number, number] = [0.3, 0.2, 0.2, 0.6]; // pessoa inteira
    const parcial: [number, number, number, number] = [0.32, 0.2, 0.16, 0.25]; // meia pessoa (tile vizinho)
    expect(containment(inteira, parcial)).toBeCloseTo(1, 6);
    expect(iouXYWH(inteira, parcial)).toBeLessThan(0.45); // o NMS por IoU NÃO pegaria
  });
  it("caixas disjuntas → 0; sobreposição parcial → fração da menor", () => {
    expect(containment([0, 0, 0.1, 0.1], [0.5, 0.5, 0.1, 0.1])).toBe(0);
    // menor [0.05..0.15]×[0..0.1] com metade dentro da maior [0..0.1]²: inter 0.05×0.1 → 0.5
    expect(containment([0, 0, 0.1, 0.1], [0.05, 0, 0.1, 0.1])).toBeCloseTo(0.5, 6);
  });
});

describe("suppressDuplicates — o bug de campo (dupla de tile vizinho)", () => {
  it("caixa PARCIAL ≥70% contida na caixa inteira é suprimida; fica a de maior score", () => {
    const inteira = person([0.3, 0.2, 0.2, 0.6], 0.8);
    const parcial = person([0.32, 0.2, 0.16, 0.25], 0.5); // contida, IoU ~0.22 (< nmsIoU 0.45)
    const out = suppressDuplicates([parcial, inteira], 0.45, 0.7);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(inteira); // manteve a de maior score
  });

  it("IoU alto continua fundindo (NMS clássico das bordas dos tiles)", () => {
    const a = person([0.3, 0.2, 0.2, 0.6], 0.8);
    const b = person([0.31, 0.21, 0.2, 0.6], 0.6); // quase idêntica (IoU ≫ 0.45)
    expect(suppressDuplicates([a, b], 0.45, 0.7)).toHaveLength(1);
  });

  it("iouThr = Infinity desliga o NMS e deixa SÓ a contenção (caminho single-shot)", () => {
    const a = person([0.3, 0.2, 0.2, 0.6], 0.8);
    const b = person([0.31, 0.21, 0.2, 0.6], 0.6); // IoU alto, contenção ~0.87 ≥ 0.7 → cai
    const c = person([0.6, 0.2, 0.2, 0.6], 0.7); // longe → fica
    const out = suppressDuplicates([a, b, c], Number.POSITIVE_INFINITY, 0.7);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.score).sort()).toEqual([0.7, 0.8]);
  });

  it("RECALL preservado: duas pessoas realmente próximas (lado a lado) NÃO são fundidas", () => {
    // Ombro a ombro: centros a 0.11 (largura 0.1) → contenção ~0 e IoU ~0 — ambas ficam.
    const p1 = person([0.3, 0.2, 0.1, 0.4], 0.8);
    const p2 = person([0.41, 0.2, 0.1, 0.4], 0.75);
    expect(suppressDuplicates([p1, p2], 0.45, 0.7)).toHaveLength(2);
    // Encostadas com leve sobreposição (contenção 0.3, IoU ~0.18): ambas ficam.
    const p3 = person([0.3, 0.2, 0.1, 0.4], 0.8);
    const p4 = person([0.37, 0.2, 0.1, 0.4], 0.75);
    expect(containment(p3.bbox, p4.bbox)).toBeLessThan(0.7);
    expect(suppressDuplicates([p3, p4], 0.45, 0.7)).toHaveLength(2);
  });

  it("supressão é POR CLASSE: pessoa contida num caminhão não some", () => {
    const truck = person([0.2, 0.1, 0.5, 0.7], 0.9, "truck");
    const driver = person([0.3, 0.2, 0.1, 0.2], 0.6); // dentro do caminhão
    expect(suppressDuplicates([truck, driver], 0.45, 0.7)).toHaveLength(2);
  });
});

describe("coveredByAny (camada visual: det de pessoa já coberta por um track)", () => {
  const track: [number, number, number, number] = [0.3, 0.2, 0.2, 0.6];
  it("det quase idêntica ao track (IoU alto) está coberta", () => {
    expect(coveredByAny([0.31, 0.21, 0.2, 0.6], [track], 0.45, 0.7)).toBe(true);
  });
  it("det parcial contida no track está coberta (mesmo com IoU baixo)", () => {
    expect(coveredByAny([0.32, 0.2, 0.16, 0.25], [track], 0.45, 0.7)).toBe(true);
  });
  it("det de OUTRA pessoa (longe / sobreposição fraca) NÃO está coberta", () => {
    expect(coveredByAny([0.7, 0.2, 0.2, 0.6], [track], 0.45, 0.7)).toBe(false);
    expect(coveredByAny([0.46, 0.2, 0.2, 0.6], [track], 0.45, 0.7)).toBe(false);
  });
  it("sem tracks, nada está coberto (câmera sem tracker desenha as dets)", () => {
    expect(coveredByAny([0.3, 0.2, 0.2, 0.6], [], 0.45, 0.7)).toBe(false);
  });
});
