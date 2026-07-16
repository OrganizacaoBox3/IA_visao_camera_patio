import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type RefObject,
} from "react";
import type { FloorplanWorkArea, Vec2 } from "../api";
import type { TopdownTransform } from "../fusion/topdown";
import {
  usePolygonEditor,
  type EditablePolygon,
  type PointerLike,
} from "../spatial/usePolygonEditor";

type SaveResult = { ok: boolean; error?: string };

function areaFromNormalized(
  id: string,
  label: string,
  points: readonly Vec2[],
  widthM: number,
  heightM: number,
): FloorplanWorkArea {
  const polygon = points.map((point) => ({ x: point.x * widthM, y: point.y * heightM }));
  const xs = polygon.map((point) => point.x);
  const ys = polygon.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    id,
    label,
    polygon,
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    widthM: maxX - minX,
    heightM: maxY - minY,
  };
}

export function nextWorkAreaId(areas: readonly FloorplanWorkArea[], now = Date.now()): string {
  const used = new Set(areas.map((area) => area.id));
  const base = `area-${Math.max(0, Math.trunc(now)).toString(36)}`.slice(0, 28);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function useWorkAreaPolygonEditor({
  widthM,
  heightM,
  areas,
  transform,
  containerRef,
  onSave,
}: {
  widthM: number;
  heightM: number;
  areas: readonly FloorplanWorkArea[];
  transform: TopdownTransform | null;
  containerRef: RefObject<HTMLDivElement | null>;
  onSave: (next: FloorplanWorkArea[]) => Promise<SaveResult>;
}) {
  const [localAreas, setLocalAreasState] = useState<FloorplanWorkArea[]>([...areas]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "alert"; text: string } | null>(null);
  const localRef = useRef(localAreas);
  const newLabelRef = useRef("");

  const setLocalAreas = useCallback((next: FloorplanWorkArea[]) => {
    localRef.current = next;
    setLocalAreasState(next);
  }, []);

  useEffect(() => setLocalAreas([...areas]), [areas, setLocalAreas]);

  const items = useMemo<EditablePolygon[]>(
    () =>
      localAreas.map((area) => ({
        id: area.id,
        points: area.polygon.map((point) => ({ x: point.x / widthM, y: point.y / heightM })),
      })),
    [heightM, localAreas, widthM],
  );
  const itemsRef = useRef<readonly EditablePolygon[]>(items);
  itemsRef.current = items;

  const persist = useCallback(
    async (next: FloorplanWorkArea[], successText: string) => {
      setSaving(true);
      setMessage(null);
      const result = await onSave(next).catch((): SaveResult => ({ ok: false }));
      if (!result.ok) {
        setLocalAreas([...areas]);
        setMessage({
          tone: "alert",
          text: result.error ?? "Não foi possível salvar as áreas de trabalho.",
        });
      } else {
        setMessage({ tone: "ok", text: successText });
      }
      setSaving(false);
      return result;
    },
    [areas, onSave, setLocalAreas],
  );

  const replaceGeometry = useCallback(
    (id: string, points: Vec2[]) => {
      const current = localRef.current.find((area) => area.id === id);
      if (!current) return localRef.current;
      return localRef.current.map((area) =>
        area.id === id ? areaFromNormalized(id, current.label, points, widthM, heightM) : area,
      );
    },
    [heightM, widthM],
  );

  const editor = usePolygonEditor({
    itemsRef,
    itemName: "área",
    keepCreating: false,
    space: {
      toNorm(event: PointerLike) {
        const container = containerRef.current;
        if (!container || !transform || !(widthM > 0) || !(heightM > 0)) return null;
        const rect = container.getBoundingClientRect();
        const world = transform.unproject({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
        const point = { x: world.x / widthM, y: world.y / heightM };
        return point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 ? null : point;
      },
      distPx(event: PointerLike, point: Vec2) {
        const container = containerRef.current;
        if (!container || !transform) return Infinity;
        const rect = container.getBoundingClientRect();
        const projected = transform.project({ x: point.x * widthM, y: point.y * heightM });
        return Math.hypot(
          rect.left + projected.x - event.clientX,
          rect.top + projected.y - event.clientY,
        );
      },
      contentSize() {
        if (!transform) return null;
        const start = transform.project({ x: 0, y: 0 });
        const end = transform.project({ x: widthM, y: heightM });
        return { w: Math.abs(end.x - start.x), h: Math.abs(end.y - start.y) };
      },
    },
    onStart: () => setMessage(null),
    onCreate(points) {
      const label = newLabelRef.current.trim();
      if (!label) {
        setMessage({ tone: "alert", text: "Informe o nome antes de desenhar a área." });
        return;
      }
      const next = [
        ...localRef.current,
        areaFromNormalized(nextWorkAreaId(localRef.current), label, points, widthM, heightM),
      ];
      setLocalAreas(next);
      void persist(next, "Área de trabalho salva.");
    },
    onLive(id, patch) {
      setLocalAreas(replaceGeometry(id, patch.points));
    },
    onPatch(id, patch) {
      const next = replaceGeometry(id, patch.points);
      setLocalAreas(next);
      void persist(next, "Geometria da área atualizada.");
    },
    onAlert(text) {
      setMessage({ tone: "alert", text });
    },
  });

  const start = useCallback(
    (label: string) => {
      if (!label.trim()) {
        setMessage({ tone: "alert", text: "Informe o nome antes de desenhar a área." });
        return false;
      }
      newLabelRef.current = label.trim();
      editor.startArea();
      return true;
    },
    [editor],
  );

  const remove = useCallback(
    async (id: string) => {
      editor.deselect();
      const next = localRef.current.filter((area) => area.id !== id);
      setLocalAreas(next);
      return persist(next, "Área de trabalho removida.");
    },
    [editor, persist, setLocalAreas],
  );

  const rename = useCallback(
    async (id: string, label: string) => {
      const clean = label.trim();
      if (!clean) {
        setMessage({ tone: "alert", text: "O nome da área não pode ficar vazio." });
        return { ok: false };
      }
      const next = localRef.current.map((area) =>
        area.id === id ? { ...area, label: clean } : area,
      );
      setLocalAreas(next);
      return persist(next, "Nome da área atualizado.");
    },
    [persist, setLocalAreas],
  );

  const pointerHandlers = {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (saving) return;
      if (!editor.onDown(event)) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      if (saving) return;
      if (editor.onMove(event)) event.preventDefault();
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      if (saving) return;
      if (editor.onUp()) event.preventDefault();
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
  };

  const polygonEditor = useMemo(
    () => ({ items, draftRef: editor.draftRef, overlayRef: editor.overlayRef }),
    [editor.draftRef, editor.overlayRef, items],
  );

  return {
    ...editor,
    areas: localAreas,
    saving,
    message,
    start,
    remove,
    rename,
    pointerHandlers,
    polygonEditor,
  };
}
