// Testes das lógicas PURAS de zona: máscara em grade (geometria + (de)serialização) em zoneMask.ts
// e os utilitários puros de zones.ts. loadZones/saveZones dependem de localStorage (browser) →
// PULADOS aqui (cobertos pelo e2e); ver observação no relatório.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  createMask,
  maskGet,
  maskSet,
  anySet,
  clearMask,
  cellAtNorm,
  containsNorm,
  fillRectNorm,
  paintBrush,
  maskBBoxNorm,
  encodeMask,
  decodeMask,
  maskFromRect,
} from "./zoneMask";
import {
  newZoneId,
  loadZones,
  pointInZone,
  assignZone,
  withDefaults,
  ZONE_MODE_COLOR,
  ZONE_MODE_LABEL,
  DEFAULT_PRESENCA_ALERT_MS,
  POLYGON_MAX_POINTS,
  isSimplePolygon,
  sanitizeZonePoints,
  polygonBBox,
  zonePolygon,
  zoneContainsFn,
  maskContainsFn,
  rasterizePolygonMask,
  sanitizeShiftIds,
  pointInPolygon,
  type ZonePoint,
} from "./zones";
import { APP_CONFIG } from "./config";

// FIXTURES COMPARTILHADAS (CA-4): o MESMO arquivo é consumido por server/analysis/zones.test.js —
// paridade TS↔JS do pointInPolygon/isSimplePolygon (armadilha 9: divergência ε na borda colocaria
// a pessoa em zonas diferentes no cliente e no hub).
type PolygonFixtures = {
  polygons: Record<string, ZonePoint[]>;
  containment: { polygon: string; point: ZonePoint; inside: boolean; why: string }[];
  simplicity: { name: string; points: ZonePoint[]; simple: boolean; why: string }[];
};
const FIX: PolygonFixtures = JSON.parse(
  readFileSync(new URL("./zones-polygon-fixtures.json", import.meta.url), "utf8"),
);

describe("zoneMask — geometria de máscara", () => {
  it("get/set respeitam limites e ignoram fora da grade", () => {
    const m = createMask(4, 3);
    expect(anySet(m)).toBe(false);
    maskSet(m, 1, 2, true);
    expect(maskGet(m, 1, 2)).toBe(true);
    expect(anySet(m)).toBe(true);
    maskSet(m, 10, 10, true); // fora → no-op
    expect(maskGet(m, 10, 10)).toBe(false);
    expect(maskGet(m, -1, 0)).toBe(false);
    clearMask(m);
    expect(anySet(m)).toBe(false);
  });

  it("cellAtNorm mapeia ponto normalizado p/ célula (com clamp nas bordas)", () => {
    const m = createMask(4, 4);
    expect(cellAtNorm(m, 0.0, 0.0)).toEqual({ col: 0, row: 0 });
    expect(cellAtNorm(m, 0.99, 0.99)).toEqual({ col: 3, row: 3 });
    expect(cellAtNorm(m, 1.0, 1.0)).toEqual({ col: 3, row: 3 }); // clamp p/ não estourar
    expect(cellAtNorm(m, -0.5, -0.5)).toEqual({ col: 0, row: 0 });
  });

  it("containsNorm reflete a célula pintada sob o ponto", () => {
    const m = createMask(2, 2);
    maskSet(m, 0, 0, true); // quadrante superior-esquerdo
    expect(containsNorm(m, 0.25, 0.25)).toBe(true);
    expect(containsNorm(m, 0.75, 0.75)).toBe(false);
  });

  it("fillRectNorm pinta o retângulo normalizado e maskBBoxNorm devolve a bbox", () => {
    const m = createMask(10, 10);
    fillRectNorm(m, 0.2, 0.2, 0.3, 0.3, true);
    expect(containsNorm(m, 0.3, 0.3)).toBe(true);
    expect(containsNorm(m, 0.9, 0.9)).toBe(false);
    const bb = maskBBoxNorm(m);
    expect(bb).not.toBeNull();
    expect(bb!.x).toBeCloseTo(0.2, 6);
    expect(bb!.y).toBeCloseTo(0.2, 6);
    expect(bb!.w).toBeGreaterThan(0);
    expect(bb!.h).toBeGreaterThan(0);
  });

  it("maskBBoxNorm é null p/ máscara vazia", () => {
    expect(maskBBoxNorm(createMask(5, 5))).toBeNull();
  });

  it("paintBrush pinta um quadrado de raio em torno da célula", () => {
    const m = createMask(5, 5);
    paintBrush(m, 2, 2, 1, true); // 3×3 ao redor de (2,2)
    expect(maskGet(m, 2, 2)).toBe(true);
    expect(maskGet(m, 1, 1)).toBe(true);
    expect(maskGet(m, 3, 3)).toBe(true);
    expect(maskGet(m, 0, 0)).toBe(false); // fora do raio
  });

  it("maskFromRect cria máscara cheia equivalente ao retângulo", () => {
    const m = maskFromRect(8, 8, 0, 0, 1, 1);
    expect(anySet(m)).toBe(true);
    expect(containsNorm(m, 0.5, 0.5)).toBe(true);
  });
});

describe("zoneMask — (de)serialização compacta (round-trip)", () => {
  it("encode→decode preserva dimensões e bits", () => {
    const m = createMask(6, 4);
    maskSet(m, 0, 0, true);
    maskSet(m, 5, 3, true);
    maskSet(m, 2, 1, true);
    const enc = encodeMask(m);
    expect(enc).toMatch(/^6x4:/); // formato "<cols>x<rows>:<base64>"
    const dec = decodeMask(enc);
    expect(dec).not.toBeNull();
    expect(dec!.cols).toBe(6);
    expect(dec!.rows).toBe(4);
    expect([...dec!.bits]).toEqual([...m.bits]);
  });

  it("decodeMask retorna null p/ entradas inválidas", () => {
    expect(decodeMask(undefined)).toBeNull();
    expect(decodeMask("")).toBeNull();
    expect(decodeMask("sem-separador")).toBeNull();
    expect(decodeMask("0x0:abc")).toBeNull();
  });
});

// MUDANÇA DE PRODUTO (2026-07): câmera nova abre LIMPA — sem as 4 zonas-semente
// (Expedição/Carga/Estoque/Espera). loadZones roda em node com um stub de localStorage
// (Map), suficiente porque a função só usa getItem/setItem.
describe("zones — loadZones sem seeding automático", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as Storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("câmera sem nada salvo → lista VAZIA (nenhuma zona-semente é criada)", () => {
    expect(loadZones("cam-nova", "Câmera Nova")).toEqual([]);
  });

  it("câmera existente com zonas salvas (formato novo) → intocadas, só normalizadas", () => {
    const saved = [
      { id: "cam-1-za", label: "Doca 3", x: 0.1, y: 0.2, w: 0.3, h: 0.4, modo: "atividade" },
    ];
    store.set("vp-zones-cam-1", JSON.stringify(saved));
    const zs = loadZones("cam-1", "Cam 1");
    expect(zs).toHaveLength(1);
    expect(zs[0]).toMatchObject({ id: "cam-1-za", label: "Doca 3", modo: "atividade", x: 0.1 });
  });

  it("zonas LEGADAS (sem `modo`) → migradas p/ atividade, sem acrescentar semente", () => {
    const legacy = [{ id: "cam-2-z1", label: "Antiga", x: 0, y: 0, w: 0.5, h: 0.5 }];
    store.set("vp-zones-cam-2", JSON.stringify(legacy));
    const zs = loadZones("cam-2", "Cam 2");
    expect(zs).toHaveLength(1); // NÃO vira 1 legada + 4 sementes
    expect(zs[0]).toMatchObject({ id: "cam-2-z1", label: "Antiga", modo: "atividade" });
  });

  it("migração de câmera legada em modo-de-câmera `leitura` segue criando a zona de leitura", () => {
    store.set("vp-camcfg-cam-3", JSON.stringify({ modo: "leitura", pontoLeitura: "Doca 1" }));
    const zs = loadZones("cam-3", "Cam Leitura");
    expect(zs).toHaveLength(1);
    expect(zs[0]).toMatchObject({ modo: "leitura", ponto: "Doca 1", label: "Cam Leitura" });
  });
});

describe("zones — utilitários puros", () => {
  it("newZoneId gera ids únicos com prefixo da câmera", () => {
    const a = newZoneId("cam-1");
    const b = newZoneId("cam-1");
    expect(a).toMatch(/^cam-1-z/);
    expect(b).toMatch(/^cam-1-z/);
    expect(a).not.toBe(b); // seq incremental garante unicidade no mesmo ms
  });

  it("mapas de cor/rótulo cobrem todos os modos", () => {
    const modos = ["atividade", "leitura", "objetos", "fadiga", "exclusao", "proibida"] as const;
    for (const modo of modos) {
      expect(ZONE_MODE_COLOR[modo]).toMatch(/^#[0-9a-f]{6}$/i);
      expect(typeof ZONE_MODE_LABEL[modo]).toBe("string");
      expect(ZONE_MODE_LABEL[modo].length).toBeGreaterThan(0);
    }
  });

  it("loadZones normaliza e PRESERVA o modo `exclusao` salvo (não vira atividade)", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as Storage);
    store.set(
      "vp-zones-cam-ex",
      JSON.stringify([
        { id: "cam-ex-z1", label: "Grade", x: 0, y: 0, w: 0.4, h: 0.4, modo: "exclusao" },
      ]),
    );
    const zs = loadZones("cam-ex", "Cam Ex");
    expect(zs).toHaveLength(1);
    expect(zs[0]).toMatchObject({ modo: "exclusao", label: "Grade" });
    vi.unstubAllGlobals();
  });

  it("loadZones PRESERVA a zona `proibida` salva com o dwell configurado", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    } as Storage);
    store.set(
      "vp-zones-cam-pr",
      JSON.stringify([
        {
          id: "cam-pr-z1",
          label: "Cofre",
          x: 0.1,
          y: 0.1,
          w: 0.3,
          h: 0.3,
          modo: "proibida",
          presencaAlertMs: 30_000,
        },
      ]),
    );
    const zs = loadZones("cam-pr", "Cam Pr");
    expect(zs).toHaveLength(1);
    expect(zs[0]).toMatchObject({
      modo: "proibida",
      label: "Cofre",
      presencaAlertMs: 30_000,
      arming: "sempre",
    });
    vi.unstubAllGlobals();
  });
});

// withDefaults: preenche os campos planos de TODOS os modos numa zona, respeitando o que já existe.
describe("zones — withDefaults (defaults de zona)", () => {
  it("partial vazio → defaults completos + id gerado com prefixo da câmera", () => {
    const z = withDefaults({}, "cam-9");
    expect(z.id).toMatch(/^cam-9-z/);
    expect(z.label).toBe("Área");
    expect(z).toMatchObject({
      x: 0,
      y: 0,
      w: 1,
      h: 1,
      modo: "atividade",
      sensitivity: 5,
      idleAlertMs: APP_CONFIG.zones.defaultIdleAlertMs,
      ponto: APP_CONFIG.reading.defaultPonto,
      atividade: "Indefinida", // label "Área" não casa nenhuma atividade
    });
    expect(z.selectedClasses).toEqual(["caixa"]); // default de produto: só caixas (2026-07-21)
    expect(z.mask).toBeUndefined();
  });

  it("preserva id, geometria, sensibilidade e atividade explícitos", () => {
    const z = withDefaults(
      { id: "z-fixo", label: "Doca 3", x: 0.1, y: 0.2, w: 0.3, h: 0.4, sensitivity: 8, atividade: "Carga" },
      "cam-1",
    );
    expect(z).toMatchObject({
      id: "z-fixo",
      label: "Doca 3",
      x: 0.1,
      y: 0.2,
      w: 0.3,
      h: 0.4,
      sensitivity: 8,
      atividade: "Carga",
    });
  });

  it("modo: preserva os válidos (inclui exclusao e proibida); inválido → atividade", () => {
    expect(withDefaults({ modo: "leitura" }, "c").modo).toBe("leitura");
    expect(withDefaults({ modo: "exclusao" }, "c").modo).toBe("exclusao");
    expect(withDefaults({ modo: "objetos" }, "c").modo).toBe("objetos");
    expect(withDefaults({ modo: "proibida" }, "c").modo).toBe("proibida");
    expect(withDefaults({ modo: "xpto" as never }, "c").modo).toBe("atividade");
  });

  // ZONA PROIBIDA (spec alerta-por-atividade E1/E2): dwell com default de 10s + arming "sempre".
  it("proibida: presencaAlertMs default 10s; explícito preservado; inválido → default", () => {
    expect(withDefaults({ modo: "proibida" }, "c").presencaAlertMs).toBe(
      DEFAULT_PRESENCA_ALERT_MS,
    );
    expect(withDefaults({ modo: "proibida", presencaAlertMs: 30_000 }, "c").presencaAlertMs).toBe(
      30_000,
    );
    expect(withDefaults({ presencaAlertMs: -5 as never }, "c").presencaAlertMs).toBe(
      DEFAULT_PRESENCA_ALERT_MS,
    );
    expect(withDefaults({ presencaAlertMs: "10" as never }, "c").presencaAlertMs).toBe(
      DEFAULT_PRESENCA_ALERT_MS,
    );
  });

  // ARMING (E4 + turnos F2): enum ampliado — "sempre" (24/7) | "dentro-turnos" | "fora-turnos".
  it("proibida: arming preserva o enum válido; ausente/inválido → 'sempre' (24/7)", () => {
    expect(withDefaults({ modo: "proibida" }, "c").arming).toBe("sempre");
    expect(withDefaults({ modo: "proibida", arming: "dentro-turnos" }, "c").arming).toBe(
      "dentro-turnos",
    );
    expect(withDefaults({ modo: "proibida", arming: "fora-turnos" }, "c").arming).toBe(
      "fora-turnos",
    );
    expect(withDefaults({ modo: "proibida", arming: "quando-der" as never }, "c").arming).toBe(
      "sempre",
    );
    // zonas dos demais modos também carregam o campo plano (padrão da casa) sem quebrar nada
    expect(withDefaults({ modo: "atividade" }, "c").arming).toBe("sempre");
  });

  // TURNOS POR ZONA (spec-turnos-por-zona F2/CA-5): ausente/[] = zona 24/7 = comportamento ATUAL.
  it("shiftIds: default [] (24/7); saneia strings vazias/duplicadas e tipos errados", () => {
    expect(withDefaults({}, "c").shiftIds).toEqual([]);
    expect(withDefaults({ modo: "atividade", shiftIds: ["sh1", "sh2"] }, "c").shiftIds).toEqual([
      "sh1",
      "sh2",
    ]);
    expect(
      withDefaults({ shiftIds: ["sh1", "sh1", " sh2 ", "", 7 as never, null as never] }, "c")
        .shiftIds,
    ).toEqual(["sh1", "sh2"]); // trim + dedup, ordem preservada
    expect(withDefaults({ shiftIds: "sh1" as never }, "c").shiftIds).toEqual([]); // não-array → 24/7
  });

  it("sanitizeShiftIds é o espelho da allowlist do hub (server/camcfg.js cleanZone)", () => {
    expect(sanitizeShiftIds(undefined)).toEqual([]);
    expect(sanitizeShiftIds([" a ", "a", "b"])).toEqual(["a", "b"]);
    expect(sanitizeShiftIds([1, {}, null])).toEqual([]);
  });

  it("mask só é mantida quando é string; selectedClasses vazio → default caixa", () => {
    expect(withDefaults({ mask: "8x8:AAAA" }, "c").mask).toBe("8x8:AAAA");
    expect(withDefaults({ mask: 123 as never }, "c").mask).toBeUndefined();
    expect(withDefaults({ selectedClasses: [] }, "c").selectedClasses).toEqual(["caixa"]);
    expect(withDefaults({ selectedClasses: ["pessoa", "palete"] }, "c").selectedClasses).toEqual([
      "pessoa",
      "palete",
    ]); // escolha explícita é preservada (zonas antigas não mudam)
  });
});

// Filtro geométrico do modo "Exclusão": o PÉ (bottom-center) da pessoa dentro da zona → descartar.
describe("zones — pointInZone (filtro de exclusão)", () => {
  const z = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }; // retângulo 0.2..0.6 em x e y

  it("ponto dentro do retângulo (sem máscara) → true; fora → false", () => {
    expect(pointInZone(z, 0.4, 0.4)).toBe(true); // centro
    expect(pointInZone(z, 0.2, 0.2)).toBe(true); // borda inclusa
    expect(pointInZone(z, 0.1, 0.4)).toBe(false); // à esquerda
    expect(pointInZone(z, 0.4, 0.9)).toBe(false); // abaixo
  });

  it("com `contains` (máscara) o ponto no retângulo mas fora da máscara é rejeitado", () => {
    // máscara que só aceita a metade superior (ny < 0.4)
    const contains = (_nx: number, ny: number) => ny < 0.4;
    expect(pointInZone(z, 0.4, 0.3, contains)).toBe(true); // no retângulo E na máscara
    expect(pointInZone(z, 0.4, 0.5, contains)).toBe(false); // no retângulo, fora da máscara
    expect(pointInZone(z, 0.05, 0.3, contains)).toBe(false); // fora do retângulo (nem chega à máscara)
  });
});

// assignZone: a regra ÚNICA de atribuição de zona com desempate. Fixa o FIX do zoneOf de
// ObjetosProcessor (first-match por ordem de lista) — o MESMO bug já corrigido na atividade:
// com zonas sobrepostas, a contagem caía na primeira zona da lista em vez da zona que de fato
// contém o corpo.
describe("zones — assignZone (desempate por interseção, depois menor área)", () => {
  // Zona "grande" primeiro na lista (pega first-match); zona "específica" sobreposta depois.
  const grande = { label: "Espera", x: 0, y: 0, w: 1, h: 1 };
  const especifica = { label: "Doca 3", x: 0.4, y: 0.4, w: 0.3, h: 0.3 };
  const zonas = [grande, especifica];

  it("BUG do first-match: bbox majoritariamente na zona específica NÃO cai na primeira da lista", () => {
    // bbox 0.45..0.65 × 0.45..0.65 — inteiramente dentro da específica (e também da grande).
    const bbox = [0.45, 0.45, 0.2, 0.2] as const;
    const z = assignZone(zonas, 0.55, 0.55, bbox);
    // interseção com a específica = área inteira do bbox; com a grande, idem — EMPATE de
    // interseção → vence a de MENOR área (a específica), nunca a primeira da lista.
    expect(z?.label).toBe("Doca 3");
  });

  it("maior interseção vence mesmo quando a zona vem depois na lista", () => {
    const a = { label: "A", x: 0, y: 0, w: 0.6, h: 1 };
    const b = { label: "B", x: 0.4, y: 0, w: 0.6, h: 1 };
    // centro em x=0.5 (dentro das duas); bbox 0.42..0.58 pende p/ B? Não: simétrico. Puxa p/ A:
    const bboxA = [0.3, 0.4, 0.25, 0.2] as const; // 0.3..0.55 → interseção maior com A
    expect(assignZone([b, a], 0.42, 0.5, bboxA)?.label).toBe("A");
    const bboxB = [0.45, 0.4, 0.25, 0.2] as const; // 0.45..0.7 → interseção maior com B
    expect(assignZone([a, b], 0.58, 0.5, bboxB)?.label).toBe("B");
  });

  it("sem bbox: decide pela MENOR área entre as zonas que contêm o ponto", () => {
    expect(assignZone(zonas, 0.5, 0.5)?.label).toBe("Doca 3");
    expect(assignZone(zonas, 0.1, 0.1)?.label).toBe("Espera"); // fora da específica
  });

  it("respeita a máscara via containsOf e devolve null quando nenhuma zona contém o ponto", () => {
    type Z = { label: string; x: number; y: number; w: number; h: number; contains?: (nx: number, ny: number) => boolean };
    const mascarada: Z = { label: "M", x: 0, y: 0, w: 1, h: 1, contains: (_nx, ny) => ny < 0.3 };
    expect(assignZone([mascarada], 0.5, 0.2, undefined, (s) => s.contains)?.label).toBe("M");
    expect(assignZone([mascarada], 0.5, 0.8, undefined, (s) => s.contains)).toBeNull();
    expect(assignZone([especifica], 0.1, 0.1)).toBeNull();
  });
});

// ── ZONAS POLIGONAIS (spec zonas-poligonais F1) ───────────────────────────────

// CA-4: as fixtures compartilhadas passam IDÊNTICAS no cliente (este arquivo) e no hub
// (server/analysis/zones.test.js) — o 1º sensor de paridade cross-language da casa.
describe("polígono — paridade das fixtures compartilhadas (CA-4, lado TS)", () => {
  it("pointInPolygon responde exatamente o registrado (inclui bordas/vértices — CA-3 no L)", () => {
    for (const c of FIX.containment) {
      const poly = FIX.polygons[c.polygon];
      expect(poly, `polígono ${c.polygon} existe nas fixtures`).toBeDefined();
      expect(pointInPolygon(c.point, poly), `${c.polygon} @ (${c.point.x},${c.point.y}): ${c.why}`).toBe(
        c.inside,
      );
    }
  });

  it("isSimplePolygon valida/bloqueia exatamente o registrado (P2/P3)", () => {
    for (const s of FIX.simplicity)
      expect(isSimplePolygon(s.points), `${s.name}: ${s.why}`).toBe(s.simple);
  });
});

describe("polígono — sanitizeZonePoints/polygonBBox (validação P2, armadilha 8)", () => {
  const tri: ZonePoint[] = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.5, y: 0.7 },
  ];

  it("válido → clamp 0..1 aplicado; malformado → undefined, NUNCA []", () => {
    expect(sanitizeZonePoints(tri)).toEqual(tri);
    // clamp de vértice fora do frame
    expect(sanitizeZonePoints([{ x: -0.5, y: 0.2 }, { x: 1.8, y: 0.2 }, { x: 0.5, y: 0.7 }])).toEqual([
      { x: 0, y: 0.2 },
      { x: 1, y: 0.2 },
      { x: 0.5, y: 0.7 },
    ]);
    // malformados: nunca devolver [] (zona sem área muda)
    for (const bad of [
      undefined,
      null,
      "abc",
      [],
      tri.slice(0, 2), // <3 vértices
      Array.from({ length: POLYGON_MAX_POINTS + 1 }, (_, i) => ({ x: i / 30, y: 0.5 })), // 21º recusado
      [{ x: 0.1, y: 0.1 }, { x: NaN, y: 0.2 }, { x: 0.5, y: 0.7 }],
      [{ x: 0.1, y: 0.1 }, { x: 0.2 }, { x: 0.5, y: 0.7 }],
      // auto-intersecção (gravata) — P2 bloqueia
      [{ x: 0.1, y: 0.1 }, { x: 0.9, y: 0.9 }, { x: 0.9, y: 0.1 }, { x: 0.1, y: 0.9 }],
    ]) {
      const out = sanitizeZonePoints(bad);
      expect(out, `malformado ${JSON.stringify(bad)?.slice(0, 40)}`).toBeUndefined();
    }
  });

  it("polygonBBox deriva a envolvente dos vértices (pré-filtro retangular, armadilha 3)", () => {
    const bb = polygonBBox(tri); // w/h por subtração de floats → comparação com tolerância
    expect(bb.x).toBeCloseTo(0.2, 10);
    expect(bb.y).toBeCloseTo(0.2, 10);
    expect(bb.w).toBeCloseTo(0.6, 10);
    expect(bb.h).toBeCloseTo(0.5, 10);
  });
});

describe("polígono — withDefaults (CA-1 round-trip do modelo + CA-5 retrocompat)", () => {
  const elle = FIX.polygons.elle;

  it("points válidos: preservados e bbox x,y,w,h DERIVADA deles (ignora a bbox informada)", () => {
    const z = withDefaults({ points: elle, x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, "cam-p");
    expect(z.points).toEqual(elle);
    // envolvente do L (w/h por subtração de floats → tolerância)
    expect(z.x).toBeCloseTo(0.1, 10);
    expect(z.y).toBeCloseTo(0.1, 10);
    expect(z.w).toBeCloseTo(0.5, 10);
    expect(z.h).toBeCloseTo(0.7, 10);
  });

  it("points malformados → undefined (nunca []), zona segue como retângulo (armadilha 8)", () => {
    const z = withDefaults({ points: [{ x: 0.1, y: 0.1 }], x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, "c");
    expect(z.points).toBeUndefined();
    expect(z).toMatchObject({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }); // bbox informada intocada
  });

  it("CA-5: zona SEM points é bit-idêntica ao comportamento anterior (rect ± máscara)", () => {
    const antes = withDefaults(
      { id: "z-r", label: "Doca", x: 0.1, y: 0.2, w: 0.3, h: 0.4, mask: "8x8:AAAA" },
      "cam-1",
    );
    expect(antes).toMatchObject({ x: 0.1, y: 0.2, w: 0.3, h: 0.4, mask: "8x8:AAAA" });
    expect(antes.points).toBeUndefined();
  });
});

describe("polígono — precedência points>mask e consumo rasterizado (P5/P6, CA-5/CA-6)", () => {
  const elle = FIX.polygons.elle;

  it("zoneContainsFn: com points, a máscara é IGNORADA (points vence — P5)", () => {
    // máscara que só aceitaria a metade DIREITA (x ≥ 0.5) — o oposto do braço do L
    const m = createMask(2, 1);
    fillRectNorm(m, 0.5, 0, 0.5, 1, true);
    const fn = zoneContainsFn({ points: elle }, m)!;
    expect(fn(0.2, 0.3)).toBe(true); // dentro do L, FORA da máscara → polígono decide
    expect(fn(0.45, 0.3)).toBe(false); // vão do L (CA-3), mesmo com máscara irrelevante
  });

  it("zoneContainsFn sem points degrada p/ o caminho de máscara (CA-5)", () => {
    const m = createMask(2, 1);
    fillRectNorm(m, 0, 0, 0.5, 1, true); // só metade esquerda
    const fn = zoneContainsFn({}, m)!;
    expect(fn(0.25, 0.5)).toBe(true);
    expect(fn(0.75, 0.5)).toBe(false);
    expect(zoneContainsFn({}, null)).toBeUndefined(); // retângulo cheio → sem teste fino
    expect(maskContainsFn(createMask(2, 1))).toBeUndefined(); // máscara vazia degrada p/ retângulo
  });

  it("rasterizePolygonMask: centro da célula decide; o L côncavo vira células fiéis (P6)", () => {
    const m = rasterizePolygonMask(10, 10, elle);
    expect(containsNorm(m, 0.2, 0.3)).toBe(true); // braço vertical
    expect(containsNorm(m, 0.45, 0.7)).toBe(true); // pé horizontal
    expect(containsNorm(m, 0.45, 0.3)).toBe(false); // vão do L
    expect(containsNorm(m, 0.95, 0.95)).toBe(false); // fora
  });

  it("zonePolygon devolve os points efetivos (≥3) ou null", () => {
    expect(zonePolygon({ points: elle })).toEqual(elle);
    expect(zonePolygon({})).toBeNull();
    expect(zonePolygon({ points: elle.slice(0, 2) })).toBeNull();
  });
});

// ── A REGRA DA UNIFICAÇÃO (spec-zona-unificada) — espelho do lado hub ─────────────────────────
// `points` é a FONTE DA VERDADE; `x/y/w/h` é CACHE da envolvente — DERIVADO, NUNCA AUTORADO.
describe("O RETÂNGULO É UM POLÍGONO DE 4 VÉRTICES (o preset da migração — lado cliente)", () => {
  const RECT = { x: 0.2, y: 0.3, w: 0.4, h: 0.5 };
  const asPoly = FIX.polygons.retangulo;

  // A regra da migração (G2/cleanZone): rect → [{x,y},{x+w,y},{x+w,y+h},{x,y+h}].
  const migrar = (r: { x: number; y: number; w: number; h: number }): ZonePoint[] => [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];

  it("a regra da migração reproduz a fixture — a MENOS DE 1 ULP (0.2+0.4 ≠ 0.6 em IEEE754)", () => {
    migrar(RECT).forEach((p, i) => {
      expect(p.x).toBeCloseTo(asPoly[i].x, 12);
      expect(p.y).toBeCloseTo(asPoly[i].y, 12);
    });
    // O DETALHE QUE MORDE quem escrever `toEqual` na migração (mordeu aqui): a SOMA não é exata.
    expect(RECT.x + RECT.w).not.toBe(0.6); // 0.6000000000000001 — erro de 5,55e-17 (1 ulp)
    expect(RECT.y + RECT.h).toBe(0.8); // e esta É exata: o erro depende do par, não da regra
  });

  it("withDefaults: rect migrado → envolvente ≤1 ulp e SEM DERIVA ao re-salvar (idempotência)", () => {
    const z = withDefaults({ label: "Doca", points: migrar(RECT) }, "cam-m");
    expect(z.x).toBe(RECT.x); // min/max não somam → x,y voltam EXATOS
    expect(z.y).toBe(RECT.y);
    expect(z.w).toBeCloseTo(RECT.w, 12); // w = (x+w)−x → carrega o ulp da soma
    expect(z.h).toBeCloseTo(RECT.h, 12);
    expect(Math.abs(z.w - RECT.w)).toBeLessThan(1e-15); // 5,55e-17: sub-nanopixel, inofensivo

    // IDEMPOTÊNCIA: re-passar a zona JÁ migrada por withDefaults não move nada (o erro não
    // se acumula a cada save — a premissa do cleanZone da G2).
    const z2 = withDefaults(z, "cam-m");
    expect(z2.points).toEqual(z.points);
    expect(z2.x).toBe(z.x);
    expect(z2.y).toBe(z.y);
    expect(z2.w).toBe(z.w);
    expect(z2.h).toBe(z.h);
  });

  it("mesma decisão do retângulo NO INTERIOR: a pessoa não troca de zona ao migrar", () => {
    const antes = { label: "Doca", ...RECT };
    const depois = withDefaults({ label: "Doca", points: asPoly }, "c");
    const fine = (z: { points?: ZonePoint[] }) => zoneContainsFn(z, null);
    for (const p of [
      { x: 0.4, y: 0.55 },
      { x: 0.25, y: 0.35 },
      { x: 0.55, y: 0.75 },
      { x: 0.1, y: 0.55 },
      { x: 0.4, y: 0.95 },
    ]) {
      const a = assignZone([antes], p.x, p.y)?.label ?? null;
      const b = assignZone([depois], p.x, p.y, undefined, fine)?.label ?? null;
      expect(b, `(${p.x},${p.y}) — migração mudou a atribuição`).toBe(a);
    }
  });
});

describe("A REGRA: points é FONTE DA VERDADE, x/y/w/h é CACHE derivado (NUNCA autorado)", () => {
  const pts = FIX.polygons.retangulo; // vive em x 0.2..0.6, y 0.3..0.8

  it("withDefaults RE-DERIVA a bbox e IGNORA a autorada, por mais mentirosa que seja", () => {
    const z = withDefaults({ label: "M", points: pts, x: 0.9, y: 0.9, w: 0.05, h: 0.05 }, "c");
    expect(z.x).toBeCloseTo(0.2, 12);
    expect(z.y).toBeCloseTo(0.3, 12);
    expect(z.w).toBeCloseTo(0.4, 12);
    expect(z.h).toBeCloseTo(0.5, 12);
  });

  it("se a bbox FOSSE autorada, a zona engoliria a pessoa em SILÊNCIO (o modo de falha que a regra mata)", () => {
    // O pré-filtro retangular do assignZone roda ANTES do teste fino: uma bbox mentirosa corta a
    // pessoa antes de o polígono opinar. A zona simplesmente nunca atribui — falha calada.
    const mentirosa = { label: "M", x: 0.9, y: 0.9, w: 0.05, h: 0.05, points: pts };
    const fine = (z: { points?: ZonePoint[] }) => zoneContainsFn(z, null);
    expect(assignZone([mentirosa], 0.4, 0.55, undefined, fine)).toBeNull(); // dentro do POLÍGONO, e null

    // Passando pelo withDefaults (bbox derivada), a mesma zona atribui.
    const correta = withDefaults(mentirosa, "c");
    expect(assignZone([correta], 0.4, 0.55, undefined, fine)?.label).toBe("M");
  });

  it("pointInZone tem o MESMO pré-filtro: bbox mentirosa mata o teste fino do polígono", () => {
    const mentirosa = { x: 0.9, y: 0.9, w: 0.05, h: 0.05 };
    const contains = zoneContainsFn({ points: pts }, null);
    expect(pointInZone(mentirosa, 0.4, 0.55, contains)).toBe(false); // pé no polígono, e não exclui
    expect(pointInZone(polygonBBox(pts), 0.4, 0.55, contains)).toBe(true); // bbox derivada → exclui
  });
});

describe("desempate com zonas 100% POLIGONAIS (o mundo pós-migração) — regra intacta", () => {
  // O desempate (maior interseção bbox∩zona, depois MENOR área da bbox — pinado acima p/ o mundo
  // retangular) roda sobre a bbox DERIVADA. Sem derivação, ele decidiria sobre geometria fantasma.
  const grande = withDefaults({ label: "Espera", points: FIX.polygons["frame-cheio"] }, "c");
  const especifica = withDefaults({ label: "Doca 3", points: FIX.polygons.retangulo }, "c");
  const fine = (z: { points?: ZonePoint[] }) => zoneContainsFn(z, null);

  it("bbox contida nas duas → EMPATE de interseção → vence a de MENOR área (a específica)", () => {
    const bbox = [0.35, 0.5, 0.1, 0.1] as const;
    expect(assignZone([grande, especifica], 0.4, 0.55, bbox, fine)?.label).toBe("Doca 3");
  });

  it("só ponto → overlap 0 p/ todas → vence a de MENOR área", () => {
    expect(assignZone([grande, especifica], 0.4, 0.55, undefined, fine)?.label).toBe("Doca 3");
  });

  it("o VÃO do L côncavo pertence à zona de baixo, não ao L (o polígono decide, não a envolvente)", () => {
    const elleZ = withDefaults({ label: "Elle", points: FIX.polygons.elle }, "c");
    expect(assignZone([elleZ, grande], 0.45, 0.3, undefined, fine)?.label).toBe("Espera"); // vão
    expect(assignZone([elleZ, grande], 0.2, 0.3, undefined, fine)?.label).toBe("Elle"); // braço
  });
});
