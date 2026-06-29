// Máscara de zona em GRADE (blueprint): a área deixa de ser só um retângulo e passa a ser um
// conjunto de células pintadas (pode ser irregular, descontínua, com furos). SRP/DRY: aqui ficam
// só a estrutura e as operações de máscara; o editor (UI) e os processadores apenas a consomem.

export type Mask = { cols: number; rows: number; bits: Uint8Array };

export function createMask(cols: number, rows: number): Mask {
  return { cols, rows, bits: new Uint8Array(cols * rows) };
}

export function maskGet(m: Mask, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < m.cols && row < m.rows && m.bits[row * m.cols + col] === 1;
}
export function maskSet(m: Mask, col: number, row: number, on: boolean): void {
  if (col < 0 || row < 0 || col >= m.cols || row >= m.rows) return;
  m.bits[row * m.cols + col] = on ? 1 : 0;
}
export function anySet(m: Mask): boolean {
  return m.bits.some((b) => b === 1);
}
export function clearMask(m: Mask): void {
  m.bits.fill(0);
}

// célula que contém um ponto NORMALIZADO (0..1) do frame
export function cellAtNorm(m: Mask, nx: number, ny: number): { col: number; row: number } {
  return {
    col: Math.min(m.cols - 1, Math.max(0, Math.floor(nx * m.cols))),
    row: Math.min(m.rows - 1, Math.max(0, Math.floor(ny * m.rows))),
  };
}
export function containsNorm(m: Mask, nx: number, ny: number): boolean {
  const { col, row } = cellAtNorm(m, nx, ny);
  return m.bits[row * m.cols + col] === 1;
}

// pinta/apaga um retângulo NORMALIZADO (atalho "retângulo de preenchimento")
export function fillRectNorm(
  m: Mask,
  x: number,
  y: number,
  w: number,
  h: number,
  on: boolean,
): void {
  const c0 = Math.max(0, Math.floor(x * m.cols)),
    c1 = Math.min(m.cols - 1, Math.ceil((x + w) * m.cols) - 1);
  const r0 = Math.max(0, Math.floor(y * m.rows)),
    r1 = Math.min(m.rows - 1, Math.ceil((y + h) * m.rows) - 1);
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) m.bits[r * m.cols + c] = on ? 1 : 0;
}

// pinta um "pincel" quadrado de raio `rad` (em células) centrado numa célula
export function paintBrush(m: Mask, col: number, row: number, rad: number, on: boolean): void {
  for (let r = row - rad; r <= row + rad; r++)
    for (let c = col - rad; c <= col + rad; c++) maskSet(m, c, r, on);
}

// bounding box NORMALIZADA das células pintadas (p/ recorte/ROI); null se vazia
export function maskBBoxNorm(m: Mask): { x: number; y: number; w: number; h: number } | null {
  let minC = m.cols,
    minR = m.rows,
    maxC = -1,
    maxR = -1;
  for (let r = 0; r < m.rows; r++)
    for (let c = 0; c < m.cols; c++)
      if (m.bits[r * m.cols + c]) {
        if (c < minC) minC = c;
        if (c > maxC) maxC = c;
        if (r < minR) minR = r;
        if (r > maxR) maxR = r;
      }
  if (maxC < 0) return null;
  return {
    x: minC / m.cols,
    y: minR / m.rows,
    w: (maxC - minC + 1) / m.cols,
    h: (maxR - minR + 1) / m.rows,
  };
}

// ── (de)serialização compacta: "<cols>x<rows>:<base64 dos bits empacotados>" ──
export function encodeMask(m: Mask): string {
  const bytes = new Uint8Array(Math.ceil(m.bits.length / 8));
  for (let i = 0; i < m.bits.length; i++) if (m.bits[i]) bytes[i >> 3] |= 1 << (i & 7);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `${m.cols}x${m.rows}:${btoa(s)}`;
}
export function decodeMask(str: string | undefined): Mask | null {
  if (!str) return null;
  const sep = str.indexOf(":");
  if (sep < 0) return null;
  const dims = str.slice(0, sep).split("x");
  const cols = Number(dims[0]),
    rows = Number(dims[1]);
  if (!cols || !rows) return null;
  try {
    const raw = atob(str.slice(sep + 1));
    const m = createMask(cols, rows);
    for (let i = 0; i < m.bits.length; i++) {
      const byte = raw.charCodeAt(i >> 3) || 0;
      m.bits[i] = (byte >> (i & 7)) & 1;
    }
    return m;
  } catch {
    return null;
  }
}

// converte um retângulo NORMALIZADO numa máscara cheia (retrocompat: zona-retângulo → células)
export function maskFromRect(
  cols: number,
  rows: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Mask {
  const m = createMask(cols, rows);
  fillRectNorm(m, x, y, w, h, true);
  return m;
}
