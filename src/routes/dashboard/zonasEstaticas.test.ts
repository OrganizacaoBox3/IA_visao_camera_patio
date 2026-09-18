// A PLANTA DE ZONAS é o que o CLIENTE vê no lugar do vídeo. Se ela desenhar errado, o cliente
// recebe "presença em área proibida (Cofre)" no WhatsApp e não acha o Cofre na tela — o desenho
// deixa de ser contexto e vira ruído.
//
// O que estes testes protegem, em ordem:
//   1. zona nunca SOME do desenho. Uma área invisível é lida como "não existe", e ela existe —
//      inclusive alarma. Coordenada degenerada/corrompida vira forma mínima, nunca nada;
//   2. coordenada fora de 0..1 (cadastro antigo, arrasto acidente) é presa na moldura em vez de
//      desenhar fora dela;
//   3. polígono só quando é polígono: com menos de 3 vértices o <polygon> desenharia uma linha,
//      e a caixa é a representação honesta do que foi salvo.
import { describe, it, expect } from "vitest";
import {
  VIEWBOX,
  desenharZona,
  desenharZonas,
  ancoraDoRotulo,
  COR_DO_MODO,
} from "./zonasEstaticas";
import type { Zone, ZoneMode } from "../../zones";

const z = (over: Partial<Zone>): Zone =>
  ({
    id: "z1",
    label: "Doca",
    x: 0.1,
    y: 0.2,
    w: 0.4,
    h: 0.3,
    modo: "atividade",
    idleAlertMs: 0,
    sensitivity: 0,
    atividade: "",
    ponto: "",
    selectedClasses: [],
    ...over,
  }) as Zone;

describe("desenharZona — normalizado 0..1 vira coordenada de viewBox", () => {
  it("converte a caixa multiplicando por 100", () => {
    const r = desenharZona(z({ x: 0.1, y: 0.2, w: 0.4, h: 0.3 }));
    expect(r.caixa).toEqual({ x: 10, y: 20, w: 40, h: 30 });
  });

  it("preserva id, rótulo e modo (é o que liga o desenho à mensagem recebida)", () => {
    const r = desenharZona(z({ id: "zc", label: "Cofre", modo: "proibida" }));
    expect(r).toMatchObject({ id: "zc", label: "Cofre", modo: "proibida" });
  });
});

describe("zona NUNCA some do desenho", () => {
  it("largura/altura zero viram piso de 1% — invisível seria lido como inexistente", () => {
    const r = desenharZona(z({ w: 0, h: 0 }));
    expect(r.caixa.w).toBeGreaterThanOrEqual(1);
    expect(r.caixa.h).toBeGreaterThanOrEqual(1);
  });

  it("valores negativos ou não-numéricos não produzem NaN no SVG", () => {
    for (const ruim of [-1, NaN, Infinity, undefined as unknown as number]) {
      const r = desenharZona(z({ x: ruim, y: ruim, w: ruim, h: ruim }));
      for (const v of [r.caixa.x, r.caixa.y, r.caixa.w, r.caixa.h])
        expect(Number.isFinite(v)).toBe(true);
      expect(r.caixa.w).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("coordenada fora da moldura é presa, não extrapolada", () => {
  it("acima de 1 vira o limite do viewBox", () => {
    const r = desenharZona(z({ x: 5, y: 2, w: 3, h: 3 }));
    expect(r.caixa.x).toBe(VIEWBOX);
    expect(r.caixa.y).toBe(VIEWBOX);
  });

  it("abaixo de 0 vira 0", () => {
    const r = desenharZona(z({ x: -0.5, y: -2 }));
    expect(r.caixa.x).toBe(0);
    expect(r.caixa.y).toBe(0);
  });
});

describe("polígono só quando é polígono", () => {
  it("≥3 vértices viram o atributo points do SVG", () => {
    const r = desenharZona(
      z({ points: [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0.5, y: 0.5 }] } as Partial<Zone>),
    );
    expect(r.pontos).toBe("0,0 50,0 50,50");
  });

  it("menos de 3 vértices cai na CAIXA (uma linha não é uma área)", () => {
    for (const pts of [[], [{ x: 0, y: 0 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]])
      expect(desenharZona(z({ points: pts } as Partial<Zone>)).pontos).toBeNull();
  });

  it("vértice fora da moldura também é preso", () => {
    const r = desenharZona(
      z({ points: [{ x: -1, y: 0 }, { x: 9, y: 0 }, { x: 0.5, y: 0.5 }] } as Partial<Zone>),
    );
    expect(r.pontos).toBe("0,0 100,0 50,50");
  });
});

describe("desenharZonas — a lista", () => {
  it("preserva a ORDEM do cadastro (é a que o operador desenhou)", () => {
    const r = desenharZonas([z({ id: "a" }), z({ id: "b" }), z({ id: "c" })]);
    expect(r.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("lista vazia/ausente não quebra", () => {
    expect(desenharZonas([])).toEqual([]);
    expect(desenharZonas(undefined as unknown as Zone[])).toEqual([]);
  });
});

describe("rótulo e cor", () => {
  it("a âncora fica DENTRO da caixa (rótulo fora da forma não diz de quem é)", () => {
    const c = { x: 10, y: 20, w: 40, h: 30 };
    const a = ancoraDoRotulo(c);
    expect(a.x).toBeGreaterThan(c.x);
    expect(a.x).toBeLessThan(c.x + c.w);
    expect(a.y).toBeGreaterThan(c.y);
    expect(a.y).toBeLessThan(c.y + c.h);
  });

  it("todo modo tem cor, e sempre via TOKEN (nunca hex cru)", () => {
    const modos: ZoneMode[] = [
      "atividade",
      "leitura",
      "objetos",
      "fadiga",
      "exclusao",
      "proibida",
    ];
    for (const m of modos) {
      expect(COR_DO_MODO[m]).toMatch(/^var\(--/);
    }
  });

  it("PROIBIDA é a única com cor de alerta — é a que gera alarme crítico", () => {
    expect(COR_DO_MODO.proibida).toContain("critical");
    for (const m of ["atividade", "leitura", "objetos", "exclusao"] as ZoneMode[])
      expect(COR_DO_MODO[m]).not.toContain("critical");
  });
});
