// Testes da SUAVIZAÇÃO display-only das caixas do hub (lógica pura, sem DOM/rAF/React).
// Cobre: LERP escalar, nascimento no alvo, deslize por frame, poda de id sumido e reuso de buffers.
import { describe, it, expect } from "vitest";
import { lerp, easeHubTracks, makeHubEaseState } from "./useHubAnalysis";
import type { Track } from "../CameraWorkspace";

// Track mínimo p/ os testes: só os campos que o easing lê/copia importam; o resto é preenchido.
function mkTrack(id: number, bbox: [number, number, number, number], score = 1): Track {
  return {
    id,
    cx: bbox[0] + bbox[2] / 2,
    cy: bbox[1] + bbox[3] / 2,
    foot: { x: bbox[0] + bbox[2] / 2, y: bbox[1] + bbox[3] },
    bbox,
    firstSeen: 0,
    lastSeen: 0,
    zone: null,
    score,
  };
}

describe("lerp", () => {
  it("t=0 → a, t=1 → b, t=0.5 → média", () => {
    expect(lerp(2, 10, 0)).toBe(2);
    expect(lerp(2, 10, 1)).toBe(10);
    expect(lerp(2, 10, 0.5)).toBe(6);
  });
});

describe("easeHubTracks", () => {
  it("nova detecção NASCE no alvo (sem deslizar do zero)", () => {
    const st = makeHubEaseState();
    const out = easeHubTracks([mkTrack(1, [0.2, 0.3, 0.1, 0.4])], st, 0.25);
    expect(out).toHaveLength(1);
    expect(out[0].bbox).toEqual([0.2, 0.3, 0.1, 0.4]);
  });

  it("desliza a bbox EXIBIDA até o alvo entre frames (fator 0.25)", () => {
    const st = makeHubEaseState();
    // frame 1: nasce em x=0
    easeHubTracks([mkTrack(1, [0, 0, 0.1, 0.1])], st, 0.25);
    // frame 2: alvo salta p/ x=1 → exibido desliza 25% → 0.25 (não salta p/ 1)
    const out = easeHubTracks([mkTrack(1, [1, 0, 0.1, 0.1])], st, 0.25);
    expect(out[0].bbox[0]).toBeCloseTo(0.25, 6);
    expect(out[0].bbox[0]).toBeLessThan(1); // ainda a caminho do alvo
  });

  it("mantém id/score EXATOS; só a bbox é a suavizada (display×lógica)", () => {
    const st = makeHubEaseState();
    easeHubTracks([mkTrack(7, [0, 0, 0.1, 0.1], 0.9)], st, 0.25);
    const out = easeHubTracks([mkTrack(7, [1, 0, 0.1, 0.1], 0.8)], st, 0.25);
    expect(out[0].id).toBe(7);
    expect(out[0].score).toBe(0.8); // score é o EXATO do último payload
    expect(out[0].bbox[0]).toBeCloseTo(0.25, 6); // bbox é a EXIBIDA (deslizando)
  });

  it("poda id que sumiu do payload (sem vazar box/pool)", () => {
    const st = makeHubEaseState();
    easeHubTracks([mkTrack(1, [0, 0, 0.1, 0.1]), mkTrack(2, [0.5, 0, 0.1, 0.1])], st, 0.25);
    expect(st.box.size).toBe(2);
    const out = easeHubTracks([mkTrack(2, [0.5, 0, 0.1, 0.1])], st, 0.25);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);
    expect(st.box.has(1)).toBe(false);
    expect(st.pool.has(1)).toBe(false);
    expect(st.box.size).toBe(1);
  });

  it("reusa o array de saída entre frames (sem realocar no hot-path)", () => {
    const st = makeHubEaseState();
    const a = easeHubTracks([mkTrack(1, [0, 0, 0.1, 0.1])], st, 0.25);
    const b = easeHubTracks([mkTrack(1, [0.5, 0, 0.1, 0.1])], st, 0.25);
    expect(b).toBe(a); // mesma referência de array reusada
    expect(b).toBe(st.out);
  });
});
