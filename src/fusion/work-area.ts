// Geometria independente de uma área de trabalho. Reconhecer uma zona não move a tag para ela.
import type { PositionPoint } from "./motion-filter";
import { pointInPolygon } from "./floor-polygon";

export type WorkArea = { id: string; label: string; polygon: PositionPoint[] };
export type RectWorkArea = {
  id: string;
  label: string;
  center: PositionPoint;
  widthM: number;
  heightM: number;
};
export type WorkAreaDistance = {
  inside: boolean;
  distanceM: number;
  nearestPoint: PositionPoint | null;
};
export type WorkAreaDistanceBand = WorkAreaDistance & {
  minDistanceM: number;
  maxDistanceM: number;
};

export function rectangleToWorkArea(rect: RectWorkArea): WorkArea {
  const halfW = rect.widthM / 2;
  const halfH = rect.heightM / 2;
  return {
    id: rect.id,
    label: rect.label,
    polygon: [
      { x: rect.center.x - halfW, y: rect.center.y - halfH },
      { x: rect.center.x + halfW, y: rect.center.y - halfH },
      { x: rect.center.x + halfW, y: rect.center.y + halfH },
      { x: rect.center.x - halfW, y: rect.center.y + halfH },
    ],
  };
}

function nearestOnSegment(point: PositionPoint, a: PositionPoint, b: PositionPoint): PositionPoint {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return a;
  const projection = ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2;
  const t = Math.max(0, Math.min(1, projection));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

export function isPointInsidePolygon(point: PositionPoint, polygon: PositionPoint[]): boolean {
  return pointInPolygon(point, polygon);
}

export function distanceToWorkArea(point: PositionPoint, area: WorkArea): WorkAreaDistance {
  if (area.polygon.length < 2) {
    return { inside: false, distanceM: Number.POSITIVE_INFINITY, nearestPoint: null };
  }
  if (isPointInsidePolygon(point, area.polygon)) {
    return { inside: true, distanceM: 0, nearestPoint: point };
  }
  let distanceM = Number.POSITIVE_INFINITY;
  let nearestPoint: PositionPoint | null = null;
  for (let i = 0; i < area.polygon.length; i += 1) {
    const candidate = nearestOnSegment(point, area.polygon[i], area.polygon[(i + 1) % area.polygon.length]);
    const candidateDistance = Math.hypot(point.x - candidate.x, point.y - candidate.y);
    if (candidateDistance < distanceM) {
      distanceM = candidateDistance;
      nearestPoint = candidate;
    }
  }
  return { inside: false, distanceM, nearestPoint };
}

/** Faixa conservadora causada pelo halo da posição; não altera ponto nem área. */
export function distanceBandToWorkArea(
  point: PositionPoint,
  uncertaintyM: number,
  area: WorkArea,
): WorkAreaDistanceBand {
  const measured = distanceToWorkArea(point, area);
  const radius = Number.isFinite(uncertaintyM) ? Math.max(0, uncertaintyM) : 0;
  return {
    ...measured,
    minDistanceM: Math.max(0, measured.distanceM - radius),
    maxDistanceM: measured.distanceM + radius,
  };
}
