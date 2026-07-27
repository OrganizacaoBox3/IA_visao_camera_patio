// Recorte da ROI da zona → FrameSource alimentado ao FadigaProcessor.
//
// Saiu do CameraWorkspace na onda do AVISO DE DETECTOR (jul/26): o ratchet de tamanho
// (CameraWorkspace.size.test.ts) tinha ~0 de folga e o diff PRECISAVA crescer (o backend do
// detector de objetos deixou de ser descartado). Em vez de subir o teto, saiu uma
// responsabilidade — e ela ficou MELHOR do que estava: a geometria virou função PURA (`cropSize`,
// testável sem DOM), que era justamente a parte com risco de erro (dois arredondamentos e um cap).
//
// Contrato preservado byte-a-byte: mesmo cap de ~480px na largura, mesmo reuso do canvas por zona
// (identidade estável — o FadigaProcessor usa a identidade do elemento como "frame novo") e o
// mesmo Map de crops que holders.ts já limpa na troca de modo.
import type { FrameSource } from "../frame";
import type { Zone } from "../zones";

/** Largura máxima do recorte: acima disto a fadiga não ganha nada e a inferência custa mais. */
export const CROP_MAX_W = 480;

export type CropSize = {
  sx: number; // recorte na FONTE (px do frame)
  sy: number;
  sw: number;
  sh: number;
  cw: number; // destino (px do canvas de recorte)
  ch: number;
};

/**
 * Geometria do recorte: zona normalizada (0..1) × dimensões do frame → retângulo de origem e
 * destino, com cap de largura em CROP_MAX_W. PURA. Todo lado é ≥1px (uma zona degenerada não
 * pode produzir canvas 0×0 — `drawImage`/`width=0` jogaria exceção no laço quente).
 */
export function cropSize(
  z: { x: number; y: number; w: number; h: number },
  f: { w: number; h: number },
): CropSize {
  const sw = Math.max(1, Math.round(z.w * f.w)),
    sh = Math.max(1, Math.round(z.h * f.h));
  const scale = Math.min(1, CROP_MAX_W / sw);
  return {
    sx: z.x * f.w,
    sy: z.y * f.h,
    sw,
    sh,
    cw: Math.max(1, Math.round(sw * scale)),
    ch: Math.max(1, Math.round(sh * scale)),
  };
}

/**
 * Recorta a ROI da zona num canvas REUSADO por zona (identidade estável) e devolve o FrameSource.
 * O chamador guarda o Map; holders.ts o poda quando a zona troca de modo.
 */
export function cropZone(
  crops: Map<string, HTMLCanvasElement>,
  z: Zone,
  f: FrameSource,
): FrameSource {
  let cv = crops.get(z.id);
  if (!cv) {
    cv = document.createElement("canvas");
    crops.set(z.id, cv);
  }
  const { sx, sy, sw, sh, cw, ch } = cropSize(z, f);
  if (cv.width !== cw || cv.height !== ch) {
    cv.width = cw;
    cv.height = ch;
  }
  cv.getContext("2d")!.drawImage(f.el, sx, sy, sw, sh, 0, 0, cw, ch);
  return { el: cv, w: cw, h: ch };
}
