import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MSG_BAD_COORD,
  MSG_CROSS_MOVE,
  MSG_CROSS_REMOVE,
  MSG_MIN_POINTS,
  NUDGE_COARSE,
  NUDGE_FINE,
  VertexTable,
  isNoOpEdit,
  movePoint,
  nudgeDelta,
  parseCoord,
  removePoint,
} from "./VertexTable";
import { isSimplePolygon, type ZonePoint } from "../zones";

// F4 — a TABELA DE VÉRTICES (teclado + precisão fina). O que este teste PINA:
//  1. o idioma do nudge (seta = fino, Shift = grosso; ArrowUp = −y porque y cresce p/ BAIXO);
//  2. que a tabela NÃO é a porta dos fundos da auto-interseção — a mesma validação do palco vale
//     aqui, no MOVER e no REMOVER (o palco tranca; se a tabela não trancasse, o polígono inválido
//     entraria por trás);
//  3. o piso de 3 vértices, com o PORQUÊ visível (botão desabilitado nunca é mudo);
//  4. a zona legada (sem points) → EmptyState honesto, não uma tabela vazia mentirosa.
// Sem jsdom: lógica pura direto + markup por SSR (renderToStaticMarkup), o padrão de src/ui.

const RECT: ZonePoint[] = [
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];
const TRI: ZonePoint[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.8, y: 0.2 },
  { x: 0.5, y: 0.8 },
];

describe("nudgeDelta — o idioma do Figma/Illustrator", () => {
  it("seta = passo FINO; Shift = passo GROSSO (10×)", () => {
    expect(nudgeDelta("ArrowRight", false)).toEqual({ dx: NUDGE_FINE, dy: 0 });
    expect(nudgeDelta("ArrowRight", true)).toEqual({ dx: NUDGE_COARSE, dy: 0 });
    expect(NUDGE_COARSE).toBeCloseTo(NUDGE_FINE * 10, 10);
  });
  it("ArrowUp SOBE na tela — y cresce para BAIXO na imagem (dy negativo)", () => {
    expect(nudgeDelta("ArrowUp", false)).toEqual({ dx: 0, dy: -NUDGE_FINE });
    expect(nudgeDelta("ArrowDown", false)).toEqual({ dx: 0, dy: NUDGE_FINE });
    expect(nudgeDelta("ArrowLeft", false)).toEqual({ dx: -NUDGE_FINE, dy: 0 });
  });
  it("tecla que não é seta não move nada", () => {
    expect(nudgeDelta("a", false)).toBeNull();
    expect(nudgeDelta("Enter", true)).toBeNull();
  });
});

describe("parseCoord — o teclado numérico do operador é BR", () => {
  it("aceita vírgula decimal e ponto", () => {
    expect(parseCoord("0,315")).toBeCloseTo(0.315, 10);
    expect(parseCoord("0.315")).toBeCloseTo(0.315, 10);
    expect(parseCoord(" 0.5 ")).toBeCloseTo(0.5, 10);
  });
  it("vazio/lixo → NaN (e o movePoint recusa)", () => {
    expect(parseCoord("")).toBeNaN();
    expect(parseCoord("abc")).toBeNaN();
    expect(movePoint(RECT, 0, parseCoord("abc"), 0.5)).toEqual({
      ok: false,
      reason: MSG_BAD_COORD,
    });
  });
});

describe("isNoOpEdit — blur sem edição NÃO persiste", () => {
  const p = { x: 0.1, y: 0.42 };
  it("o texto que apenas RE-EXIBE o ponto é no-op (Tab não vira PUT de zona no hub)", () => {
    expect(isNoOpEdit("0.100", "0.420", p)).toBe(true);
    expect(isNoOpEdit("0,100", "0,420", p)).toBe(true); // idem com vírgula
  });
  it("edição de verdade NÃO é no-op — inclusive lixo (que precisa virar erro visível)", () => {
    expect(isNoOpEdit("0.105", "0.420", p)).toBe(false);
    expect(isNoOpEdit("abc", "0.420", p)).toBe(false);
  });
});

describe("movePoint — mesma validação do palco", () => {
  it("move o vértice e devolve o polígono novo (os demais intactos)", () => {
    const r = movePoint(RECT, 2, 0.8, 0.8);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points[2]).toEqual({ x: 0.8, y: 0.8 });
    expect(r.points[0]).toEqual(RECT[0]);
    expect(r.points).toHaveLength(4);
  });

  it("CLAMPA 0..1 (a coordenada não escapa do frame)", () => {
    const r = movePoint(RECT, 2, 1.4, 1.4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points[2]).toEqual({ x: 1, y: 1 });
    // e a validação roda sobre o polígono JÁ clampeado (não sobre o que se digitou)
    expect(isSimplePolygon(r.points)).toBe(true);
  });

  it("RECUSA o movimento que cruza arestas — a tabela não é a porta dos fundos", () => {
    // Mover o vértice #1 do retângulo para (0.5,0.95) faz a aresta 1→2 atravessar a aresta 3→4.
    const bowtie = RECT.map((p, i) => (i === 0 ? { x: 0.5, y: 0.95 } : p));
    expect(isSimplePolygon(bowtie)).toBe(false); // controle: o polígono-alvo É inválido
    expect(movePoint(RECT, 0, 0.5, 0.95)).toEqual({ ok: false, reason: MSG_CROSS_MOVE });
  });

  it("o polígono devolvido é SEMPRE simples (invariante)", () => {
    const r = movePoint(RECT, 1, 0.95, 0.05);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(isSimplePolygon(r.points)).toBe(true);
  });
});

describe("removePoint — piso de 3 e sem cruzar arestas", () => {
  it("com 3 vértices, RECUSA (e diz por quê)", () => {
    expect(removePoint(TRI, 1)).toEqual({ ok: false, reason: MSG_MIN_POINTS });
  });

  it("com 4+, remove e reindexa", () => {
    const r = removePoint(RECT, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.points).toHaveLength(3);
    expect(r.points[1]).toEqual(RECT[2]);
  });

  it("RECUSA a remoção que cruzaria arestas (a corda atravessa o polígono)", () => {
    // Pentágono SIMPLES cuja remoção do vértice #5 devolve a gravata-borboleta A,B,C,D:
    // as diagonais B→C e D→A se cruzam. É o caso que a auditoria previu — remover também valida.
    const penta: ZonePoint[] = [
      { x: 0.1, y: 0.1 }, // A
      { x: 0.9, y: 0.1 }, // B
      { x: 0.1, y: 0.5 }, // C
      { x: 0.9, y: 0.5 }, // D
      { x: 1.0, y: 0.0 }, // V — o vértice que "desamarra" o cruzamento
    ];
    expect(isSimplePolygon(penta)).toBe(true); // controle: a entrada É válida
    expect(isSimplePolygon(penta.slice(0, 4))).toBe(false); // controle: sem V, cruza
    expect(removePoint(penta, 4)).toEqual({ ok: false, reason: MSG_CROSS_REMOVE });
  });
});

describe("VertexTable (markup)", () => {
  const html = (points?: ZonePoint[]) =>
    renderToStaticMarkup(<VertexTable points={points} onChange={() => {}} />);
  // ATENÇÃO: `disabled` também aparece na CLASSE do átomo (`disabled:opacity-45`) — procurar a
  // palavra daria falso positivo em TODO botão. O que vale é o ATRIBUTO.
  const disabledCount = (h: string) => (h.match(/\sdisabled=""/g) ?? []).length;

  it("zona LEGADA (sem points) → EmptyState honesto, nunca tabela vazia", () => {
    const h = html(undefined);
    expect(h).toContain("máscara legada");
    expect(h).not.toContain("Remover vértice");
  });

  it("lista um botão por vértice, com a coordenada e o rótulo acessível", () => {
    const h = html(RECT);
    expect(h).toContain("Vértices (4)");
    expect(h).toContain("#1 (0.100, 0.100)");
    expect(h).toContain("#3 (0.900, 0.900)");
    expect(h).toMatch(/aria-label="Vértice 1: x 0\.100, y 0\.100"/);
    // o 1º vértice nasce selecionado (aria-pressed) — e há 4 botões de remover
    expect(h).toContain('aria-pressed="true"');
    expect((h.match(/Remover vértice/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("com 4 vértices, remover está HABILITADO", () => {
    expect(disabledCount(html(RECT))).toBe(0);
  });

  it("com 3, remover fica DESABILITADO e o porquê é VISÍVEL (nunca um botão morto e mudo)", () => {
    const h = html(TRI);
    expect(disabledCount(h)).toBe(3); // os 3 botões de remover
    expect(h).toContain("Remover está indisponível");
    expect(h).toContain(MSG_MIN_POINTS); // o motivo, em texto — não só o botão apagado
    expect(h).toContain(`Remover vértice 1 — indisponível`); // e no rótulo acessível do botão
  });

  it("o campo numérico (ArcGIS) edita o vértice selecionado e é rotulado", () => {
    const h = html(RECT);
    expect(h).toContain("X do vértice #1");
    expect(h).toContain("Y do vértice #1");
    expect(h).toMatch(/<input[^>]*value="0\.100"/);
  });
});
