import { describe, it, expect } from "vitest";
import { multilaterate, deriveFloorplanView, type FloorplanStation } from "./floorplan";
import { distFromRssi, type PathLossModel } from "./floor-plot";

// Modelo default DECLARADO (o mesmo do núcleo) — usado para inverter distância→rssi nos testes de
// deriveFloorplanView, de modo que uma distância-verdade vire o rssi que a produz por aquele modelo.
const MODEL: PathLossModel = { rssi0: -45, n: 2.2, source: "default", samples: 0 };
/** rssi que, pelo MODEL, o distFromRssi devolve como distância `d` (inverso do path-loss). */
const rssiForDist = (d: number): number => MODEL.rssi0 - 10 * MODEL.n * Math.log10(d);

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

describe("deriveFloorplanView — a Planta BLE (estimativa grampeada)", () => {
  it("3 antenas vivas ouvindo 1 tag → fix ok, pos dentro do retângulo, nStations 3", () => {
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
    expect(t.fix).toBe("ok");
    expect(t.nStations).toBe(3);
    expect(t.pos).not.toBeNull();
    expect(t.pos!.x).toBeGreaterThanOrEqual(0);
    expect(t.pos!.x).toBeLessThanOrEqual(WIDTH);
    expect(t.pos!.y).toBeGreaterThanOrEqual(0);
    expect(t.pos!.y).toBeLessThanOrEqual(HEIGHT);
    // Sem ruído a estimativa bate no verdade (o modelo inverteu exato).
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

  it("clamp: config que multilateraria FORA do retângulo → pos grampeada às bordas", () => {
    // Ponto-verdade FORA do galpão (x=-5,y=-5): a multilateração acha ~(-5,-5), o grampo puxa p/ (0,0).
    const truth = { x: -5, y: -5 };
    const view = deriveFloorplanView({
      widthM: WIDTH,
      heightM: HEIGHT,
      stations: STATIONS,
      readings: readingsAt("FF:FF:FF:FF:FF:FF", truth, ["A", "B", "C"]),
      model: MODEL,
    });
    const t = view.tags[0];
    expect(t.fix).toBe("ok");
    expect(t.pos).not.toBeNull();
    // Grampeado: dentro do retângulo, e nesta config específica cai no canto (0,0).
    expect(t.pos!.x).toBeGreaterThanOrEqual(0);
    expect(t.pos!.y).toBeGreaterThanOrEqual(0);
    expect(t.pos!.x).toBe(0);
    expect(t.pos!.y).toBe(0);
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
