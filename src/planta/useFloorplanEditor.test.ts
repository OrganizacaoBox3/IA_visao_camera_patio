// Testes das TRANSIÇÕES PURAS do editor da planta — clamp à caixa, hit-test em px de viewport, e
// place/remove do conjunto de antenas. Sem DOM (no espírito do usePolygonEditor.test.ts, mas aqui a
// lógica pura já está fatorada em funções, então testamos direto — sem micro-runtime de hooks).
import { describe, it, expect } from "vitest";
import {
  clampToBox,
  hitStation,
  placeStationAt,
  removeStationAt,
  HIT_RADIUS_PX,
} from "./useFloorplanEditor";
import type { Vec2 } from "../api";

describe("clampToBox — grampeia à caixa do galpão [0,w]×[0,h]", () => {
  it("dentro da caixa passa intacto", () => {
    expect(clampToBox({ x: 3, y: 4 }, 10, 8)).toEqual({ x: 3, y: 4 });
  });
  it("estoura à direita/baixo → grampeia no limite", () => {
    expect(clampToBox({ x: 99, y: 99 }, 10, 8)).toEqual({ x: 10, y: 8 });
  });
  it("negativo → grampeia no zero (nunca fora do prédio)", () => {
    expect(clampToBox({ x: -5, y: -1 }, 10, 8)).toEqual({ x: 0, y: 0 });
  });
  it("caixa ainda sem medida (dim ≤ 0) → eixo colado no zero", () => {
    expect(clampToBox({ x: 5, y: 5 }, 0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("placeStationAt / removeStationAt — o conjunto de antenas (Record<id,Vec2>)", () => {
  it("place adiciona sem mutar o original", () => {
    const a: Record<string, Vec2> = { A: { x: 1, y: 1 } };
    const b = placeStationAt(a, "B", { x: 2, y: 2 });
    expect(b).toEqual({ A: { x: 1, y: 1 }, B: { x: 2, y: 2 } });
    expect(a).toEqual({ A: { x: 1, y: 1 } }); // imutável
  });
  it("place sobre id existente MOVE (não duplica)", () => {
    const b = placeStationAt({ A: { x: 1, y: 1 } }, "A", { x: 9, y: 9 });
    expect(b).toEqual({ A: { x: 9, y: 9 } });
  });
  it("remove tira o id; remover ausente devolve o mesmo objeto", () => {
    const a: Record<string, Vec2> = { A: { x: 1, y: 1 }, B: { x: 2, y: 2 } };
    expect(removeStationAt(a, "A")).toEqual({ B: { x: 2, y: 2 } });
    expect(removeStationAt(a, "Z")).toBe(a); // no-op → mesma referência
  });
});

describe("hitStation — a antena mais próxima dentro do raio, em px de viewport", () => {
  // Transform trivial: 1 m = 10 px, sem offset (project(w) = w*10). Basta para o hit-test.
  const project = (w: Vec2): Vec2 => ({ x: w.x * 10, y: w.y * 10 });
  const pos: Record<string, Vec2> = { A: { x: 1, y: 1 }, B: { x: 5, y: 5 } };

  it("clique em cima de A (10,10 px) → A", () => {
    expect(hitStation(pos, { x: 10, y: 10 }, project, HIT_RADIUS_PX)).toBe("A");
  });
  it("clique perto de B, dentro do raio → B", () => {
    // B projeta em (50,50); (56,50) dista 6 px < 14.
    expect(hitStation(pos, { x: 56, y: 50 }, project, HIT_RADIUS_PX)).toBe("B");
  });
  it("clique longe de todas → null (não pega nada)", () => {
    expect(hitStation(pos, { x: 200, y: 200 }, project, HIT_RADIUS_PX)).toBeNull();
  });
  it("entre duas, escolhe a MAIS próxima", () => {
    const p: Record<string, Vec2> = { A: { x: 1, y: 1 }, C: { x: 1.1, y: 1 } };
    // A em (10,10), C em (11,10); ponteiro (11,10) casa nas duas (dist 1 e 0) → a menor é C.
    expect(hitStation(p, { x: 11, y: 10 }, project, HIT_RADIUS_PX)).toBe("C");
  });
});
