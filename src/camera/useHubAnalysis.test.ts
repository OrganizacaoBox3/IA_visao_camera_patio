// Testes do sub-passo PURO do rAF: applyHubAnalysis (espelho do MOTOR DO HUB → tracksRef/detsRef).
// A suavização display-only foi UNIFICADA no TrackInterpolator (interpolate.ts / interpolate.test.ts);
// o antigo easeHubTracks e seus testes saíram daqui. Cobrimos o que resta neste módulo: conversão
// HubTrack → Track (foot/score/firstSeen), pseudo-dets em PIXELS p/ a contagem, persistência+poda do
// firstSeen por id entre payloads, gate de payload novo e descarte de payload STALE.
import { describe, it, expect } from "vitest";
import { applyHubAnalysis, type HubApplyRefs } from "./useHubAnalysis";
import type { HubAnalysis, HubZone, Track } from "../CameraWorkspace";
import type { Detection } from "../vision/model";

function mkRefs(): HubApplyRefs {
  return {
    tracksRef: { current: [] as Track[] },
    detsRef: { current: [] as Detection[] },
    hubZonesRef: { current: null as HubZone[] | null },
    hubTracksTsRef: { current: 0 },
    hubFirstSeenRef: { current: new Map<number, number>() },
  };
}

// Payload FRESCO: ts ancorado em Date.now() (a frescura é Date.now()-ts <= HUB_TRACKS_STALE_MS).
function freshAnalysis(
  tracks: Array<{ id: number; bbox: [number, number, number, number]; score?: number }>,
  ts = Date.now(),
): HubAnalysis {
  return {
    ts,
    tracks: tracks.map((t) => ({ id: t.id, bbox: t.bbox, cx: 0, cy: 0, zone: null, score: t.score })),
    zones: [{ id: "z1", label: "Z1", people: 1, occupied: true }],
  };
}

describe("applyHubAnalysis", () => {
  it("converte HubTrack → Track: foot (bottom-center), score default 1, zones espelhadas", () => {
    const refs = mkRefs();
    applyHubAnalysis(true, freshAnalysis([{ id: 7, bbox: [0.2, 0.3, 0.1, 0.4] }]), 1000, 640, 480, refs);
    expect(refs.tracksRef.current).toHaveLength(1);
    const t = refs.tracksRef.current[0];
    expect(t.id).toBe(7);
    expect(t.foot).toEqual({ x: 0.2 + 0.1 / 2, y: 0.3 + 0.4 }); // bottom-center normalizado
    expect(t.score).toBe(1); // hub sem score → 1 (retrocompat, nunca atenua)
    expect(t.firstSeen).toBe(1000);
    expect(refs.hubZonesRef.current).toHaveLength(1);
  });

  it("preserva o score REAL da detecção quando presente", () => {
    const refs = mkRefs();
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0, 0, 0.1, 0.1], score: 0.42 }]), 0, 640, 480, refs);
    expect(refs.tracksRef.current[0].score).toBe(0.42);
  });

  it("pseudo-dets 'person' em PIXELS p/ a contagem (occupied do AtividadeProcessor)", () => {
    const refs = mkRefs();
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0.5, 0.25, 0.1, 0.2] }]), 0, 640, 480, refs);
    expect(refs.detsRef.current).toHaveLength(1);
    const d = refs.detsRef.current[0];
    expect(d.class).toBe("person");
    expect(d.bbox).toEqual([0.5 * 640, 0.25 * 480, 0.1 * 640, 0.2 * 480]);
  });

  it("firstSeen PERSISTE por id entre payloads e é PODADO quando o id some", () => {
    const refs = mkRefs();
    const t0 = Date.now(); // ts FRESCOS (Date.now()-ts <= stale) mas DISTINTOS (gate de payload novo)
    // payload 1 @ now=100: ids 1 e 2 nascem
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0, 0, 0.1, 0.1] }, { id: 2, bbox: [0.5, 0, 0.1, 0.1] }], t0), 100, 640, 480, refs);
    expect(refs.hubFirstSeenRef.current.get(1)).toBe(100);
    expect(refs.hubFirstSeenRef.current.get(2)).toBe(100);
    // payload 2 (ts diferente) @ now=500: id 1 permanece (firstSeen intacto), id 2 some (podado)
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0.1, 0, 0.1, 0.1] }], t0 + 1), 500, 640, 480, refs);
    expect(refs.hubFirstSeenRef.current.get(1)).toBe(100); // não reinicia
    expect(refs.hubFirstSeenRef.current.has(2)).toBe(false); // podado (mapa não vaza)
    expect(refs.tracksRef.current[0].firstSeen).toBe(100);
  });

  it("gate de payload novo: mesmo ts NÃO reconverte (não desloca firstSeen)", () => {
    const refs = mkRefs();
    const ts = Date.now();
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0, 0, 0.1, 0.1] }], ts), 100, 640, 480, refs);
    const before = refs.tracksRef.current;
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0.9, 0, 0.1, 0.1] }], ts), 999, 640, 480, refs);
    expect(refs.tracksRef.current).toBe(before); // mesmo ts → não reconverteu (mesma ref)
    expect(refs.hubFirstSeenRef.current.get(1)).toBe(100);
  });

  it("payload STALE (ts antigo) limpa tracks/dets/zonas/firstSeen", () => {
    const refs = mkRefs();
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0, 0, 0.1, 0.1] }]), 0, 640, 480, refs);
    expect(refs.tracksRef.current).toHaveLength(1);
    // ts 10s no passado → stale (> HUB_TRACKS_STALE_MS)
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0, 0, 0.1, 0.1] }], Date.now() - 10_000), 0, 640, 480, refs);
    expect(refs.tracksRef.current).toHaveLength(0);
    expect(refs.detsRef.current).toHaveLength(0);
    expect(refs.hubZonesRef.current).toBeNull();
    expect(refs.hubFirstSeenRef.current.size).toBe(0);
  });

  it("engine local (hubActive=false) limpa o resíduo do hub e não converte", () => {
    const refs = mkRefs();
    applyHubAnalysis(true, freshAnalysis([{ id: 1, bbox: [0, 0, 0.1, 0.1] }]), 0, 640, 480, refs);
    applyHubAnalysis(false, null, 0, 640, 480, refs);
    expect(refs.hubZonesRef.current).toBeNull();
    expect(refs.hubTracksTsRef.current).toBe(0);
    expect(refs.hubFirstSeenRef.current.size).toBe(0);
  });
});
