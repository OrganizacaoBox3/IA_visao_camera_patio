// SENSORES DO DELTA — o que `usePolygonEditor.test.ts` (frente G1, dona daquele arquivo) NÃO cobre.
//
// Nesta onda as frentes rodam em paralelo com posse EXCLUSIVA de arquivo: a G1 escreveu o contrato
// do editor e a G3 (esta) escreveu o editor. As duas convergiram — o arquivo irmão já cobre preset
// retângulo, seleção, midpoint, Alt+clique/Delete, mover a forma, clamp e o flag `dirty`. Sobraram
// TRÊS casos que só quem implementou enxergou, e que não podem ficar sem sensor:
//
//   1. REMOVER um vértice pode CRIAR uma auto-interseção. Não é hipótese: o caso abaixo veio de
//      busca exaustiva sobre o próprio isSimplePolygon. Uma remoção ingênua (só checando o mínimo
//      de 3) persistiria um polígono cruzado — e o cruzado passa a valer para o pointInPolygon do
//      HUB (o motor herda a geometria). É o buraco que nenhum e2e veria.
//   2. O TETO de 20 vértices tem DUAS portas: o rascunho (coberto lá) e o MIDPOINT (só aqui).
//   3. Desarmar o modo (toggle "Área" desligado) tem de parar de criar zona no gesto seguinte.
//
// ⚠ REVISÃO SERIALIZADA: fundir este arquivo no irmão (um micro-runtime só). A duplicação do
// runtime é o preço declarado do paralelismo — não é padrão da casa.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Zone, ZonePoint } from "../zones";
import type { FrameSource } from "../frame";

// ── micro-runtime de hooks (idêntico ao do arquivo irmão — ver nota de MERGE acima) ──
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
      if (!H.rendering) H.render?.();
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
      H.cleanups.get(i)?.();
      H.cleanups.delete(i);
      const c = eff();
      if (typeof c === "function") H.cleanups.set(i, c);
    }
  };
  H.render = render;
  render();
  return box;
}

// ── palco falso: viewport 1000×1000 = frame 1000×1000 → 1 unidade normalizada = 1000 px ──
const VP = 1000;
const FRAME = { el: null, w: VP, h: VP } as unknown as FrameSource;
const at = (nx: number, ny: number) => ({ clientX: nx * VP, clientY: ny * VP });
const altAt = (nx: number, ny: number) => ({ ...at(nx, ny), altKey: true });

type Patch = { points: ZonePoint[]; x: number; y: number; w: number; h: number };
const zona = (points: ZonePoint[]): Zone[] => [
  { id: "z1", label: "Doca", points, x: 0, y: 0, w: 1, h: 1 } as Zone,
];

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
  return { hook, spies };
}

// SELECIONAR arma o listener de teclado (Delete remove o vértice) → o hook toca `document` mesmo
// quando o teste não aperta tecla nenhuma. Sem este stub, o ambiente node quebra em ReferenceError.
beforeEach(() => {
  vi.stubGlobal("document", {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null, // guarda do ESC no hook (sem layer modal do Radix no palco falso)
  });
});
afterEach(() => vi.unstubAllGlobals());

const { usePolygonEditor } = await import("./usePolygonEditor");

// ─────────────────────────────────────────────────────────────────────────────

describe("REMOVER vértice — a auto-interseção não entra pela porta dos fundos", () => {
  // "Pente" (um dente para dentro): polígono SIMPLES. Remover o vértice 0 faz a corda que fecha o
  // polígono atravessar o dente. Caso ENCONTRADO por busca exaustiva sobre o próprio
  // isSimplePolygon — não é chute geométrico.
  const PENTE: ZonePoint[] = [
    { x: 0.1, y: 0.8 }, // ← removê-lo CRUZA
    { x: 0.1, y: 0.2 },
    { x: 0.45, y: 0.2 },
    { x: 0.45, y: 0.6 },
    { x: 0.55, y: 0.6 },
    { x: 0.55, y: 0.2 },
    { x: 0.9, y: 0.2 },
    { x: 0.9, y: 0.8 },
  ];

  it("a remoção que CRUZARIA as arestas é recusada com aviso — e nada é persistido", () => {
    const { hook, spies } = setup(zona(PENTE));
    expect(hook.current.onDown(altAt(0.1, 0.8))).toBe(true); // consumiu o Alt+clique…
    expect(spies.patch).not.toHaveBeenCalled(); // …e NÃO salvou um polígono cruzado
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.alert.mock.calls[0][0]).toMatch(/cruzariam/i);
  });

  it("controle: no MESMO polígono, remover um vértice SEGURO passa normalmente (7 pontos)", () => {
    const { hook, spies } = setup(zona(PENTE));
    hook.current.onDown(altAt(0.45, 0.6)); // a ponta do dente: sai sem cruzar nada
    expect(spies.patch).toHaveBeenCalledTimes(1);
    expect(spies.patch.mock.calls[0][1].points).toHaveLength(7);
    expect(spies.alert).not.toHaveBeenCalled();
  });
});

describe("TETO de 20 vértices — a SEGUNDA porta (o midpoint, não só o rascunho)", () => {
  it("com 20 vértices, o midpoint avisa e NÃO insere o 21º", () => {
    const cheio: ZonePoint[] = Array.from({ length: 20 }, (_, i) => ({
      x: 0.5 + 0.3 * Math.cos((i / 20) * 2 * Math.PI),
      y: 0.5 + 0.3 * Math.sin((i / 20) * 2 * Math.PI),
    }));
    const { hook, spies } = setup(zona(cheio));
    hook.current.onDown(at(0.5, 0.5)); // seleciona (centro) → os midpoints ficam clicáveis
    hook.current.onUp();
    spies.live.mockClear();

    const m = { x: (cheio[0].x + cheio[1].x) / 2, y: (cheio[0].y + cheio[1].y) / 2 };
    expect(hook.current.onDown(at(m.x, m.y))).toBe(true);
    expect(spies.live).not.toHaveBeenCalled(); // nada inserido
    expect(spies.alert).toHaveBeenCalledTimes(1);
    expect(spies.alert.mock.calls[0][0]).toContain("20");
  });
});

describe("modo ÁREA — desarmar o modo desarma o gesto", () => {
  it("cancel() (o toggle 'Área' desligado) para de criar zona no gesto seguinte", () => {
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
