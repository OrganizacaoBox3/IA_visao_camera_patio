import { describe, it, expect } from "vitest";
import {
  aggregateSamples,
  aggregateTaggedSamples,
  classify,
  type Fingerprint,
} from "./fingerprint";

const fp = (id: string, label: string, vec: Record<string, number>, xy?: [number, number]): Fingerprint => ({
  id,
  label,
  ...(xy ? { x: xy[0], y: xy[1] } : {}),
  createdAt: 0,
  vec: Object.fromEntries(Object.entries(vec).map(([k, m]) => [k, { mean: m, std: 1, n: 10 }])),
});

describe("aggregateSamples", () => {
  it("média/desvio/n por antena, descarta antena sem amostra", () => {
    const v = aggregateSamples({ "EST-A": [-40, -42, -44], "EST-B": [], "EST-C": [-60, -60] });
    expect(v["EST-A"].mean).toBeCloseTo(-42, 6);
    expect(v["EST-A"].std).toBeCloseTo(Math.sqrt((4 + 0 + 4) / 3), 6);
    expect(v["EST-A"].n).toBe(3);
    expect(v["EST-B"]).toBeUndefined(); // sem amostra válida → fora
    expect(v["EST-C"].std).toBe(0);
  });
  it("normaliza o stationId para MAIÚSCULO", () => {
    const v = aggregateSamples({ "est-a": [-50] });
    expect(v["EST-A"]).toBeDefined();
  });
});

describe("classify", () => {
  const db = [
    fp("1", "Doca A", { A: -40, B: -75, C: -78 }, [0, 0]),
    fp("2", "Doca B", { A: -78, B: -40, C: -76 }, [4, 0]),
    fp("3", "Doca C", { A: -77, B: -74, C: -41 }, [2, 3]),
  ];

  it("classifica o vivo para a assinatura mais parecida", () => {
    const r = classify({ A: -42, B: -73, C: -80 }, db);
    expect(r.best?.label).toBe("Doca A");
    expect(r.ranked[0].id).toBe("1");
    expect(r.confidence).toBe("alta"); // bem separado das outras
  });

  it("margem grande → ALTA; margem pequena → não-alta", () => {
    const claro = classify({ A: -40, B: -75, C: -78 }, db);
    expect(claro.confidence).toBe("alta");
    // vetor ambíguo entre A e B (no meio) → margem pequena
    const meio = classify({ A: -59, B: -58, C: -77 }, db);
    expect(meio.margin).toBeLessThan(6);
    expect(["media", "baixa"]).toContain(meio.confidence);
  });

  it("exige minShared: vivo com <2 antenas em comum → nenhuma", () => {
    const r = classify({ Z: -50 }, db); // Z não existe no banco
    expect(r.best).toBeNull();
    expect(r.confidence).toBe("nenhuma");
    expect(r.pos).toBeNull();
  });

  it("banco vazio → best null, nenhuma", () => {
    const r = classify({ A: -40, B: -70 }, []);
    expect(r.best).toBeNull();
    expect(r.confidence).toBe("nenhuma");
  });

  it("WKNN: vivo equidistante de dois pontos → posição entre eles", () => {
    const dois = [
      fp("1", "P0", { A: -40, B: -80 }, [0, 0]),
      fp("2", "P1", { A: -80, B: -40 }, [2, 0]),
    ];
    // exatamente no meio no espaço de RSSI → pesos iguais → ~(1, 0)
    const r = classify(
      { A: -60, B: -60 },
      dois,
      { mediaDb: 0, farFitDb: 30 },
    );
    expect(r.pos).not.toBeNull();
    expect(r.pos!.x).toBeCloseTo(1, 1);
    expect(r.pos!.y).toBeCloseTo(0, 6);
  });

  it("distância RMS só sobre antenas COMPARTILHADAS; ranking ordenado", () => {
    const r = classify({ A: -40, B: -75, C: -78 }, db);
    expect(r.ranked.map((m) => m.id)).toEqual(["1", "2", "3"]);
    expect(r.ranked[0].dist).toBeLessThan(r.ranked[1].dist);
    expect(r.ranked[0].shared).toBe(3);
  });

  it("casa stationId sem depender de caixa (vivo minúsculo × banco maiúsculo)", () => {
    const r = classify({ a: -42, b: -73, c: -80 }, db);
    expect(r.best?.id).toBe("1");
  });

  it("uma zona só + vivo PERTO dela → MÉDIA (nunca alta: não há 2º p/ comparar)", () => {
    const uma = [fp("1", "Doca A", { A: -40, B: -75, C: -78 })];
    const r = classify({ A: -41, B: -74, C: -79 }, uma); // bate bem
    expect(r.best?.label).toBe("Doca A");
    expect(r.confidence).toBe("media"); // NÃO "alta" — bug corrigido
  });

  it("uma zona só + vivo LONGE dela → BAIXA (tag noutro lugar, não na zona)", () => {
    const uma = [fp("1", "Doca A", { A: -40, B: -75, C: -78 })]; // A forte
    const r = classify({ A: -78, B: -75, C: -40 }, uma); // agora C é que está forte → outra zona
    expect(r.confidence).toBe("baixa");
  });

  it("longe de TODAS as zonas conhecidas → BAIXA mesmo com margem (ajuste absoluto ruim)", () => {
    // vivo que não se parece com nenhuma das 3 (todas as antenas ~-90)
    const r = classify({ A: -90, B: -90, C: -90 }, db);
    expect(r.best?.dist).toBeGreaterThan(18);
    expect(r.confidence).toBe("baixa");
    expect(r.pos).toBeNull();
  });

  it("mede a margem contra outro LABEL, não contra uma amostra irmã da mesma zona", () => {
    const repetida = [
      fp("a1", "Mesa", { A: -50, B: -70 }, [1, 1]),
      fp("a2", "Mesa", { A: -50.2, B: -70.2 }, [1.1, 1]),
      fp("b1", "Doca", { A: -75, B: -45 }, [4, 1]),
    ];
    const r = classify({ A: -50, B: -70 }, repetida);
    expect(r.best?.label).toBe("Mesa");
    expect(r.evidence.distinctLabels).toBe(2);
    expect(r.margin).toBeGreaterThan(6);
    expect(r.confidence).toBe("alta");
  });

  it("usa std com piso e teto sem deixar std=0 ou std enorme dominar a distância", () => {
    const a = fp("a", "A", { X: -50, Y: -70 });
    a.vec.X.std = 0;
    a.vec.Y.std = 10_000;
    const b = fp("b", "B", { X: -65, Y: -55 });
    const r = classify({ X: -51, Y: -69 }, [a, b]);
    expect(r.best?.id).toBe("a");
    expect(Number.isFinite(r.best?.dist)).toBe(true);
  });

  it("WKNN balanceia por zona: duplicar amostras de um label não multiplica seu voto", () => {
    const base = [
      fp("a1", "A", { X: -50, Y: -70 }, [0, 0]),
      fp("b1", "B", { X: -70, Y: -50 }, [4, 0]),
    ];
    const duplicado = [
      ...base,
      fp("a2", "A", { X: -50, Y: -70 }, [0, 0]),
      fp("a3", "A", { X: -50, Y: -70 }, [0, 0]),
    ];
    const opts = { mediaDb: 0, farFitDb: 30, k: 2 };
    const semDuplicar = classify({ X: -60, Y: -60 }, base, opts);
    const comDuplicata = classify({ X: -60, Y: -60 }, duplicado, opts);
    expect(semDuplicar.pos?.x).toBeCloseTo(2, 6);
    expect(comDuplicata.pos?.x).toBeCloseTo(semDuplicar.pos!.x, 6);
  });

  it("WKNN tem piso de distância e permanece finito em casamento exato", () => {
    const r = classify(
      { A: -40, B: -80 },
      [fp("a", "A", { A: -40, B: -80 }, [1, 2]), fp("b", "B", { A: -80, B: -40 }, [4, 2])],
    );
    expect(r.confidence).toBe("alta");
    expect(r.pos).toEqual({ x: expect.any(Number), y: expect.any(Number) });
    expect(Number.isFinite(r.pos!.x)).toBe(true);
  });
});

describe("regressão — survey real da planta 3 × 5 m", () => {
  const cell = (mean: number) => ({ mean, std: 3, n: 20 });
  const survey: Fingerprint[] = [
    {
      id: "fp-0963",
      label: "tc22-0963",
      x: 3,
      y: 0,
      createdAt: 1,
      vec: {
        TC22: cell(-86.1786),
        "TC22-70A3": cell(-83.4571),
        "TC22-0963": cell(-57.8286),
      },
    },
    {
      id: "fp-70a3",
      label: "tc22-70a3",
      x: 0,
      y: 0,
      createdAt: 2,
      vec: {
        TC22: cell(-95.4242),
        "TC22-70A3": cell(-48.1714),
        "TC22-0963": cell(-76.7143),
      },
    },
    {
      id: "fp-tc22",
      label: "tc22",
      x: 1.4347258485639685,
      y: 5,
      createdAt: 3,
      vec: {
        TC22: cell(-64.9143),
        "TC22-70A3": cell(-90.2857),
        "TC22-0963": cell(-82.3429),
      },
    },
    {
      id: "fp-mesa",
      label: "Mesa serigrafia",
      x: 1.5,
      y: 2.5,
      createdAt: 4,
      vec: {
        TC22: cell(-90.0357),
        "TC22-70A3": cell(-79.2857),
        "TC22-0963": cell(-78.0357),
      },
    },
  ];

  it.each([
    ["CE3C", { TC22: -85, "TC22-70A3": -79, "TC22-0963": -94 }],
    ["CE5C", { TC22: -91, "TC22-70A3": -81, "TC22-0963": -83 }],
    ["CE89", { TC22: -95, "TC22-70A3": -79, "TC22-0963": -83 }],
    ["CE8B", { TC22: -96, "TC22-70A3": -82, "TC22-0963": -84 }],
  ])("%s recebe posição interna contínua, não um canto", (_mac, live) => {
    const result = classify(live, survey);
    expect(["alta", "media"]).toContain(result.confidence);
    expect(result.best?.label).toBe("Mesa serigrafia");
    expect(result.pos).not.toBeNull();
    expect(result.pos!.x).toBeGreaterThan(0);
    expect(result.pos!.x).toBeLessThan(3);
    expect(result.pos!.y).toBeGreaterThan(0);
    expect(result.pos!.y).toBeLessThan(5);
  });
});

describe("aggregateTaggedSamples", () => {
  it("deduplica medição física e balanceia tags mesmo com contagens diferentes", () => {
    const r = aggregateTaggedSamples([
      { stationId: "tc22", mac: "aa", rssi: -60, measuredAt: 1000 },
      { stationId: "TC22", mac: "AA", rssi: -60, measuredAt: 1000 }, // mesma medição
      { stationId: "tc22", mac: "AA", rssi: -60, measuredAt: 2000 },
      { stationId: "tc22", mac: "AA", rssi: -20, measuredAt: 3000 }, // outlier
      { stationId: "tc22", mac: "BB", rssi: -80, measuredAt: 1000 },
    ]);
    expect(r.vec.TC22.mean).toBeCloseTo(-70, 6); // mediana AA=-60 e BB=-80, peso igual por tag
    expect(r.vec.TC22.n).toBe(4); // duplicata não infla n (Regra 8)
    expect(r.evidence.nDistinct).toBe(4);
    expect(r.vec.TC22.n).toBeLessThanOrEqual(r.evidence.nDistinct); // nEff ≤ medições físicas
    expect(r.evidence.nTags).toBe(2);
    expect(r.evidence.byStation.TC22).toEqual({ nDistinct: 4, nTags: 2 });
  });
});
