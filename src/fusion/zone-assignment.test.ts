// Testes da ATRIBUIÇÃO OPERADOR↔ZONA (Onda 2 re-escopada). Cada bloco corresponde a um critério de
// aceite de `docs/cientifica/onda2-conservacao-workflow-spec.md` (CA-A1..CA-A9).
//
// O que estes testes protegem, acima de tudo: o sistema **nunca chuta**. Quando as restrições não
// entranham um destino, o retorno é `ambigua` com o conjunto exato — e o `foraPossivel` é a confissão
// de que a exclusividade sozinha não decide nada.

import { describe, it, expect } from "vitest";
import {
  assignOperators,
  zoneObservationsFromConservation,
  type AssignmentInput,
  type AssignmentResult,
  type Placement,
  type ZoneAssignment,
} from "./zone-assignment";
import { conserveIdentities, type Place, type TrackZoneEvent } from "./petri-conservation";
import type { Zone } from "./zone-crossing";

// —— fixtures ————————————————————————————————————————————————————————————————————————————————————

const base = (over: Partial<AssignmentInput>): AssignmentInput => ({
  ts: 10_000,
  zones: [],
  roster: [],
  radio: { present: [] },
  ...over,
});

const ok = (r: AssignmentResult): Extract<AssignmentResult, { kind: "ok" }> => {
  if (r.kind !== "ok") throw new Error(`esperava ok, veio ${r.kind}: ${JSON.stringify(r)}`);
  return r;
};

const pl = (r: AssignmentResult, token: string): Placement => {
  const p = ok(r).placements.find((x) => x.token === token);
  if (!p) throw new Error(`operador ${token} ausente do resultado`);
  return p;
};

const zn = (r: AssignmentResult, zoneId: string): ZoneAssignment => {
  const z = ok(r).zones.find((x) => x.zoneId === zoneId);
  if (!z) throw new Error(`zona ${zoneId} ausente do resultado`);
  return z;
};

// —— CA-A1 — o CONJUNTO DE TAGS PRESENTES é identidade de graça ——————————————————————————————————

describe("CA-A1 — o conjunto de tags presentes restringe SEM correlação, SEM movimento, SEM n_eff", () => {
  it("só quem está na ESCALA e no SCAN é atribuível; o resto da escala é 'ausente'", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 1, capacity: 1 }],
        roster: ["A", "B", "C"],
        radio: { present: ["A"] },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA4", via: "exclusao" });
    expect(pl(r, "B")).toEqual({ kind: "ausente", token: "B" });
    expect(pl(r, "C")).toEqual({ kind: "ausente", token: "C" });
    expect(ok(r).diagnostics.tagsPresent).toBe(1);
  });

  it("tag vista fora da ESCALA não é atribuível — é anônimo COM tag (visitante/turno anterior)", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 1 }],
        roster: ["A"],
        radio: { present: ["A", "ZZ"] },
      }),
    );
    expect(ok(r).diagnostics.offRoster).toEqual(["ZZ"]);
    expect(ok(r).placements.some((p) => p.token === "ZZ")).toBe(false);
  });

  it("locality do receptor (set-membership, não RSSI) poda as zonas candidatas", () => {
    const r = assignOperators(
      base({
        zones: [
          { zoneId: "MESA4", occupancy: 1 },
          { zoneId: "MESA7", occupancy: 1 },
        ],
        roster: ["A"],
        radio: { present: ["A"], nearZones: { A: ["MESA7"] } },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA7", via: "exclusao" });
  });
});

// —— CA-A2 — a CONTAGEM DE ANÔNIMOS (a conta do dono) ————————————————————————————————————————————

describe("CA-A2 — anônimos = pessoas(câmera) − tags(rádio)", () => {
  it("câmera vê 2 na mesa 4, só 1 tag presente ⇒ UMA delas é visitante (anonymous.min = 1)", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 2, capacity: 2 }],
        roster: ["A"],
        radio: { present: ["A"] },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(ok(r).diagnostics.anonymousFloor).toBe(1);
    expect(zn(r, "MESA4").anonymous).toEqual({ min: 1, max: 1 });
    expect(zn(r, "MESA4").certain).toEqual(["A"]);
  });

  it("sem o fechamento, o anônimo da zona pode ser 2 (A pode estar no corredor) — faixa honesta", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 2, capacity: 2 }],
        roster: ["A"],
        radio: { present: ["A"] },
      }),
    );
    expect(zn(r, "MESA4").anonymous).toEqual({ min: 1, max: 2 });
    expect(zn(r, "MESA4").certain).toEqual([]); // nada é entranhado
    expect(zn(r, "MESA4").possible).toEqual(["A"]);
  });

  it("MAIS TAG QUE GENTE é diagnóstico (tag na bancada / pessoa fora do FOV / subcontagem)", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 1, capacity: 1 }],
        roster: ["A", "B"],
        radio: { present: ["A", "B"] },
      }),
    );
    const d = ok(r).diagnostics;
    expect(d.tagsExceedPeople).toBe(1);
    expect(d.anonymousFloor).toBe(0);
    expect(zn(r, "MESA4").anonymous).toEqual({ min: 0, max: 1 });
  });

  it("zona vazia: ninguém é candidato lá e o anônimo é 0", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 0, capacity: 1 }],
        roster: ["A"],
        radio: { present: ["A"] },
      }),
    );
    expect(zn(r, "MESA4")).toMatchObject({ certain: [], possible: [], anonymous: { min: 0, max: 0 } });
    expect(pl(r, "A")).toEqual({ kind: "fora", token: "A" });
  });
});

// —— CA-A3 — EXCLUSIVIDADE: é aqui que a atribuição paga (por PROPAGAÇÃO de um pino) ——————————————

describe("CA-A3 — exclusividade global colapsa a ambiguidade da zona vizinha", () => {
  const zones = [
    { zoneId: "MESA4", occupancy: 1, capacity: 2, pinned: ["A"] },
    { zoneId: "MESA7", occupancy: 1, capacity: 2 },
  ];

  it("A fixado na MESA4 ⇒ A não está na MESA7 ⇒ B (única outra tag) é DECIDIDO na MESA7", () => {
    const r = assignOperators(
      base({
        zones,
        roster: ["A", "B"],
        radio: { present: ["A", "B"] },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA4", via: "pin" });
    expect(pl(r, "B")).toEqual({ kind: "decidida", token: "B", zoneId: "MESA7", via: "exclusao" });
    expect(zn(r, "MESA7").anonymous).toEqual({ min: 0, max: 0 });
    expect(ok(r).diagnostics.solutions).toBe(1); // cenário TOTALMENTE determinado
  });

  it("HONESTIDADE — sem o fechamento, a exclusividade PODA mas NÃO DECIDE: B fica ambíguo com 'fora'", () => {
    const r = assignOperators(base({ zones, roster: ["A", "B"], radio: { present: ["A", "B"] } }));
    expect(pl(r, "B")).toEqual({
      kind: "ambigua",
      token: "B",
      zones: ["MESA7"], // a MESA4 FOI podada pela exclusividade (o pino de A a saturou)
      foraPossivel: true, // ...mas B ainda pode estar no corredor. Nenhum chute.
    });
    expect(zn(r, "MESA7").certain).toEqual([]);
    expect(zn(r, "MESA7").possible).toEqual(["B"]);
  });

  it("um operador está em EXATAMENTE UM lugar: nenhuma solução o põe em duas zonas", () => {
    const r = assignOperators(
      base({
        zones: [
          { zoneId: "MESA4", occupancy: 1 },
          { zoneId: "MESA7", occupancy: 1 },
        ],
        roster: ["A"],
        radio: { present: ["A"] },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    // Duas soluções (A em cada mesa) — e o resultado é AMBÍGUO, não a soma das duas.
    expect(ok(r).diagnostics.solutions).toBe(2);
    expect(pl(r, "A")).toEqual({ kind: "ambigua", token: "A", zones: ["MESA4", "MESA7"], foraPossivel: false });
    expect(zn(r, "MESA4").anonymous).toEqual({ min: 0, max: 1 });
    expect(zn(r, "MESA7").anonymous).toEqual({ min: 0, max: 1 });
  });

  it("saturação de ocupação decide sem pino: 2 tags, 2 zonas de 1 pessoa, locality cruzada", () => {
    const r = assignOperators(
      base({
        zones: [
          { zoneId: "MESA4", occupancy: 1 },
          { zoneId: "MESA7", occupancy: 1 },
        ],
        roster: ["A", "B"],
        radio: { present: ["A", "B"], nearZones: { A: ["MESA4", "MESA7"], B: ["MESA7"] } },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "B")).toMatchObject({ kind: "decidida", zoneId: "MESA7" });
    expect(pl(r, "A")).toMatchObject({ kind: "decidida", zoneId: "MESA4" }); // por exclusão
  });
});

// —— CA-A4 — CONTINUIDADE FÍSICA (e a confissão de que ela é fraca entre mesas vizinhas) —————————

describe("CA-A4 — continuidade física: ninguém se teleporta", () => {
  const topology = { neighbors: { MESA4: ["MESA7"], MESA7: ["MESA4", "DOCA"], DOCA: ["MESA7"] }, hopMs: 30_000 };

  it("zona longe demais para o tempo decorrido é PODADA (2 saltos em 30 s, com hop de 30 s)", () => {
    const r = assignOperators(
      base({
        ts: 40_000,
        zones: [
          { zoneId: "MESA7", occupancy: 1 },
          { zoneId: "DOCA", occupancy: 1 },
        ],
        roster: ["A"],
        radio: { present: ["A"] },
        lastSeen: { A: { zoneId: "MESA4", ts: 10_000 } }, // 30 s ⇒ 1 salto ⇒ DOCA (2 saltos) inalcançável
        topology,
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA7", via: "exclusao" });
  });

  it("com tempo suficiente, a DOCA volta a ser possível (nada é excluído por decreto)", () => {
    const r = assignOperators(
      base({
        ts: 100_000,
        zones: [
          { zoneId: "MESA7", occupancy: 1 },
          { zoneId: "DOCA", occupancy: 1 },
        ],
        roster: ["A"],
        radio: { present: ["A"] },
        lastSeen: { A: { zoneId: "MESA4", ts: 10_000 } },
        topology,
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toMatchObject({ kind: "ambigua", zones: ["DOCA", "MESA7"] });
  });

  it("HONESTIDADE — entre MESAS VIZINHAS a continuidade não exclui nada (é o caso deste CD)", () => {
    const r = assignOperators(
      base({
        ts: 40_000,
        zones: [
          { zoneId: "MESA4", occupancy: 1 },
          { zoneId: "MESA7", occupancy: 1 },
        ],
        roster: ["A"],
        radio: { present: ["A"] },
        lastSeen: { A: { zoneId: "MESA4", ts: 10_000 } },
        topology,
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toMatchObject({ kind: "ambigua", zones: ["MESA4", "MESA7"] });
  });

  it("sem topologia declarada, nenhuma opinião é inventada (tudo alcançável)", () => {
    const r = assignOperators(
      base({
        ts: 10_001,
        zones: [
          { zoneId: "MESA4", occupancy: 1 },
          { zoneId: "DOCA", occupancy: 1 },
        ],
        roster: ["A"],
        radio: { present: ["A"] },
        lastSeen: { A: { zoneId: "MESA4", ts: 10_000 } },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toMatchObject({ kind: "ambigua", zones: ["DOCA", "MESA4"] });
  });
});

// —— CA-A5 — o PINO vem da conservação, e a contradição pino×rádio é DIAGNÓSTICO ————————————————

describe("CA-A5 — pino da conservação × silêncio do rádio", () => {
  it("pino vence o silêncio do rádio (advertising perdido/bateria), e a contradição é REGISTRADA", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 1, capacity: 1, pinned: ["A"] }],
        roster: ["A"],
        radio: { present: [] }, // o rádio não viu A
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA4", via: "pin" });
    expect(ok(r).diagnostics.pinnedNotDetected).toEqual(["A"]);
  });

  it("dois pinos numa zona onde a câmera só conta 1 pessoa ⇒ INVIÁVEL (não se inventa saída)", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 1, capacity: 1, pinned: ["A", "B"] }],
        roster: ["A", "B"],
        radio: { present: ["A", "B"] },
      }),
    );
    expect(r.kind).toBe("inviavel");
    if (r.kind !== "inviavel") throw new Error("esperava inviavel");
    expect(r.reasons[0]).toContain("MESA4");
  });

  it("o mesmo token fixado em duas zonas viola a exclusividade na ENTRADA ⇒ INVIÁVEL", () => {
    const r = assignOperators(
      base({
        zones: [
          { zoneId: "MESA4", occupancy: 1, pinned: ["A"] },
          { zoneId: "MESA7", occupancy: 1, pinned: ["A"] },
        ],
        roster: ["A"],
        radio: { present: ["A"] },
      }),
    );
    expect(r.kind).toBe("inviavel");
    if (r.kind !== "inviavel") throw new Error("esperava inviavel");
    expect(r.reasons.join(" ")).toContain("exclusividade");
  });
});

// —— CA-A6 — CAPACIDADE é sensor de saúde, não restrição dura —————————————————————————————————————

describe("CA-A6 — capacidade não altera a atribuição (mesma semântica de petri-conservation)", () => {
  it("3 pessoas num posto de capacidade 2: bandeira levantada, atribuição segue", () => {
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 3, capacity: 2 }],
        roster: ["A"],
        radio: { present: ["A"] },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(zn(r, "MESA4").capacityViolation).toBe(true);
    expect(ok(r).diagnostics.capacityViolations).toBe(1);
    expect(pl(r, "A")).toMatchObject({ kind: "decidida", zoneId: "MESA4" });
    expect(zn(r, "MESA4").anonymous).toEqual({ min: 2, max: 2 }); // e 2 são anônimos
  });
});

// —— CA-A7 — determinismo e robustez ————————————————————————————————————————————————————————————

describe("CA-A7 — determinismo, ordenação e ausência de NaN", () => {
  const input = base({
    zones: [
      { zoneId: "MESA7", occupancy: 1, capacity: 1 },
      { zoneId: "MESA4", occupancy: 2, capacity: 2, pinned: ["A"] },
    ],
    roster: ["C", "A", "B"],
    radio: { present: ["B", "A"] },
    options: { tagsMustBeInSomeZone: false },
  });

  it("a ordem de entrada de zonas/escala/tags não muda a saída", () => {
    const a = assignOperators(input);
    const b = assignOperators(
      base({
        zones: [...input.zones].reverse(),
        roster: [...input.roster].reverse(),
        radio: { present: [...input.radio.present].reverse() },
        options: input.options,
      }),
    );
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("zonas, placements e conjuntos saem ordenados e sem NaN", () => {
    const r = ok(assignOperators(input));
    expect(r.zones.map((z) => z.zoneId)).toEqual(["MESA4", "MESA7"]);
    expect(r.placements.map((p) => p.token)).toEqual(["A", "B", "C"]);
    expect(JSON.stringify(r)).not.toContain("null");
    expect(JSON.stringify(r)).not.toContain("\\u0000"); // a sentinela FORA nunca vaza no contrato
  });

  it("entradas degeneradas (ocupação NaN, id vazio, escala vazia) não quebram", () => {
    const r = assignOperators(
      base({
        zones: [
          { zoneId: "Z", occupancy: Number.NaN },
          { zoneId: "", occupancy: 1 },
        ],
        roster: [],
        radio: { present: [] },
      }),
    );
    expect(ok(r).zones).toEqual([
      { zoneId: "Z", occupancy: 0, certain: [], possible: [], anonymous: { min: 0, max: 0 }, capacityViolation: false },
    ]);
    expect(ok(r).placements).toEqual([]);
  });

  it("orçamento de busca estourado NÃO produz decisão inventada — degrada para ambíguo", () => {
    const zones = Array.from({ length: 6 }, (_, i) => ({ zoneId: `M${i}`, occupancy: 2 }));
    const roster = Array.from({ length: 8 }, (_, i) => `OP${i}`);
    const r = assignOperators(
      base({ zones, roster, radio: { present: roster }, options: { searchBudget: 50 } }),
    );
    const res = ok(r);
    expect(res.diagnostics.budgetExceeded).toBe(true);
    expect(res.zones.every((z) => z.certain.length === 0)).toBe(true); // nada é afirmado
    expect(res.placements.every((p) => p.kind === "ambigua")).toBe(true);
  });
});

// —— CA-A9 — FECHAMENTO PARCIAL: o "fora" é um place com TETO, não um saco sem fundo ————————————
//
// O que a PLANTA BAIXA (`floor-plan.ts`) destrava: o corredor entre as mesas está DENTRO do campo da
// câmera, então quem anda por ali é CONTADO. `foraCapacity` = essa contagem. É o meio-termo honesto
// entre "fora é impossível" (fechamento total, uma assunção forte) e "fora é ilimitado" (hoje).

describe("CA-A9 — fechamento PARCIAL (o teto do 'fora' que a planta mede)", () => {
  const zones = [
    { zoneId: "MESA4", occupancy: 1, capacity: 2, pinned: ["A"] },
    { zoneId: "MESA7", occupancy: 1, capacity: 2 },
  ];
  const cenario = (foraCapacity?: number) =>
    assignOperators(base({ zones, roster: ["A", "B"], radio: { present: ["A", "B"] }, options: { foraCapacity } }));

  it("teto 0 (as zonas ladrilham, a área é completa) ≡ tagsMustBeInSomeZone: B é DECIDIDO por exclusão", () => {
    expect(pl(cenario(0), "B")).toEqual({ kind: "decidida", token: "B", zoneId: "MESA7", via: "exclusao" });
    expect(ok(cenario(0)).diagnostics.foraCapacity).toBe(0);
  });

  it("teto 1 (a câmera vê 1 pessoa no corredor) ⇒ B volta a ser AMBÍGUO — o corredor cabe nele", () => {
    // HONESTIDADE: cobertura parcial NÃO é fechamento. Se há uma vaga no corredor, ela é um destino
    // viável, e o sistema diz "não sei" — em vez de empurrar B para a MESA7 com cara de certeza.
    expect(pl(cenario(1), "B")).toEqual({ kind: "ambigua", token: "B", zones: ["MESA7"], foraPossivel: true });
    expect(ok(cenario(1)).diagnostics.foraCapacity).toBe(1);
  });

  it("sem planta, o teto é ILIMITADO — e é assim que o contrato o declara", () => {
    expect(ok(cenario(undefined)).diagnostics.foraCapacity).toBe("ilimitado");
    expect(pl(cenario(undefined), "B")).toMatchObject({ kind: "ambigua", foraPossivel: true });
  });

  it("o TETO do 'fora' é uma restrição de CONTAGEM: 2 operadores, 1 vaga no corredor, 1 vaga na mesa", () => {
    // MESA4 conta 1 pessoa; o corredor, 1. Dois operadores presentes ⇒ um está na mesa e o outro no
    // corredor — mas QUAL é qual, ninguém sabe. A saturação existe, a simetria permanece: AMBÍGUO.
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 1, capacity: 2 }],
        roster: ["A", "B"],
        radio: { present: ["A", "B"] },
        options: { foraCapacity: 1 },
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "ambigua", token: "A", zones: ["MESA4"], foraPossivel: true });
    expect(pl(r, "B")).toEqual({ kind: "ambigua", token: "B", zones: ["MESA4"], foraPossivel: true });
    expect(ok(r).diagnostics.solutions).toBe(2); // {A na mesa, B fora} ou {B na mesa, A fora}
    expect(zn(r, "MESA4").anonymous).toEqual({ min: 0, max: 0 }); // mas a MESA4 sabe que NÃO tem anônimo
  });

  it("o teto do 'fora' pode tornar o cenário INVIÁVEL — e a falha é SEGURA (nenhum rótulo é emitido)", () => {
    // 2 operadores, nenhuma zona ocupada e nenhuma vaga no corredor: a premissa de fechamento
    // CONTRADIZ a contagem. É exatamente o que acontece quando a área observável NÃO era completa.
    const r = assignOperators(
      base({
        zones: [{ zoneId: "MESA4", occupancy: 0 }],
        roster: ["A", "B"],
        radio: { present: ["A", "B"] },
        options: { foraCapacity: 0 },
      }),
    );
    expect(r.kind).toBe("inviavel");
  });

  it("`tagsMustBeInSomeZone` continua sendo o açúcar de teto 0 (contrato antigo intacto)", () => {
    const a = assignOperators(base({ zones, roster: ["A", "B"], radio: { present: ["A", "B"] }, options: { tagsMustBeInSomeZone: true } }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(cenario(0)));
  });
});

// —— CA-A10 — TOPOLOGIA REAL: os ZEROS ESTRUTURAIS que a planta deriva ———————————————————————————

describe("CA-A10 — minTravelMs (a planta) vence a vizinhança abstrata", () => {
  it("par AUSENTE do mapa = ZERO ESTRUTURAL: nem com o turno inteiro de tempo ele é alcançável", () => {
    const r = assignOperators(
      base({
        ts: 8 * 3600_000, // 8 horas depois
        zones: [
          { zoneId: "MESA4", occupancy: 1 },
          { zoneId: "ILHA", occupancy: 1 },
        ],
        roster: ["A"],
        radio: { present: ["A"] },
        lastSeen: { A: { zoneId: "MESA4", ts: 0 } },
        // A planta diz: da MESA4 só se chega à MESA4. A ILHA está atrás de uma parede.
        topology: { neighbors: {}, hopMs: 0, minTravelMs: { MESA4: { MESA4: 0 } } },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA4", via: "exclusao" });
  });

  it("DESVIO (contornar o rack): a mesa 'vizinha' custa 20 s — em 10 s ela é podada, em 30 s não", () => {
    const topology = { neighbors: {}, hopMs: 0, minTravelMs: { MESA4: { MESA4: 0, MESA7: 20_000 } } };
    const cen = (elapsed: number) =>
      assignOperators(
        base({
          ts: elapsed,
          zones: [
            { zoneId: "MESA4", occupancy: 1 },
            { zoneId: "MESA7", occupancy: 1 },
          ],
          roster: ["A"],
          radio: { present: ["A"] },
          lastSeen: { A: { zoneId: "MESA4", ts: 0 } },
          topology,
          options: { tagsMustBeInSomeZone: true },
        }),
      );
    expect(pl(cen(10_000), "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA4", via: "exclusao" });
    expect(pl(cen(30_000), "A")).toMatchObject({ kind: "ambigua", zones: ["MESA4", "MESA7"] });
  });
});

// —— CA-A8 — ponte com a CONSERVAÇÃO (o que sobreviveu do core antigo) ——————————————————————————

describe("CA-A8 — zoneObservationsFromConservation: a conservação alimenta a atribuição", () => {
  const zone = (id: string): Zone => ({
    id,
    poly: [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
  });
  const places: Place[] = [
    { zone: zone("MESA4"), capacity: 2 },
    { zone: zone("MESA7"), capacity: 2 },
  ];
  const ev = (trackId: string, zoneId: string, kind: TrackZoneEvent["kind"], ts: number): TrackZoneEvent => ({
    trackId,
    zoneId,
    kind,
    ts,
    tickIndex: 0,
    bounces: 0,
  });

  it("o token conservado numa zona vira PINO e dispara a exclusividade na outra", () => {
    const cons = conserveIdentities(
      [ev("T1", "MESA4", "entrou", 1000), ev("T1", "MESA4", "morreu-dentro", 2000), ev("T2", "MESA7", "entrou", 2500)],
      places,
      [{ ts: 900, trackId: "T1", token: "A" }],
    );
    const zones = zoneObservationsFromConservation(cons, places);
    expect(zones).toEqual([
      { zoneId: "MESA4", occupancy: 1, capacity: 2, pinned: ["A"] }, // segurado pela morte do track (CA-2)
      { zoneId: "MESA7", occupancy: 1, capacity: 2, pinned: [] },
    ]);

    const r = assignOperators(
      base({
        ts: 3000,
        zones,
        roster: ["A", "B"],
        radio: { present: ["A", "B"] },
        options: { tagsMustBeInSomeZone: true },
      }),
    );
    expect(pl(r, "A")).toEqual({ kind: "decidida", token: "A", zoneId: "MESA4", via: "pin" });
    expect(pl(r, "B")).toEqual({ kind: "decidida", token: "B", zoneId: "MESA7", via: "exclusao" });
  });

  it("SUPERCONJUNTO (saída ambígua) NÃO vira pino — pino falso é pior que nenhum", () => {
    const cons = conserveIdentities(
      [
        ev("T1", "MESA4", "entrou", 1000),
        ev("T2", "MESA4", "entrou", 1100),
        ev("T1", "MESA4", "morreu-dentro", 2000),
        ev("T2", "MESA4", "morreu-dentro", 2100),
        ev("T3", "MESA4", "nasceu-dentro", 2200), // ambíguo {A,B}
        ev("T3", "MESA4", "saiu", 2500), // saiu ALGUÉM — não se sabe quem
      ],
      places,
      [
        { ts: 900, trackId: "T1", token: "A" },
        { ts: 900, trackId: "T2", token: "B" },
      ],
    );
    expect(cons.places.find((p) => p.zoneId === "MESA4")?.supersetTokens).toBe(true);
    const zones = zoneObservationsFromConservation(cons, places);
    expect(zones.find((z) => z.zoneId === "MESA4")).toEqual({
      zoneId: "MESA4",
      occupancy: 1,
      capacity: 2,
      pinned: [], // a conservação não SABE quem ficou → nada é fixado
    });
  });
});
