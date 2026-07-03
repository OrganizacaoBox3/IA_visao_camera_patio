// ─────────────────────────────────────────────────────────────────────────────
// nms.ts — geometria PURA de supressão de detecções duplicadas (extraída de
// detect.ts p/ ser testável sem carregar tfjs). SEM DOM, SEM dependências.
//
// Duas regras de supressão, aplicadas POR CLASSE, guloso do maior score p/ o menor:
//   • IoU ≥ iouThr — a fusão clássica de duplicatas nas bordas dos tiles.
//   • CONTENÇÃO ≥ containThr — interseção / área da caixa MENOR. Mata a dupla
//     que o IoU NÃO pega: caixa PARCIAL de um tile vizinho (meia pessoa) quase
//     toda contida na caixa inteira — IoU baixo (união grande), contenção alta.
//     É a "pessoa duplicada" clássica do tiling com overlap e do upscale 2×.
//
// TRADE-OFF DECLARADO (containThr = 0.7, conservador): duas pessoas REALMENTE
// próximas lado a lado raramente têm uma caixa ≥70% contida na outra — isso só
// acontece em oclusão forte (uma na frente da outra), caso em que o detector
// costuma emitir uma caixa só de qualquer forma. Baixar o limiar mataria recall
// de pares próximos; subir deixaria passar a duplicata parcial. 0.7 é o meio.
// ─────────────────────────────────────────────────────────────────────────────

/** Detecção normalizada ao frame (bbox [x,y,w,h] em frações 0..1). */
export type NormDet = { cls: string; score: number; bbox: [number, number, number, number] };

/** IoU de duas bboxes [x,y,w,h] na mesma unidade. 0 sem interseção. */
export function iouXYWH(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const ax2 = a[0] + a[2],
    ay2 = a[1] + a[3],
    bx2 = b[0] + b[2],
    by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const ua = a[2] * a[3] + b[2] * b[3] - inter;
  return ua > 0 ? inter / ua : 0;
}

/**
 * CONTENÇÃO: interseção / área da caixa MENOR (0..1). 1 = a menor está toda
 * dentro da maior. Simétrica; robusta onde o IoU falha (caixas de tamanhos
 * muito diferentes sobre o mesmo alvo).
 */
export function containment(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const ix = Math.max(
    0,
    Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]),
  );
  const iy = Math.max(
    0,
    Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]),
  );
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const minArea = Math.min(a[2] * a[3], b[2] * b[3]);
  return minArea > 0 ? inter / minArea : 0;
}

/**
 * Supressão POR CLASSE, gulosa (maior score primeiro): descarta `d` se alguma
 * caixa JÁ MANTIDA da mesma classe tem IoU ≥ iouThr OU contenção ≥ containThr
 * com ela (mantém sempre a de maior score). `iouThr = Infinity` desliga o
 * critério de IoU (uso: single-shot, onde o coco já fez o próprio NMS — só a
 * contenção é adicionada, sem mudar o comportamento anterior).
 */
export function suppressDuplicates(
  dets: NormDet[],
  iouThr: number,
  containThr: number,
): NormDet[] {
  const byClass = new Map<string, NormDet[]>();
  for (const d of dets) {
    const arr = byClass.get(d.cls) ?? [];
    arr.push(d);
    byClass.set(d.cls, arr);
  }
  const kept: NormDet[] = [];
  for (const arr of byClass.values()) {
    arr.sort((a, b) => b.score - a.score);
    const sel: NormDet[] = [];
    for (const d of arr) {
      if (
        sel.every(
          (s) => iouXYWH(s.bbox, d.bbox) < iouThr && containment(s.bbox, d.bbox) < containThr,
        )
      )
        sel.push(d);
    }
    kept.push(...sel);
  }
  return kept;
}

/**
 * true se `bbox` já está "coberta" por alguma caixa de `boxes` (IoU ≥ iouThr OU
 * contenção ≥ containThr). Uso: camada visual de caixas omite a detecção crua de
 * pessoa quando um TRACK já desenha a mesma pessoa (1 pessoa = 1 caixa na tela).
 */
export function coveredByAny(
  bbox: readonly [number, number, number, number],
  boxes: ReadonlyArray<readonly [number, number, number, number]>,
  iouThr: number,
  containThr: number,
): boolean {
  for (const b of boxes)
    if (iouXYWH(b, bbox) >= iouThr || containment(b, bbox) >= containThr) return true;
  return false;
}
