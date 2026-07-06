// Testes da atribuição de zona (server/analysis/zones.js) — PORT do zoneAtAtiv
// de src/CameraWorkspace.tsx (+ máscara de src/zoneMask.ts). O TS de origem não
// tinha unit test (função vivia dentro do componente); estes testes FIXAM o
// comportamento documentado lá: centro-na-zona (mask-aware) como critério
// primário, desempate por MAIOR interseção bbox∩zona, depois MENOR área.
// Mudanças de comportamento devem ser feitas no TS de origem e re-portadas.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  attributeZone,
  inExclusionZone,
  createMask,
  anySet,
  containsNorm,
  fillRectNorm,
  encodeMask,
  decodeMask,
} = require("./zones");

// Zona mínima (modo é irrelevante aqui: o caller pré-filtra por modo, como no TS).
function zone(label, x, y, w, h, mask) {
  return { id: label, label, x, y, w, h, mask };
}
// bbox normalizada a partir do CENTRO (compatível com Track.bbox: cx/cy É o centro).
function bboxAt(cx, cy, w = 0.1, h = 0.2) {
  return [cx - w / 2, cy - h / 2, w, h];
}

describe("attributeZone — critério primário: centro dentro da zona", () => {
  it("centro dentro de uma única zona → label dela; fora de todas → null", () => {
    const zs = [zone("Doca", 0.2, 0.2, 0.4, 0.4)];
    expect(attributeZone(bboxAt(0.4, 0.4), zs)).toBe("Doca");
    expect(attributeZone(bboxAt(0.8, 0.8), zs)).toBeNull();
  });

  it("lista vazia → null", () => {
    expect(attributeZone(bboxAt(0.5, 0.5), [])).toBeNull();
  });

  it("borda é INCLUSIVA (centro exatamente sobre o limite da zona conta)", () => {
    const zs = [zone("Z", 0.2, 0.2, 0.4, 0.4)];
    expect(attributeZone({ x: 0.2, y: 0.4 }, zs)).toBe("Z"); // x == z.x
    expect(attributeZone({ x: 0.6, y: 0.4 }, zs)).toBe("Z"); // x == z.x + z.w
  });

  it("aceita ponto {x,y} e {cx,cy} além de bbox [x,y,w,h]", () => {
    const zs = [zone("Z", 0.2, 0.2, 0.4, 0.4)];
    expect(attributeZone({ x: 0.4, y: 0.4 }, zs)).toBe("Z");
    expect(attributeZone({ cx: 0.4, cy: 0.4 }, zs)).toBe("Z");
    expect(attributeZone([0.35, 0.3, 0.1, 0.2], zs)).toBe("Z");
  });
});

describe("attributeZone — desempate em zonas sobrepostas (regra: maior interseção, depois menor área)", () => {
  it("zona-semente full-frame ANTES na lista NÃO rouba: bbox contido em ambas → vence a MENOR (a desenhada)", () => {
    // Cenário de campo: seed "Espera" cobre o frame todo e vem primeiro; a zona
    // desenhada pelo operador é menor. bbox∩seed == bbox∩desenhada (bbox contido
    // nas duas) → empate de overlap → vence a de MENOR área (a mais específica).
    const zs = [zone("Espera", 0, 0, 1, 1), zone("Doca 3", 0.35, 0.3, 0.3, 0.5)];
    expect(attributeZone(bboxAt(0.5, 0.5), zs)).toBe("Doca 3");
  });

  it("MAIOR interseção bbox∩zona vence quando os overlaps diferem", () => {
    // Coordenadas múltiplas de 1/16 (exatas em binário — sem ruído de float no empate).
    // A (x 0.25..0.625) e B (x 0.5..0.875), mesma faixa de y e MESMA área.
    const zs = [zone("A", 0.25, 0.25, 0.375, 0.5), zone("B", 0.5, 0.25, 0.375, 0.5)];
    // bbox x 0.5..0.625 (centro 0.5625 ∈ ambas), simétrico entre A e B:
    // ov(A) = ov(B) exatos → empate de overlap E de área → PRIMEIRA da lista.
    expect(attributeZone([0.5, 0.375, 0.125, 0.25], zs)).toBe("A");
    // bbox x 0.5625..0.6875 (centro 0.625 ∈ ambas): ov(B) 0.125 > ov(A) 0.0625
    // → B vence mesmo vindo depois na lista.
    expect(attributeZone([0.5625, 0.375, 0.125, 0.25], zs)).toBe("B");
  });

  it("sem bbox (só ponto), overlap é 0 p/ todas → vence a de MENOR área", () => {
    const zs = [zone("Grande", 0, 0, 1, 1), zone("Pequena", 0.4, 0.4, 0.2, 0.2)];
    expect(attributeZone({ x: 0.5, y: 0.5 }, zs)).toBe("Pequena");
  });
});

describe("attributeZone — mask-aware (máscara portável, sem canvas)", () => {
  // Zona full-frame com máscara pintada só na METADE ESQUERDA (x < 0.5).
  const m = createMask(32, 18);
  fillRectNorm(m, 0, 0, 0.5, 1, true);
  const masked = zone("Pintada", 0, 0, 1, 1, encodeMask(m));

  it("centro dentro do retângulo mas FORA das células pintadas → zona não atribui", () => {
    expect(attributeZone(bboxAt(0.75, 0.5), [masked])).toBeNull();
  });

  it("centro dentro das células pintadas → atribui", () => {
    expect(attributeZone(bboxAt(0.25, 0.5), [masked])).toBe("Pintada");
  });

  it("máscara VAZIA (nenhuma célula pintada) degrada p/ retângulo cheio (paridade com anySet)", () => {
    const empty = zone("Vazia", 0.2, 0.2, 0.4, 0.4, encodeMask(createMask(32, 18)));
    expect(attributeZone(bboxAt(0.4, 0.4), [empty])).toBe("Vazia");
  });

  it("máscara malformada → ignorada (zona vale como retângulo; nunca lança)", () => {
    const bad = zone("Ruim", 0.2, 0.2, 0.4, 0.4, "32x18:%%%não-base64%%%");
    expect(attributeZone(bboxAt(0.4, 0.4), [bad])).toBe("Ruim");
  });

  it("com máscara excluindo o centro, a zona sobreposta SEM máscara ganha", () => {
    const plain = zone("Aberta", 0.5, 0, 0.5, 1);
    expect(attributeZone(bboxAt(0.75, 0.5), [masked, plain])).toBe("Aberta");
  });
});

describe("helpers de máscara — paridade com src/zoneMask.ts", () => {
  it("encodeMask/decodeMask fazem roundtrip bit a bit (formato <cols>x<rows>:<base64>)", () => {
    const m = createMask(32, 18);
    fillRectNorm(m, 0.1, 0.2, 0.3, 0.4, true);
    const enc = encodeMask(m);
    expect(enc).toMatch(/^32x18:[A-Za-z0-9+/]+=*$/);
    const back = decodeMask(enc);
    expect(back).not.toBeNull();
    expect(back.cols).toBe(32);
    expect(back.rows).toBe(18);
    expect([...back.bits]).toEqual([...m.bits]);
  });

  it("decodeMask → null p/ ausente, sem separador, dims inválidas e base64 inválido", () => {
    expect(decodeMask(undefined)).toBeNull();
    expect(decodeMask("")).toBeNull();
    expect(decodeMask("semseparador")).toBeNull();
    expect(decodeMask("0x18:AAAA")).toBeNull();
    expect(decodeMask("32x18:@@@@")).toBeNull(); // atob lançaria no browser → null
  });

  it("anySet/containsNorm seguem a grade (célula do ponto normalizado)", () => {
    const m = createMask(4, 4);
    expect(anySet(m)).toBe(false);
    fillRectNorm(m, 0, 0, 0.25, 0.25, true); // só a célula (0,0)
    expect(anySet(m)).toBe(true);
    expect(containsNorm(m, 0.1, 0.1)).toBe(true);
    expect(containsNorm(m, 0.9, 0.9)).toBe(false);
  });
});

// Zona de exclusão: critério = o PÉ (bottom-center do bbox), não o centro (Medida A).
describe("inExclusionZone — âncora no pé (bottom-center), mask-aware", () => {
  const zEx = { x: 0.4, y: 0.6, w: 0.2, h: 0.3 }; // retângulo no canto inferior-central

  it("lista vazia / ausente → false", () => {
    expect(inExclusionZone([0.45, 0.7, 0.1, 0.15], [])).toBe(false);
    expect(inExclusionZone([0.45, 0.7, 0.1, 0.15], null)).toBe(false);
  });

  it("PÉ dentro do retângulo → true; PÉ fora → false", () => {
    // bbox cujo pé (x+w/2=0.5, y+h=0.75) cai dentro da zona
    expect(inExclusionZone([0.45, 0.6, 0.1, 0.15], [zEx])).toBe(true);
    // mesmo bbox deslocado p/ a direita: pé em x=0.9 → fora
    expect(inExclusionZone([0.85, 0.6, 0.1, 0.15], [zEx])).toBe(false);
  });

  it("ancora no PÉ, não no centro: centro fora mas pé dentro → true", () => {
    // bbox alto: centro em y=0.5 (acima da zona, y≥0.6) mas o pé em y=0.7 entra
    const bbox = [0.45, 0.3, 0.1, 0.4]; // pé = (0.5, 0.7)
    const cy = bbox[1] + bbox[3] / 2; // 0.5 — fora da zona
    expect(cy < zEx.y).toBe(true); // o centro NÃO entraria
    expect(inExclusionZone(bbox, [zEx])).toBe(true); // mas o pé sim
  });

  it("aceita ponto {x,y} já no pé", () => {
    expect(inExclusionZone({ x: 0.5, y: 0.7 }, [zEx])).toBe(true);
    expect(inExclusionZone({ x: 0.1, y: 0.1 }, [zEx])).toBe(false);
  });

  it("mask-aware: pé no retângulo mas fora da máscara pintada → false", () => {
    // máscara cobrindo só a metade ESQUERDA da zona (célula da esquerda)
    const m = createMask(2, 1);
    fillRectNorm(m, 0, 0, 0.5, 1, true); // só col 0 (x<0.5) pintada
    const z = { ...zEx, mask: encodeMask(m) };
    // pé em x=0.45 → col 0 (pintada) → exclui
    expect(inExclusionZone([0.4, 0.6, 0.1, 0.2], [z])).toBe(true);
    // pé em x=0.55 → dentro do retângulo mas col 1 (não pintada) → não exclui
    expect(inExclusionZone([0.5, 0.6, 0.1, 0.2], [z])).toBe(false);
  });
});
