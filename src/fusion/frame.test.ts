import { describe, it, expect } from "vitest";
import { buildFusionFrame } from "./frame";
import type { Matrix3 } from "../vision/homography";

const ID: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]; // identidade: pixelToWorld devolve as próprias coords

describe("buildFusionFrame — distância via homografia", () => {
  it("estação na base-centro; pé mais perto do rodapé = distância menor", () => {
    const tracks = [
      { id: 1, bbox: [0.4, 0.4, 0.2, 0.1] as const }, // pé (0.5, 0.5)
      { id: 2, bbox: [0.4, 0.8, 0.2, 0.1] as const }, // pé (0.5, 0.9) — mais perto da base
    ];
    const f = buildFusionFrame(tracks, [{ mac: "AA", rotulo: "João", rssi: -50 }], ID, 1000);
    const d1 = f.tracks.find((t) => t.trackId === 1)!.dist;
    const d2 = f.tracks.find((t) => t.trackId === 2)!.dist;
    expect(d1).toBeCloseTo(0.5, 5); // |(0.5,0.5) - (0.5,1.0)|
    expect(d2).toBeCloseTo(0.1, 5);
    expect(d2).toBeLessThan(d1); // mais perto da base = mais perto da estação
    expect(f.readings).toEqual([{ tag: "João", rssi: -50 }]); // rótulo vira o `tag`
    expect(f.ts).toBe(1000);
  });
});

describe("buildFusionFrame — fallback sem calibração", () => {
  it("proxy pelo tamanho da caixa: maior = mais perto (dist menor)", () => {
    const tracks = [
      { id: 1, bbox: [0, 0, 0.2, 0.5] as const }, // alta = perto
      { id: 2, bbox: [0, 0, 0.2, 0.25] as const }, // baixa = longe
    ];
    const f = buildFusionFrame(tracks, [], null, 0);
    const d1 = f.tracks.find((t) => t.trackId === 1)!.dist;
    const d2 = f.tracks.find((t) => t.trackId === 2)!.dist;
    expect(d1).toBeLessThan(d2);
  });

  it("reading sem rótulo cai no MAC", () => {
    const f = buildFusionFrame([], [{ mac: "48:87:2D:9D:CE:8D", rotulo: null, rssi: -60 }], null, 0);
    expect(f.readings[0].tag).toBe("48:87:2D:9D:CE:8D");
  });
});
