// Kernel de LUMA p/ detecção de movimento — dono ÚNICO do readback RGBA→luma e do ping-pong de
// buffers (antes copiado 3×: CameraWorkspace, fallback LR do AtividadeProcessor e LeituraProcessor).
// Matemática idêntica às cópias originais: luma = 0.299R + 0.587G + 0.114B (BT.601).
// Mover o readback p/ OffscreenCanvas/worker no futuro acontece AQUI, num ponto só.

/** Converte RGBA (4 bytes/pixel) em luma BT.601. `out.length` = nº de pixels do buffer RGBA. */
export function rgbaToLuma(rgba: ArrayLike<number>, out: Float32Array): void {
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++)
    out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

/**
 * Ping-pong PURO de buffers de luma (testável sem DOM): recicla 2 Float32Array — zero alocação
 * por frame em regime. Mudar o tamanho invalida o par (prev() = null → sem diff naquele frame).
 */
export function createLumaPingPong() {
  let prev: Float32Array | null = null;
  let free: Float32Array | null = null;
  let size = 0;
  return {
    /** Buffer p/ escrever a luma do frame atual (recicla o livre; realoca só se o tamanho mudou). */
    acquire(sz: number): Float32Array {
      if (sz !== size) {
        size = sz;
        prev = null;
        free = null;
      }
      const cur = free && free.length === sz ? free : new Float32Array(sz);
      free = null;
      return cur;
    },
    /** Luma do último frame analisado (base do diff). null = 1º frame ou tamanho mudou. */
    prev(): Float32Array | null {
      return prev;
    },
    /** Conclui o frame: `cur` vira o "anterior"; o anterior antigo é reciclado p/ o próximo acquire. */
    swap(cur: Float32Array): void {
      free = prev;
      prev = cur;
    },
    reset(): void {
      prev = null;
      free = null;
      size = 0;
    },
  };
}
export type LumaPingPong = ReturnType<typeof createLumaPingPong>;

/** Recorte da FONTE a rasterizar (px da fonte); ausente = fonte inteira reamostrada p/ pw×ph. */
export type LumaRegion = { sx: number; sy: number; sw: number; sh: number };

/** Amostra de um frame: luma ATUAL + luma do frame analisado ANTERIOR (null = sem diff possível). */
export type LumaSample = { luma: Float32Array; prev: Float32Array | null; pw: number; ph: number };

export type LumaSource = {
  /**
   * Rasteriza `el` (inteiro, ou o recorte `src`) em pw×ph e devolve o par {luma, prev}.
   * Retorna null se o contexto 2D não existir (frame sem motion — caller pula o diff).
   * Mudança de pw/ph invalida o par (prev = null neste frame; nada de diff entre resoluções).
   */
  sample(el: CanvasImageSource, pw: number, ph: number, src?: LumaRegion): LumaSample | null;
  /** Libera canvas/buffers (dispose / troca de perfil). O próximo sample recria do zero. */
  reset(): void;
};

/** Fonte de luma com canvas offscreen próprio (willReadFrequently) + ping-pong interno. */
export function createLumaSource(): LumaSource {
  const pp = createLumaPingPong();
  let canvas: HTMLCanvasElement | null = null;
  return {
    sample(el, pw, ph, src) {
      if (!canvas) canvas = document.createElement("canvas");
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
        pp.reset(); // geometria mudou → diff entre resoluções distintas nunca acontece
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      if (src) ctx.drawImage(el, src.sx, src.sy, src.sw, src.sh, 0, 0, pw, ph);
      else ctx.drawImage(el, 0, 0, pw, ph);
      const rgba = ctx.getImageData(0, 0, pw, ph).data;
      const luma = pp.acquire(pw * ph);
      rgbaToLuma(rgba, luma);
      const prev = pp.prev();
      pp.swap(luma);
      return { luma, prev, pw, ph };
    },
    reset() {
      pp.reset();
      canvas = null;
    },
  };
}
