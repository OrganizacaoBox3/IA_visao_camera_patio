// O CONTRATO DO EDITOR DE ZONA — o gate do `usePolygonEditor` (spec-zona-unificada F3).
//
// POR QUE ESTE ARQUIVO EXISTE: o hook é o molde do editor e até esta onda só tinha e2e do fluxo de
// CRIAÇÃO. "Estender contrato sem teste é a regressão silenciosa nº 1" não é slogan — foi a mordida
// do dia (a UI salvava `calibration.stations`, o hub descartava calado, e não havia round-trip).
// Aqui pinamos o contrato INTEIRO, incluindo o delta que a unificação acabou de trazer: preset
// retângulo, seleção, midpoint que insere, Alt+clique/Delete que removem e arraste da FORMA.
// (Regra 11: toda feature nova reporta o sensor do SEU delta — não só o agregado.)
//
// COMO SE TESTA UM HOOK SEM NAVEGADOR (e por que não vale um jsdom): o hook usa exatamente três
// primitivas do React — useState/useRef/useEffect — e nenhuma API de DOM além de
// `document.addEventListener` e `getBoundingClientRect`. Um micro-runtime de ~40 linhas (abaixo)
// roda o HOOK REAL, com re-render e efeitos, sem trazer jsdom + testing-library ao projeto (duas
// deps novas para testar três hooks — não passa no filtro Signal×Noise da casa).
//
// GEOMETRIA DO PALCO (fixada p/ aritmética limpa): viewport 1000×1000 px, frame 1000×1000 →
// getContentRect sem letterbox → 1 unidade normalizada = 1000 px. Logo o alvo de toque de 14 px
// (HIT_RADIUS_PX — o que torna o editor usável no DEDO; P7: o operador usa TABLET) vale 0,014
// normalizado, e o piso do preset retângulo (16 px) vale 0,016.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Zone, ZonePoint } from "../zones";
import type { FrameSource } from "../frame";

// ── micro-runtime de hooks (substitui o React só neste arquivo) ───────────────
type EffectSlot = { deps?: readonly unknown[] };
const H = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  queue: [] as Array<{ i: number; fn: () => void | (() => void) }>,
  cleanups: new Map<number, () => void>(),
  render: null as null | (() => void),
  rendering: false,
}));

vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = H.cursor++;
    if (!(i in H.slots)) H.slots[i] = init;
    const set = (v: unknown) => {
      const next = typeof v === "function" ? (v as (p: unknown) => unknown)(H.slots[i]) : v;
      if (Object.is(next, H.slots[i])) return;
      H.slots[i] = next;
      if (!H.rendering) H.render?.(); // re-render síncrono (o React batcha; aqui não precisa)
    };
    return [H.slots[i], set];
  },
  useRef: (init: unknown) => {
    const i = H.cursor++;
    if (!(i in H.slots)) H.slots[i] = { current: init };
    return H.slots[i];
  },
  useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => {
    const i = H.cursor++;
    const prev = H.slots[i] as EffectSlot | undefined;
    const mudou =
      !prev ||
      !deps ||
      !prev.deps ||
      deps.length !== prev.deps.length ||
      deps.some((d, k) => !Object.is(d, prev.deps![k]));
    H.slots[i] = { deps } satisfies EffectSlot;
    if (mudou) H.queue.push({ i, fn });
  },
}));

/** roda o hook de verdade; `box.current` é sempre o retorno do ÚLTIMO render (como no React) */
function renderHook<T>(fn: () => T): { current: T } {
  H.slots.length = 0;
  H.cursor = 0;
  H.queue.length = 0;
  for (const c of H.cleanups.values()) c();
  H.cleanups.clear();
  const box = { current: undefined as unknown as T };
  const render = () => {
    H.cursor = 0;
    H.rendering = true;
    try {
      box.current = fn();
    } finally {
      H.rendering = false;
    }
    for (const { i, fn: eff } of H.queue.splice(0)) {
      H.cleanups.get(i)?.(); // cleanup do efeito anterior, como o React faz
      H.cleanups.delete(i);
      const c = eff();
      if (typeof c === "function") H.cleanups.set(i, c);
    }
  };
  H.render = render;
  render();
  return box;
}

// ── palco falso ───────────────────────────────────────────────────────────────
const VP = 1000; // viewport = frame → 1 unidade normalizada = 1000 px
const FRAME = { el: null, w: VP, h: VP } as unknown as FrameSource;
/** ponto NORMALIZADO → evento de pointer em px do viewport (r.left = r.top = 0) */
const at = (nx: number, ny: number) => ({ clientX: nx * VP, clientY: ny * VP });
const altAt = (nx: number, ny: number) => ({ ...at(nx, ny), altKey: true });

const QUADRADO: ZonePoint[] = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];
const TRIANGULO: ZonePoint[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.5, y: 0.8 },
];
type Patch = { points: ZonePoint[]; x: number; y: number; w: number; h: number };

/** zona poligonal com a bbox DERIVADA (a regra: points é a fonte da verdade) */
function zona(id: string, points: ZonePoint[]): Zone {
  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    id,
    label: id,
    points,
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  } as Zone;
}

function setup(zones: Zone[] = []) {
  const spies = {
    start: vi.fn(),
    create: vi.fn<(pts: ZonePoint[]) => void>(),
    live: vi.fn<(id: string, p: Patch) => void>(),
    patch: vi.fn<(id: string, p: Patch) => void>(),
    alert: vi.fn<(m: string) => void>(),
  };
  const viewport = {
    clientWidth: VP,
    clientHeight: VP,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: VP, height: VP }),
  };
  const hook = renderHook(() =>
    usePolygonEditor({
      viewportRef: { current: viewport as unknown as HTMLDivElement },
      currentFrame: () => FRAME,
      zonesRef: { current: zones },
      onStart: spies.start,
      onCreate: spies.create,
      onLive: spies.live,
      onPatch: spies.patch,
      onAlert: spies.alert,
    }),
  );
  /** último patch/live emitido (o que a UI de fato receberia) */
  const ultimo = (m: typeof spies.live) => m.mock.calls[m.mock.calls.length - 1][1];
  return { hook, spies, ultimo };
}

/** o hook instala o listener de teclado no `document` em CAPTURE — capturamos p/ simular teclas */
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
beforeEach(() => {
  keyHandler = null;
  vi.stubGlobal("document", {
    addEventListener: (t: string, fn: EventListener) => {
      if (t === "keydown") keyHandler = fn as (e: KeyboardEvent) => void;
    },
    removeEventListener: (t: string) => {
      if (t === "keydown") keyHandler = null;
    },
    // Guarda do ESC no hook: sem layer modal do Radix aberto neste palco falso, sempre null.
    querySelector: () => null,
  });
});
afterEach(() => vi.unstubAllGlobals());

const press = (key: string, target?: { tagName?: string; isContentEditable?: boolean }) => {
  const e = { key, target, preventDefault: vi.fn() } as unknown as KeyboardEvent;
  keyHandler?.(e);
  return e;
};

// O import vem DEPOIS do vi.mock (hoistado) — o hook enxerga o micro-runtime.
const { usePolygonEditor } = await import("./usePolygonEditor");

// ── gestos do modo ÁREA (área-um-botão) ──────────────────────────────────────
// UM CLIQUE = down + up SEM movimento: com o rascunho VAZIO ele semeia o 1º vértice (decide
// "polígono"); com o rascunho já aberto, adiciona um vértice. O ARRASTE (down + move ≥ limiar + up)
// decide "retângulo" — testado à parte no bloco do gesto.
type Ptr = { clientX: number; clientY: number; altKey?: boolean };
type Ed = ReturnType<typeof usePolygonEditor>;
const click = (h: { current: Ed }, e: Ptr) => {
  h.current.onDown(e);
  h.current.onUp();
};
/** abre o modo Área e desenha um POLÍGONO clicando cada ponto (o 1º clique decide a forma). */
const drawPoly = (h: { current: Ed }, pts: Ptr[]) => {
  h.current.startArea();
  for (const p of pts) click(h, p);
};

// ═════════════════════════════════════════════════════════════════════════════

describe("usePolygonEditor — RASCUNHO polígono (clique a clique, depois do 1º clique decidir)", () => {
  it("nasce inerte: sem modo e sem zona, o palco NÃO é sequestrado (onDown devolve o evento)", () => {
    const { hook } = setup();
    expect(hook.current.active).toBe(false);
    expect(hook.current.count).toBe(0);
    expect(hook.current.hint).toBeNull();
    expect(hook.current.onDown(at(0.5, 0.5))).toBe(false);
    expect(hook.current.onMove(at(0.5, 0.5))).toBe(false);
    expect(hook.current.onUp()).toBe(false);
  });

  it("startArea() desliga os outros editores e arma o modo; cada CLIQUE acrescenta um vértice", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    expect(spies.start).toHaveBeenCalledTimes(1); // exclusividade do palco
    expect(hook.current.active).toBe(true);
    expect(hook.current.count).toBe(0); // ainda INDECISO (o gesto é que decide)
    [at(0.2, 0.2), at(0.6, 0.2), at(0.6, 0.6)].forEach((p, i) => {
      click(hook, p); // clique = down+up sem mover: o 1º decide "polígono", os demais adicionam
      expect(hook.current.count).toBe(i + 1);
    });
    expect(spies.create).not.toHaveBeenCalled(); // ainda não fechou
  });

  it("clique FORA do vídeo é ignorado sem matar o rascunho (o dedo escorrega na borda do tablet)", () => {
    const { hook } = setup();
    hook.current.startArea();
    click(hook, at(0.2, 0.2)); // 1º vértice
    expect(hook.current.onDown({ clientX: -50, clientY: 500 })).toBe(true); // consome, mas não cria
    expect(hook.current.onDown({ clientX: 1500, clientY: 500 })).toBe(true);
    expect(hook.current.count).toBe(1);
    expect(hook.current.active).toBe(true);
  });

  it("Voltar (undo) remove o ÚLTIMO vértice; em rascunho vazio é no-op (não vira -1)", () => {
    const { hook } = setup();
    hook.current.startArea();
    click(hook, at(0.2, 0.2));
    click(hook, at(0.6, 0.2));
    hook.current.undo();
    expect(hook.current.count).toBe(1);
    hook.current.undo();
    hook.current.undo();
    expect(hook.current.count).toBe(0);
  });

  it("TETO de 20 vértices: o 21º é RECUSADO com aviso (e o rascunho segue fechável)", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    for (let i = 0; i < 20; i++) click(hook, at(0.05 + i * 0.045, 0.1 + (i % 2) * 0.02));
    expect(hook.current.count).toBe(20);
    click(hook, at(0.9, 0.9)); // 21º
    expect(hook.current.count).toBe(20); // NÃO entrou
    expect(spies.alert.mock.calls[0][0]).toContain("20");
  });
});

describe("usePolygonEditor — FECHAMENTO (1º vértice · Enter · ESC) e o mínimo de 3", () => {
  const desenhaTres = (hook: { current: Ed }) =>
    drawPoly(hook, [at(0.2, 0.2), at(0.6, 0.2), at(0.6, 0.6)]);

  it("fecha clicando NO 1º VÉRTICE (alvo de 14 px — o dedo, não o pixel)", () => {
    const { hook, spies } = setup();
    desenhaTres(hook);
    hook.current.onDown({ clientX: 0.2 * VP + 13, clientY: 0.2 * VP }); // 13 px < 14 → FECHA
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toEqual([
      { x: 0.2, y: 0.2 },
      { x: 0.6, y: 0.2 },
      { x: 0.6, y: 0.6 },
    ]); // o clique de fechamento NÃO vira vértice
    expect(hook.current.active).toBe(false);
    expect(hook.current.count).toBe(0);
  });

  it("clique PERTO mas FORA do raio (15 px) NÃO fecha — vira mais um vértice", () => {
    const { hook, spies } = setup();
    desenhaTres(hook);
    hook.current.onDown({ clientX: 0.2 * VP + 15, clientY: 0.2 * VP });
    expect(spies.create).not.toHaveBeenCalled();
    expect(hook.current.count).toBe(4);
  });

  it("MÍNIMO de 3: com 2 vértices nem Concluir nem Enter fecham (e o rascunho é preservado)", () => {
    const { hook, spies } = setup();
    drawPoly(hook, [at(0.2, 0.2), at(0.6, 0.2)]);
    hook.current.close();
    press("Enter");
    expect(spies.create).not.toHaveBeenCalled();
    expect(hook.current.active).toBe(true); // o operador continua de onde parou
  });

  it("ENTER conclui o rascunho (teclado — o editor não depende de mira fina)", () => {
    const { hook, spies } = setup();
    desenhaTres(hook);
    const e = press("Enter");
    expect(e.preventDefault).toHaveBeenCalled(); // não vaza p/ a casca
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(hook.current.active).toBe(false);
  });

  it("ESC descarta o rascunho (a câmera fica aberta) e NÃO cria zona", () => {
    const { hook, spies } = setup();
    desenhaTres(hook);
    const e = press("Escape");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(spies.create).not.toHaveBeenCalled();
    expect(hook.current.active).toBe(false);
    expect(hook.current.count).toBe(0);
  });

  // Regressão: com o modo Área armado mas INDECISO (nenhum vértice ainda — draftRef null), o ESC
  // TEM de sair do modo E ser consumido. Sem isto, o ESC vaza p/ a casca fullscreen e FECHA a câmera
  // (é o que quebrou o e2e do clique: o retry armava o modo, o frame não vinha, e o ESC fechava tudo).
  it("ESC no modo Área armado e VAZIO sai do modo e é CONSUMIDO (a casca não fecha a câmera)", () => {
    const { hook } = setup();
    hook.current.startArea();
    expect(hook.current.active).toBe(true);
    const e = press("Escape");
    expect(e.preventDefault).toHaveBeenCalled(); // consumido → ESC não vaza p/ a casca
    expect(hook.current.active).toBe(false); // saiu do modo (câmera segue aberta)
  });

  it("modo Área armado sem seleção instala o teclado; cancel() faz o cleanup (ESC volta à casca)", () => {
    const { hook } = setup();
    expect(keyHandler).toBeNull();
    hook.current.startArea();
    expect(keyHandler).not.toBeNull(); // armado (mesmo indeciso): Enter/ESC do rascunho já valem
    hook.current.cancel();
    expect(keyHandler).toBeNull(); // cleanup rodou → ESC volta a fechar a câmera (ADR-007)
  });

  it("AUTO-INTERSECÇÃO no fechamento: avisa e PRESERVA o rascunho (não joga o trabalho fora)", () => {
    const { hook, spies } = setup();
    drawPoly(hook, [at(0.1, 0.1), at(0.9, 0.9), at(0.9, 0.1), at(0.1, 0.9)]); // gravata
    press("Enter");
    expect(spies.create).not.toHaveBeenCalled();
    expect(spies.alert.mock.calls[0][0]).toMatch(/cruzam/i);
    expect(hook.current.active).toBe(true);
    expect(hook.current.count).toBe(4);
  });
});

describe("usePolygonEditor — modo ÁREA: o GESTO decide (arraste→retângulo · clique→polígono)", () => {
  const RETANGULO = [
    { x: 0.2, y: 0.3 },
    { x: 0.6, y: 0.3 },
    { x: 0.6, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];

  it("ARRASTE (≥ limiar) cria um RETÂNGULO de 4 vértices — o caso comum (mesas)", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    expect(hook.current.active).toBe(true);
    expect(hook.current.count).toBe(0); // indeciso até o gesto

    hook.current.onDown(at(0.2, 0.3));
    hook.current.onMove(at(0.6, 0.8)); // arraste largo → cruza o limiar
    expect(hook.current.onUp()).toBe(true);

    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(spies.create.mock.calls[0][0]).toEqual(RETANGULO); // rect → [{x,y},{x+w,y},{x+w,y+h},{x,y+h}]
    expect(hook.current.count).toBe(0); // retângulo NÃO abre rascunho polígono
  });

  it("arraste em QUALQUER sentido normaliza os cantos (de baixo-direita p/ cima-esquerda)", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    hook.current.onDown(at(0.6, 0.8)); // começa no canto oposto
    hook.current.onMove(at(0.2, 0.3));
    hook.current.onUp();
    expect(spies.create.mock.calls[0][0]).toEqual(RETANGULO);
  });

  it("CLIQUE (soltou no lugar) semeia o 1º VÉRTICE de um polígono — NÃO cria retângulo", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    hook.current.onDown(at(0.5, 0.5));
    expect(hook.current.onUp()).toBe(true); // soltou sem mover → clique
    expect(spies.create).not.toHaveBeenCalled();
    expect(hook.current.count).toBe(1); // é o 1º vértice do polígono
    expect(hook.current.draftRef.current?.points).toEqual([{ x: 0.5, y: 0.5 }]);
  });

  it("micro-movimento (< limiar, wobble do dedo/mouse) ainda é CLIQUE → 1º vértice", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    hook.current.onDown(at(0.5, 0.5));
    hook.current.onMove({ clientX: 0.5 * VP + 4, clientY: 0.5 * VP }); // 4 px < 5 → não vira arraste
    hook.current.onUp();
    expect(spies.create).not.toHaveBeenCalled(); // não virou retângulo
    expect(hook.current.count).toBe(1); // o clique venceu
  });

  it("cruzar o limiar (≥ 5 px) durante o arraste compromete com o RETÂNGULO", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    hook.current.onDown(at(0.5, 0.5));
    hook.current.onMove({ clientX: 0.5 * VP + 6, clientY: 0.5 * VP }); // 6 px ≥ 5 → decidiu arraste
    hook.current.onMove(at(0.8, 0.8)); // segue até um retângulo acima do piso
    hook.current.onUp();
    expect(spies.create).toHaveBeenCalledTimes(1);
    expect(hook.current.count).toBe(0); // é retângulo, não polígono
  });

  it("arraste que cruza o limiar mas fica ABAIXO do piso (16 px) não cria zona-fantasma", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    hook.current.onDown(at(0.5, 0.5));
    hook.current.onMove({ clientX: 0.5 * VP + 10, clientY: 0.5 * VP + 10 }); // ~14 px: >5 (arraste) mas <16 (piso)
    hook.current.onUp();
    expect(spies.create).not.toHaveBeenCalled(); // comprometeu com rect, mas pequeno demais → nada
    expect(hook.current.count).toBe(0); // e NÃO recai para polígono
  });

  it("count>0 (polígono já iniciado): arraste NÃO vira retângulo — a forma já se comprometeu", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    click(hook, at(0.3, 0.3)); // 1º clique → polígono (count 1)
    expect(hook.current.count).toBe(1);
    // agora um "arraste": onDown adiciona vértice; onMove só move o cursor; onUp não cria retângulo
    hook.current.onDown(at(0.7, 0.3));
    hook.current.onMove(at(0.7, 0.7));
    hook.current.onUp();
    expect(spies.create).not.toHaveBeenCalled(); // nenhum retângulo
    expect(hook.current.count).toBe(2); // virou o 2º vértice do polígono
  });

  it("cancel() (toggle 'Área' desligado) para de criar zona no gesto seguinte", () => {
    const { hook, spies } = setup();
    hook.current.startArea();
    expect(hook.current.active).toBe(true);
    hook.current.cancel();
    expect(hook.current.active).toBe(false);

    hook.current.onDown(at(0.2, 0.2)); // arraste completo, já sem o modo armado
    hook.current.onMove(at(0.6, 0.6));
    hook.current.onUp();
    expect(spies.create).not.toHaveBeenCalled();
  });
});

describe("usePolygonEditor — SELEÇÃO e edição de VÉRTICE (arrastar / inserir / remover)", () => {
  it("clicar o VÉRTICE seleciona e agarra; clicar o VAZIO larga a seleção e devolve o evento", () => {
    const { hook } = setup([zona("z1", QUADRADO)]);
    expect(hook.current.onDown(at(0.25, 0.25))).toBe(true); // agarrou o vértice 0
    expect(hook.current.hint).toContain("Vértice 1 de 4"); // going-gray: a interação é ENSINADA em texto
    hook.current.onUp();

    expect(hook.current.onDown(at(0.05, 0.05))).toBe(false); // fora de qualquer zona → delega ao palco
    expect(hook.current.hint).toBeNull(); // e larga a seleção
  });

  it("PREVIEW ao vivo: onMove emite onLive com a bbox RE-DERIVADA; só o soltar PERSISTE", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.25, 0.25)); // vértice 0
    hook.current.onMove(at(0.1, 0.1));

    expect(spies.live).toHaveBeenCalledTimes(1);
    expect(spies.patch).not.toHaveBeenCalled(); // ao vivo NÃO persiste
    const p = ultimo(spies.live);
    expect(p.points[0]).toEqual({ x: 0.1, y: 0.1 });
    // A REGRA: x/y/w/h é CACHE da envolvente dos points — derivado, nunca autorado.
    expect(p).toMatchObject({ x: 0.1, y: 0.1 });
    expect(p.w).toBeCloseTo(0.65, 12); // 0.75 − 0.1
    expect(p.h).toBeCloseTo(0.65, 12);

    expect(hook.current.onUp()).toBe(true);
    expect(spies.patch).toHaveBeenCalledTimes(1);
    expect(ultimo(spies.patch).points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.75, y: 0.25 },
      { x: 0.75, y: 0.75 },
      { x: 0.25, y: 0.75 },
    ]);
    expect(spies.alert).not.toHaveBeenCalled();
  });

  it("REVERSÃO: arraste que CRUZA as arestas é desfeito no soltar (com aviso) — nada persiste", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.25, 0.25));
    hook.current.onMove(at(0.9, 0.5)); // atravessa a aresta oposta → deixa de ser simples
    expect(spies.live).toHaveBeenCalledTimes(1); // o preview MOSTRA o inválido (avisar > desfazer)

    hook.current.onUp();
    expect(spies.patch).not.toHaveBeenCalled(); // NADA foi persistido
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(ultimo(spies.live).points).toEqual(QUADRADO); // a zona volta ao que era, na tela
  });

  it("MIDPOINT insere um vértice na aresta (Mapbox/Geoman) — só na zona SELECIONADA", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    // sem seleção, o midpoint não está visível → não é alvo (o evento vai p/ o interior/palco)
    expect(spies.live).not.toHaveBeenCalled();

    hook.current.onDown(at(0.5, 0.5)); // seleciona pelo INTERIOR
    hook.current.onUp();
    expect(hook.current.hint).toContain("4 vértices");

    hook.current.onDown(at(0.5, 0.25)); // midpoint da aresta de cima ((0.25,0.25)→(0.75,0.25))
    expect(ultimo(spies.live).points).toEqual([
      { x: 0.25, y: 0.25 },
      { x: 0.5, y: 0.25 }, // ← vértice NOVO, já no lugar
      { x: 0.75, y: 0.25 },
      { x: 0.75, y: 0.75 },
      { x: 0.25, y: 0.75 },
    ]);
    hook.current.onMove(at(0.5, 0.1)); // e já sai arrastando (o padrão dominante)
    hook.current.onUp();
    expect(ultimo(spies.patch).points[1]).toEqual({ x: 0.5, y: 0.1 });
    expect(ultimo(spies.patch).points).toHaveLength(5);
  });

  it("ALT+CLIQUE remove o vértice (NUNCA clique-direito — P7: o operador usa TABLET)", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(altAt(0.25, 0.25));
    expect(spies.patch).toHaveBeenCalledTimes(1);
    expect(ultimo(spies.patch).points).toEqual([
      { x: 0.75, y: 0.25 },
      { x: 0.75, y: 0.75 },
      { x: 0.25, y: 0.75 },
    ]);
    expect(ultimo(spies.patch).x).toBeCloseTo(0.25, 12); // bbox derivada dos points restantes
  });

  it("MÍNIMO de 3 na remoção: um triângulo não vira linha — avisa e NÃO remove", () => {
    const { hook, spies } = setup([zona("z1", TRIANGULO)]);
    hook.current.onDown(altAt(0.2, 0.2));
    expect(spies.patch).not.toHaveBeenCalled();
    expect(spies.alert.mock.calls[0][0]).toMatch(/[Mm]ínimo de 3/);
  });

  it("DELETE remove o vértice SELECIONADO (teclado — mesmo caminho do Alt+clique)", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.25, 0.25)); // seleciona o vértice 0
    hook.current.onUp();
    const e = press("Delete");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(ultimo(spies.patch).points).toHaveLength(3);
  });

  it("DELETE dentro de um CAMPO DE TEXTO não remove vértice (apagar caractere ≠ apagar zona)", () => {
    const { hook, spies } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.25, 0.25));
    hook.current.onUp();
    // Medimos o DELTA da tecla, não o total: o onUp acima já emite um patch (ver o teste
    // "clicar um vértice NÃO deveria persistir" abaixo — comportamento hoje, sinalizado).
    const antes = spies.patch.mock.calls.length;
    const e = press("Backspace", { tagName: "INPUT" }); // o diálogo de config da zona
    expect(e.preventDefault).not.toHaveBeenCalled(); // a tecla segue p/ o campo
    expect(spies.patch.mock.calls.length).toBe(antes); // e NENHUM vértice foi removido
  });

  // SELECIONAR NÃO É EDITAR (o flag `dirty`). Sem isto, todo clique numa zona — só para
  // selecioná-la — dispararia um onPatch de geometria IDÊNTICA: um PUT na rede a cada toque,
  // e a seleção viraria uma ação MUTANTE. A exceção é o MIDPOINT: ali o vértice ENTRA no
  // pointer-down, então soltar sem arrastar TEM de persistir (senão o vértice inserido some).
  it("SELECIONAR não persiste: clicar um vértice (ou o interior) e soltar NÃO emite onPatch", () => {
    const { hook, spies } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.25, 0.25)); // agarra o vértice…
    hook.current.onUp(); // …e solta sem mover
    expect(spies.patch).not.toHaveBeenCalled();
    expect(hook.current.hint).toContain("Vértice 1 de 4"); // selecionou, sim

    hook.current.onDown(at(0.5, 0.5)); // agarra a FORMA…
    hook.current.onUp(); // …e solta sem mover
    expect(spies.patch).not.toHaveBeenCalled();
  });

  it("MIDPOINT é a exceção: soltar sem arrastar PERSISTE (o vértice inserido não pode sumir)", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.5, 0.5)); // seleciona pelo interior
    hook.current.onUp();
    expect(spies.patch).not.toHaveBeenCalled();

    hook.current.onDown(at(0.5, 0.25)); // midpoint da aresta de cima
    hook.current.onUp(); // solta NO LUGAR
    expect(spies.patch).toHaveBeenCalledTimes(1);
    expect(ultimo(spies.patch).points).toHaveLength(5); // o vértice novo foi SALVO
  });

  it("ESC com SELEÇÃO (sem rascunho) só larga a seleção e SEGUE — a casca fecha a câmera (ADR-007)", () => {
    const { hook } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.5, 0.5));
    hook.current.onUp();
    expect(hook.current.hint).not.toBeNull();
    const e = press("Escape");
    expect(e.preventDefault).not.toHaveBeenCalled(); // NÃO consome: o ESC segue p/ a casca
    expect(hook.current.hint).toBeNull();
  });

  it("zona SEM points (retângulo legado, pré-migração) não oferece vértice nem interior", () => {
    const legado = [{ id: "zr", label: "R", x: 0.25, y: 0.25, w: 0.5, h: 0.5 } as Zone];
    const { hook } = setup(legado);
    expect(hook.current.onDown(at(0.25, 0.25))).toBe(false); // sem points, não há o que editar
    expect(hook.current.onDown(at(0.5, 0.5))).toBe(false);
  });

  it("com RASCUNHO aberto, a edição de zona existente não roda (um editor por vez)", () => {
    const { hook, spies } = setup([zona("z1", QUADRADO)]);
    hook.current.startArea();
    click(hook, at(0.25, 0.25)); // 1º vértice do rascunho — NÃO agarra o vértice da zona existente
    expect(hook.current.count).toBe(1);
    hook.current.onDown(at(0.75, 0.25)); // clique sobre outro vértice da zona → vira vértice do rascunho
    expect(hook.current.count).toBe(2);
    hook.current.onMove(at(0.8, 0.3));
    expect(spies.live).not.toHaveBeenCalled();
    expect(spies.patch).not.toHaveBeenCalled();
  });
});

describe("usePolygonEditor — MOVER A FORMA (o que o retângulo NUNCA teve)", () => {
  it("arrastar o INTERIOR translada o polígono inteiro (e persiste no soltar)", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.5, 0.5)); // interior
    expect(hook.current.hint).toContain("arraste dentro para mover");
    hook.current.onMove(at(0.6, 0.6)); // +0.1, +0.1
    hook.current.onUp();

    expect(ultimo(spies.patch).points).toEqual([
      { x: 0.35, y: 0.35 },
      { x: 0.85, y: 0.35 },
      { x: 0.85, y: 0.85 },
      { x: 0.35, y: 0.85 },
    ]);
    expect(ultimo(spies.patch).x).toBeCloseTo(0.35, 12); // bbox derivada acompanha
  });

  it("o clamp é da FORMA, não de cada ponto: encostar na borda NÃO deforma o polígono", () => {
    const { hook, spies, ultimo } = setup([zona("z1", QUADRADO)]);
    hook.current.onDown(at(0.5, 0.5));
    hook.current.onMove(at(0.99, 0.99)); // puxa MUITO além da borda
    hook.current.onUp();

    const p = ultimo(spies.patch);
    // encostou: bbox vai a (0.5, 0.5) e para. Se o clamp fosse ponto-a-ponto, os vértices se
    // ACHATARIAM contra a borda e a zona viraria outra coisa. A largura tem de sobreviver.
    expect(p.x).toBeCloseTo(0.5, 12);
    expect(p.y).toBeCloseTo(0.5, 12);
    expect(p.w).toBeCloseTo(0.5, 12); // ← a prova: a forma não encolheu
    expect(p.h).toBeCloseTo(0.5, 12);
    expect(p.points[1].x).toBeCloseTo(1, 12); // o vértice da direita encostou em 1.0, sem passar
  });

  it("zonas SOBREPOSTAS: o interior escolhe a de MENOR área (mesmo desempate do assignZone)", () => {
    const grande = zona("grande", [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
    const { hook } = setup([grande, zona("pequena", QUADRADO)]);
    hook.current.onDown(at(0.5, 0.5)); // dentro das DUAS
    hook.current.onMove(at(0.55, 0.5));
    hook.current.onUp();
    expect(hook.current.hint).toContain("4 vértices");
    // a que se moveu foi a PEQUENA (a mais específica), não a full-frame que vem antes na lista
    expect(hook.current.overlayRef.current.editId).toBe("pequena");
  });
});
