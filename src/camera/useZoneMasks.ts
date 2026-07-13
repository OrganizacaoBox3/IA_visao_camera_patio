// Máscara EFETIVA por zona do CameraWorkspace: cache de decodificação + as fábricas de `contains`
// (teste fino de contenção). Extraído do CameraWorkspace na onda das zonas poligonais (o ratchet
// anti-reengorda barra crescer lá; ver CameraWorkspace.size.test):
//   • getMask: zona com `points` → máscara RASTERIZADA 1× dos points (P6; cacheada pelos pontos),
//     consumida pelo caminho POR PIXEL da atividade e pelo desenho de células (nunca pointInPolygon
//     por pixel). Zona LEGADA (sem points): decodifica z.mask como sempre.
//   • containsFn: teste por PONTO com precedência points>mask (P5, via zones.zoneContainsFn) —
//     EXATO no polígono; cada call-site mantém a própria âncora (centro/pé — CA-6).
//   • pixelContainsFn: `contains` da ATIVIDADE (laço por pixel + ocupação) — SEMPRE via máscara
//     (rasterizada p/ polígono), o consumo barato O(1)/ponto.
//
// A PODA (spec-zona-unificada F5): o PINCEL saiu do palco — a pintura (ensurePaint/paintAt/
// commitPaint/clearPaint) morreu junto. A MÁSCARA não: ela continua sendo o consumo POR PIXEL do
// polígono (um mecanismo, dois consumos) E o caminho de LEITURA das zonas legadas já pintadas
// (`z.mask` segue no modelo e é decodificado aqui). O que não existe mais é AUTORAR máscara à mão:
// o dado de produção provou que o pincel era um workaround do polígono que faltava.
import { useRef } from "react";
import { decodeMask, type Mask } from "../zoneMask";
import {
  DEFAULT_GRID,
  maskContainsFn,
  rasterizePolygonMask,
  zoneContainsFn,
  zonePolygon,
  type Zone,
} from "../zones";

export function useZoneMasks() {
  const cacheRef = useRef<Map<string, { enc?: string; mask: Mask }>>(new Map()); // decodificadas/rasterizadas

  function getMask(z: Zone): Mask | null {
    const pts = zonePolygon(z);
    if (pts) {
      // P6: polígono → rasteriza 1× p/ a grade padrão; chave de cache = os próprios vértices
      // (arrastar/inserir/remover um vértice muda a chave → re-rasteriza). A máscara pintada de
      // uma zona legada vira LEGADO no instante em que ela ganha points (P5: points vence).
      const enc = `poly:${pts.map((p) => `${p.x},${p.y}`).join(";")}`;
      const hit = cacheRef.current.get(z.id);
      if (hit && hit.enc === enc) return hit.mask;
      const m = rasterizePolygonMask(DEFAULT_GRID.cols, DEFAULT_GRID.rows, pts);
      cacheRef.current.set(z.id, { enc, mask: m });
      return m;
    }
    if (!z.mask) return null;
    const c = cacheRef.current.get(z.id);
    if (c && c.enc === z.mask) return c.mask;
    const m = decodeMask(z.mask);
    if (m) cacheRef.current.set(z.id, { enc: z.mask, mask: m });
    return m;
  }

  function drop(zoneId: string): void {
    cacheRef.current.delete(zoneId);
  }

  // Teste fino por PONTO (assignZone/exclusão-pé/objetos): precedência points>mask (P5).
  function containsFn(z: Zone): ((nx: number, ny: number) => boolean) | undefined {
    return zoneContainsFn(z, getMask(z));
  }
  // `contains` do caminho POR PIXEL (atividade: movimento + ocupação): sempre via máscara —
  // rasterizada p/ polígono (P6), decodificada p/ zona legada, undefined p/ retângulo cheio.
  function pixelContainsFn(z: Zone): ((nx: number, ny: number) => boolean) | undefined {
    return maskContainsFn(getMask(z));
  }

  return { getMask, drop, containsFn, pixelContainsFn };
}
