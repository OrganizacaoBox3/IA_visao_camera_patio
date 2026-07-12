// Testes da PLANTA BAIXA → RESTRIÇÕES (`floor-plan.ts`). O que se protege aqui:
//   - o FECHAMENTO nunca é inferido: `observableIsClosed` é do desenhista, e sem ele o teto do "fora"
//     é ILIMITADO (nenhuma cobertura de zona conserta um buraco de FOV);
//   - o ZERO ESTRUTURAL é REAL (parede que separa) e não é confundido com DESVIO (rack contornável);
//   - a geodésica é um LIMITE INFERIOR — a poda erra sempre para o lado de NÃO excluir.

import { describe, it, expect } from "vitest";
import { analyzeFloorPlan, foraCapacityFromPlan, topologyFromPlan, type FloorPlan } from "./floor-plan";

const rect = (x0: number, y0: number, x1: number, y1: number) => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

/** Sala 12×6: duas mesas de 6×6 lado a lado (ladrilham 100%). */
const tiled: FloorPlan = {
  observable: rect(0, 0, 12, 6),
  zones: [
    { id: "A", poly: rect(0, 0, 6, 6) },
    { id: "B", poly: rect(6, 0, 12, 6) },
  ],
  observableIsClosed: true,
};

/** A mesma sala, mas as mesas encolhidas: sobra CORREDOR (o gap). */
const partial: FloorPlan = {
  ...tiled,
  zones: [
    { id: "A", poly: rect(0.5, 0.5, 5.5, 5.5) },
    { id: "B", poly: rect(6.5, 0.5, 11.5, 5.5) },
  ],
};

describe("COBERTURA — quanto as zonas ladrilham a área observável", () => {
  it("zonas que ladrilham ⇒ cobertura 100% e GAP zero (não há corredor onde se esconder)", () => {
    const a = analyzeFloorPlan(tiled);
    expect(a.coverage).toBeCloseTo(1, 2);
    expect(a.gapCells).toBe(0);
    expect(a.overlappingZones).toEqual([]);
    expect(a.zonesOutsideObservable).toEqual([]);
  });

  it("zonas encolhidas ⇒ cobertura parcial e GAP > 0 (o corredor existe — e a câmera o vê)", () => {
    const a = analyzeFloorPlan(partial);
    expect(a.coverage).toBeGreaterThan(0.5);
    expect(a.coverage).toBeLessThan(0.85);
    expect(a.gapCells).toBeGreaterThan(0);
  });

  it("planta inválida (observável degenerado) NÃO afirma nada — cobertura 0, nada navegável", () => {
    const a = analyzeFloorPlan({ observable: [{ x: 0, y: 0 }], zones: [] });
    expect(a).toMatchObject({ coverage: 0, navigableCells: 0, neighbors: {}, unreachablePairs: [] });
  });

  it("zona que VAZA para fora do campo da câmera é sinalizada (é por ali que o fechamento fura)", () => {
    const a = analyzeFloorPlan({ ...tiled, zones: [{ id: "A", poly: rect(-3, 0, 6, 6) }] });
    expect(a.zonesOutsideObservable).toEqual(["A"]);
  });

  it("zonas SOBREPOSTAS são diagnóstico (a atribuição pressupõe postos disjuntos)", () => {
    const a = analyzeFloorPlan({ ...tiled, zones: [{ id: "A", poly: rect(0, 0, 7, 6) }, { id: "B", poly: rect(6, 0, 12, 6) }] });
    expect(a.overlappingZones).toEqual([["A", "B"]]);
  });
});

describe("FECHAMENTO — o teto do 'fora' (e a assunção que ele exige)", () => {
  it("`observableIsClosed` FALSO ⇒ teto ILIMITADO, por mais que as zonas ladrilhem", () => {
    // Ladrilhar as mesas não fecha a porta do banheiro. A cobertura NÃO conserta o buraco de FOV.
    expect(foraCapacityFromPlan({ ...tiled, observableIsClosed: false }, 0)).toBeUndefined();
    expect(foraCapacityFromPlan({ ...tiled, observableIsClosed: undefined }, 0)).toBeUndefined();
  });

  it("área observável COMPLETA ⇒ o teto do 'fora' é a gente CONTADA no corredor (medida, não assumida)", () => {
    expect(foraCapacityFromPlan(tiled, 0)).toBe(0); // ladrilha 100% ⇒ ninguém pode estar fora das zonas
    expect(foraCapacityFromPlan(partial, 2)).toBe(2); // 2 pessoas no corredor ⇒ no máximo 2 operadores fora
    expect(foraCapacityFromPlan(partial, Number.NaN)).toBe(0);
  });
});

describe("OBSTÁCULOS — zero estrutural × desvio (a diferença que decide a continuidade)", () => {
  /** Galpão 12×12, duas mesas frente a frente (2 m de distância) e um RACK entre elas.
   *  `walled` = o rack atravessa TODO o galpão. `doored` = ele para em x=9 (passagem na ponta). */
  const hall = (obstacle: number[][]): FloorPlan => ({
    observable: rect(0, 0, 12, 12),
    zones: [
      { id: "A", poly: rect(1, 1, 5, 5) },
      { id: "B", poly: rect(1, 7, 5, 11) },
    ],
    obstacles: [obstacle.map(([x, y]) => ({ x, y }))],
    observableIsClosed: true,
  });
  const walled = hall([
    [0, 5.8],
    [12, 5.8],
    [12, 6.2],
    [0, 6.2],
  ]);
  const doored = hall([
    [0, 5.8],
    [9, 5.8],
    [9, 6.2],
    [0, 6.2],
  ]);

  it("rack que ATRAVESSA o galpão ⇒ ZERO ESTRUTURAL: transição impossível em QUALQUER tempo", () => {
    const a = analyzeFloorPlan(walled);
    expect(a.unreachablePairs).toEqual([["A", "B"]]);
    expect(a.geodesicM.A?.B).toBeUndefined();
    expect(a.neighbors.A).toEqual([]);

    const topo = topologyFromPlan(a, 1.2);
    expect(topo.minTravelMs?.A?.B).toBeUndefined(); // par AUSENTE = impossível (é o contrato)
  });

  it("rack com PASSAGEM ⇒ NÃO é zero estrutural, é DESVIO (o 'contorne o rack')", () => {
    const a = analyzeFloorPlan(doored);
    expect(a.unreachablePairs).toEqual([]); // dá para contornar: nada é IMPOSSÍVEL
    expect(a.neighbors.A).toEqual(["B"]); // e no grafo de vizinhança elas continuam "vizinhas"...
    const [, , comRack, semRack] = a.detouredPairs[0]; // ...mas o CAMINHO conta outra história
    expect(semRack).toBeLessThan(3); // 2 m em linha reta
    expect(comRack).toBeGreaterThan(3 * semRack); // 2,25 m → 8,75 m contornando: ~4× mais longe
    expect(a.narrowPassageRisk).toBe(false);

    // E é ISSO que a continuidade ganha: 2 m ⇒ ~1,7 s (não poda nada) × 8,8 m ⇒ ~7 s (poda de verdade).
    const topo = topologyFromPlan(a, 1.2);
    expect(topo.minTravelMs?.A?.B).toBeGreaterThan(6_000);
  });

  it("sem obstáculo, a geodésica é curta e a continuidade quase não poda (o CD descrito pelo dono)", () => {
    const a = analyzeFloorPlan(tiled);
    const topo = topologyFromPlan(a, 1.2);
    expect(a.detouredPairs).toEqual([]);
    expect(topo.minTravelMs?.A?.B).toBeLessThan(2000); // < 2 s entre mesas vizinhas: não exclui nada
  });

  it("a geodésica é BORDA-A-BORDA e LIMITE INFERIOR — a poda erra sempre para NÃO excluir", () => {
    // O operador pode estar na BORDA da zona: o menor percurso possível é o único honesto para uma
    // restrição de impossibilidade. Superestimá-lo excluiria um trajeto que era possível.
    const a = analyzeFloorPlan(doored);
    const geo = a.geodesicM.A?.B ?? 0;
    expect(geo).toBeGreaterThan(0);
    expect(geo).toBeLessThan(16); // a volta real (Manhattan ≈ 16 m) nunca é SUPERESTIMADA
  });

  it("determinismo: a mesma planta dá a mesma análise, byte a byte", () => {
    expect(JSON.stringify(analyzeFloorPlan(doored))).toBe(JSON.stringify(analyzeFloorPlan(doored)));
  });
});
