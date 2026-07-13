// Máscara EFETIVA por zona do CameraWorkspace: cache de decodificação + operações de pintura +
// as fábricas de `contains` (teste fino de contenção). Extraído 1:1 do CameraWorkspace na onda
// das zonas poligonais (o ratchet anti-reengorda barra crescer lá; ver CameraWorkspace.size.test):
// comportamento do caminho retângulo+máscara PRESERVADO (CA-5); o que é NOVO aqui é o polígono —
//   • getMask: zona com `points` → máscara RASTERIZADA 1× dos points (P6; cacheada pelos pontos),
//     consumida pelo caminho POR PIXEL da atividade e pelo desenho de células (nunca pointInPolygon
//     por pixel). Zona sem points: decodifica z.mask como sempre.
//   • containsFn: teste por PONTO com precedência points>mask (P5, via zones.zoneContainsFn) —
//     EXATO no polígono; cada call-site mantém a própria âncora (centro/pé — CA-6).
//   • pixelContainsFn: `contains` da ATIVIDADE (laço por pixel + ocupação) — SEMPRE via máscara
//     (rasterizada p/ polígono), o consumo barato O(1)/ponto.
import { useRef } from "react";
import {
  cellAtNorm,
  clearMask,
  decodeMask,
  encodeMask,
  maskBBoxNorm,
  maskFromRect,
  paintBrush,
  type Mask,
} from "../zoneMask";
import {
  DEFAULT_GRID,
  maskContainsFn,
  rasterizePolygonMask,
  zoneContainsFn,
  zonePolygon,
  type Zone,
} from "../zones";

export function useZoneMasks(paintZoneId: string | null) {
  const cacheRef = useRef<Map<string, { enc?: string; mask: Mask }>>(new Map()); // máscaras decodificadas/rasterizadas

  function getMask(z: Zone): Mask | null {
    const pts = zonePolygon(z);
    if (pts) {
      // P6: polígono → rasteriza 1× p/ a grade padrão; chave de cache = os próprios vértices
      // (arrastar um vértice muda a chave → re-rasteriza). O pincel vira legado (P5).
      const enc = `poly:${pts.map((p) => `${p.x},${p.y}`).join(";")}`;
      const hit = cacheRef.current.get(z.id);
      if (hit && hit.enc === enc) return hit.mask;
      const m = rasterizePolygonMask(DEFAULT_GRID.cols, DEFAULT_GRID.rows, pts);
      cacheRef.current.set(z.id, { enc, mask: m });
      return m;
    }
    const c = cacheRef.current.get(z.id);
    if (paintZoneId === z.id && c) return c.mask; // ao vivo durante a pintura
    if (!z.mask) return null;
    if (c && c.enc === z.mask) return c.mask;
    const m = decodeMask(z.mask);
    if (m) cacheRef.current.set(z.id, { enc: z.mask, mask: m });
    return m;
  }

  // Máscara editável da PINTURA (garante uma, semeando do retângulo da zona quando não há).
  function ensurePaint(z: Zone): Mask {
    const c = cacheRef.current.get(z.id);
    if (c && paintZoneId === z.id) return c.mask;
    const m =
      decodeMask(z.mask) ?? maskFromRect(DEFAULT_GRID.cols, DEFAULT_GRID.rows, z.x, z.y, z.w, z.h);
    cacheRef.current.set(z.id, { enc: z.mask, mask: m });
    return m;
  }
  // Pincel quadrado no ponto NORMALIZADO (rad em células; erase apaga).
  function paintAt(z: Zone, nx: number, ny: number, rad: number, erase: boolean): void {
    const m = ensurePaint(z);
    const { col, row } = cellAtNorm(m, nx, ny);
    paintBrush(m, col, row, rad, !erase);
  }
  // Fecha a pintura: codifica + re-deriva a bbox das células (padrão maskBBoxNorm) e devolve o
  // PATCH p/ o chamador persistir; null se a zona nunca teve máscara editada nesta sessão.
  function commitPaint(z: Zone): Partial<Zone> | null {
    const c = cacheRef.current.get(z.id);
    if (!c) return null;
    const enc = encodeMask(c.mask);
    cacheRef.current.set(z.id, { enc, mask: c.mask });
    const bb = maskBBoxNorm(c.mask);
    return bb ? { mask: enc, ...bb } : { mask: enc };
  }
  function clearPaint(z: Zone): void {
    clearMask(ensurePaint(z));
  }
  function drop(zoneId: string): void {
    cacheRef.current.delete(zoneId);
  }

  // Teste fino por PONTO (assignZone/exclusão-pé/objetos): precedência points>mask (P5).
  function containsFn(z: Zone): ((nx: number, ny: number) => boolean) | undefined {
    return zoneContainsFn(z, getMask(z));
  }
  // `contains` do caminho POR PIXEL (atividade: movimento + ocupação): sempre via máscara —
  // rasterizada p/ polígono (P6), pintada p/ máscara, undefined p/ retângulo cheio.
  function pixelContainsFn(z: Zone): ((nx: number, ny: number) => boolean) | undefined {
    return maskContainsFn(getMask(z));
  }

  return { getMask, ensurePaint, paintAt, commitPaint, clearPaint, drop, containsFn, pixelContainsFn };
}
