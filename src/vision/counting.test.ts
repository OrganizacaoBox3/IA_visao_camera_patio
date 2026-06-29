// Testes de unidade da biblioteca PURA de contagem por tripwire + heatmap (counting.ts).
// Determinísticos: usam o parâmetro `now` das funções (sem relógio real) e geometria fixa.
// Convenção verificada em counting.test-notes.md (seta a→b; esquerda→direita = "in").
import { describe, it, expect } from "vitest";
import {
  orient,
  segmentsIntersect,
  inwardNormal,
  centroidOfBBox,
  createCounter,
  createOccupancy,
  type Tripwire,
} from "./counting";

// Tripwire vertical apontando p/ BAIXO (a={0.5,0} → b={0.5,1}).
// side(p) = -(p.x-0.5): x menor (oeste) fica à DIREITA da seta; x maior à ESQUERDA.
const vWire: Tripwire = { id: "w", a: { x: 0.5, y: 0 }, b: { x: 0.5, y: 1 } };

describe("geometria pura", () => {
  describe("orient", () => {
    it("sinaliza lado direito/esquerdo/colinear de uma seta horizontal a→b", () => {
      const a = { x: 0, y: 0 };
      const b = { x: 1, y: 0 };
      // y para baixo: ponto abaixo (y>0) cai à DIREITA da seta → >0
      expect(orient(a, b, { x: 0.5, y: 1 })).toBeGreaterThan(0);
      // ponto acima (y<0) cai à ESQUERDA → <0
      expect(orient(a, b, { x: 0.5, y: -1 })).toBeLessThan(0);
      // ponto sobre a reta → 0
      expect(orient(a, b, { x: 0.5, y: 0 })).toBe(0);
    });
  });

  describe("segmentsIntersect", () => {
    it("detecta cruzamento próprio (X)", () => {
      expect(
        segmentsIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 }),
      ).toBe(true);
    });
    it("retorna false p/ segmentos paralelos/que não se cruzam", () => {
      expect(
        segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }),
      ).toBe(false);
    });
    it("retorna false p/ toque em extremidade (interseção é PRÓPRIA)", () => {
      // compartilham o ponto {1,0}, mas é só um toque → não conta
      expect(
        segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }),
      ).toBe(false);
    });
  });

  describe("inwardNormal", () => {
    it("aponta no sentido de uma ENTRADA p/ seta horizontal (a→direita ⇒ normal p/ baixo)", () => {
      const n = inwardNormal({ id: "h", a: { x: 0, y: 0.5 }, b: { x: 1, y: 0.5 } });
      expect(n.x).toBeCloseTo(0, 6);
      expect(n.y).toBeCloseTo(1, 6); // +y (baixo) é o lado "in" (cruzar cima→baixo)
    });
    it("aponta p/ oeste (lado 'in') numa seta vertical p/ baixo, e é unitária", () => {
      const n = inwardNormal(vWire);
      expect(n.x).toBeCloseTo(-1, 6);
      expect(n.y).toBeCloseTo(0, 6);
      expect(Math.hypot(n.x, n.y)).toBeCloseTo(1, 6);
    });
    it("retorna {0,0} quando a e b coincidem (degenerado)", () => {
      const n = inwardNormal({ id: "d", a: { x: 0.3, y: 0.3 }, b: { x: 0.3, y: 0.3 } });
      expect(n).toEqual({ x: 0, y: 0 });
    });
  });

  describe("centroidOfBBox", () => {
    it("converte bbox px [x,y,w,h] em centróide normalizado", () => {
      const c = centroidOfBBox([10, 20, 40, 60], 100, 200);
      expect(c.x).toBeCloseTo(0.3, 6); // (10+40/2)/100
      expect(c.y).toBeCloseTo(0.25, 6); // (20+60/2)/200
    });
    it("evita divisão por zero quando frame tem dimensão 0", () => {
      expect(centroidOfBBox([10, 20, 40, 60], 0, 0)).toEqual({ x: 0, y: 0 });
    });
  });
});

describe("createCounter — contagem direcional", () => {
  it("cruzar esquerda→direita da seta conta 'in'", () => {
    const c = createCounter([vWire]);
    c.update([{ id: 1, cx: 0.6, cy: 0.5 }], 1); // 1º frame: registra posição
    const ev = c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 2); // leste→oeste = esq→dir da seta
    expect(ev).toHaveLength(1);
    expect(ev[0].dir).toBe("in");
    expect(ev[0].tripwireId).toBe("w");
    expect(c.counts().w).toEqual({ in: 1, out: 0 });
    expect(c.totals()).toEqual({ in: 1, out: 0 });
  });

  it("cruzar direita→esquerda da seta conta 'out'", () => {
    const c = createCounter([vWire]);
    c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 1);
    const ev = c.update([{ id: 1, cx: 0.6, cy: 0.5 }], 2);
    expect(ev).toHaveLength(1);
    expect(ev[0].dir).toBe("out");
    expect(c.counts().w).toEqual({ in: 0, out: 1 });
  });

  it("micro-jitter abaixo de minMove não conta mesmo cruzando a linha", () => {
    const c = createCounter([vWire], { minMove: 0.01 });
    c.update([{ id: 1, cx: 0.501, cy: 0.5 }], 1);
    const ev = c.update([{ id: 1, cx: 0.499, cy: 0.5 }], 2); // |Δ|=0.002 < 0.01
    expect(ev).toHaveLength(0);
    expect(c.counts().w).toEqual({ in: 0, out: 0 });
  });

  it("não conta em dobro: após cruzar, mover do mesmo lado não recontagem", () => {
    const c = createCounter([vWire]);
    c.update([{ id: 1, cx: 0.6, cy: 0.5 }], 1);
    c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 2); // in (1)
    const ev = c.update([{ id: 1, cx: 0.3, cy: 0.5 }], 3); // continua à direita da seta, sem novo cruzamento
    expect(ev).toHaveLength(0);
    expect(c.counts().w).toEqual({ in: 1, out: 0 });
  });

  it("movimento paralelo (sem cruzar o segmento) não gera evento", () => {
    const c = createCounter([vWire]);
    c.update([{ id: 1, cx: 0.2, cy: 0.2 }], 1);
    const ev = c.update([{ id: 1, cx: 0.2, cy: 0.8 }], 2); // desce do mesmo lado
    expect(ev).toHaveLength(0);
  });

  it("TTL limpa tracks sumidos: reaparecer após o TTL não conta cruzamento", () => {
    const c = createCounter([vWire], { ttl: 100 });
    c.update([{ id: 1, cx: 0.6, cy: 0.5 }], 0); // lastSeen = 0
    c.update([], 201); // 201-0 > 100 → track 1 descartado
    const ev = c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 202); // sem posição anterior → tratado como novo
    expect(ev).toHaveLength(0);
    expect(c.counts().w).toEqual({ in: 0, out: 0 });
  });

  it("dentro do TTL o histórico persiste e o cruzamento na volta é contado", () => {
    const c = createCounter([vWire], { ttl: 1000 });
    c.update([{ id: 1, cx: 0.6, cy: 0.5 }], 0);
    c.update([], 50); // 50-0 < 1000 → mantém
    const ev = c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 60); // prev preservado → conta in
    expect(ev).toHaveLength(1);
    expect(ev[0].dir).toBe("in");
  });

  it("setTripwires preserva contadores por id e descarta os removidos", () => {
    const c = createCounter([vWire]);
    c.update([{ id: 1, cx: 0.6, cy: 0.5 }], 1);
    c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 2); // in (1) em "w"
    c.setTripwires([vWire, { id: "w2", a: { x: 0, y: 0.5 }, b: { x: 1, y: 0.5 } }]);
    expect(c.counts().w).toEqual({ in: 1, out: 0 }); // preservado
    expect(c.counts().w2).toEqual({ in: 0, out: 0 }); // novo zerado
    c.setTripwires([{ id: "w2", a: { x: 0, y: 0.5 }, b: { x: 1, y: 0.5 } }]);
    expect(c.counts().w).toBeUndefined(); // removido
  });

  it("reset zera contadores e histórico de posições", () => {
    const c = createCounter([vWire]);
    c.update([{ id: 1, cx: 0.6, cy: 0.5 }], 1);
    c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 2);
    c.reset();
    expect(c.counts().w).toEqual({ in: 0, out: 0 });
    // após reset, o "1º frame" volta a só registrar posição (não conta)
    const ev = c.update([{ id: 1, cx: 0.4, cy: 0.5 }], 3);
    expect(ev).toHaveLength(0);
  });
});

describe("createOccupancy — heatmap com decaimento", () => {
  it("add acumula nas células certas e grid() normaliza 0..1", () => {
    const occ = createOccupancy({ cols: 2, rows: 2, decay: 1 }); // decay 1 = sem decaimento
    occ.add([
      { x: 0.1, y: 0.1 }, // célula (0,0) → índice 0
      { x: 0.9, y: 0.9 }, // célula (1,1) → índice 3
    ]);
    const g = occ.grid();
    expect(g[0]).toBeCloseTo(1, 6);
    expect(g[3]).toBeCloseTo(1, 6);
    expect(g[1]).toBe(0);
    expect(g[2]).toBe(0);
  });

  it("grid() de grade vazia é toda zero", () => {
    const occ = createOccupancy({ cols: 2, rows: 2, decay: 1 });
    const g = occ.grid();
    expect([...g]).toEqual([0, 0, 0, 0]);
  });

  it("ignora pontos fora do frame (0..1)", () => {
    const occ = createOccupancy({ cols: 1, rows: 1, decay: 1, decayOnAdd: false });
    occ.add([{ x: 1.5, y: 0.5 }, { x: -0.1, y: 0.5 }]);
    expect(occ.rawGrid()[0]).toBe(0);
  });

  it("respeita weight e o teto max", () => {
    const occ = createOccupancy({ cols: 1, rows: 1, decay: 1, decayOnAdd: false, addAmount: 0.6 });
    occ.add([{ x: 0.5, y: 0.5, weight: 2 }]); // 0.6 * 2 = 1.2
    expect(occ.rawGrid()[0]).toBeCloseTo(1.2, 6);
    const capped = createOccupancy({ cols: 1, rows: 1, decay: 1, decayOnAdd: false, max: 1 });
    capped.add([{ x: 0.5, y: 0.5, weight: 10 }]);
    expect(capped.rawGrid()[0]).toBe(1); // limitado ao max
  });

  it("decayStep aplica um passo de decaimento", () => {
    const occ = createOccupancy({ cols: 1, rows: 1, decay: 0.5, decayOnAdd: false });
    occ.add([{ x: 0.5, y: 0.5 }]); // raw = 0.6
    occ.decayStep(); // 0.6 * 0.5
    expect(occ.rawGrid()[0]).toBeCloseTo(0.3, 6);
  });

  it("decayOnAdd decai ANTES de somar a cada frame", () => {
    const occ = createOccupancy({ cols: 1, rows: 1, decay: 0.5 }); // decayOnAdd default true
    occ.add([{ x: 0.5, y: 0.5 }]); // 0*0.5 + 0.6 = 0.6
    occ.add([{ x: 0.5, y: 0.5 }]); // 0.6*0.5 + 0.6 = 0.9
    expect(occ.rawGrid()[0]).toBeCloseTo(0.9, 6);
  });

  it("reset zera a grade", () => {
    const occ = createOccupancy({ cols: 1, rows: 1, decay: 1, decayOnAdd: false });
    occ.add([{ x: 0.5, y: 0.5 }]);
    occ.reset();
    expect(occ.rawGrid()[0]).toBe(0);
  });
});
