import { describe, it, expect } from "vitest";
import { aggregateSamples, classify, type Fingerprint } from "./fingerprint";

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
    const r = classify({ A: -60, B: -60 }, dois);
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
  });
});
