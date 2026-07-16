import { describe, expect, it } from "vitest";
import {
  distanceBandToWorkArea,
  distanceToWorkArea,
  isPointInsidePolygon,
  rectangleToWorkArea,
} from "./work-area";

const table = {
  id: "mesa-serigrafia",
  label: "Mesa serigrafia",
  polygon: [
    { x: 1, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 3 },
    { x: 1, y: 3 },
  ],
};

describe("work-area", () => {
  it("reconhece o interior sem deslocar a posição", () => {
    const point = { x: 1.5, y: 2 };
    expect(isPointInsidePolygon(point, table.polygon)).toBe(true);
    expect(distanceToWorkArea(point, table)).toEqual({
      inside: true,
      distanceM: 0,
      nearestPoint: point,
    });
  });

  it("mede a menor distância até a borda", () => {
    const result = distanceToWorkArea({ x: 3.5, y: 2 }, table);
    expect(result.inside).toBe(false);
    expect(result.distanceM).toBeCloseTo(1.5);
    expect(result.nearestPoint).toEqual({ x: 2, y: 2 });
  });

  it("não inventa distância para geometria incompleta", () => {
    const result = distanceToWorkArea(
      { x: 0, y: 0 },
      { id: "x", label: "X", polygon: [{ x: 1, y: 1 }] },
    );
    expect(result.distanceM).toBe(Number.POSITIVE_INFINITY);
  });

  it("converte centro e dimensões em polígono sem alterar a referência", () => {
    expect(
      rectangleToWorkArea({
        id: "mesa",
        label: "Mesa",
        center: { x: 1.5, y: 2.5 },
        widthM: 1,
        heightM: 2,
      }).polygon,
    ).toEqual([
      { x: 1, y: 1.5 },
      { x: 2, y: 1.5 },
      { x: 2, y: 3.5 },
      { x: 1, y: 3.5 },
    ]);
  });

  it("propaga a incerteza como faixa de distância", () => {
    const result = distanceBandToWorkArea({ x: 3.5, y: 2 }, 0.4, table);
    expect(result.distanceM).toBeCloseTo(1.5);
    expect(result.minDistanceM).toBeCloseTo(1.1);
    expect(result.maxDistanceM).toBeCloseTo(1.9);
  });
});
