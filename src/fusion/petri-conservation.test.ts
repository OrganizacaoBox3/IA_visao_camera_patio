// Testes da CONSERVAÇÃO de identidade por zona (ADR-014, camada 3). Cada bloco corresponde a um
// critério de aceite de `docs/cientifica/onda2-conservacao-workflow-spec.md` (CA-1..CA-11).
//
// O teste central é o CA-2: a identidade sobrevive à MORTE DE TRACK. É a H2 — e é o que sustenta os
// ≥84,5% de episódios que o rádio nunca vai cobrir (gate das Ondas 0/1).

import { describe, it, expect } from "vitest";
import {
  conserveIdentities,
  buildTrackZoneEvents,
  type TrackZoneEvent,
  type IdentityClaim,
  type Place,
  type PlaceState,
} from "./petri-conservation";
import type { Zone } from "./zone-crossing";

// —— fixtures ————————————————————————————————————————————————————————————————————————————————————

const zone = (id: string): Zone => ({
  id,
  poly: [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 4 },
    { x: 0, y: 4 },
  ],
});

const posto = (id: string): Place => ({ zone: zone(id), capacity: 1 });
const area = (id: string): Place => ({ zone: zone(id) });

const ev = (
  trackId: string,
  zoneId: string,
  kind: TrackZoneEvent["kind"],
  ts: number,
): TrackZoneEvent => ({ trackId, zoneId, kind, ts, tickIndex: 0, bounces: 0 });

const claim = (trackId: string, token: string, ts: number): IdentityClaim => ({ trackId, token, ts });

const place = (r: { places: PlaceState[] }, id: string): PlaceState => {
  const p = r.places.find((x) => x.zoneId === id);
  if (!p) throw new Error(`zona ${id} ausente`);
  return p;
};

// —— CA-1 ————————————————————————————————————————————————————————————————————————————————————————

describe("CA-1 — balanço de fronteira conserva a ocupação", () => {
  it("entrou→saiu volta a zona ao vazio e registra a última zona do token", () => {
    const r = conserveIdentities(
      [ev("T1", "P1", "entrou", 1000), ev("T1", "P1", "saiu", 5000)],
      [posto("P1")],
      [claim("T1", "A", 900)],
    );
    const p = place(r, "P1");
    expect(p.occupancy).toBe(0);
    expect(p.tokens).toEqual([]);
    expect(p.anonymous).toBe(0);
    expect(p.supersetTokens).toBe(false);
    expect(r.lastZone).toEqual({ A: "P1" });
    expect(r.identities.T1).toEqual({ kind: "resolvida", token: "A", via: "claim" });
  });

  it("durante a permanência o token está no conjunto da zona", () => {
    const r = conserveIdentities([ev("T1", "P1", "entrou", 1000)], [posto("P1")], [claim("T1", "A", 900)]);
    expect(place(r, "P1")).toMatchObject({ occupancy: 1, tokens: ["A"], anonymous: 0 });
  });
});

// —— CA-2 (o núcleo da H2) ———————————————————————————————————————————————————————————————————————

describe("CA-2 — a identidade sobrevive à MORTE DE TRACK (1 pessoa/posto)", () => {
  const events = [
    ev("T1", "P1", "entrou", 1000),
    ev("T1", "P1", "morreu-dentro", 3000),
    ev("T2", "P1", "nasceu-dentro", 4000),
  ];
  const r = conserveIdentities(events, [posto("P1")], [claim("T1", "A", 900)]);

  it("a morte do track NÃO decrementa a ocupação (não confia no tracker)", () => {
    expect(place(r, "P1").occupancy).toBe(1);
    expect(place(r, "P1").tokens).toEqual(["A"]);
    expect(r.diagnostics.diedInsideHeld).toBe(1);
  });

  it("o track novo nascido dentro é ABSORVIDO (sem dupla-contagem)", () => {
    expect(place(r, "P1").occupancy).toBe(1);
    expect(r.diagnostics.bornInsideAbsorbed).toBe(1);
    expect(r.diagnostics.bornInsideNew).toBe(0);
  });

  it("o track novo é RESOLVIDO como A pela CONSERVAÇÃO — sem rádio, sem tracker", () => {
    expect(r.identities.T2).toEqual({ kind: "resolvida", token: "A", via: "conservacao" });
  });

  it("e a saída desse track novo esvazia a zona corretamente", () => {
    const r2 = conserveIdentities(
      [...events, ev("T2", "P1", "saiu", 9000)],
      [posto("P1")],
      [claim("T1", "A", 900)],
    );
    expect(place(r2, "P1")).toMatchObject({ occupancy: 0, tokens: [], supersetTokens: false });
    expect(r2.lastZone.A).toBe("P1");
  });
});

// —— CA-3 ————————————————————————————————————————————————————————————————————————————————————————

describe("CA-3 — com N pessoas o vínculo individual é AMBÍGUO e o sistema o DECLARA", () => {
  const r = conserveIdentities(
    [
      ev("T1", "Z", "entrou", 1000),
      ev("T2", "Z", "entrou", 1200),
      ev("T1", "Z", "morreu-dentro", 3000),
      ev("T2", "Z", "morreu-dentro", 3200),
      ev("T3", "Z", "nasceu-dentro", 4000),
    ],
    [area("Z")],
    [claim("T1", "A", 900), claim("T2", "B", 900)],
  );

  it("o CONJUNTO {A,B} é conservado", () => {
    expect(place(r, "Z")).toMatchObject({ occupancy: 2, tokens: ["A", "B"], anonymous: 0 });
  });

  it("o track novo é AMBÍGUO com candidatos [A,B] — nunca um chute", () => {
    expect(r.identities.T3).toEqual({
      kind: "ambigua",
      zoneId: "Z",
      candidates: ["A", "B"],
      anonymousPossible: false,
    });
  });

  it("um segundo track novo NÃO herda o mesmo palpite (continua ambíguo)", () => {
    const r2 = conserveIdentities(
      [
        ev("T1", "Z", "entrou", 1000),
        ev("T2", "Z", "entrou", 1200),
        ev("T1", "Z", "morreu-dentro", 3000),
        ev("T2", "Z", "morreu-dentro", 3200),
        ev("T3", "Z", "nasceu-dentro", 4000),
        ev("T4", "Z", "nasceu-dentro", 4200),
      ],
      [area("Z")],
      [claim("T1", "A", 900), claim("T2", "B", 900)],
    );
    expect(r2.identities.T4).toMatchObject({ kind: "ambigua", candidates: ["A", "B"] });
    expect(place(r2, "Z").occupancy).toBe(2); // ambos absorvidos, sem dupla-contagem
  });
});

// —— CA-4 ————————————————————————————————————————————————————————————————————————————————————————

describe("CA-4 — ocupante ANÔNIMO contamina o conjunto (candidato único não basta)", () => {
  const r = conserveIdentities(
    [
      ev("T1", "Z", "entrou", 1000), // com token A
      ev("T2", "Z", "entrou", 1200), // SEM identidade → anônimo
      ev("T1", "Z", "morreu-dentro", 3000),
      ev("T2", "Z", "morreu-dentro", 3200),
      ev("T3", "Z", "nasceu-dentro", 4000),
    ],
    [area("Z")],
    [claim("T1", "A", 900)],
  );

  it("a zona sabe que há um ocupante sem identidade", () => {
    expect(place(r, "Z")).toMatchObject({ occupancy: 2, tokens: ["A"], anonymous: 1 });
  });

  it("o track novo NÃO é resolvido como A: ambíguo com anonymousPossible", () => {
    expect(r.identities.T3).toEqual({
      kind: "ambigua",
      zoneId: "Z",
      candidates: ["A"],
      anonymousPossible: true,
    });
  });
});

// —— CA-5 ————————————————————————————————————————————————————————————————————————————————————————

describe("CA-5 — saída AMBÍGUA degrada o conjunto para SUPERCONJUNTO", () => {
  const r = conserveIdentities(
    [
      ev("T1", "Z", "entrou", 1000),
      ev("T2", "Z", "entrou", 1200),
      ev("T1", "Z", "morreu-dentro", 3000),
      ev("T2", "Z", "morreu-dentro", 3200),
      ev("T3", "Z", "nasceu-dentro", 4000), // ambíguo {A,B}
      ev("T3", "Z", "saiu", 5000),
    ],
    [area("Z")],
    [claim("T1", "A", 900), claim("T2", "B", 900)],
  );

  it("a ocupação cai, mas NENHUM token é removido (não se sabe qual saiu)", () => {
    expect(place(r, "Z")).toMatchObject({
      occupancy: 1,
      tokens: ["A", "B"],
      supersetTokens: true,
    });
    expect(r.diagnostics.ambiguousExits).toBe(1);
  });
});

// —— CA-6 / CA-7 —————————————————————————————————————————————————————————————————————————————————

describe("CA-6 — nascer-dentro sem ocupante disponível = ocupante NOVO", () => {
  it("pessoa já presente no início da observação vira ocupante anônimo e é CONTADA", () => {
    const r = conserveIdentities([ev("T1", "Z", "nasceu-dentro", 1000)], [area("Z")]);
    expect(place(r, "Z")).toMatchObject({ occupancy: 1, anonymous: 1, tokens: [] });
    expect(r.diagnostics.bornInsideNew).toBe(1);
    expect(r.diagnostics.bornInsideAbsorbed).toBe(0);
    expect(r.identities.T1).toEqual({ kind: "desconhecida" });
  });
});

describe("CA-7 — balanço negativo é diagnóstico, não crash", () => {
  it("'saiu' sem entrada clampa em 0 e conta negativeBalance", () => {
    const r = conserveIdentities([ev("T9", "Z", "saiu", 1000)], [area("Z")]);
    expect(place(r, "Z").occupancy).toBe(0);
    expect(r.diagnostics.negativeBalance).toBe(1);
  });

  it("eventos de zona desconhecida e ts não-finito são descartados sem NaN", () => {
    const r = conserveIdentities(
      [
        ev("T1", "FANTASMA", "entrou", 1000),
        { trackId: "T2", zoneId: "Z", kind: "entrou", ts: NaN, tickIndex: 0, bounces: 0 },
        ev("T3", "Z", "entrou", 2000),
      ],
      [area("Z")],
    );
    expect(r.places).toHaveLength(1);
    expect(place(r, "Z").occupancy).toBe(1);
    expect(Number.isNaN(place(r, "Z").occupancy)).toBe(false);
  });
});

// —— CA-8 ————————————————————————————————————————————————————————————————————————————————————————

describe("CA-8 — capacidade do posto é sensor de saúde", () => {
  it("duas pessoas num posto de capacidade 1 levantam a bandeira (sem mudar a resolução)", () => {
    const r = conserveIdentities(
      [ev("T1", "P1", "entrou", 1000), ev("T2", "P1", "entrou", 1200)],
      [posto("P1")],
      [claim("T1", "A", 900), claim("T2", "B", 900)],
    );
    expect(place(r, "P1").capacityViolations).toBe(1);
    expect(place(r, "P1").occupancy).toBe(2);
    expect(r.identities.T2).toMatchObject({ kind: "resolvida", token: "B" });
  });

  it("zona sem capacidade declarada nunca viola", () => {
    const r = conserveIdentities(
      [ev("T1", "Z", "entrou", 1000), ev("T2", "Z", "entrou", 1200)],
      [area("Z")],
    );
    expect(place(r, "Z").capacityViolations).toBe(0);
  });

  it("troca de posto no MESMO ts não gera falsa violação (saída processada antes da entrada)", () => {
    const r = conserveIdentities(
      [ev("T1", "P1", "entrou", 1000), ev("T1", "P1", "saiu", 5000), ev("T2", "P1", "entrou", 5000)],
      [posto("P1")],
    );
    expect(place(r, "P1")).toMatchObject({ occupancy: 1, capacityViolations: 0 });
  });
});

// —— CA-9 ————————————————————————————————————————————————————————————————————————————————————————

describe("CA-9 — claim de identidade durante a visita identifica o anônimo", () => {
  it("o anônimo ganha nome: token entra no conjunto, anonymous decrementa", () => {
    const r = conserveIdentities(
      [ev("T1", "P1", "entrou", 1000)],
      [posto("P1")],
      [claim("T1", "A", 3000)], // o rádio só fala DEPOIS da entrada (o caso comum)
    );
    expect(place(r, "P1")).toMatchObject({ occupancy: 1, tokens: ["A"], anonymous: 0 });
    expect(r.identities.T1).toEqual({ kind: "resolvida", token: "A", via: "claim" });
    // O log mostra a transição desconhecida → resolvida (não some a história).
    expect(r.resolutions.map((x) => x.identity.kind)).toEqual(["desconhecida", "resolvida"]);
  });

  it("claim vence a conservação quando há conflito de candidato", () => {
    const r = conserveIdentities(
      [
        ev("T1", "Z", "entrou", 1000),
        ev("T1", "Z", "morreu-dentro", 2000),
        ev("T2", "Z", "nasceu-dentro", 3000),
      ],
      [area("Z")],
      [claim("T1", "A", 900), claim("T2", "B", 4000)],
    );
    // Antes do claim, a topologia resolveu T2 como A (candidato único); o claim corrige para B.
    expect(r.identities.T2).toEqual({ kind: "resolvida", token: "B", via: "claim" });
    expect(place(r, "Z").tokens).toEqual(["A", "B"]);
  });
});

// —— CA-10 ———————————————————————————————————————————————————————————————————————————————————————

describe("CA-10 — determinismo", () => {
  const events = [
    ev("T1", "P1", "entrou", 1000),
    ev("T2", "P2", "entrou", 1100),
    ev("T1", "P1", "morreu-dentro", 3000),
    ev("T3", "P1", "nasceu-dentro", 3500),
    ev("T2", "P2", "saiu", 4000),
    ev("T3", "P1", "saiu", 6000),
  ];
  const claims = [claim("T1", "A", 900), claim("T2", "B", 900)];
  const places = [posto("P1"), posto("P2")];

  it("a ordem de ENTRADA dos eventos não muda a saída", () => {
    const a = conserveIdentities(events, places, claims);
    const b = conserveIdentities([...events].reverse(), places, [...claims].reverse());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("a saída não contém NaN e as zonas/tokens vêm ordenados", () => {
    const r = conserveIdentities(events, places, claims);
    expect(JSON.stringify(r)).not.toContain("null"); // NaN serializa como null em JSON
    expect(r.places.map((p) => p.zoneId)).toEqual(["P1", "P2"]);
    // A: entrou em P1, o track morreu, T3 nasceu (herdou A por conservação) e SAIU → P1 vazia.
    expect(place(r, "P1")).toMatchObject({ occupancy: 0, tokens: [] });
    expect(r.identities.T3).toEqual({ kind: "resolvida", token: "A", via: "conservacao" });
  });
});

// —— CA-11 (v2) — `lastZone` sobrevive ao prior morto: agora é o insumo da CONTINUIDADE ——————————
//
// O CA-11 ORIGINAL testava o MECANISMO do prior de workflow (matriz de transição). Ele foi REMOVIDO:
// o dono respondeu que o operador CIRCULA LIVRE ⇒ a matriz é uniforme ⇒ informação zero. O que
// sobrevive é o HOOK: a última zona conhecida de cada token, datada — hoje insumo da restrição de
// CONTINUIDADE FÍSICA em `zone-assignment.ts` (não mais de um prior de rota).

describe("CA-11 — a última zona conhecida do token continua a sair da conservação", () => {
  it("lastZone registra de onde o operador veio (insumo da continuidade, não de um prior de rota)", () => {
    const r = conserveIdentities(
      [ev("T1", "MESA4", "entrou", 1000), ev("T1", "MESA4", "saiu", 2000)],
      [posto("MESA4"), posto("MESA7")],
      [claim("T1", "A", 900)],
    );
    expect(r.lastZone.A).toBe("MESA4");
  });
});

// —— Integração com a fronteira real (zone-crossing.ts) ——————————————————————————————————————————

describe("integração — buildTrackZoneEvents sobre a geometria de zone-crossing", () => {
  const p = posto("P1"); // quadrado (0,0)-(4,4)
  const at = (ts: number, x: number, y: number) => ({ ts, foot: { x, y } });

  it("caminha para dentro, o track morre, outro nasce dentro → identidade conservada", () => {
    // T1 entra (confirmado em 2 ticks dentro) e some; T2 aparece já dentro.
    const tracks = [
      {
        trackId: "T1",
        samples: [at(0, -1, 2), at(500, 1, 2), at(1000, 2, 2), at(1500, 2, 2)],
      },
      { trackId: "T2", samples: [at(3000, 2, 2), at(3500, 2, 2)] },
    ];
    const events = buildTrackZoneEvents(tracks, [p]);
    expect(events.map((e) => `${e.trackId}:${e.kind}`)).toEqual([
      "T1:entrou",
      "T1:morreu-dentro",
      "T2:nasceu-dentro",
      "T2:morreu-dentro",
    ]);

    const r = conserveIdentities(events, [p], [claim("T1", "A", 0)]);
    expect(place(r, "P1")).toMatchObject({ occupancy: 1, tokens: ["A"] });
    expect(r.identities.T2).toEqual({ kind: "resolvida", token: "A", via: "conservacao" });
    expect(r.diagnostics.bornInsideNew).toBe(0); // absorvido — sem dupla-contagem
  });

  it("track que só passa por fora não move a conservação", () => {
    const events = buildTrackZoneEvents(
      [{ trackId: "T9", samples: [at(0, -2, 2), at(500, -1, 2), at(1000, -3, 2)] }],
      [p],
    );
    expect(events).toEqual([]);
    const r = conserveIdentities(events, [p]);
    expect(place(r, "P1")).toMatchObject({ occupancy: 0, tokens: [], anonymous: 0 });
  });
});
