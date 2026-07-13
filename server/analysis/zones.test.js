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
  pointInPolygon,
  isSimplePolygon,
  sanitizeZonePoints,
  polygonBBox,
  rasterizePolygonMask,
} = require("./zones");

// FIXTURES COMPARTILHADAS (spec zonas-poligonais CA-4): o MESMO arquivo é consumido por
// src/zones.test.ts — paridade TS↔JS do pointInPolygon/isSimplePolygon (armadilha 9).
const FIX = require("../../src/zones-polygon-fixtures.json");

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

// ── ZONAS POLIGONAIS (spec zonas-poligonais F1 — espelho do hub) ──────────────

// CA-4: as fixtures compartilhadas passam IDÊNTICAS no hub (este arquivo) e no cliente
// (src/zones.test.ts) — o 1º sensor de paridade cross-language da casa.
describe("polígono — paridade das fixtures compartilhadas (CA-4, lado JS)", () => {
  it("pointInPolygon responde exatamente o registrado (inclui bordas/vértices — CA-3 no L)", () => {
    for (const c of FIX.containment) {
      const poly = FIX.polygons[c.polygon];
      expect(poly, `polígono ${c.polygon} existe nas fixtures`).toBeDefined();
      expect(
        pointInPolygon(c.point, poly),
        `${c.polygon} @ (${c.point.x},${c.point.y}): ${c.why}`,
      ).toBe(c.inside);
    }
  });

  it("isSimplePolygon valida/bloqueia exatamente o registrado (P2/P3)", () => {
    for (const s of FIX.simplicity)
      expect(isSimplePolygon(s.points), `${s.name}: ${s.why}`).toBe(s.simple);
  });

  it("pointInPolygon é seguro p/ entrada degenerada (<3 pontos / não-array → false)", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, FIX.polygons.quadrado.slice(0, 2))).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, null)).toBe(false);
  });
});

// bbox derivada dos points (como cleanZone grava) — os testes de zona abaixo usam esta helper.
function polyZone(label, points) {
  const bb = polygonBBox(points);
  return { id: label, label, x: bb.x, y: bb.y, w: bb.w, h: bb.h, points };
}

describe("attributeZone — zona POLIGONAL (centro EXATO no polígono; points>mask — P5/CA-5/CA-6)", () => {
  const elle = polyZone("Elle", FIX.polygons.elle);

  it("CA-3: pessoa dentro do L atribui; pessoa no VÃO do L não atribui", () => {
    expect(attributeZone(bboxAt(0.2, 0.3), [elle])).toBe("Elle"); // braço vertical
    expect(attributeZone(bboxAt(0.45, 0.7), [elle])).toBe("Elle"); // pé horizontal
    expect(attributeZone(bboxAt(0.45, 0.3), [elle])).toBeNull(); // vão (dentro da BBOX!)
  });

  it("points VENCE mask quando ambos existem (a máscara vira legado — P5)", () => {
    // máscara que só aceitaria a metade DIREITA (x ≥ 0.5) — o oposto do braço do L
    const m = createMask(2, 1);
    fillRectNorm(m, 0.5, 0, 0.5, 1, true);
    const ambos = { ...polyZone("Ambos", FIX.polygons.elle), mask: encodeMask(m) };
    expect(attributeZone(bboxAt(0.2, 0.3), [ambos])).toBe("Ambos"); // polígono decide (máscara diria não)
    expect(attributeZone(bboxAt(0.45, 0.3), [ambos])).toBeNull(); // vão do L (máscara diria não também)
  });

  it("desempate segue o mesmo: polígono côncavo × zona aberta sobreposta", () => {
    const aberta = zone("Aberta", 0.3, 0.1, 0.3, 0.5); // cobre o vão do L
    expect(attributeZone(bboxAt(0.45, 0.3), [elle, aberta])).toBe("Aberta"); // vão → só a aberta contém
    expect(attributeZone(bboxAt(0.2, 0.3), [elle, aberta])).toBe("Elle"); // braço → só o L contém
  });
});

describe("inExclusionZone — zona POLIGONAL (âncora segue no PÉ — CA-6)", () => {
  const elle = polyZone("ElleEx", FIX.polygons.elle);

  it("PÉ dentro do polígono exclui; PÉ no vão do L não exclui (mesmo com centro noutro lugar)", () => {
    // bbox alto: pé em (0.2, 0.7) dentro do pé do L; centro em y=0.5 estaria no braço também
    expect(inExclusionZone([0.15, 0.3, 0.1, 0.4], [elle])).toBe(true);
    // pé em (0.45, 0.3) → vão do L (dentro da bbox envolvente!) → NÃO exclui
    expect(inExclusionZone([0.4, 0.1, 0.1, 0.2], [elle])).toBe(false);
    // âncora é o PÉ, não o centro: centro no vão (0.45,0.3) mas pé em (0.45,0.7) dentro do L → exclui
    expect(inExclusionZone([0.4, 0.1, 0.1, 0.6], [elle])).toBe(true);
  });
});

// ── A REGRA DA UNIFICAÇÃO (spec-zona-unificada) ───────────────────────────────
// `points` é a FONTE DA VERDADE; `x/y/w/h` é CACHE da envolvente — DERIVADO, NUNCA AUTORADO.
describe("O RETÂNGULO É UM POLÍGONO DE 4 VÉRTICES (o preset da migração — lado hub)", () => {
  const RECT = { x: 0.2, y: 0.3, w: 0.4, h: 0.5 };
  const asPoly = FIX.polygons.retangulo; // = [{x,y},{x+w,y},{x+w,y+h},{x,y+h}] do RECT acima

  // A regra da migração (G2/cleanZone): rect → [{x,y},{x+w,y},{x+w,y+h},{x,y+h}].
  const migrar = (r) => [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];

  it("a regra da migração reproduz a fixture — a MENOS DE 1 ULP (0.2+0.4 ≠ 0.6 em IEEE754)", () => {
    const gerado = migrar(RECT);
    gerado.forEach((p, i) => {
      expect(p.x).toBeCloseTo(asPoly[i].x, 12);
      expect(p.y).toBeCloseTo(asPoly[i].y, 12);
    });
    // O DETALHE QUE MORDE quem escrever `toEqual` na migração (mordeu aqui): a SOMA não é exata.
    expect(RECT.x + RECT.w).not.toBe(0.6); // 0.6000000000000001 — erro de 5,55e-17 (1 ulp)
    expect(RECT.y + RECT.h).toBe(0.8); // e esta É exata: o erro depende do par, não da regra
  });

  it("a envolvente volta ≤1 ulp (a migração não move a zona) e NÃO DERIVA ao re-migrar", () => {
    const bb = polygonBBox(migrar(RECT));
    expect(bb.x).toBe(RECT.x); // min/max não somam → x,y voltam EXATOS
    expect(bb.y).toBe(RECT.y);
    expect(bb.w).toBeCloseTo(RECT.w, 12); // w = (x+w)−x → carrega o ulp da soma
    expect(bb.h).toBeCloseTo(RECT.h, 12);
    expect(Math.abs(bb.w - RECT.w)).toBeLessThan(1e-15); // 5,55e-17: sub-nanopixel, inofensivo

    // IDEMPOTÊNCIA (a premissa do cleanZone da G2: migrar no load/save, sem script): re-derivar a
    // bbox a partir dos MESMOS points dá o MESMO resultado — o erro não se acumula a cada save.
    const bb2 = polygonBBox(migrar(RECT));
    expect(bb2).toEqual(bb);
    // e uma zona JÁ migrada não é re-migrada (points vencem): a bbox segue vindo dos points.
    expect(polygonBBox(asPoly).w).toBeCloseTo(RECT.w, 12);
  });

  it("mesma decisão do retângulo NO INTERIOR: a pessoa não troca de zona ao migrar", () => {
    const antes = zone("Doca", RECT.x, RECT.y, RECT.w, RECT.h); // sem points (hoje)
    const depois = polyZone("Doca", asPoly); // migrada (bbox derivada)
    for (const p of [
      { x: 0.4, y: 0.55 }, // centro
      { x: 0.25, y: 0.35 }, // perto do canto de cima-esquerda
      { x: 0.55, y: 0.75 }, // perto do canto de baixo-direita
      { x: 0.1, y: 0.55 }, // fora
      { x: 0.4, y: 0.95 }, // fora
    ])
      expect(attributeZone(p, [depois]), `(${p.x},${p.y})`).toBe(attributeZone(p, [antes]));
  });
});

describe("A REGRA: points é FONTE DA VERDADE, x/y/w/h é CACHE derivado (NUNCA autorado)", () => {
  const pts = FIX.polygons.retangulo; // vive em x 0.2..0.6, y 0.3..0.8

  it("bbox MENTIROSA (autorada) faz a zona ENGOLIR a pessoa em silêncio — é por isso que a regra existe", () => {
    // Zona cujo polígono está no meio do frame mas cuja bbox foi AUTORADA lá no canto (0.9,0.9).
    // O pré-filtro retangular roda ANTES do teste fino em TODOS os call-sites (attributeZone,
    // inExclusionZone, assignZone): a bbox mentirosa corta a pessoa antes de o polígono opinar.
    // Falha CALADA — a zona simplesmente nunca atribui. Este é o modo de falha que a regra mata.
    const mentirosa = { id: "m", label: "Mentirosa", x: 0.9, y: 0.9, w: 0.05, h: 0.05, points: pts };
    expect(attributeZone({ x: 0.4, y: 0.55 }, [mentirosa])).toBeNull(); // dentro do POLÍGONO, e mesmo assim NULL

    // Com a bbox RE-DERIVADA dos points (o que withDefaults/cleanZone fazem), a zona atribui.
    const correta = polyZone("Mentirosa", pts);
    expect(attributeZone({ x: 0.4, y: 0.55 }, [correta])).toBe("Mentirosa");
  });

  it("a mentira é ASSIMÉTRICA: bbox MENOR que a envolvente PERDE gente; MAIOR só custa CPU", () => {
    const menor = { id: "a", label: "Menor", x: 0.3, y: 0.4, w: 0.1, h: 0.1, points: pts };
    // (0.55,0.75) está DENTRO do polígono, mas fora da bbox encolhida → perdido, calado.
    expect(attributeZone({ x: 0.55, y: 0.75 }, [menor])).toBeNull();

    const maior = { id: "b", label: "Maior", x: 0, y: 0, w: 1, h: 1, points: pts };
    // bbox inflada só deixa passar mais candidatos ao teste fino — o POLÍGONO segue decidindo.
    expect(attributeZone({ x: 0.4, y: 0.55 }, [maior])).toBe("Maior"); // dentro do polígono
    expect(attributeZone({ x: 0.05, y: 0.05 }, [maior])).toBeNull(); // dentro da bbox, FORA do polígono
  });

  it("inExclusionZone (âncora no PÉ) sofre a MESMA mentira — o pré-filtro é o mesmo", () => {
    const mentirosa = { x: 0.9, y: 0.9, w: 0.05, h: 0.05, points: pts };
    expect(inExclusionZone({ x: 0.4, y: 0.55 }, [mentirosa])).toBe(false); // pé no polígono, e não exclui
    expect(inExclusionZone({ x: 0.4, y: 0.55 }, [polyZone("Ex", pts)])).toBe(true); // bbox derivada → exclui
  });
});

describe("desempate com zonas 100% POLIGONAIS (o mundo pós-migração) — regra intacta", () => {
  // O desempate (maior interseção bbox∩zona, depois MENOR área da bbox) roda sobre a bbox
  // DERIVADA. Se ela deixar de ser derivada, o desempate decide sobre uma geometria fantasma.
  const grande = polyZone("Espera", FIX.polygons["frame-cheio"]); // área 1.0
  const especifica = polyZone("Doca 3", FIX.polygons.retangulo); // área 0.2

  it("bbox contida nas duas → EMPATE de interseção → vence a de MENOR área (a específica)", () => {
    expect(attributeZone(bboxAt(0.4, 0.55, 0.1, 0.1), [grande, especifica])).toBe("Doca 3");
  });

  it("só ponto (sem bbox) → overlap 0 p/ todas → vence a de MENOR área", () => {
    expect(attributeZone({ x: 0.4, y: 0.55 }, [grande, especifica])).toBe("Doca 3");
  });

  it("fora da específica → cai na grande (o polígono, não a envolvente, decide)", () => {
    expect(attributeZone({ x: 0.05, y: 0.05 }, [grande, especifica])).toBe("Espera");
  });

  it("côncava × convexa sobrepostas: o VÃO do L pertence à outra, não ao L", () => {
    const elle = polyZone("Elle", FIX.polygons.elle);
    expect(attributeZone({ x: 0.45, y: 0.3 }, [elle, grande])).toBe("Espera"); // vão do L
    expect(attributeZone({ x: 0.2, y: 0.3 }, [elle, grande])).toBe("Elle"); // braço do L (menor área)
  });
});

describe("polígono — sanitizeZonePoints/polygonBBox (espelho da validação do cleanZone)", () => {
  it("válido → clamp; malformado (curto/21+/NaN/auto-intersecção) → undefined, NUNCA []", () => {
    const tri = [
      { x: -0.5, y: 0.2 },
      { x: 1.8, y: 0.2 },
      { x: 0.5, y: 0.7 },
    ];
    expect(sanitizeZonePoints(tri)).toEqual([
      { x: 0, y: 0.2 },
      { x: 1, y: 0.2 },
      { x: 0.5, y: 0.7 },
    ]);
    expect(sanitizeZonePoints(undefined)).toBeUndefined();
    expect(sanitizeZonePoints([])).toBeUndefined();
    expect(sanitizeZonePoints(tri.slice(0, 2))).toBeUndefined();
    expect(
      sanitizeZonePoints(Array.from({ length: 21 }, (_, i) => ({ x: i / 30, y: 0.5 }))),
    ).toBeUndefined();
    expect(sanitizeZonePoints([{ x: 0.1, y: 0.1 }, { x: NaN, y: 0.2 }, { x: 0.5, y: 0.7 }])).toBeUndefined();
    expect(sanitizeZonePoints(FIX.simplicity.find((s) => s.name === "gravata").points)).toBeUndefined();
  });

  it("polygonBBox deriva a envolvente (pré-filtro retangular dos call-sites)", () => {
    const bb = polygonBBox(FIX.polygons.elle); // w/h por subtração de floats → tolerância
    expect(bb.x).toBeCloseTo(0.1, 10);
    expect(bb.y).toBeCloseTo(0.1, 10);
    expect(bb.w).toBeCloseTo(0.5, 10);
    expect(bb.h).toBeCloseTo(0.7, 10);
  });
});

// P6 — rasterização (espelho de rasterizePolygonMask em src/zones.ts). No hub o consumidor é o
// GATE DE MOVIMENTO (engine.buildMotionIgnore); o teste de comportamento vive em engine.test.js.
// Aqui pinamos a PARIDADE com o cliente: mesma grade, mesmo critério (centro da célula), mesmos bits.
describe("polígono — rasterizePolygonMask (espelho do cliente; critério = CENTRO da célula)", () => {
  it("o L côncavo vira células fiéis: o VÃO não é marcado (mesmos asserts do lado TS)", () => {
    const m = rasterizePolygonMask(10, 10, FIX.polygons.elle);
    expect(m.cols).toBe(10);
    expect(m.rows).toBe(10);
    expect(containsNorm(m, 0.2, 0.3)).toBe(true); // braço vertical
    expect(containsNorm(m, 0.45, 0.7)).toBe(true); // pé horizontal
    expect(containsNorm(m, 0.45, 0.3)).toBe(false); // VÃO do L — dentro da envolvente, fora da zona
    expect(containsNorm(m, 0.95, 0.95)).toBe(false); // fora
  });

  it("retângulo-como-polígono rasteriza no retângulo (a migração não muda o mapa de pixels)", () => {
    const m = rasterizePolygonMask(10, 10, FIX.polygons.retangulo); // x 0.2..0.6, y 0.3..0.8
    expect(containsNorm(m, 0.45, 0.55)).toBe(true);
    expect(containsNorm(m, 0.05, 0.55)).toBe(false);
    expect(containsNorm(m, 0.45, 0.95)).toBe(false);
  });

  it("polígono degenerado (colinear) não marca célula nenhuma — nunca lança", () => {
    const m = rasterizePolygonMask(8, 8, [
      { x: 0.2, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ]);
    expect(anySet(m)).toBe(false);
  });
});
