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

// Os 4 cantos que a MIGRAÇÃO semeia p/ um retângulo, na ordem TL → TR → BR → BL (horária, y p/
// baixo). É a forma canônica do preset — o teste a escreve à mão de propósito (se ele importasse
// o rectPreset do camcfg, provaria só que a função é igual a si mesma).
const rectPreset = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const RECT_PRESET_02 = rectPreset(0.2, 0.2, 0.3, 0.3);

// ZONA POLIGONAL (spec zonas-poligonais, CA-1 round-trip + armadilha 1): `points` na allowlist —
// salvar e reler preserva o polígono; a bbox é RE-DERIVADA dos points no save (armadilha 3);
// malformado cai no PRESET do retângulo (spec-zona-unificada §7), nunca [] (armadilha 8).
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

  // Malformado NUNCA vira [] (armadilha 8). O que mudou na spec-zona-unificada: em vez de sumir,
  // ele cai no PRESET do retângulo (rectPreset) — que é EXATAMENTE o que a zona já era na prática
  // (sem points e sem máscara, a zona É o retângulo x/y/w/h). Nada é expandido nem encolhido.
  it("malformado (<3, >20, NaN, gravata) → cai no PRESET do retângulo, nunca [] e nunca vazio", () => {
    const casos = [
      [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }], // <3
      Array.from({ length: 21 }, (_, i) => ({ x: i / 30, y: 0.5 })), // 21 vértices
      [{ x: 0.1, y: 0.1 }, { x: NaN, y: 0.2 }, { x: 0.5, y: 0.7 }], // coordenada inválida
      [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }], // gravata
      "não-é-array",
    ];
    for (const points of casos) {
      const rotulo = JSON.stringify(points).slice(0, 40);
      const [z] = roundTrip([{ id: "z-bad", points, x: 0.2, y: 0.2, w: 0.3, h: 0.3 }]);
      expect(z.points, rotulo).toEqual(RECT_PRESET_02); // o retângulo, e SÓ ele
      expect(z, rotulo).toMatchObject({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }); // bbox intacta
    }
  });

  it("retrocompat (CA-5): zona com MÁSCARA não ganha points nem muda de bbox/máscara", () => {
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

// ── MIGRAÇÃO rect → POLÍGONO (spec-zona-unificada §7, F2) ────────────────────────────────────
// A zona É um polígono; o retângulo é o PRESET de 4 vértices. A migração vive no cleanZone (load
// E save) ⇒ é IDEMPOTENTE por construção — sem script, sem downtime. Dado de produção medido no
// camcfg.json real: 22 zonas / 16 câmeras = 20 retângulos puros + 1 polígono + 1 máscara.
//
// O que os testes abaixo PROVAM (a spec pede prova, não comentário):
//   1. o migrado é polígono SIMPLES (não auto-intersecta) — ordem TL→TR→BR→BL consistente;
//   2. a bbox re-derivada volta igual à original a ≤1 ULP (medido bit-a-bit, não "toBeCloseTo");
//   3. contenção: o migrado NUNCA expande a zona, e é IDÊNTICO ao retângulo no interior e nas
//      bordas esquerda/topo — o desacordo é EXATAMENTE a borda direita/baixo (ver o bloco do
//      DELTA abaixo: é bug de `pointInPolygon`, PRÉ-EXISTENTE, que esta migração universaliza);
//   4. idempotência; 5. zona com points não é tocada; 6. zona com máscara NÃO é migrada.
const { pointInPolygon, isSimplePolygon, polygonBBox } = require("./analysis/zones");

// Contenção RETANGULAR de hoje — o pré-filtro que TODO call-site roda (attributeZone/
// inExclusionZone/assignZone/pointInZone): retângulo FECHADO nas 4 bordas (`<`/`>`, não `<=`).
const inRect = (z, px, py) => !(px < z.x || px > z.x + z.w || py < z.y || py > z.y + z.h);

// Distância em ULPs entre dois doubles (bit-a-bit): "≤1 ulp" vira MEDIDA, não retórica.
// (doubles positivos têm padrão de bits monotônico ⇒ a diferença dos bits É a contagem de ulps.)
const ULP_VIEW = new DataView(new ArrayBuffer(8));
function ulpsApart(a, b) {
  ULP_VIEW.setFloat64(0, a);
  const ai = ULP_VIEW.getBigInt64(0);
  ULP_VIEW.setFloat64(0, b);
  const bi = ULP_VIEW.getBigInt64(0);
  return Number(ai > bi ? ai - bi : bi - ai);
}

// Grade densa + as BORDAS EXATAS da zona (é lá que mora o off-by-one — uma grade "redonda" de
// 0,00..1,00 passaria RASPANDO por elas e o teste não valeria nada).
function gridWithEdges(z) {
  const axis = (a, b) => {
    const vs = [];
    for (let i = 0; i <= 100; i++) vs.push(i / 100);
    vs.push(a, b, a - 1e-9, a + 1e-9, b - 1e-9, b + 1e-9);
    return vs.filter((v) => v >= 0 && v <= 1);
  };
  return { xs: axis(z.x, z.x + z.w), ys: axis(z.y, z.y + z.h) };
}

describe("camcfg — MIGRAÇÃO rect → polígono de 4 vértices (spec-zona-unificada §7)", () => {
  // retângulo de produção (cam-8a95ac6090, arredondado): nem alinhado à grade, nem redondo.
  const RECT = { id: "z-rect", label: "Mesa", modo: "atividade", x: 0.2, y: 0.3, w: 0.5, h: 0.4 };

  it("o retângulo puro GANHA os 4 vértices (TL→TR→BR→BL) e o polígono é SIMPLES", () => {
    const [z] = roundTrip([RECT]);
    expect(z.points).toEqual(rectPreset(0.2, 0.3, 0.5, 0.4));
    expect(isSimplePolygon(z.points)).toBe(true); // ordem consistente ⇒ não auto-intersecta
    expect(z.points).toHaveLength(4);
  });

  it("a bbox re-derivada volta IGUAL à original — ≤1 ulp (medido bit-a-bit)", () => {
    const [z] = roundTrip([RECT]);
    expect(z.x).toBe(RECT.x); // origem: idêntica bit-a-bit (não passa por subtração)
    expect(z.y).toBe(RECT.y);
    // w/h re-derivados por (x+w)−x: 0 ou 1 ulp de erro de float, JAMAIS mais.
    expect(ulpsApart(z.w, RECT.w)).toBeLessThanOrEqual(1);
    expect(ulpsApart(z.h, RECT.h)).toBeLessThanOrEqual(1);
  });

  // O CONTRATO DE CONTENÇÃO — o que a migração pode e o que NÃO pode mudar.
  it("contenção: o migrado NUNCA EXPANDE a zona, e é IDÊNTICO no interior e nas bordas esq./topo", () => {
    const [z] = roundTrip([RECT]);
    const { xs, ys } = gridWithEdges(RECT);
    const naBordaDireitaOuBaixo = (px, py) =>
      px === RECT.x + RECT.w || py === RECT.y + RECT.h || px === z.x + z.w || py === z.y + z.h;
    let testados = 0;
    for (const px of xs)
      for (const py of ys) {
        testados++;
        const rect = inRect(RECT, px, py);
        const poly = pointInPolygon({ x: px, y: py }, z.points);
        // (a) NUNCA EXPANDE: nenhum ponto entra na zona que já não estivesse nela. É a direção de
        //     falha que importa p/ área (uma zona não pode crescer EM SILÊNCIO na migração).
        if (poly) expect(rect, `expandiu em (${px},${py})`).toBe(true);
        // (b) fora das bordas direita/baixo, a equivalência é EXATA.
        if (!naBordaDireitaOuBaixo(px, py))
          expect(poly, `divergiu em (${px},${py})`).toBe(rect);
      }
    expect(testados).toBeGreaterThan(10_000); // a grade é densa de verdade
  });

  // ⚠ DELTA MEDIDO — PENDÊNCIA CROSS-FRONT (não é do camcfg): `pointInPolygon` (ray casting) é
  // MEIO-ABERTO — [x0,x1) × [y0,y1). Borda esquerda/topo DENTRO, borda direita/baixo FORA. O
  // pré-filtro retangular é FECHADO. Enquanto a zona não tinha points, só o pré-filtro decidia
  // (fechado); com points, o teste fino meio-aberto passa a decidir ⇒ a zona perde as bordas
  // direita/baixo. Na prática só morde onde as coordenadas se encontram EXATAMENTE: a BORDA DO
  // FRAME (o detector clipa o bbox e o pé sai em y = 1.0 exato). Bug PRÉ-EXISTENTE (já vale p/ o
  // polígono que existe em produção); a migração o universaliza. Conserto: fechar a aresta no
  // pointInPolygon dos DOIS espelhos (server/analysis/zones.js + src/fusion/floor-polygon.ts).
  // A asserção abaixo é ESTÁVEL nos dois mundos: hoje o conjunto de desacordos é a borda
  // direita/baixo; depois do conserto ele é VAZIO (∅ ⊆ borda). O teste não pina o bug.
  it("DELTA de borda: todo desacordo está confinado à borda DIREITA/BAIXO (nunca no interior)", () => {
    const [z] = roundTrip([RECT]);
    const { xs, ys } = gridWithEdges(RECT);
    const desacordos = [];
    for (const px of xs)
      for (const py of ys)
        if (inRect(RECT, px, py) !== pointInPolygon({ x: px, y: py }, z.points))
          desacordos.push([px, py]);
    for (const [px, py] of desacordos)
      expect(px === z.x + z.w || py === z.y + z.h, `desacordo NO INTERIOR: (${px},${py})`).toBe(
        true,
      );
  });

  it("IDEMPOTENTE: migrar 2× = migrar 1× (é por isso que não há script nem downtime)", () => {
    const uma = cleanZones([RECT]);
    expect(cleanZones(uma)).toEqual(uma); // 2ª passada entra pelo ramo de `points`
    expect(roundTrip(uma)).toEqual(uma); // e sobrevive à serialização JSON (Postgres/arquivo)
    expect(roundTrip(roundTrip([RECT]))).toEqual(uma); // ponto fixo a partir do dado LEGADO
  });

  it("zona que JÁ tem points NÃO é tocada (o preset não sobrescreve o desenho do operador)", () => {
    const tri = [
      { x: 0.1, y: 0.1 },
      { x: 0.8, y: 0.2 },
      { x: 0.4, y: 0.9 },
    ];
    const [z] = roundTrip([{ ...RECT, points: tri }]);
    expect(z.points).toEqual(tri); // e NÃO os 4 cantos da bbox velha
  });

  // A EXCEÇÃO (§7 da spec, e a única migração MANUAL da onda): cam-50fa5758e7 "Área 1" é uma faixa
  // DIAGONAL que o pincel entregou serrilhada. O retângulo dela é a ENVOLVENTE, não a área —
  // semear os 4 cantos AUMENTARIA a área em silêncio. Ela preserva a mask e espera o operador.
  it("EXCEÇÃO: zona com MÁSCARA preserva a mask e NÃO ganha points (senão a área CRESCE calada)", () => {
    const [z] = roundTrip([
      { id: "cam-50fa5758e7-zmr2i1ou65", label: "Área 1", modo: "atividade", mask: "32x18:AAAA", x: 0.21875, y: 0.5555555555555556, w: 0.5625, h: 0.4444444444444444 }, // prettier-ignore
    ]);
    expect(z.points).toBeUndefined(); // a migração NÃO a alcança
    expect(z.mask).toBe("32x18:AAAA"); // e a máscara sobrevive intacta (a área real)
    expect(z).toMatchObject({ x: 0.21875, w: 0.5625 }); // bbox da máscara, não re-derivada
  });

  it("DEGENERADA (w ou h = 0) não vira polígono: área zero não é polígono simples → segue retângulo", () => {
    for (const deg of [
      { id: "d1", x: 0.3, y: 0.3, w: 0, h: 0.4 },
      { id: "d2", x: 0.3, y: 0.3, w: 0.4, h: 0 },
    ]) {
      const [z] = roundTrip([deg]);
      expect(z.points, deg.id).toBeUndefined();
      expect(z, deg.id).toMatchObject({ x: deg.x, y: deg.y, w: deg.w, h: deg.h });
    }
  });

  it("retângulo que ESTOURA o frame: vértices clampados 0..1 e a bbox vira a parte DENTRO do frame", () => {
    const [z] = roundTrip([{ id: "z-of", x: 0.8, y: 0.9, w: 0.5, h: 0.5 }]); // x+w=1,3 · y+h=1,4
    expect(z.points).toEqual(rectPreset(0.8, 0.9, 0.2, 0.1)); // = clamp em 1,0
    expect(z.w).toBeCloseTo(0.2, 12);
    expect(z.h).toBeCloseTo(0.1, 12);
  });

  it("o modo não muda nada: exclusão/proibida/leitura migram igual (a zona é UMA só primitiva)", () => {
    for (const modo of ["atividade", "leitura", "objetos", "fadiga", "exclusao", "proibida"]) {
      const [z] = roundTrip([{ ...RECT, id: `z-${modo}`, modo }]);
      expect(z.modo, modo).toBe(modo);
      expect(z.points, modo).toEqual(rectPreset(0.2, 0.3, 0.5, 0.4));
    }
  });

  // O DIA SEGUINTE DA EXCEÇÃO — e o único caminho de migração MANUAL da onda: o operador abre a
  // "Área 1" (máscara) e a REDESENHA como polígono. A zona passa a ter points E mask ao mesmo
  // tempo. Ninguém testava esse estado — e é EXATAMENTE o estado em que a única zona irregular de
  // produção vai cair. O contrato: `points` MANDA (precedência P5, src/zones.ts:39-44 e o espelho
  // analysis/zones.js), a bbox vira a do POLÍGONO (não a envolvente velha da máscara), e a mask
  // fica INERTE — preservada no dado (dropá-la no save seria perda irreversível numa allowlist),
  // mas sem voto na contenção. Sem este teste, "redesenhei e a zona continuou com a área velha"
  // é uma regressão que só o operador descobriria — no chão de fábrica.
  it("points + mask COEXISTEM: o polígono manda, a bbox é dele, e a máscara fica INERTE", () => {
    const { attributeZone } = require("./analysis/zones");
    // faixa diagonal (o que a "Área 1" sempre quis ser) desenhada DENTRO da envolvente da máscara
    const faixa = [
      { x: 0.25, y: 0.95 },
      { x: 0.45, y: 0.6 },
      { x: 0.6, y: 0.6 },
      { x: 0.4, y: 0.95 },
    ];
    const [z] = roundTrip([
      { id: "cam-50fa5758e7-zmr2i1ou65", label: "Área 1", modo: "atividade", points: faixa,
        mask: "32x18:AAAA", x: 0.21875, y: 0.5555555555555556, w: 0.5625, h: 0.4444444444444444 }, // prettier-ignore
    ]);
    expect(z.points).toEqual(faixa); // o desenho do operador sobrevive
    expect(z.mask).toBe("32x18:AAAA"); // a máscara NÃO é destruída no save (dado é do dono)
    expect(z.x).toBeCloseTo(0.25, 10); // ...mas a bbox agora é a do POLÍGONO — a envolvente velha
    expect(z.w).toBeCloseTo(0.35, 10); //    (x=0,21875 · w=0,5625) NÃO sobrevive: points é a fonte
    // e a CONTENÇÃO segue o polígono: um ponto dentro da bbox velha, mas FORA da faixa, está fora.
    expect(attributeZone({ x: 0.3, y: 0.65 }, [z])).toBeNull(); // canto sup-esq: fora da diagonal
    expect(attributeZone({ x: 0.42, y: 0.75 }, [z])).toBe("Área 1"); // dentro da faixa
  });

  // INVARIANTE UNIVERSAL da migração (a razão de ela poder rodar sem script e sem downtime):
  // depois do cleanZone, NENHUMA zona sem máscara fica órfã de `points`. Se um único retângulo
  // escapar, a unificação é mentira — a UI teria de continuar sabendo desenhar "o outro tipo".
  it("INVARIANTE: toda zona SEM máscara e não-degenerada sai do cleanZone COM points", () => {
    let seed = 42; // LCG determinístico (mesmo dado a cada run — teste não pode ser sorteio)
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const zonas = Array.from({ length: 300 }, (_, i) => {
      const x = rnd() * 0.9;
      const y = rnd() * 0.9;
      return { id: `z${i}`, x, y, w: 0.01 + rnd() * (1 - x), h: 0.01 + rnd() * (1 - y) };
    });
    const limpas = cleanZones(zonas);
    expect(limpas).toHaveLength(300);
    for (const z of limpas) {
      expect(z.points, z.id).toHaveLength(4);
      expect(isSimplePolygon(z.points), z.id).toBe(true); // nenhum vira gravata
      expect(polygonBBox(z.points), z.id).toEqual({ x: z.x, y: z.y, w: z.w, h: z.h }); // bbox = cache
    }
    expect(cleanZones(limpas)).toEqual(limpas); // e o conjunto inteiro é ponto fixo (idempotência)
  });
});

// ── CALIBRAÇÃO: round-trip da allowlist (sem BLE — ADR-018) ─────────────────────────────────────
// A regra da casa segue: allowlist nasce com round-trip, ou não nasce. Os campos BLE
// (mac/station/stations/refTag) migraram para o repo mvp_trilateracao_BLE; o teste agora PINA o
// contrato enxuto (points/H/updatedAt) E que payload antigo com os campos BLE continua VÁLIDO —
// os campos só deixam de ser persistidos (aditivo: cliente velho não quebra o hub).
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

describe("camcfg — round-trip da CALIBRAÇÃO (contrato sem BLE, ADR-018)", () => {
  it("preserva points/H/updatedAt no round-trip (o contrato inteiro da distância)", () => {
    const cal = calRoundTrip(BASE);
    expect(cal).toEqual(BASE);
  });

  it("payload ANTIGO com campos BLE (mac/station/stations/refTag) segue válido — os campos só saem", () => {
    const cal = calRoundTrip({
      ...BASE,
      points: BASE.points.map((p, i) => (i === 0 ? { ...p, mac: "AA:BB:CC:DD:EE:FF" } : p)),
      station: { x: 0.2, y: 0.8 },
      stations: { "tc22-a1b2": { x: 0.2, y: 0.8 } },
      refTag: { mac: "AA:BB:CC:DD:EE:00", px: { x: 0.5, y: 0.5 } },
    });
    expect(cal).not.toBeNull(); // cliente velho não quebra o hub (allowlist é aditiva)
    expect(cal).toEqual(BASE); // …mas nada de BLE é persistido
  });
});
