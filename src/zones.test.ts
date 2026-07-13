// Testes das lógicas PURAS de zona: máscara em grade (geometria + (de)serialização) em zoneMask.ts
// e os utilitários puros de zones.ts. loadZones/saveZones dependem de localStorage (browser) →
// PULADOS aqui (cobertos pelo e2e); ver observação no relatório.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
} from "./zones";
import { APP_CONFIG } from "./config";
import { OBJECT_KEYS } from "./objects/catalog";

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
    expect(z.selectedClasses).toEqual([...OBJECT_KEYS]);
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

  it("proibida: arming normalizado p/ 'sempre' (único valor desta onda)", () => {
    expect(withDefaults({ modo: "proibida" }, "c").arming).toBe("sempre");
    expect(withDefaults({ modo: "proibida", arming: "sempre" }, "c").arming).toBe("sempre");
    // zonas dos demais modos também carregam o campo plano (padrão da casa) sem quebrar nada
    expect(withDefaults({ modo: "atividade" }, "c").arming).toBe("sempre");
  });

  it("mask só é mantida quando é string; selectedClasses vazio → todas", () => {
    expect(withDefaults({ mask: "8x8:AAAA" }, "c").mask).toBe("8x8:AAAA");
    expect(withDefaults({ mask: 123 as never }, "c").mask).toBeUndefined();
    expect(withDefaults({ selectedClasses: [] }, "c").selectedClasses).toEqual([...OBJECT_KEYS]);
    expect(withDefaults({ selectedClasses: ["caixa"] }, "c").selectedClasses).toEqual(["caixa"]);
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
