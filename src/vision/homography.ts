// Homografia de plano de chão (câmera fixa sobre piso plano) — lógica PURA, SEM dependências.
// Converte um ponto do PÉ da pessoa (pixel normalizado 0..1) para uma posição no CHÃO em METROS
// e vice-versa, e mede distâncias reais entre dois pontos da imagem. Base do "medir distância na
// câmera" e da fusão de identidade por tag BLE (projetar o pé no chão) — ver
// docs/analises/tags-bluetooth/00-avaliacao-e-plano.md §3.
//
// HOME desta lógica: aqui em src/vision/ (vizinha de bytetrack/counting/luma — CV pura do cliente).
// O FRONT é quem computa H (na calibração) e mede (readout); o hub apenas PERSISTE os pontos + H
// (server/camcfg.js) e, no futuro, aplica H já pronto — uma multiplicação matriz×vetor trivial que
// não justifica duplicar este solver no back hoje (YAGNI). Se o back precisar APLICAR H, reusa o
// contrato numérico (Matrix3 = 9 números row-major) sem recomputar.
//
// Método: DLT (Direct Linear Transform). Cada correspondência (px→mundo) dá 2 equações lineares
// nos 8 incógnitos de H (h33 fixado em 1). Com N≥4 pontos montamos o sistema 2N×8 e resolvemos as
// equações normais (AᵀA·h = Aᵀb) — um solve 8×8 por eliminação de Gauss com pivotamento parcial.
// Pontos degenerados (colineares/coincidentes) → matriz singular → erro explícito (nunca NaN mudo).

export type Vec2 = { x: number; y: number };
/** Homografia 3×3 em ROW-MAJOR: [m0 m1 m2 · m3 m4 m5 · m6 m7 m8]. Aplica-se projetivamente. */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];
/** Par de calibração: ponto na imagem (px, tipicamente normalizado 0..1) ↔ ponto no mundo (metros). */
export type Correspondence = { px: Vec2; world: Vec2 };
/** Resultado discriminado: nunca lança — o chamador trata o erro (KISS, sem try/catch difuso). */
export type HomographyResult = { ok: true; H: Matrix3 } | { ok: false; error: string };

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const isVec = (v: unknown): v is Vec2 =>
  !!v && typeof v === "object" && isFiniteNum((v as Vec2).x) && isFiniteNum((v as Vec2).y);

// Resolve A·x = b (A é n×n, mutável) por eliminação de Gauss com pivotamento parcial.
// Devolve x, ou null se a matriz for (quase) singular — o sinal de pontos degenerados.
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  // Matriz aumentada [A | b] — trabalhamos sobre cópias para não mutar a entrada do chamador.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Pivô = maior |valor| na coluna (estabilidade numérica).
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    if (Math.abs(M[pivot][col]) < 1e-12) return null; // coluna sem pivô → singular
    [M[col], M[pivot]] = [M[pivot], M[col]];
    // Elimina abaixo do pivô.
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  // Substituição regressiva.
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = M[row][n];
    for (let c = row + 1; c < n; c++) sum -= M[row][c] * x[c];
    x[row] = sum / M[row][row];
  }
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Computa a homografia H que leva px→mundo a partir de N≥4 correspondências.
 * Retorna {ok:false} para: menos de 4 pontos, coordenadas não-finitas, ou pontos degenerados
 * (colineares/coincidentes → sistema singular). Nunca devolve NaN silencioso.
 */
export function computeHomography(pairs: Correspondence[]): HomographyResult {
  if (!Array.isArray(pairs) || pairs.length < 4)
    return { ok: false, error: "mínimo de 4 pontos de calibração" };
  for (const p of pairs)
    if (!p || !isVec(p.px) || !isVec(p.world))
      return { ok: false, error: "ponto com coordenada inválida" };

  // Sistema 2N×8: para cada par (x,y)→(X,Y):
  //   x·h0 + y·h1 + h2 − X·x·h6 − X·y·h7 = X
  //   x·h3 + y·h4 + h5 − Y·x·h6 − Y·y·h7 = Y
  const A: number[][] = [];
  const b: number[] = [];
  for (const { px, world } of pairs) {
    const { x, y } = px;
    const { x: X, y: Y } = world;
    A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  // Equações normais AᵀA·h = Aᵀb → solve 8×8 (cobre N=4 exato e N>4 por mínimos quadrados).
  const N = 8;
  const AtA: number[][] = Array.from({ length: N }, () => new Array<number>(N).fill(0));
  const Atb = new Array<number>(N).fill(0);
  for (let i = 0; i < A.length; i++) {
    const row = A[i];
    for (let r = 0; r < N; r++) {
      Atb[r] += row[r] * b[i];
      for (let c = 0; c < N; c++) AtA[r][c] += row[r] * row[c];
    }
  }
  const h = solveLinear(AtA, Atb);
  if (!h) return { ok: false, error: "pontos degenerados (colineares ou coincidentes)" };
  const H: Matrix3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  if (!H.every(Number.isFinite)) return { ok: false, error: "solução não-finita" };
  return { ok: true, H };
}

/**
 * Aplica uma matriz 3×3 projetiva a um ponto: [X,Y,W]ᵀ = M·[x,y,1]ᵀ, resultado = (X/W, Y/W).
 * null quando o ponto cai na linha do horizonte da matriz (W≈0) — sem divisão por ~0.
 */
export function applyMatrix3(M: Matrix3, p: Vec2): Vec2 | null {
  const w = M[6] * p.x + M[7] * p.y + M[8];
  if (Math.abs(w) < 1e-12) return null;
  const x = (M[0] * p.x + M[1] * p.y + M[2]) / w;
  const y = (M[3] * p.x + M[4] * p.y + M[5]) / w;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Inverte uma matriz 3×3 (adjunta/determinante). null se singular (det≈0). */
export function invertMatrix3(M: Matrix3): Matrix3 | null {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const out: Matrix3 = [
    A * inv,
    (c * h - b * i) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    (c * d - a * f) * inv,
    C * inv,
    (b * g - a * h) * inv,
    (a * e - b * d) * inv,
  ];
  return out.every(Number.isFinite) ? out : null;
}

/** px (imagem) → mundo (metros). Açúcar sobre applyMatrix3 com o nome do domínio. */
export function pixelToWorld(H: Matrix3, px: Vec2): Vec2 | null {
  return applyMatrix3(H, px);
}
/** mundo (metros) → px (imagem). Requer H invertível (calibração não-degenerada). */
export function worldToPixel(H: Matrix3, world: Vec2): Vec2 | null {
  const inv = invertMatrix3(H);
  return inv ? applyMatrix3(inv, world) : null;
}

/**
 * Distância REAL em metros entre dois pontos da imagem, via H. null se algum ponto não projeta
 * (horizonte). É o "medir distância na câmera" — projeta os dois pés no chão e mede a reta.
 */
export function measureDistance(H: Matrix3, a: Vec2, b: Vec2): number | null {
  const wa = applyMatrix3(H, a);
  const wb = applyMatrix3(H, b);
  if (!wa || !wb) return null;
  return Math.hypot(wa.x - wb.x, wa.y - wb.y);
}
