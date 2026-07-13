// A GRADE DE CONFERÊNCIA é o único sensor que o operador tem de que a calibração está boa ("ela
// assenta no chão?"). Se ela mentir, ele salva uma homografia errada com cara de certeza — e todo
// metro medido depois sai torto. Por isso a matemática dela é PURA e testada aqui, não escondida
// num useMemo.
//
// O critério de aceite da spec §1 é literalmente este round-trip: cliquei 4 cantos e disse L×C →
// a grade projetada DE VOLTA tem de cair EM CIMA dos cantos que cliquei.
import { describe, it, expect } from "vitest";
import { computeHomography, type Correspondence } from "../vision/homography";
import { gridSegments, worldCorners } from "./useCalibrationEditor";

// Um retângulo de 4 m × 6 m no chão, visto em perspectiva (os cantos "longe" mais juntos — é o que
// uma câmera de teto vê). Coords de imagem normalizadas 0..1, na ordem de clique da UI.
const CORNERS = [
  { x: 0.2, y: 0.9 }, // 1 · próximo-esquerdo → (0,0)
  { x: 0.8, y: 0.9 }, // 2 · próximo-direito  → (L,0)
  { x: 0.65, y: 0.4 }, // 3 · longe-direito    → (L,C)
  { x: 0.35, y: 0.4 }, // 4 · longe-esquerdo   → (0,C)
];
const L = 4,
  C = 6;

function H() {
  const w = worldCorners(L, C);
  const corr: Correspondence[] = CORNERS.map((px, i) => ({ px, world: w[i] }));
  const r = computeHomography(corr);
  if (!r.ok) throw new Error(r.error);
  return r.H;
}

describe("gridSegments — a grade métrica de conferência", () => {
  it("assenta no chão: as linhas de borda caem EXATAMENTE sobre os 4 cantos clicados", () => {
    const g = gridSegments(H(), L, C);
    expect(g).not.toBeNull();
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

    // 1ª linha do eixo X é o mundo (0,0)→(0,C) = canto 1 → canto 4 (a borda esquerda do retângulo).
    const primeira = g!.seg[0];
    expect(near(primeira[0], CORNERS[0])).toBe(true);
    expect(near(primeira[1], CORNERS[3])).toBe(true);

    // Alguma linha do eixo Y é o mundo (0,0)→(L,0) = canto 1 → canto 2 (a borda de baixo).
    const temBordaDeBaixo = g!.seg.some(
      ([a, b]) => near(a, CORNERS[0]) && near(b, CORNERS[1]),
    );
    expect(temBordaDeBaixo).toBe(true);
  });

  it("passo ≥ 1 m e ≤ ~13 linhas por eixo (retângulo grande não vira teia de aranha)", () => {
    const g = gridSegments(H(), L, C);
    expect(g!.step).toBe(1); // 4×6 m → 1 m por linha
    expect(g!.seg.length).toBe(5 + 7); // x: 0..4 · y: 0..6

    // 60 m × 90 m: o passo SOBE para não passar de ~13 linhas/eixo (senão a grade tapa o vídeo).
    const w = worldCorners(60, 90);
    const big = computeHomography(CORNERS.map((px, i) => ({ px, world: w[i] })));
    if (!big.ok) throw new Error(big.error);
    const gb = gridSegments(big.H, 60, 90)!;
    expect(gb.step).toBe(8); // ceil(90/12)
    expect(gb.seg.length).toBeLessThanOrEqual(26);
  });

  it("sem H válida ou sem dimensões (>0) não desenha grade — nunca inventa geometria", () => {
    expect(gridSegments(null, L, C)).toBeNull();
    expect(gridSegments(H(), 0, C)).toBeNull();
    expect(gridSegments(H(), L, NaN)).toBeNull();
    expect(gridSegments(H(), -2, C)).toBeNull();
  });
});
