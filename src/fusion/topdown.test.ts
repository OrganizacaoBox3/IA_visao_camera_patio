import { describe, it, expect } from "vitest";
import { deriveTopdownView, worldToCanvas, topdownBounds, bboxOf } from "./topdown";
import type { Matrix3 } from "../vision/homography";

// H IDENTIDADE: worldToPixel(identity) = mundo→pixel 1:1 ⇒ pixelToWorld(identity, px) = px.
// Assim os pontos de imagem viram diretamente coordenadas de mundo nos testes.
const IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const CORNERS = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 5 },
  { x: 0, y: 5 },
];
const STATIONS = [
  { id: "A", px: { x: 0, y: 0 }, label: "Doca A", live: true },
  { id: "B", px: { x: 10, y: 0 }, label: "Doca B", live: true },
];

describe("deriveTopdownView — a vista de topo (nearest-beacon honesto)", () => {
  it("nearest = beacon de MAIOR rssi (o mais próximo); um anel por beacon que ouve", () => {
    const view = deriveTopdownView({
      H: IDENTITY,
      corners: CORNERS,
      stations: STATIONS,
      readings: [
        { stationId: "A", mac: "AA:BB", rssi: -70 },
        { stationId: "B", mac: "AA:BB", rssi: -55 }, // mais forte → B é o mais próximo
      ],
    });
    expect(view.floorWorld).toHaveLength(4);
    expect(view.beacons.map((b) => b.id).sort()).toEqual(["A", "B"]);
    expect(view.tags).toHaveLength(1);
    expect(view.tags[0].nearest?.beaconId).toBe("B");
    expect(view.tags[0].rings).toHaveLength(2); // ouvida por A e B
  });

  it("beacon MORTO não mede: nem anel nem nearest por ele (controle negativo com dente)", () => {
    const view = deriveTopdownView({
      H: IDENTITY,
      corners: CORNERS,
      stations: [
        { id: "A", px: { x: 0, y: 0 }, label: "A", live: false }, // morto
        { id: "B", px: { x: 10, y: 0 }, label: "B", live: true },
      ],
      readings: [
        { stationId: "A", mac: "AA", rssi: -50 }, // mais forte, MAS o beacon está morto
        { stationId: "B", mac: "AA", rssi: -80 },
      ],
    });
    // A está morto → não conta; nearest tem de ser B mesmo com rssi pior.
    expect(view.tags[0].nearest?.beaconId).toBe("B");
    expect(view.tags[0].rings.map((r) => r.beaconId)).toEqual(["B"]);
  });

  it("sem H → sem mundo: floorWorld e beacons vazios; tag sem nearest", () => {
    const view = deriveTopdownView({
      H: null,
      corners: CORNERS,
      stations: STATIONS,
      readings: [{ stationId: "A", mac: "AA", rssi: -60 }],
    });
    expect(view.floorWorld).toHaveLength(0);
    expect(view.beacons).toHaveLength(0);
    expect(view.tags).toHaveLength(0); // sem beacon vivo com mundo → tag não entra
  });

  it("tag ouvida só por beacon INEXISTENTE (id sem estação) → não entra", () => {
    const view = deriveTopdownView({
      H: IDENTITY,
      corners: CORNERS,
      stations: STATIONS,
      readings: [{ stationId: "Z", mac: "AA", rssi: -60 }], // Z não é estação
    });
    expect(view.tags).toHaveLength(0);
  });
});

describe("worldToCanvas — enquadramento", () => {
  it("centraliza e escala o bbox no canvas com margem, preservando aspecto", () => {
    const bbox = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const tf = worldToCanvas(bbox, { w: 120, h: 120 }, 10);
    // 10 m em 100 px úteis → 10 px/m; canto (0,0) → (10,10) (a margem).
    expect(tf.scale).toBeCloseTo(10, 5);
    expect(tf.project({ x: 0, y: 0 })).toEqual({ x: 10, y: 10 });
    expect(tf.project({ x: 10, y: 10 })).toEqual({ x: 110, y: 110 });
  });

  it("bbox degenerado (ponto único) → escala 1 px/m, nunca NaN/Infinity", () => {
    const tf = worldToCanvas({ minX: 3, minY: 3, maxX: 3, maxY: 3 }, { w: 100, h: 100 }, 0);
    expect(Number.isFinite(tf.scale)).toBe(true);
    const p = tf.project({ x: 3, y: 3 });
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });

  it("topdownBounds cobre chão + beacons + a extensão dos anéis", () => {
    const view = deriveTopdownView({
      H: IDENTITY,
      corners: CORNERS,
      stations: STATIONS,
      readings: [{ stationId: "B", mac: "AA", rssi: -55 }],
    });
    const bb = topdownBounds(view);
    expect(bb).not.toBeNull();
    // o anel ao redor de B (x=10) estende o maxX além de 10.
    expect(bb!.maxX).toBeGreaterThan(10);
  });

  it("bboxOf: sem ponto válido → null", () => {
    expect(bboxOf([])).toBeNull();
  });
});
