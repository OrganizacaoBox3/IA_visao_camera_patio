// O CONTRATO DO TRAP DE FOCO da casca fullscreen da câmera (ADR-007: a casca NÃO é Radix Dialog,
// então o trap é MANUAL e a a11y da tela cheia depende dele).
//
// POR QUE ESTE ARQUIVO EXISTE: o trap deferia ESC/Tab ao Radix só quando o diálogo da PRÓPRIA
// câmera estava aberto (`cfgOpenRef`). O drawer de alarmes abre SOZINHO ao chegar alarme crítico —
// sobre a câmera em tela cheia o ESC funcionava, mas o TAB era puxado de volta para a casca e o
// drawer ficava navegável só a mouse. Alarme crítico exigindo mouse é falha de acessibilidade num
// caminho de segurança, e o gate não a via: não havia teste nenhum aqui.
//
// COMO SE TESTA SEM NAVEGADOR: mesmo padrão de usePolygonEditor.test.ts — o hook usa UMA primitiva
// do React (useEffect) e um punhado de APIs de DOM (addEventListener, activeElement, focus,
// querySelector/All, contains). Micro-runtime + palco falso rodam o HOOK REAL sem trazer jsdom +
// testing-library ao projeto (duas deps para testar três hooks não passa no filtro Signal×Noise).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── micro-runtime de hooks (só useEffect — é tudo que este hook consome) ─────────────────────
const H = vi.hoisted(() => ({
  queue: [] as Array<() => void | (() => void)>,
  cleanups: [] as Array<() => void>,
}));
vi.mock("react", () => ({
  useEffect: (fn: () => void | (() => void)) => {
    H.queue.push(fn);
  },
}));

/** roda o hook e seus efeitos; devolve o cleanup agregado (o unmount do React) */
function renderHook(fn: () => void): () => void {
  H.queue.length = 0;
  fn();
  for (const eff of H.queue.splice(0)) {
    const c = eff();
    if (typeof c === "function") H.cleanups.push(c);
  }
  return () => {
    for (const c of H.cleanups.splice(0)) c();
  };
}

// ── palco falso: a casca com DOIS focáveis + o <body> onde as guardas do Radix aparecem ──────
type FakeEl = {
  tagName: string;
  tabIndex: number;
  hasAttribute: () => boolean;
  offsetWidth: number;
  offsetHeight: number;
  focus: ReturnType<typeof vi.fn>;
};
const focusavel = (tagName: string): FakeEl => ({
  tagName,
  tabIndex: 0,
  hasAttribute: () => false,
  offsetWidth: 10,
  offsetHeight: 10,
  focus: vi.fn(),
});

let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let primeiro: FakeEl,
  ultimo: FakeEl,
  root: FakeEl & { querySelectorAll: () => FakeEl[]; contains: (el: unknown) => boolean };
/** o que `document.querySelector("[data-radix-focus-guard]")` devolve — a camada modal aberta */
let guardaRadix: object | null;
/** quem está focado no palco (o hook lê document.activeElement em toda decisão de Tab) */
let focado: unknown;

beforeEach(() => {
  keyHandler = null;
  guardaRadix = null;
  primeiro = focusavel("BUTTON");
  ultimo = focusavel("BUTTON");
  root = {
    ...focusavel("DIV"),
    querySelectorAll: () => [primeiro, ultimo],
    contains: (el: unknown) => el === primeiro || el === ultimo || el === root,
  };
  focado = primeiro;
  vi.stubGlobal("document", {
    addEventListener: (t: string, fn: EventListener) => {
      if (t === "keydown") keyHandler = fn as (e: KeyboardEvent) => void;
    },
    removeEventListener: (t: string) => {
      if (t === "keydown") keyHandler = null;
    },
    querySelector: (sel: string) => (sel === "[data-radix-focus-guard]" ? guardaRadix : null),
    get activeElement() {
      return focado;
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

// O import vem DEPOIS do vi.mock (hoistado) — o hook enxerga o micro-runtime.
const { useFocusTrap } = await import("./useFocusTrap");

const onClose = vi.fn();
function montar(cfgOpen = false) {
  onClose.mockClear();
  return renderHook(() =>
    useFocusTrap(
      true,
      { current: root as unknown as HTMLElement },
      { current: cfgOpen },
      { current: onClose },
    ),
  );
}
const press = (key: string, over: Partial<KeyboardEvent> = {}) => {
  const e = {
    key,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...over,
  } as unknown as KeyboardEvent;
  keyHandler?.(e);
  return e as unknown as { preventDefault: ReturnType<typeof vi.fn> };
};

// ── o trap legítimo da casca (ADR-007) segue de pé ───────────────────────────────────────────
// Sem camada modal aberta, NADA muda: é o controle NEGATIVO do conserto. Se o novo deferimento
// fosse largo demais, é aqui que apareceria — a casca deixaria de circular o foco e o ESC
// deixaria de fechar a câmera.
describe("sem camada modal: o trap manual da casca continua valendo", () => {
  it("Tab no ÚLTIMO focável volta ao primeiro (círculo fechado)", () => {
    montar();
    focado = ultimo;
    const e = press("Tab");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(primeiro.focus).toHaveBeenCalled();
  });

  it("Shift+Tab no PRIMEIRO vai ao último", () => {
    montar();
    focado = primeiro;
    const e = press("Tab", { shiftKey: true });
    expect(e.preventDefault).toHaveBeenCalled();
    expect(ultimo.focus).toHaveBeenCalled();
  });

  it("foco FORA da casca é puxado de volta (é o que o trap existe para fazer)", () => {
    montar();
    focado = { tagName: "A" }; // elemento de fora — root.contains() dá false
    press("Tab");
    expect(primeiro.focus).toHaveBeenCalled();
  });

  it("ESC fecha a câmera", () => {
    montar();
    const e = press("Escape");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── O CONSERTO (2026-07-27): deferir a QUALQUER camada modal, não só à da câmera ──────────────
// A guarda do Radix (data-radix-focus-guard nas pontas do <body>) é o sinal: enquanto ela existe,
// há ≥1 camada modal montada e é o Radix quem traça o círculo de foco. O trap sai da frente.
describe("camada modal de OUTRO dono (drawer de alarmes) — o Tab é dela", () => {
  it("Tab NÃO é sequestrado: sem preventDefault e sem foco puxado para a casca", () => {
    montar(); // cfgOpenRef=false: a câmera não abriu nada — quem abriu foi o alarme
    guardaRadix = { id: "guard" }; // drawer de alarmes montou → guardas no body
    focado = ultimo; // no trap antigo, ESTE era o caso que voltava para o primeiro
    const e = press("Tab");
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(primeiro.focus).not.toHaveBeenCalled();
    expect(ultimo.focus).not.toHaveBeenCalled();
  });

  it("Shift+Tab idem (o drawer navega nos DOIS sentidos, não só num)", () => {
    montar();
    guardaRadix = { id: "guard" };
    focado = primeiro;
    const e = press("Tab", { shiftKey: true });
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(ultimo.focus).not.toHaveBeenCalled();
  });

  it("Tab com foco FORA da casca (dentro do drawer) também é deixado em paz", () => {
    montar();
    guardaRadix = { id: "guard" };
    focado = { tagName: "BUTTON" }; // um botão do drawer — contains() dá false
    const e = press("Tab");
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(primeiro.focus).not.toHaveBeenCalled();
  });

  it("ESC com camada aberta NÃO fecha a câmera por baixo do drawer", () => {
    montar();
    guardaRadix = { id: "guard" };
    const e = press("Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("camada FECHADA devolve o Tab à casca (o deferimento é por-evento, não pegajoso)", () => {
    montar();
    guardaRadix = { id: "guard" };
    focado = ultimo;
    press("Tab");
    expect(primeiro.focus).not.toHaveBeenCalled();
    guardaRadix = null; // drawer fechou → guardas removidas do body
    press("Tab");
    expect(primeiro.focus).toHaveBeenCalled();
  });
});

// ── os dois sinais são COMPLEMENTARES (o popover "Exibição" é não-modal) ─────────────────────
// O Popover da casa é NÃO-MODAL por construção (src/ui/Popover.tsx: sem RemoveScroll, senão o
// <canvas> remonta) — logo NÃO instala guardas de foco. Trocar o ref pelas guardas em vez de
// somar os dois teria regredido esse caso em silêncio.
describe("cfgOpenRef segue necessário: camada NÃO-MODAL não instala guardas", () => {
  it("diálogo/popover da própria câmera (ref true, sem guarda) ainda defere", () => {
    montar(true);
    expect(guardaRadix).toBeNull(); // exatamente o caso do popover não-modal
    focado = ultimo;
    const e = press("Tab");
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(primeiro.focus).not.toHaveBeenCalled();
  });
});

// ── a corrida do ESC (React 19) permanece coberta ────────────────────────────────────────────
// Quando o ESC FECHA a camada, o Radix já a desmontou (e já removeu as guardas) antes deste
// listener rodar: nem o ref nem o querySelector veem nada. A marca síncrona é o próprio evento —
// toda camada Radix que dismissa por ESC chama preventDefault antes.
describe("ESC já consumido pelo Radix (defaultPrevented) não fecha a câmera junto", () => {
  it("guarda já removida + defaultPrevented → a câmera fica aberta", () => {
    montar();
    guardaRadix = null; // o cleanup do Radix já rodou no microtask entre os listeners
    press("Escape", { defaultPrevented: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("ciclo de vida", () => {
  it("desmontar remove o listener e devolve o foco anterior", () => {
    const anterior = focusavel("BUTTON");
    focado = anterior;
    const unmount = montar();
    expect(root.focus).toHaveBeenCalled(); // a casca recebe foco ao entrar em tela cheia
    unmount();
    expect(keyHandler).toBeNull();
    expect(anterior.focus).toHaveBeenCalled();
  });
});
