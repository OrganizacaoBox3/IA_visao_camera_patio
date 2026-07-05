// Testes dos sub-passos puros do rAF (rafSteps.ts) + do espelho do hub (applyHubAnalysis).
// Provam a DECISÃO de agendamento (intervalo/gate/opts) e a conversão HubTrack→Track/pseudo-dets
// SEM tocar no laço de vídeo. Regressões viram teste (CLAUDE.md §6).
import { describe, it, expect } from "vitest";
import { detectionInterval, shouldRunDetection, detectScheduleOpts } from "./rafSteps";
import { applyHubAnalysis, type HubApplyRefs } from "./useHubAnalysis";
import { type Detection } from "../vision/model";
import type { HubAnalysis, HubZone, Track } from "../CameraWorkspace";

describe("detectionInterval", () => {
  it("full usa o intervalo rápido; grade usa o lento", () => {
    expect(detectionInterval("full", 350, 4000)).toBe(350);
    expect(detectionInterval("tile", 350, 4000)).toBe(4000);
  });
});

describe("shouldRunDetection", () => {
  it("dispara só quando passou o intervalo E não há detecção em voo", () => {
    expect(shouldRunDetection(1000, 0, 350, false)).toBe(true);
    expect(shouldRunDetection(1000, 800, 350, false)).toBe(false); // intervalo não passou
    expect(shouldRunDetection(1000, 0, 350, true)).toBe(false); // em voo
  });
});

describe("detectScheduleOpts", () => {
  it("câmera aberta: tiled + prioridade high, sem tiling LR", () => {
    const { tiled, opts } = detectScheduleOpts("cam1", "full", false);
    expect(tiled).toBe(true);
    expect(opts.schedule).toEqual({ key: "cam1:atividade", priority: "high" });
    expect(opts.tiles).toBeUndefined();
  });
  it("grade: prioridade low + não-tiled", () => {
    const { tiled, opts } = detectScheduleOpts("cam1", "tile", false);
    expect(tiled).toBe(false);
    expect(opts.schedule?.priority).toBe("low");
  });
  it("longo alcance injeta tiles/tileWidth/minScore", () => {
    const { opts } = detectScheduleOpts("cam1", "full", true);
    expect(opts.tiles).toBeDefined();
    expect(opts.tileWidth).toBeDefined();
    expect(opts.minScore).toBeDefined();
  });
});

// Helpers p/ montar refs de teste (mesma forma que useRef: { current }).
function makeRefs(): HubApplyRefs {
  return {
    tracksRef: { current: [] as Track[] },
    detsRef: { current: [] as Detection[] },
    hubZonesRef: { current: null as HubZone[] | null },
    hubTracksTsRef: { current: 0 },
    hubFirstSeenRef: { current: new Map<number, number>() },
  };
}
const hub = (ts: number): HubAnalysis => ({
  ts,
  tracks: [{ id: 7, bbox: [0.2, 0.1, 0.4, 0.5], cx: 0.4, cy: 0.35, zone: "A", score: 0.8 }],
  zones: [{ id: "z1", label: "A", people: 1, occupied: true }],
});

describe("applyHubAnalysis", () => {
  it("payload fresco converte tracks (foot no pé do bbox) + pseudo-dets em pixels", () => {
    const refs = makeRefs();
    applyHubAnalysis(true, hub(Date.now()), 1000, 640, 480, refs);
    expect(refs.tracksRef.current).toHaveLength(1);
    const t = refs.tracksRef.current[0];
    expect(t.foot).toEqual({ x: 0.2 + 0.4 / 2, y: 0.1 + 0.5 });
    expect(t.firstSeen).toBe(1000);
    expect(refs.detsRef.current[0].bbox).toEqual([0.2 * 640, 0.1 * 480, 0.4 * 640, 0.5 * 480]);
    expect(refs.hubZonesRef.current).toEqual(hub(0).zones);
  });
  it("payload STALE limpa tracks/dets/zonas", () => {
    const refs = makeRefs();
    refs.tracksRef.current = [{ id: 1 } as Track];
    applyHubAnalysis(true, hub(Date.now() - 10_000), 1000, 640, 480, refs);
    expect(refs.tracksRef.current).toHaveLength(0);
    expect(refs.hubZonesRef.current).toBeNull();
  });
  it("mesmo ts não reconverte (gate de payload novo)", () => {
    const refs = makeRefs();
    const p = hub(Date.now());
    applyHubAnalysis(true, p, 1000, 640, 480, refs);
    const firstArr = refs.tracksRef.current;
    applyHubAnalysis(true, p, 2000, 640, 480, refs); // mesmo ts
    expect(refs.tracksRef.current).toBe(firstArr); // não realocou
  });
  it("firstSeen persiste por id entre payloads; ids mortos são podados", () => {
    const refs = makeRefs();
    const t0 = Date.now(); // ts recente (dentro da janela de frescor) — só o ts precisa diferir
    applyHubAnalysis(true, hub(t0), 1000, 640, 480, refs);
    applyHubAnalysis(true, hub(t0 + 1), 5000, 640, 480, refs);
    expect(refs.tracksRef.current[0].firstSeen).toBe(1000); // manteve o 1º avistamento
    expect(refs.hubFirstSeenRef.current.has(7)).toBe(true);
  });
  it("engine local com resíduo do hub limpa o estado espelho", () => {
    const refs = makeRefs();
    refs.hubZonesRef.current = [{ id: "z1", label: "A", people: 1, occupied: true }];
    refs.hubTracksTsRef.current = 123;
    applyHubAnalysis(false, null, 1000, 640, 480, refs);
    expect(refs.hubZonesRef.current).toBeNull();
    expect(refs.hubTracksTsRef.current).toBe(0);
  });
});
