import { describe, expect, it } from "vitest";
import { derivePlayerFrame } from "./derive-player-frame";
import { computeHomography } from "../../vision/homography";
import type { SimTick } from "../sim";

// Mesmos 4 pontos de sim.ts (FLOOR_PAIRS) — chão 8×6 m em perspectiva.
const calib = computeHomography([
  { px: { x: 0.15, y: 0.92 }, world: { x: 0, y: 0 } },
  { px: { x: 0.85, y: 0.92 }, world: { x: 8, y: 0 } },
  { px: { x: 0.68, y: 0.3 }, world: { x: 8, y: 6 } },
  { px: { x: 0.32, y: 0.3 }, world: { x: 0, y: 6 } },
]);
if (!calib.ok) throw new Error(`teste: homografia degenerada (${calib.error})`);
const H = calib.H;

const STATION_PX = { x: 0.15, y: 0.92 }; // canto (0,0) — mesmo ponto do 1º par

function tick(overrides: Partial<SimTick> = {}): SimTick {
  return {
    ts: 0,
    tracks: [{ id: 1, bbox: [0.1, 0.5, 0.1, 0.2] }],
    readings: [],
    truthTagByTrack: { 1: "AA:AA" },
    ...overrides,
  };
}

describe("derivePlayerFrame", () => {
  it("vista-câmera devolve as bboxes tal como gravadas (sem transformação)", () => {
    const frame = derivePlayerFrame(tick(), H, STATION_PX);
    expect(frame.camera).toEqual([{ id: 1, bbox: [0.1, 0.5, 0.1, 0.2] }]);
  });

  it("vista-planta projeta o PÉ do bbox (bottom-center) a mundo, com H calibrada", () => {
    const frame = derivePlayerFrame(tick(), H, STATION_PX);
    expect(frame.planta).toHaveLength(1);
    const pos = frame.planta[0].worldPos;
    expect(pos).not.toBeNull();
    // Pé em (0.15, 0.7) — perto do canto (0,0) do chão, mas não exatamente nele (y menor que 0.92).
    expect(pos!.x).toBeGreaterThan(-1);
    expect(pos!.x).toBeLessThan(3);
  });

  it("SEM H (cenário não-calibrado): planta e estação saem null, nunca inventa posição", () => {
    const frame = derivePlayerFrame(tick(), null, STATION_PX);
    expect(frame.planta).toEqual([{ id: 1, worldPos: null }]);
    expect(frame.stationWorld).toBeNull();
    // vista-câmera segue intacta — a ausência de H só afeta a planta.
    expect(frame.camera).toHaveLength(1);
  });

  it("estação projeta perto da origem-mundo (canto 0,0) com a H calibrada", () => {
    const frame = derivePlayerFrame(tick(), H, STATION_PX);
    expect(frame.stationWorld).not.toBeNull();
    expect(frame.stationWorld!.x).toBeCloseTo(0, 0);
    expect(frame.stationWorld!.y).toBeCloseTo(0, 0);
  });

  it("repassa verdade-terreno e âncoras do tick/cenário sem alterar", () => {
    const anchors = [{ mac: "FX:01", world: { x: 1, y: 1 } }];
    const frame = derivePlayerFrame(tick({ truthTagByTrack: { 1: "AA:AA", 2: null } }), H, STATION_PX, anchors);
    expect(frame.truthTagByTrack).toEqual({ 1: "AA:AA", 2: null });
    expect(frame.anchorsWorld).toEqual([{ mac: "FX:01", world: { x: 1, y: 1 } }]);
  });

  it("sem âncoras no cenário, anchorsWorld sai vazio (nunca undefined)", () => {
    const frame = derivePlayerFrame(tick(), H, STATION_PX);
    expect(frame.anchorsWorld).toEqual([]);
  });

  it("múltiplos tracks — cada um com sua própria projeção, ordem preservada", () => {
    const frame = derivePlayerFrame(
      tick({
        tracks: [
          { id: 1, bbox: [0.1, 0.5, 0.1, 0.2] },
          { id: 2, bbox: [0.6, 0.6, 0.1, 0.2] },
        ],
      }),
      H,
      STATION_PX,
    );
    expect(frame.camera.map((t) => t.id)).toEqual([1, 2]);
    expect(frame.planta.map((t) => t.id)).toEqual([1, 2]);
    expect(frame.planta.every((t) => t.worldPos !== null)).toBe(true);
  });
});
