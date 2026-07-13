// Teste do ROUND-TRIP da allowlist de zonas (server/camcfg.js cleanZones) — CA-7 da spec
// alerta-por-atividade (armadilha A5: campo fora da allowlist é descartado MUDO no save).
// Usa SÓ a função PURA cleanZones (exportada p/ teste): não toca camcfg.json nem Postgres —
// saveZones/getZones persistem em disco real e ficam fora do unit test de propósito.
// CommonJS (server/ é pacote CJS) via createRequire, como os demais testes de server/.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const camcfg = require("./camcfg");
const { cleanZones } = camcfg;

// Simula "salvar e reler": allowlist → serialização JSON (Postgres/arquivo) → allowlist de novo.
function roundTrip(zones) {
  return cleanZones(JSON.parse(JSON.stringify(cleanZones(zones))));
}

describe("camcfg — round-trip da zona PROIBIDA (CA-7)", () => {
  it("preserva modo, presencaAlertMs e arming ao salvar e reler", () => {
    const [z] = roundTrip([
      {
        id: "cam-1-z1",
        label: "Cofre",
        x: 0.1,
        y: 0.2,
        w: 0.3,
        h: 0.4,
        modo: "proibida",
        presencaAlertMs: 30_000,
        arming: "sempre",
      },
    ]);
    expect(z).toMatchObject({
      id: "cam-1-z1",
      label: "Cofre",
      modo: "proibida", // NÃO rebaixa p/ "atividade" (mesma armadilha da exclusão)
      presencaAlertMs: 30_000,
      arming: "sempre",
    });
  });

  it("aplica defaults sãos: dwell ausente → 10s; inválido/negativo → clamp; arming inválido → sempre", () => {
    const [semCampos] = roundTrip([{ id: "z1", modo: "proibida" }]);
    expect(semCampos.presencaAlertMs).toBe(10_000);
    expect(semCampos.arming).toBe("sempre");

    const [invalido] = roundTrip([
      { id: "z2", modo: "proibida", presencaAlertMs: "trinta", arming: "quando-der" },
    ]);
    expect(invalido.presencaAlertMs).toBe(10_000); // não-número → default
    expect(invalido.arming).toBe("sempre"); // fora do enum → normalizado p/ 24/7

    const [negativo] = roundTrip([{ id: "z3", modo: "proibida", presencaAlertMs: -5 }]);
    expect(negativo.presencaAlertMs).toBe(0); // clamp inferior

    const [gigante] = roundTrip([{ id: "z4", modo: "proibida", presencaAlertMs: 1e12 }]);
    expect(gigante.presencaAlertMs).toBe(86_400_000); // clamp superior (24h)
  });

  it("retrocompat: zona de outro modo não muda de comportamento (campos antigos intactos)", () => {
    const [z] = roundTrip([
      {
        id: "cam-1-za",
        label: "Espera",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        modo: "atividade",
        idleAlertMs: 120_000,
        sensitivity: 7,
        atividade: "Carga",
        mask: "8x8:AAAA",
      },
    ]);
    expect(z).toMatchObject({
      modo: "atividade",
      idleAlertMs: 120_000,
      sensitivity: 7,
      atividade: "Carga",
      mask: "8x8:AAAA",
    });
    // os campos novos existem com default (aditivo) — nenhum consumidor antigo os lê
    expect(z.presencaAlertMs).toBe(10_000);
    expect(z.arming).toBe("sempre");
    expect(z.shiftIds).toEqual([]); // [] = zona 24/7 (CA-5 da spec-turnos-por-zona)
  });

  it("round-trip é idempotente (limpar 2× = limpar 1×)", () => {
    const uma = cleanZones([
      { id: "z", modo: "proibida", presencaAlertMs: 5_000, x: 0.5, y: 0.5, w: 0.2, h: 0.2 },
    ]);
    expect(roundTrip(uma)).toEqual(uma);
  });
});

// TURNOS POR ZONA (spec-turnos-por-zona F2) — a MESMA armadilha A5: `shiftIds`/`arming` fora da
// allowlist seriam descartados MUDOS no save e o gate de turno nunca veria a atribuição.
describe("camcfg — round-trip da atribuição zona→TURNOS (F2)", () => {
  it("preserva shiftIds e o arming ampliado (dentro-turnos/fora-turnos)", () => {
    const [z] = roundTrip([
      {
        id: "cam-1-z1",
        label: "Expedição",
        modo: "atividade",
        shiftIds: ["sh1", "sh2"],
      },
    ]);
    expect(z.shiftIds).toEqual(["sh1", "sh2"]);

    const [p] = roundTrip([
      { id: "cam-1-z2", label: "Cofre", modo: "proibida", arming: "fora-turnos", shiftIds: ["sh1"] },
    ]);
    expect(p).toMatchObject({ arming: "fora-turnos", shiftIds: ["sh1"] });
    expect(roundTrip([{ id: "z", modo: "proibida", arming: "dentro-turnos" }])[0].arming).toBe(
      "dentro-turnos",
    );
  });

  it("saneia a lista: não-strings/vazios fora, sem duplicata; malformado → [] (24/7)", () => {
    const [z] = roundTrip([{ id: "z", shiftIds: ["sh1", "sh1", "", 7, null, " sh2 "] }]);
    expect(z.shiftIds).toEqual(["sh1", "sh2"]); // trim + dedup, ordem preservada
    expect(roundTrip([{ id: "z", shiftIds: "sh1" }])[0].shiftIds).toEqual([]);
    expect(roundTrip([{ id: "z" }])[0].shiftIds).toEqual([]);
  });
});

// CA-4 — a grade de uma zona não pode ter turnos SOBREPOSTOS (D4). A regra vive no SERVIDOR
// (validateZoneShifts, chamada pelo saveZones → 400 na rota); a UI só exibe a mensagem.
describe("camcfg — validateZoneShifts (CA-4: overlap rejeitado no save)", () => {
  const SEG_SEX = [1, 2, 3, 4, 5];
  const T1 = { id: "sh1", nome: "Turno 1", dias: SEG_SEX, inicio: "06:00", fim: "14:00" };
  const T2 = { id: "sh2", nome: "Turno 2", dias: SEG_SEX, inicio: "14:00", fim: "22:00" };
  const NOITE = { id: "sh3", nome: "Noite", dias: SEG_SEX, inicio: "22:00", fim: "06:00" }; // overnight
  const SOBREPOSTO = { id: "sh4", nome: "Meio", dias: [3], inicio: "10:00", fim: "16:00" }; // pega T1 e T2
  const SABADO = { id: "sh5", nome: "Sábado", dias: [6], inicio: "06:00", fim: "14:00" };
  const CADASTRO = [T1, T2, NOITE, SOBREPOSTO, SABADO];
  const zona = (shiftIds) => [{ id: "z1", label: "Expedição", shiftIds }];

  it("turnos ENCOSTADOS (06–14 + 14–22) não são overlap — a borda pertence a quem INICIA (D4)", () => {
    expect(camcfg.validateZoneShifts(zona(["sh1", "sh2"]), CADASTRO)).toBeNull();
  });

  it("turnos que se cruzam na MESMA zona → erro claro (com os nomes dos dois turnos)", () => {
    const err = camcfg.validateZoneShifts(zona(["sh1", "sh4"]), CADASTRO);
    expect(err).toContain("Expedição");
    expect(err).toContain("Turno 1");
    expect(err).toContain("Meio");
    expect(err).toMatch(/sobrep/i);
    expect(camcfg.validateZoneShifts(zona(["sh2", "sh4"]), CADASTRO)).not.toBeNull();
  });

  it("overnight (22–06) não colide com o turno da manhã do dia seguinte (06–14)", () => {
    expect(camcfg.validateZoneShifts(zona(["sh3", "sh1"]), CADASTRO)).toBeNull();
    // ...mas colide com um turno que comece 05:00 (ainda dentro da janela da noite)
    const madruga = { id: "sh6", nome: "Madrugada", dias: [2], inicio: "05:00", fim: "07:00" };
    expect(
      camcfg.validateZoneShifts(zona(["sh3", "sh6"]), [...CADASTRO, madruga]),
    ).not.toBeNull(); // ter 05:00 cai dentro da noite iniciada na seg 22:00
  });

  it("dias distintos não colidem; zona com 0/1 turno e id órfão nunca são rejeitados", () => {
    expect(camcfg.validateZoneShifts(zona(["sh1", "sh5"]), CADASTRO)).toBeNull(); // seg-sex × sábado
    expect(camcfg.validateZoneShifts(zona([]), CADASTRO)).toBeNull();
    expect(camcfg.validateZoneShifts(zona(["sh4"]), CADASTRO)).toBeNull();
    expect(camcfg.validateZoneShifts(zona(["sh1", "sh-orfa"]), CADASTRO)).toBeNull(); // dangling ignorado
  });
});

// ZONA POLIGONAL (spec zonas-poligonais, CA-1 round-trip + armadilha 1): `points` na allowlist —
// salvar e reler preserva o polígono; a bbox é RE-DERIVADA dos points no save (armadilha 3);
// malformado é descartado como CAMPO AUSENTE (nunca []) e a zona segue como retângulo.
describe("camcfg — round-trip da zona POLIGONAL (points na allowlist)", () => {
  const elle = [
    { x: 0.1, y: 0.1 },
    { x: 0.3, y: 0.1 },
    { x: 0.3, y: 0.6 },
    { x: 0.6, y: 0.6 },
    { x: 0.6, y: 0.8 },
    { x: 0.1, y: 0.8 },
  ];

  it("preserva os points (côncavo em L) e RE-DERIVA a bbox — mesmo com bbox velha do cliente", () => {
    const [z] = roundTrip([
      { id: "z-poly", label: "Rack", modo: "atividade", points: elle, x: 0.9, y: 0.9, w: 0.05, h: 0.05 },
    ]);
    expect(z.points).toEqual(elle); // CA-1: salvar → reler → polígono igual
    // envolvente do L, não a bbox velha (w/h por subtração de floats → tolerância)
    expect(z.x).toBeCloseTo(0.1, 10);
    expect(z.y).toBeCloseTo(0.1, 10);
    expect(z.w).toBeCloseTo(0.5, 10);
    expect(z.h).toBeCloseTo(0.7, 10);
  });

  it("vértices fora do frame são CLAMPADOS 0..1 (P2)", () => {
    const [z] = roundTrip([
      { id: "z-c", points: [{ x: -0.2, y: 0.1 }, { x: 1.5, y: 0.1 }, { x: 0.5, y: 0.9 }] },
    ]);
    expect(z.points).toEqual([
      { x: 0, y: 0.1 },
      { x: 1, y: 0.1 },
      { x: 0.5, y: 0.9 },
    ]);
  });

  it("malformado → campo OMITIDO (nunca []): <3, >20, NaN, auto-intersecção", () => {
    const casos = [
      [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }], // <3
      Array.from({ length: 21 }, (_, i) => ({ x: i / 30, y: 0.5 })), // 21 vértices
      [{ x: 0.1, y: 0.1 }, { x: NaN, y: 0.2 }, { x: 0.5, y: 0.7 }], // coordenada inválida
      [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }], // gravata
      "não-é-array",
    ];
    for (const points of casos) {
      const [z] = roundTrip([{ id: "z-bad", points, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }]);
      expect(z.points, JSON.stringify(points).slice(0, 40)).toBeUndefined();
      expect(z).toMatchObject({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }); // zona segue como retângulo
    }
  });

  it("retrocompat (CA-5): zona sem points não ganha o campo nem muda de bbox/máscara", () => {
    const [z] = roundTrip([
      { id: "z-r", modo: "exclusao", x: 0.1, y: 0.2, w: 0.3, h: 0.4, mask: "8x8:AAAA" },
    ]);
    expect("points" in z).toBe(false);
    expect(z).toMatchObject({ modo: "exclusao", x: 0.1, y: 0.2, w: 0.3, h: 0.4, mask: "8x8:AAAA" });
  });

  it("round-trip poligonal é idempotente", () => {
    const uma = cleanZones([{ id: "z", modo: "proibida", points: elle }]);
    expect(roundTrip(uma)).toEqual(uma);
  });
});

// ── CALIBRAÇÃO: o round-trip que NÃO existia (e por isso o hub descartou `stations` calado) ──────
// A UI da multi-antena salvava `calibration.stations` (o ponto de chão de CADA estação) desde a F3;
// a allowlist do hub nunca conheceu o campo e o jogava fora. Marcar a 2ª antena, salvar e recarregar
// → sumiu. É a "regressão silenciosa nº 1" do CLAUDE.md (contrato entre camadas sem teste), literal.
// A regra da casa é dura por causa disto: allowlist NOVA nasce com round-trip, ou não nasce.
const { cleanCalibration } = camcfg;
const calRoundTrip = (c) => cleanCalibration(JSON.parse(JSON.stringify(cleanCalibration(c))));

// Calibração mínima válida: 4 cantos ↔ retângulo de 5×3 m + a homografia (aqui, identidade).
const BASE = {
  points: [
    { px: { x: 0.1, y: 0.9 }, world: { x: 0, y: 0 } },
    { px: { x: 0.9, y: 0.9 }, world: { x: 5, y: 0 } },
    { px: { x: 0.9, y: 0.5 }, world: { x: 5, y: 3 } },
    { px: { x: 0.1, y: 0.5 }, world: { x: 0, y: 3 } },
  ],
  H: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  updatedAt: 1_700_000_000_000,
};

describe("camcfg — round-trip da CALIBRAÇÃO multi-antena (stations na allowlist)", () => {
  it("preserva os pontos de N estações, indexados pelo stationId", () => {
    const stations = { "tc22-a1b2": { x: 0.2, y: 0.8 }, "tc22-c3d4": { x: 0.85, y: 0.3 } };
    const cal = calRoundTrip({ ...BASE, station: stations["tc22-a1b2"], stations });
    expect(cal.stations).toEqual(stations); // era isto que o hub jogava fora
  });

  it("mantém `station` (singular) como o ponto da PRINCIPAL — retrocompat do motor antigo", () => {
    const principal = { x: 0.2, y: 0.8 };
    const cal = calRoundTrip({
      ...BASE,
      station: principal,
      stations: { "tc22-a1b2": principal, "tc22-c3d4": { x: 0.85, y: 0.3 } },
    });
    expect(cal.station).toEqual(principal);
  });

  it("descarta ponto a ponto: estação torta não invalida a calibração nem as estações boas", () => {
    const cal = calRoundTrip({
      ...BASE,
      stations: {
        "tc22-ok": { x: 0.5, y: 0.5 },
        "tc22-fora": { x: 1.7, y: 0.5 }, // px fora de 0..1
        "tc22-nan": { x: Number.NaN, y: 0.5 },
        "": { x: 0.5, y: 0.5 }, // id vazio
      },
    });
    expect(cal).not.toBeNull(); // a calibração sobrevive
    expect(cal.stations).toEqual({ "tc22-ok": { x: 0.5, y: 0.5 } });
  });

  it("sem estação alguma, o campo é OMITIDO (nunca um objeto vazio mentiroso)", () => {
    expect(calRoundTrip({ ...BASE, stations: {} }).stations).toBeUndefined();
    expect(calRoundTrip(BASE).stations).toBeUndefined();
  });
});
