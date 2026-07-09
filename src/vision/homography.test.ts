// Testes da homografia PURA (src/vision/homography.ts): identidade, mapeamento de perspectiva
// conhecido (recuperar H de pontos gerados por uma H₀), ida∘volta ≈ identidade, medição de
// distância em metros, e rejeição de pontos degenerados (colineares/coincidentes/insuficientes).
import { describe, it, expect } from "vitest";
import {
  computeHomography,
  applyMatrix3,
  invertMatrix3,
  pixelToWorld,
  worldToPixel,
  measureDistance,
  type Correspondence,
  type Matrix3,
} from "./homography";

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);
function expectVecClose(a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-6) {
  close(a.x, b.x, eps);
  close(a.y, b.y, eps);
}
// Aplica uma H "verdade" a um ponto (para gerar pares de teste e conferir recuperação).
function applyTruth(H: Matrix3, x: number, y: number) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w };
}

describe("computeHomography — casos válidos", () => {
  it("identidade: quadrado unitário → ele mesmo mapeia todo ponto em si", () => {
    const pairs: Correspondence[] = [
      { px: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      { px: { x: 1, y: 0 }, world: { x: 1, y: 0 } },
      { px: { x: 1, y: 1 }, world: { x: 1, y: 1 } },
      { px: { x: 0, y: 1 }, world: { x: 0, y: 1 } },
    ];
    const r = computeHomography(pairs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectVecClose(applyMatrix3(r.H, { x: 0.37, y: 0.62 })!, { x: 0.37, y: 0.62 });
    expectVecClose(applyMatrix3(r.H, { x: 0.5, y: 0.5 })!, { x: 0.5, y: 0.5 });
  });

  it("escala afim conhecida: unitário → 10m × 5m (calculada à mão)", () => {
    // px unitário mapeado a um retângulo de 10m (x) por 5m (y): H afim puro.
    const pairs: Correspondence[] = [
      { px: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      { px: { x: 1, y: 0 }, world: { x: 10, y: 0 } },
      { px: { x: 1, y: 1 }, world: { x: 10, y: 5 } },
      { px: { x: 0, y: 1 }, world: { x: 0, y: 5 } },
    ];
    const r = computeHomography(pairs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Centro (0.5,0.5) → (5, 2.5) metros.
    expectVecClose(applyMatrix3(r.H, { x: 0.5, y: 0.5 })!, { x: 5, y: 2.5 });
    // Distância entre bordas esquerda/direita na altura média = 10 m.
    close(measureDistance(r.H, { x: 0, y: 0.5 }, { x: 1, y: 0.5 })!, 10);
    // Distância vertical topo→base = 5 m.
    close(measureDistance(r.H, { x: 0.5, y: 0 }, { x: 0.5, y: 1 })!, 5);
  });

  it("perspectiva genuína: recupera uma H₀ projetiva a partir de 4 pontos gerados por ela", () => {
    // H₀ com termos projetivos (linha de fuga) — não-afim. Geramos os dst aplicando H₀ e
    // conferimos que computeHomography a recupera (testando num 5º ponto independente).
    const H0: Matrix3 = [1.4, 0.25, 0.1, -0.15, 1.1, 0.05, 0.3, 0.2, 1];
    const src = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.15 },
      { x: 0.85, y: 0.95 },
      { x: 0.05, y: 0.8 },
    ];
    const pairs: Correspondence[] = src.map((p) => ({ px: p, world: applyTruth(H0, p.x, p.y) }));
    const r = computeHomography(pairs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Ponto NÃO usado na calibração: a H recuperada deve reproduzir a H₀ verdadeira.
    const probe = { x: 0.42, y: 0.66 };
    expectVecClose(applyMatrix3(r.H, probe)!, applyTruth(H0, probe.x, probe.y), 1e-6);
  });

  it("aceita mais de 4 pontos (mínimos quadrados) sem degradar um mapeamento exato", () => {
    const H0: Matrix3 = [2, 0.1, 0.3, 0.05, 1.7, -0.2, 0.1, 0.15, 1];
    const src = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
      { x: 0.9, y: 0.9 },
      { x: 0.1, y: 0.9 },
      { x: 0.5, y: 0.5 },
      { x: 0.3, y: 0.7 },
    ];
    const pairs: Correspondence[] = src.map((p) => ({ px: p, world: applyTruth(H0, p.x, p.y) }));
    const r = computeHomography(pairs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const probe = { x: 0.6, y: 0.25 };
    expectVecClose(applyMatrix3(r.H, probe)!, applyTruth(H0, probe.x, probe.y), 1e-5);
  });
});

describe("ida e volta (forward ∘ inverse ≈ identidade)", () => {
  it("pixelToWorld → worldToPixel devolve o ponto original", () => {
    const H0: Matrix3 = [1.4, 0.25, 0.1, -0.15, 1.1, 0.05, 0.3, 0.2, 1];
    const src = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.15 },
      { x: 0.85, y: 0.95 },
      { x: 0.05, y: 0.8 },
    ];
    const pairs: Correspondence[] = src.map((p) => ({ px: p, world: applyTruth(H0, p.x, p.y) }));
    const r = computeHomography(pairs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const p of [
      { x: 0.3, y: 0.3 },
      { x: 0.7, y: 0.6 },
      { x: 0.5, y: 0.9 },
    ]) {
      const world = pixelToWorld(r.H, p)!;
      const back = worldToPixel(r.H, world)!;
      expectVecClose(back, p, 1e-6);
    }
  });

  it("invertMatrix3 ∘ matriz ≈ identidade (M⁻¹·M·p = p)", () => {
    const M: Matrix3 = [1.4, 0.25, 0.1, -0.15, 1.1, 0.05, 0.3, 0.2, 1];
    const inv = invertMatrix3(M)!;
    expect(inv).not.toBeNull();
    const p = { x: 0.42, y: 0.31 };
    expectVecClose(applyMatrix3(inv, applyMatrix3(M, p)!)!, p, 1e-6);
  });
});

describe("robustez — degenerados e entradas inválidas (nunca NaN silencioso)", () => {
  it("rejeita menos de 4 pontos", () => {
    const r = computeHomography([
      { px: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      { px: { x: 1, y: 0 }, world: { x: 1, y: 0 } },
      { px: { x: 0, y: 1 }, world: { x: 0, y: 1 } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/4 pontos/);
  });

  it("rejeita 4 pontos COLINEARES na imagem (sistema singular)", () => {
    const r = computeHomography([
      { px: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      { px: { x: 0.25, y: 0.25 }, world: { x: 1, y: 1 } },
      { px: { x: 0.5, y: 0.5 }, world: { x: 2, y: 2 } },
      { px: { x: 0.75, y: 0.75 }, world: { x: 3, y: 3 } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/degenerado/);
  });

  it("rejeita pontos de imagem COINCIDENTES (duplicados)", () => {
    const r = computeHomography([
      { px: { x: 0.2, y: 0.2 }, world: { x: 0, y: 0 } },
      { px: { x: 0.2, y: 0.2 }, world: { x: 5, y: 0 } },
      { px: { x: 0.8, y: 0.2 }, world: { x: 5, y: 5 } },
      { px: { x: 0.2, y: 0.8 }, world: { x: 0, y: 5 } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/degenerado/);
  });

  it("rejeita coordenada não-finita (NaN/Infinity)", () => {
    const r = computeHomography([
      { px: { x: 0, y: 0 }, world: { x: 0, y: 0 } },
      { px: { x: 1, y: 0 }, world: { x: Number.NaN, y: 0 } },
      { px: { x: 1, y: 1 }, world: { x: 1, y: 1 } },
      { px: { x: 0, y: 1 }, world: { x: 0, y: 1 } },
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/inválida/);
  });

  it("applyMatrix3 devolve null no horizonte (W≈0) em vez de NaN/Infinity", () => {
    // Matriz cuja 3ª linha zera W no ponto (1,0): 1·(-1) + 0 + 1 = 0.
    const M: Matrix3 = [1, 0, 0, 0, 1, 0, -1, 0, 1];
    expect(applyMatrix3(M, { x: 1, y: 0 })).toBeNull();
    expect(measureDistance(M, { x: 1, y: 0 }, { x: 0.5, y: 0.5 })).toBeNull();
  });

  it("invertMatrix3 devolve null para matriz singular", () => {
    const singular: Matrix3 = [1, 2, 3, 2, 4, 6, 1, 1, 1]; // linha 2 = 2× linha 1
    expect(invertMatrix3(singular)).toBeNull();
  });
});
