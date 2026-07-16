import { describe, it, expect } from "vitest";
import { multilaterate, deriveFloorplanView, type FloorplanStation } from "./floorplan";
import { distFromRssi, type PathLossModel } from "./floor-plot";

// Modelo default DECLARADO (o mesmo do núcleo) — usado para inverter distância→rssi nos testes de
// deriveFloorplanView, de modo que uma distância-verdade vire o rssi que a produz por aquele modelo.
const MODEL: PathLossModel = { rssi0: -45, n: 2.2, source: "default", samples: 0 };
/** rssi que, pelo MODEL, o distFromRssi devolve como distância `d` (inverso do path-loss). */
const rssiForDist = (d: number): number => MODEL.rssi0 - 10 * MODEL.n * Math.log10(d);
const rssiForModelDist = (model: PathLossModel, d: number): number =>
  model.rssi0 - 10 * model.n * Math.log10(d);

describe("multilaterate — mínimos quadrados linearizados", () => {
  it("3 antenas, ponto-verdade (3,4) SEM ruído → recupera (3,4) com erro < 1e-6", () => {
    const truth = { x: 3, y: 4 };
    const antennas = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    const obs = antennas.map((pos) => ({ pos, distM: Math.hypot(pos.x - truth.x, pos.y - truth.y) }));
    const res = multilaterate(obs);
    expect(res).not.toBeNull();
    expect(Math.hypot(res!.pos.x - truth.x, res!.pos.y - truth.y)).toBeLessThan(1e-6);
    expect(res!.residualM).toBeLessThan(1e-6);
  });

  it("com ruído pequeno nas distâncias → erro pequeno e residualM > 0", () => {
    const truth = { x: 3, y: 4 };
    const antennas = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
    ];
    const noise = [0.15, -0.1, 0.08, -0.12];
    const obs = antennas.map((pos, i) => ({
      pos,
      distM: Math.hypot(pos.x - truth.x, pos.y - truth.y) + noise[i],
    }));
    const res = multilaterate(obs);
    expect(res).not.toBeNull();
    expect(Math.hypot(res!.pos.x - truth.x, res!.pos.y - truth.y)).toBeLessThan(0.5);
    expect(res!.residualM).toBeGreaterThan(0);
  });

  it("antenas COLINEARES (0,0),(5,0),(10,0) → det≈0 → retorna null (não crasha, não NaN)", () => {
    // A direção Y não é observável quando todas as antenas estão sobre a mesma reta (eixo X):
    // AᵀA fica de posto 1 → |det| < 1e-9 → null honesto (o comportamento documentado no núcleo).
    const antennas = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ];
    const obs = antennas.map((pos) => ({ pos, distM: Math.hypot(pos.x - 3, pos.y - 4) }));
    const res = multilaterate(obs);
    expect(res).toBeNull();
  });

  it("<2 observações → null", () => {
    expect(multilaterate([{ pos: { x: 1, y: 1 }, distM: 2 }])).toBeNull();
    expect(multilaterate([])).toBeNull();
  });
});

// Antenas nos cantos de um galpão 10×8 m. srcKey casa por MAIÚSCULAS (mesmo critério do topdown).
const WIDTH = 10;
const HEIGHT = 8;
const st = (id: string, x: number, y: number, live = true): FloorplanStation => ({
  id,
  label: id,
  pos: { x, y },
  live,
});
const STATIONS: FloorplanStation[] = [
  st("A", 0, 0),
  st("B", 10, 0),
  st("C", 0, 8),
  st("D", 10, 8),
];
/** Leituras que colocam um MAC no ponto-verdade `truth`, ouvido pelas antenas `ids`. */
const readingsAt = (mac: string, truth: { x: number; y: number }, ids: string[], rotulo?: string) =>
  ids.map((id) => {
    const s = STATIONS.find((x) => x.id === id)!;
    return { stationId: id, mac, rssi: rssiForDist(Math.hypot(s.pos.x - truth.x, s.pos.y - truth.y)), rotulo };
  });

describe("deriveFloorplanView — a Planta BLE (estimativa validada antes de publicar)", () => {
  it("3 antenas com modelo global default e geometria coerente → pos contínua, mas fix weak declarado", () => {
    const truth = { x: 3, y: 4 };
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: readingsAt("AA:BB:CC:DD:11:22", truth, ["A", "B", "C"]),
      model: MODEL,
    });
    expect(view.tags).toHaveLength(1);
    const t = view.tags[0];
    expect(t.fix).toBe("weak");
    expect(t.nStations).toBe(3);
    expect(t.quality).toBe("estimated");
    expect(t.source).toBe("multilateration");
    expect(t.modelSource).toBe("default");
    expect(t.residualM).not.toBeNull();
    expect(t.residualM!).toBeLessThan(1e-3);
    expect(t.pos).not.toBeNull();
    expect(t.pos!.x).toBeGreaterThanOrEqual(0);
    expect(t.pos!.x).toBeLessThanOrEqual(WIDTH);
    expect(t.pos!.y).toBeGreaterThanOrEqual(0);
    expect(t.pos!.y).toBeLessThanOrEqual(HEIGHT);
    // Sem ruído a estimativa bate no verdade (o modelo inverteu exato).
    expect(Math.hypot(t.pos!.x - truth.x, t.pos!.y - truth.y)).toBeLessThan(1e-3);
  });

  it("usa o modelo calibrado de CADA estação e só então publica fix ok", () => {
    const truth = { x: 3, y: 4 };
    const stationModels: Record<string, PathLossModel> = {
      a: { rssi0: -51, n: 1.8, source: "anchors", samples: 8 },
      b: { rssi0: -58, n: 2.7, source: "anchors", samples: 9 },
      c: { rssi0: -62, n: 3.1, source: "anchors", samples: 7 },
    };
    const readings = ["A", "B", "C"].map((stationId) => {
      const station = STATIONS.find((candidate) => candidate.id === stationId)!;
      const model = stationModels[stationId.toLowerCase()];
      const distanceM = Math.hypot(station.pos.x - truth.x, station.pos.y - truth.y);
      return {
        stationId,
        mac: "AA:BB:CC:DD:22:33",
        rssi: rssiForModelDist(model, distanceM),
      };
    });
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings,
      model: MODEL,
      stationModels,
    });
    const t = view.tags[0];
    expect(t.fix).toBe("ok");
    expect(t.quality).toBe("good");
    expect(t.modelSource).toBe("anchors");
    expect(t.source).toBe("multilateration");
    expect(t.residualM).not.toBeNull();
    expect(t.residualM!).toBeLessThan(1e-3);
    expect(t.pos).not.toBeNull();
    expect(Math.hypot(t.pos!.x - truth.x, t.pos!.y - truth.y)).toBeLessThan(1e-3);
  });

  it("2 antenas → fix weak, pos não-null dentro do retângulo", () => {
    const truth = { x: 4, y: 3 };
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: readingsAt("11:22:33:44:55:66", truth, ["A", "B"]),
      model: MODEL,
    });
    expect(view.tags).toHaveLength(1);
    const t = view.tags[0];
    expect(t.fix).toBe("weak");
    expect(t.nStations).toBe(2);
    expect(t.quality).toBe("estimated");
    expect(t.source).toBe("two-circle");
    expect(t.residualM).not.toBeNull();
    expect(t.pos).not.toBeNull();
    expect(t.pos!.x).toBeGreaterThanOrEqual(0);
    expect(t.pos!.x).toBeLessThanOrEqual(WIDTH);
    expect(t.pos!.y).toBeGreaterThanOrEqual(0);
    expect(t.pos!.y).toBeLessThanOrEqual(HEIGHT);
  });

  it("1 antena → fix none, pos null, nearest não-null (só distância, não posição)", () => {
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: readingsAt("AB:CD:EF:00:11:22", { x: 2, y: 2 }, ["A"]),
      model: MODEL,
    });
    expect(view.tags).toHaveLength(1);
    const t = view.tags[0];
    expect(t.fix).toBe("none");
    expect(t.nStations).toBe(1);
    expect(t.quality).toBe("unavailable");
    expect(t.source).toBe("none");
    expect(t.residualM).toBeNull();
    expect(t.pos).toBeNull();
    expect(t.nearest).not.toBeNull();
    expect(t.nearest!.stationId).toBe("A");
    expect(t.nearest!.distM).toBeGreaterThan(0);
  });

  it("antena MORTA (live:false) não mede — não conta em nStations", () => {
    const stations = [st("A", 0, 0, true), st("B", 10, 0, false), st("C", 0, 8, true)];
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations,
      // A tag é ouvida pelas 3, mas B está morta → só A e C contam → nStations 2, fix weak.
      readings: readingsAt("DE:AD:00:00:00:01", { x: 3, y: 4 }, ["A", "B", "C"]),
      model: MODEL,
    });
    const t = view.tags[0];
    expect(t.nStations).toBe(2);
    expect(t.fix).toBe("weak");
    // A antena morta ainda aparece como marcador na vista (para desenhar), mas não mediu.
    expect(view.stations.find((s) => s.id === "B")?.live).toBe(false);
    // nearest jamais é a antena morta.
    expect(t.nearest!.stationId).not.toBe("B");
  });

  it("posição resolvida FORA do retângulo é rejeitada antes do clamp — nunca vira canto firme", () => {
    // Ponto-verdade FORA do galpão (x=-5,y=-5): a multilateração acha ~(-5,-5).
    // O contrato novo preserva o diagnóstico e cala a coordenada, em vez de fabricar (0,0).
    const truth = { x: -5, y: -5 };
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: readingsAt("FF:FF:FF:FF:FF:FF", truth, ["A", "B", "C"]),
      model: MODEL,
    });
    const t = view.tags[0];
    expect(t.fix).toBe("none");
    expect(t.quality).toBe("invalid");
    expect(t.source).toBe("multilateration");
    expect(t.pos).toBeNull();
    expect(t.residualM).not.toBeNull();
  });

  it("gate de residual: solução interna que briga com os três raios não é publicada", () => {
    // Três raios de 1 m em antenas separadas por 8–10 m são impossíveis. A solução linear cai
    // dentro da planta, portanto este cenário isola o gate de residual do gate de borda.
    const readings = ["A", "B", "C"].map((stationId) => ({
      stationId,
      mac: "AA:00:00:00:00:01",
      rssi: rssiForDist(1),
    }));
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings,
      model: MODEL,
    });
    const t = view.tags[0];
    expect(t.nStations).toBe(3);
    expect(t.source).toBe("multilateration");
    expect(t.residualM).not.toBeNull();
    expect(t.residualM!).toBeGreaterThan(3);
    expect(t.quality).toBe("invalid");
    expect(t.fix).toBe("none");
    expect(t.pos).toBeNull();
  });

  it("fixture real da Mesa serigrafia no centro: RSSIs incompatíveis não viram canto (3,0)", () => {
    const stations: FloorplanStation[] = [
      st("tc22", 1.4347258485639685, 5),
      st("tc22-0963", 3, 0),
      st("tc22-70a3", 0, 0),
    ];
    const view = deriveFloorplanView({
      widthM: 3,
      heightM: 5,
      stations,
      readings: [
        { stationId: "TC22", mac: "CE:00:00:00:00:01", rssi: -90.0357 },
        { stationId: "TC22-70A3", mac: "CE:00:00:00:00:01", rssi: -79.2857 },
        { stationId: "TC22-0963", mac: "CE:00:00:00:00:01", rssi: -78.0357 },
      ],
      model: MODEL,
    });
    const t = view.tags[0];
    expect(t.nStations).toBe(3);
    expect(t.source).toBe("multilateration");
    expect(t.residualM).not.toBeNull();
    expect(t.residualM!).toBeGreaterThan(100);
    expect(t.quality).toBe("invalid");
    expect(t.fix).toBe("none");
    expect(t.pos).toBeNull();
  });

  it("os quatro vetores vivos do baseline não são clampados nas bordas", () => {
    const stations: FloorplanStation[] = [
      { id: "TC22", label: "TC22", pos: { x: 1.4347258485639685, y: 5 }, live: true },
      { id: "TC22-0963", label: "TC22-0963", pos: { x: 3, y: 0 }, live: true },
      { id: "TC22-70A3", label: "TC22-70A3", pos: { x: 0, y: 0 }, live: true },
    ];
    const signals = [
      { mac: "CE3C", values: [-85, -94, -79] },
      { mac: "CE5C", values: [-91, -83, -81] },
      { mac: "CE89", values: [-95, -83, -79] },
      { mac: "CE8B", values: [-96, -84, -82] },
    ];
    const readings = signals.flatMap(({ mac, values }) =>
      stations.map((station, index) => ({ stationId: station.id, mac, rssi: values[index] })),
    );
    const view = deriveFloorplanView({ widthM: 3, heightM: 5, stations, readings });
    expect(view.tags).toHaveLength(4);
    for (const tag of view.tags) {
      expect(tag.rawPos).not.toBeNull();
      expect(tag.pos).toBeNull();
      expect(tag.fix).toBe("none");
      expect(tag.quality).toBe("invalid");
    }
  });

  it("tag ouvida SÓ por antena morta → não aparece (nada honesto a mostrar)", () => {
    const stations = [st("A", 0, 0, false), st("B", 10, 0, true)];
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations,
      readings: [{ stationId: "A", mac: "00:00:00:00:00:09", rssi: -50 }], // só a antena morta ouviu
      model: MODEL,
    });
    expect(view.tags).toHaveLength(0);
  });

  it("dedup: mesma (antena,mac) com 2 rssi → fica o MAIOR (menor distância)", () => {
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: [
        { stationId: "A", mac: "01:02:03:04:05:06", rssi: -80 }, // longe
        { stationId: "A", mac: "01:02:03:04:05:06", rssi: -50 }, // perto → deve vencer
      ],
      model: MODEL,
    });
    const t = view.tags[0];
    expect(t.nStations).toBe(1);
    // A distância do nearest tem de bater com o rssi MAIOR (-50), não o -80.
    expect(t.nearest!.distM).toBeCloseTo(distFromRssi(MODEL, -50), 6);
  });

  it("label = rotulo quando batizada; senão sufixo de 4 hex do MAC", () => {
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: [
        ...readingsAt("AA:BB:CC:DD:EE:FF", { x: 5, y: 4 }, ["A", "B", "C"], "João"),
        ...readingsAt("11:22:33:44:AB:CD", { x: 6, y: 4 }, ["A", "B", "C"]),
      ],
      model: MODEL,
    });
    const joao = view.tags.find((t) => t.mac === "AA:BB:CC:DD:EE:FF");
    const anon = view.tags.find((t) => t.mac === "11:22:33:44:AB:CD");
    expect(joao?.label).toBe("João");
    expect(anon?.label).toBe("ABCD"); // 4 últimos hex, maiúsculo
  });

  it("robusto a lixo: args inválidos → vista vazia, sem crashar", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = deriveFloorplanView({ widthM: NaN, heightM: -3, stations: null as any, readings: undefined as any });
    expect(view.widthM).toBe(0);
    expect(view.heightM).toBe(0);
    expect(view.stations).toEqual([]);
    expect(view.tags).toEqual([]);
  });

  it("tags ordenadas por MAC (determinístico)", () => {
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: [
        { stationId: "A", mac: "FF:00:00:00:00:00", rssi: -60 },
        { stationId: "A", mac: "00:11:00:00:00:00", rssi: -60 },
        { stationId: "A", mac: "88:00:00:00:00:00", rssi: -60 },
      ],
      model: MODEL,
    });
    expect(view.tags.map((t) => t.mac)).toEqual([
      "00:11:00:00:00:00",
      "88:00:00:00:00:00",
      "FF:00:00:00:00:00",
    ]);
  });
});
