import { describe, expect, it } from "vitest";
import { createMotionTrack, DEFAULT_MOTION_FILTER_CONFIG, updateMotionTrack } from "./motion-filter";

describe("motion-filter", () => {
  it("inicia com a primeira posição observada", () => {
    const track = createMotionTrack({
      ts: 1_000,
      pos: { x: 1, y: 2 },
      confidence: "alta",
      uncertaintyM: 0.4,
    });
    expect(track.pos).toEqual({ x: 1, y: 2 });
    expect(track.lastReliableTs).toBe(1_000);
    expect(track.uncertaintyM).toBe(0.4);
  });

  it("não teleporta diante de salto fisicamente impossível", () => {
    const initial = createMotionTrack({ ts: 0, pos: { x: 0, y: 0 }, confidence: "alta" });
    const next = updateMotionTrack(initial, {
      ts: 1_000,
      pos: { x: 100, y: 0 },
      confidence: "alta",
    });
    expect(next.pos!.x).toBeGreaterThan(0);
    expect(next.pos!.x).toBeLessThanOrEqual(DEFAULT_MOTION_FILTER_CONFIG.maxSpeedMps);
    expect(next.uncertaintyM).toBeGreaterThan(0);
  });

  it("declara parado apenas após observações próximas repetidas", () => {
    let track = createMotionTrack({ ts: 0, pos: { x: 1, y: 1 }, confidence: "media" });
    track = updateMotionTrack(track, {
      ts: 1_000,
      pos: { x: 1.1, y: 1 },
      confidence: "media",
    });
    expect(track.state).toBe("andando");
    track = updateMotionTrack(track, {
      ts: 2_000,
      pos: { x: 1.1, y: 1.05 },
      confidence: "media",
    });
    expect(track.state).toBe("parado");
  });

  it("mantém a última posição como incerta e aumenta o halo sem evidência", () => {
    const initial = createMotionTrack({
      ts: 0,
      pos: { x: 2, y: 2 },
      confidence: "alta",
      uncertaintyM: 0.5,
    });
    const next = updateMotionTrack(initial, { ts: 2_000, pos: null, confidence: "nenhuma" });
    expect(next.pos).toEqual({ x: 2, y: 2 });
    expect(next.state).toBe("incerto");
    expect(next.uncertaintyM).toBeGreaterThan(0.5);
  });

  it("expira a posição mantida depois do TTL", () => {
    const initial = createMotionTrack({
      ts: 0,
      pos: { x: 2, y: 2 },
      confidence: "alta",
    });
    const next = updateMotionTrack(initial, {
      ts: DEFAULT_MOTION_FILTER_CONFIG.holdMs + 1,
      pos: null,
      confidence: "nenhuma",
    });
    expect(next.pos).toBeNull();
    expect(next.state).toBe("incerto");
  });

  it("ignora uma evidência atrasada", () => {
    const initial = createMotionTrack({ ts: 2_000, pos: { x: 1, y: 1 }, confidence: "alta" });
    const next = updateMotionTrack(initial, {
      ts: 1_000,
      pos: { x: 9, y: 9 },
      confidence: "alta",
    });
    expect(next).toBe(initial);
  });

  it("re-entrada pós-gap CURTO é ancorada na última posição (sem teleporte)", () => {
    // Confiável em (2,2) no ts=0; hold expira (pos → null); volta em ts=15s a 100 m de distância.
    let track = createMotionTrack({ ts: 0, pos: { x: 2, y: 2 }, confidence: "alta" });
    track = updateMotionTrack(track, {
      ts: DEFAULT_MOTION_FILTER_CONFIG.holdMs + 1_000,
      pos: null,
      confidence: "nenhuma",
    });
    expect(track.pos).toBeNull(); // expirou
    expect(track.lastPos).toEqual({ x: 2, y: 2 }); // mas a âncora sobrevive
    const back = updateMotionTrack(track, {
      ts: 15_000,
      pos: { x: 100, y: 2 },
      confidence: "alta",
    });
    // Passo limitado por v_max × gap (1,8 m/s × 15 s = 27 m a partir de x=2) — nunca os 100 m.
    expect(back.pos).not.toBeNull();
    expect(back.pos!.x).toBeLessThanOrEqual(2 + DEFAULT_MOTION_FILTER_CONFIG.maxSpeedMps * 15 + 1e-9);
    expect(back.uncertaintyM).toBeGreaterThan(0); // o trecho rejeitado vira incerteza declarada
  });

  it("re-entrada pós-gap LONGO reseta honestamente (a pessoa pode ter ido a qualquer lugar)", () => {
    let track = createMotionTrack({ ts: 0, pos: { x: 2, y: 2 }, confidence: "alta" });
    track = updateMotionTrack(track, {
      ts: DEFAULT_MOTION_FILTER_CONFIG.holdMs + 1_000,
      pos: null,
      confidence: "nenhuma",
    });
    const back = updateMotionTrack(track, {
      ts: DEFAULT_MOTION_FILTER_CONFIG.recoverMs + 60_000,
      pos: { x: 100, y: 2 },
      confidence: "alta",
    });
    expect(back.pos).toEqual({ x: 100, y: 2 }); // reset: aceita a nova posição como recomeço
  });
});
