// Adaptador do editor espacial compartilhado para o palco de vídeo.
// Toda a gestualidade (retângulo/polígono, seleção, vértices e translação) vive em
// spatial/usePolygonEditor; aqui permanece somente a conversão letterbox → coordenadas 0..1.
import type { RefObject } from "react";
import type { FrameSource } from "../frame";
import type { Zone, ZonePoint } from "../zones";
import { getContentRect } from "./draw";
import {
  usePolygonEditor as useSpatialPolygonEditor,
  type PointerLike,
} from "../spatial/usePolygonEditor";

type ZonePatch = { points: ZonePoint[]; x: number; y: number; w: number; h: number };

type Opts = {
  viewportRef: RefObject<HTMLDivElement | null>;
  currentFrame: () => FrameSource | null;
  zonesRef: RefObject<Zone[]>;
  onStart: () => void;
  onCreate: (points: ZonePoint[]) => void;
  onLive: (id: string, patch: ZonePatch) => void;
  onPatch: (id: string, patch: ZonePatch) => void;
  onAlert: (msg: string) => void;
};

export type { Selection } from "../spatial/usePolygonEditor";

export function usePolygonEditor(o: Opts) {
  const contentRect = () => {
    const frame = o.currentFrame();
    const viewport = o.viewportRef.current;
    if (!frame || !viewport) return null;
    return {
      viewport,
      rect: viewport.getBoundingClientRect(),
      content: getContentRect(viewport.clientWidth, viewport.clientHeight, frame.w, frame.h),
    };
  };

  return useSpatialPolygonEditor({
    itemsRef: o.zonesRef,
    itemName: "zona",
    space: {
      toNorm(event: PointerLike) {
        const geometry = contentRect();
        if (!geometry) return null;
        const nx = (event.clientX - geometry.rect.left - geometry.content.x) / geometry.content.w;
        const ny = (event.clientY - geometry.rect.top - geometry.content.y) / geometry.content.h;
        return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { x: nx, y: ny };
      },
      distPx(event: PointerLike, point: ZonePoint) {
        const geometry = contentRect();
        if (!geometry) return Infinity;
        return Math.hypot(
          geometry.rect.left + geometry.content.x + point.x * geometry.content.w - event.clientX,
          geometry.rect.top + geometry.content.y + point.y * geometry.content.h - event.clientY,
        );
      },
      contentSize() {
        const geometry = contentRect();
        return geometry ? { w: geometry.content.w, h: geometry.content.h } : null;
      },
    },
    onStart: o.onStart,
    onCreate: o.onCreate,
    onLive: o.onLive,
    onPatch: o.onPatch,
    onAlert: o.onAlert,
  });
}
