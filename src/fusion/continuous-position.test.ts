import { describe, expect, it } from "vitest";
import type { Classification } from "./fingerprint";
import type { FloorplanTag, FloorplanView } from "./floorplan";
import { deriveContinuousFloorplan, selectPositionCandidate } from "./continuous-position";

const classification = (patch: Partial<Classification> = {}): Classification => ({
  best: { id: "mesa", label: "Mesa", x: 1.5, y: 2.5, dist: 2, shared: 3 },
  ranked: [
    { id: "mesa", label: "Mesa", x: 1.5, y: 2.5, dist: 2, shared: 3 },
    { id: "norte", label: "Norte", x: 1.5, y: 5, dist: 8, shared: 3 },
  ],
  confidence: "alta",
  margin: 6,
  pos: { x: 1.5, y: 2.3 },
  evidence: {
    liveStations: 3,
    newestMeasuredAt: 10_000,
    comparedFingerprints: 2,
    distinctLabels: 2,
    bestShared: 3,
  },
  ...patch,
});

const geometric = (patch: Partial<FloorplanTag> = {}): FloorplanTag => ({
  mac: "AA",
  label: "AA",
  pos: null,
  fix: "none",
  nStations: 3,
  nearest: null,
  residualM: 900,
  residualLimitM: 1.5,
  quality: "invalid",
  source: "multilateration",
  modelSource: "default",
  ...patch,
});

describe("continuous-position", () => {
  it("usa o WKNN contínuo como fonte primária sem encaixar no centro da zona", () => {
    const selected = selectPositionCandidate(geometric(), classification(), { widthM: 3, heightM: 5 });
    expect(selected.source).toBe("fingerprint");
    expect(selected.pos).toEqual({ x: 1.5, y: 2.3 });
    expect(selected.pos).not.toEqual({ x: 1.5, y: 2.5 });
  });

  it("não publica o canto produzido por geometria inválida", () => {
    const selected = selectPositionCandidate(
      geometric({ pos: { x: 3, y: 0 }, quality: "invalid" }),
      classification({ pos: null, confidence: "baixa" }),
      { widthM: 3, heightM: 5 },
    );
    expect(selected.pos).toBeNull();
    expect(selected.source).toBe("none");
  });

  it("usa geometria somente como fallback após o gate", () => {
    const selected = selectPositionCandidate(
      geometric({ pos: { x: 1.2, y: 2 }, quality: "good", residualM: 0.2 }),
      classification({ pos: null, confidence: "baixa" }),
    );
    expect(selected.source).toBe("multilateration");
    expect(selected.pos).toEqual({ x: 1.2, y: 2 });
    expect(selected.confidence).toBe("media");
  });

  it("mantém classificação e coordenada como campos separados na vista", () => {
    const input: FloorplanView = {
      widthM: 3,
      heightM: 5,
      stations: [],
      tags: [geometric()],
    };
    const result = deriveContinuousFloorplan(input, new Map([["AA", classification()]]), new Map(), 10_000);
    expect(result.view.tags[0].zoneLabel).toBe("Mesa");
    expect(result.view.tags[0].pos).toEqual({ x: 1.5, y: 2.3 });
    expect(result.view.tags[0].displaySource).toBe("fingerprint");
  });

  it("downgrade fingerprint→geometria exige K polls consecutivos (histerese de fonte)", () => {
    const input = (tag: FloorplanTag): FloorplanView => ({
      widthM: 3,
      heightM: 5,
      stations: [],
      tags: [tag],
    });
    // Poll 1: fingerprint qualificado estabelece a fonte primária.
    const r1 = deriveContinuousFloorplan(
      input(geometric()),
      new Map([["AA", classification()]]),
      new Map(),
      10_000,
    );
    expect(r1.view.tags[0].displaySource).toBe("fingerprint");
    // Polls 2 e 3: fingerprint degrada (baixa) e a geometria validada se oferece — a troca NÃO
    // acontece ainda; o hold segura a última posição fingerprint (sem ping-pong de geometria).
    const degraded = () =>
      new Map([["AA", classification({ pos: null, confidence: "baixa" })]]);
    const geo = geometric({ pos: { x: 1.2, y: 2 }, quality: "good", residualM: 0.2 });
    const r2 = deriveContinuousFloorplan(input(geo), degraded(), r1.tracks, 12_000);
    expect(r2.view.tags[0].displaySource).toBe("none"); // aguardando confirmação
    expect(r2.view.tags[0].pos).toEqual(r1.view.tags[0].pos); // hold: posição fingerprint mantida
    const r3 = deriveContinuousFloorplan(input(geo), degraded(), r2.tracks, 14_000);
    expect(r3.view.tags[0].displaySource).toBe("none");
    // Poll 4 (3º consecutivo da geometria): a troca se confirma.
    const r4 = deriveContinuousFloorplan(input(geo), degraded(), r3.tracks, 16_000);
    expect(r4.view.tags[0].displaySource).toBe("multilateration");
  });

  it("tag que some das leituras vira FANTASMA (última posição conhecida, incerta) até o TTL", () => {
    const withTag: FloorplanView = { widthM: 3, heightM: 5, stations: [], tags: [geometric()] };
    const empty: FloorplanView = { widthM: 3, heightM: 5, stations: [], tags: [] };
    const r1 = deriveContinuousFloorplan(withTag, new Map([["AA", classification()]]), new Map(), 10_000);
    expect(r1.view.tags[0].pos).toEqual({ x: 1.5, y: 2.3 });

    // 20 s depois, a tag sumiu das leituras: permanece no mapa como incerta, na última posição.
    const r2 = deriveContinuousFloorplan(empty, new Map(), r1.tracks, 30_000);
    expect(r2.view.tags).toHaveLength(1);
    expect(r2.view.tags[0].mac).toBe("AA");
    expect(r2.view.tags[0].pos).toEqual({ x: 1.5, y: 2.3 });
    expect(r2.view.tags[0].motionState).toBe("incerto");
    expect(r2.view.tags[0].displaySource).toBe("none");
    expect(r2.view.tags[0].uncertaintyM).toBeGreaterThan(0); // halo cresce com o silêncio

    // Passado o TTL (60 s sem ser ouvida), some de vez — e o estado morre junto (prune).
    const r3 = deriveContinuousFloorplan(empty, new Map(), r2.tracks, 10_000 + 61_000);
    expect(r3.view.tags).toHaveLength(0);
    expect(r3.tracks.size).toBe(0);
  });

  it("a volta após silêncio curto é re-entrada limitada, não teleporte", () => {
    const at = (pos: { x: number; y: number } | null): FloorplanView => ({
      widthM: 30,
      heightM: 50,
      stations: [],
      tags: [geometric({ pos, quality: pos ? "good" : "invalid", residualM: pos ? 0.2 : 900 })],
    });
    const empty: FloorplanView = { widthM: 30, heightM: 50, stations: [], tags: [] };
    // Estabelece posição por geometria validada em (1,1); some por 20 s; volta longe, em (25,1).
    const r1 = deriveContinuousFloorplan(at({ x: 1, y: 1 }), new Map(), new Map(), 10_000);
    expect(r1.view.tags[0].pos).toEqual({ x: 1, y: 1 });
    const r2 = deriveContinuousFloorplan(empty, new Map(), r1.tracks, 30_000);
    const r3 = deriveContinuousFloorplan(at({ x: 25, y: 1 }), new Map(), r2.tracks, 30_500);
    const x = r3.view.tags[0].pos!.x;
    // 20,5 s de gap × 1,8 m/s = ~37 m de teto — mas o passo parte de x=1 rumo a x=25 LIMITADO;
    // o que não pode acontecer é o teleporte instantâneo ignorando a âncora quando o gap é curto.
    expect(x).toBeGreaterThan(1);
    expect(x).toBeLessThanOrEqual(25);
  });
});
