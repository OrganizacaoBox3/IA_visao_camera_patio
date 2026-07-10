// Testes do módulo PURO de geometria de chão navegável (src/fusion/floor-polygon.ts).
// Tudo em coordenadas de MUNDO (metros) — sem homografia, sem câmera, 100% determinístico.
import { describe, it, expect } from "vitest";
import { pointInPolygon, clipRingToPolygon, type Polygon } from "./floor-polygon";
import type { Vec2 } from "../vision/homography";

/** Retângulo simples 0,0 a 5,5 — usado na maioria dos testes. */
const RECT: Polygon = [
  { x: 0, y: 0 },
  { x: 5, y: 0 },
  { x: 5, y: 5 },
  { x: 0, y: 5 },
];

describe("pointInPolygon", () => {
  it("ponto claramente dentro do retângulo → true", () => {
    expect(pointInPolygon({ x: 2.5, y: 2.5 }, RECT)).toBe(true);
  });

  it("ponto claramente fora do retângulo → false", () => {
    expect(pointInPolygon({ x: 10, y: 10 }, RECT)).toBe(false);
    expect(pointInPolygon({ x: -1, y: 2 }, RECT)).toBe(false);
  });

  it("polígono com <3 pontos (ou vazio) → sempre false — sem chão navegável, nada é navegável", () => {
    expect(pointInPolygon({ x: 1, y: 1 }, [])).toBe(false);
    expect(pointInPolygon({ x: 1, y: 1 }, [{ x: 0, y: 0 }])).toBe(false);
    expect(
      pointInPolygon({ x: 1, y: 1 }, [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toBe(false);
  });

  it("ponto inválido (NaN/Infinity) → false, não contamina o teste", () => {
    expect(pointInPolygon({ x: NaN, y: 1 }, RECT)).toBe(false);
    expect(pointInPolygon({ x: 1, y: Infinity }, RECT)).toBe(false);
  });

  it("ponto exatamente sobre a borda: resultado não é garantido, mas é DETERMINÍSTICO (mesma entrada → mesma resposta)", () => {
    const onEdge: Vec2 = { x: 5, y: 2.5 };
    const r1 = pointInPolygon(onEdge, RECT);
    const r2 = pointInPolygon(onEdge, RECT);
    expect(r1).toBe(r2);
  });

  it("polígono não-convexo em L: distingue dentro/fora nas reentrâncias", () => {
    // L ocupa a união dos retângulos (0,0)-(4,2) e (0,2)-(2,4); a reentrância
    // (2,2)-(4,4) fica FORA do polígono.
    const lShape: Polygon = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 4 },
      { x: 0, y: 4 },
    ];
    expect(pointInPolygon({ x: 1, y: 1 }, lShape)).toBe(true); // perna inferior
    expect(pointInPolygon({ x: 3, y: 1 }, lShape)).toBe(true); // perna inferior-direita
    expect(pointInPolygon({ x: 1, y: 3 }, lShape)).toBe(true); // perna esquerda-superior
    expect(pointInPolygon({ x: 3, y: 3 }, lShape)).toBe(false); // reentrância — fora do L
  });
});

describe("clipRingToPolygon — casos triviais", () => {
  it("anel inteiro dentro do polígono → 1 arco = o anel inteiro, mesma ordem", () => {
    const ring: Vec2[] = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 1, y: 2 },
    ];
    expect(clipRingToPolygon(ring, RECT)).toEqual([ring]);
  });

  it("anel inteiro fora do polígono → []", () => {
    const ring: Vec2[] = [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 11, y: 11 },
    ];
    expect(clipRingToPolygon(ring, RECT)).toEqual([]);
  });

  it("anel vazio → []", () => {
    expect(clipRingToPolygon([], RECT)).toEqual([]);
  });

  it("polígono inválido (<3 pontos ou vazio) → [] — mesma regra segura de pointInPolygon", () => {
    const ring: Vec2[] = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    expect(clipRingToPolygon(ring, [])).toEqual([]);
    expect(
      clipRingToPolygon(ring, [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toEqual([]);
  });
});

describe("clipRingToPolygon — anel que cruza a borda", () => {
  it("anel com transições dentro/fora, incluindo wraparound pelo início/fim do array → arcos corretos", () => {
    // Pontos escolhidos à mão pra deixar o resultado esperado óbvio (sem depender de
    // trigonometria): p4,p5 formam um arco contíguo; p7,p0,p1 formam outro arco que
    // "dá a volta" pelo fim/início do array (por isso o algoritmo precisa girar o
    // início da varredura, não apenas percorrer o array em ordem linear).
    const p0: Vec2 = { x: 1, y: 1 }; // dentro
    const p1: Vec2 = { x: 2, y: 1 }; // dentro
    const p2: Vec2 = { x: 6, y: 1 }; // fora
    const p3: Vec2 = { x: 6, y: 2 }; // fora
    const p4: Vec2 = { x: 2, y: 2 }; // dentro
    const p5: Vec2 = { x: 1, y: 2 }; // dentro
    const p6: Vec2 = { x: 1, y: 6 }; // fora
    const p7: Vec2 = { x: 0.5, y: 0.5 }; // dentro
    const ring = [p0, p1, p2, p3, p4, p5, p6, p7];

    const arcs = clipRingToPolygon(ring, RECT);

    expect(arcs).toEqual([
      [p4, p5],
      [p7, p0, p1],
    ]);
    for (const arc of arcs) {
      for (const p of arc) {
        expect(pointInPolygon(p, RECT)).toBe(true);
      }
    }
  });

  it("anel circular cruzando os 4 lados do retângulo → múltiplos arcos, todo ponto de cada arco está dentro", () => {
    const center: Vec2 = { x: 2.5, y: 2.5 };
    const radius = 3.2; // maior que a metade do lado (2.5) → cruza a borda
    const segments = 36;
    const ring: Vec2[] = [];
    for (let i = 0; i < segments; i++) {
      const th = (2 * Math.PI * i) / segments;
      ring.push({ x: center.x + radius * Math.cos(th), y: center.y + radius * Math.sin(th) });
    }

    const arcs = clipRingToPolygon(ring, RECT);

    expect(arcs.length).toBeGreaterThan(1);

    // Os arcos particionam exatamente os pontos "dentro" do anel — nenhum a mais, nenhum a menos.
    const insideCountExpected = ring.filter((p) => pointInPolygon(p, RECT)).length;
    const totalArcPoints = arcs.reduce((acc, a) => acc + a.length, 0);
    expect(totalArcPoints).toBe(insideCountExpected);

    for (const arc of arcs) {
      expect(arc.length).toBeGreaterThan(0);
      for (const p of arc) {
        expect(pointInPolygon(p, RECT)).toBe(true);
      }
    }
  });
});
