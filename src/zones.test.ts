// Testes das lógicas PURAS de zona: máscara em grade (geometria + (de)serialização) em zoneMask.ts
// e os utilitários puros de zones.ts. loadZones/saveZones dependem de localStorage (browser) →
// PULADOS aqui (cobertos pelo e2e); ver observação no relatório.
import { describe, it, expect } from "vitest";
import {
  createMask,
  maskGet,
  maskSet,
  anySet,
  clearMask,
  cellAtNorm,
  containsNorm,
  fillRectNorm,
  paintBrush,
  maskBBoxNorm,
  encodeMask,
  decodeMask,
  maskFromRect,
} from "./zoneMask";
import { newZoneId, ZONE_MODE_COLOR, ZONE_MODE_LABEL } from "./zones";

describe("zoneMask — geometria de máscara", () => {
  it("get/set respeitam limites e ignoram fora da grade", () => {
    const m = createMask(4, 3);
    expect(anySet(m)).toBe(false);
    maskSet(m, 1, 2, true);
    expect(maskGet(m, 1, 2)).toBe(true);
    expect(anySet(m)).toBe(true);
    maskSet(m, 10, 10, true); // fora → no-op
    expect(maskGet(m, 10, 10)).toBe(false);
    expect(maskGet(m, -1, 0)).toBe(false);
    clearMask(m);
    expect(anySet(m)).toBe(false);
  });

  it("cellAtNorm mapeia ponto normalizado p/ célula (com clamp nas bordas)", () => {
    const m = createMask(4, 4);
    expect(cellAtNorm(m, 0.0, 0.0)).toEqual({ col: 0, row: 0 });
    expect(cellAtNorm(m, 0.99, 0.99)).toEqual({ col: 3, row: 3 });
    expect(cellAtNorm(m, 1.0, 1.0)).toEqual({ col: 3, row: 3 }); // clamp p/ não estourar
    expect(cellAtNorm(m, -0.5, -0.5)).toEqual({ col: 0, row: 0 });
  });

  it("containsNorm reflete a célula pintada sob o ponto", () => {
    const m = createMask(2, 2);
    maskSet(m, 0, 0, true); // quadrante superior-esquerdo
    expect(containsNorm(m, 0.25, 0.25)).toBe(true);
    expect(containsNorm(m, 0.75, 0.75)).toBe(false);
  });

  it("fillRectNorm pinta o retângulo normalizado e maskBBoxNorm devolve a bbox", () => {
    const m = createMask(10, 10);
    fillRectNorm(m, 0.2, 0.2, 0.3, 0.3, true);
    expect(containsNorm(m, 0.3, 0.3)).toBe(true);
    expect(containsNorm(m, 0.9, 0.9)).toBe(false);
    const bb = maskBBoxNorm(m);
    expect(bb).not.toBeNull();
    expect(bb!.x).toBeCloseTo(0.2, 6);
    expect(bb!.y).toBeCloseTo(0.2, 6);
    expect(bb!.w).toBeGreaterThan(0);
    expect(bb!.h).toBeGreaterThan(0);
  });

  it("maskBBoxNorm é null p/ máscara vazia", () => {
    expect(maskBBoxNorm(createMask(5, 5))).toBeNull();
  });

  it("paintBrush pinta um quadrado de raio em torno da célula", () => {
    const m = createMask(5, 5);
    paintBrush(m, 2, 2, 1, true); // 3×3 ao redor de (2,2)
    expect(maskGet(m, 2, 2)).toBe(true);
    expect(maskGet(m, 1, 1)).toBe(true);
    expect(maskGet(m, 3, 3)).toBe(true);
    expect(maskGet(m, 0, 0)).toBe(false); // fora do raio
  });

  it("maskFromRect cria máscara cheia equivalente ao retângulo", () => {
    const m = maskFromRect(8, 8, 0, 0, 1, 1);
    expect(anySet(m)).toBe(true);
    expect(containsNorm(m, 0.5, 0.5)).toBe(true);
  });
});

describe("zoneMask — (de)serialização compacta (round-trip)", () => {
  it("encode→decode preserva dimensões e bits", () => {
    const m = createMask(6, 4);
    maskSet(m, 0, 0, true);
    maskSet(m, 5, 3, true);
    maskSet(m, 2, 1, true);
    const enc = encodeMask(m);
    expect(enc).toMatch(/^6x4:/); // formato "<cols>x<rows>:<base64>"
    const dec = decodeMask(enc);
    expect(dec).not.toBeNull();
    expect(dec!.cols).toBe(6);
    expect(dec!.rows).toBe(4);
    expect([...dec!.bits]).toEqual([...m.bits]);
  });

  it("decodeMask retorna null p/ entradas inválidas", () => {
    expect(decodeMask(undefined)).toBeNull();
    expect(decodeMask("")).toBeNull();
    expect(decodeMask("sem-separador")).toBeNull();
    expect(decodeMask("0x0:abc")).toBeNull();
  });
});

describe("zones — utilitários puros", () => {
  it("newZoneId gera ids únicos com prefixo da câmera", () => {
    const a = newZoneId("cam-1");
    const b = newZoneId("cam-1");
    expect(a).toMatch(/^cam-1-z/);
    expect(b).toMatch(/^cam-1-z/);
    expect(a).not.toBe(b); // seq incremental garante unicidade no mesmo ms
  });

  it("mapas de cor/rótulo cobrem todos os modos", () => {
    const modos = ["atividade", "leitura", "objetos", "fadiga"] as const;
    for (const modo of modos) {
      expect(ZONE_MODE_COLOR[modo]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(typeof ZONE_MODE_LABEL[modo]).toBe("string");
      expect(ZONE_MODE_LABEL[modo].length).toBeGreaterThan(0);
    }
  });
});
