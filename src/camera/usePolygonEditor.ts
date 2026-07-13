// Editor de ZONA POLIGONAL do palco (spec zonas-poligonais F2 — P1/P7): clique adiciona
// vértice; FECHA clicando no 1º vértice, no botão Concluir (ZonasTab) ou Enter; ESC cancela;
// "voltar" remove o último vértice. Pós-criação: ARRASTE de vértices com alvo generoso (CA-7).
// Pointer events (mouse+touch unificados) — nenhuma função exclusiva de clique-direito (P7).
// Extraído do CameraWorkspace (ratchet anti-reengorda): aqui vivem o estado do rascunho/arraste
// e as validações interativas (CA-2); o CW só delega onDown/onMove/onUp e fornece criação/patch.
import { useEffect, useRef, useState, type RefObject } from "react";
import { type FrameSource } from "../frame";
import { getContentRect, type PolygonDraft } from "./draw";
import {
  isSimplePolygon,
  polygonBBox,
  POLYGON_MAX_POINTS,
  POLYGON_MIN_POINTS,
  zonePolygon,
  type Zone,
  type ZonePoint,
} from "../zones";

// Alvo de toque GENEROSO (px do viewport): raio p/ fechar no 1º vértice e p/ agarrar um vértice
// no arraste (P7: operador pode usar tablet — o alvo visual de 4px seria hostil ao dedo).
const HIT_RADIUS_PX = 14;

type PointerLike = { clientX: number; clientY: number };
type ZonePatch = { points: ZonePoint[]; x: number; y: number; w: number; h: number };

type Opts = {
  viewportRef: RefObject<HTMLDivElement | null>;
  /** fonte da GEOMETRIA do palco (WebRTC × MJPEG) — o mesmo currentFrame do editor de zonas */
  currentFrame: () => FrameSource | null;
  zonesRef: RefObject<Zone[]>;
  /** desliga os demais editores (retângulo/linha/pintura) ao entrar no modo polígono */
  onStart: () => void;
  onCreate: (points: ZonePoint[]) => void;
  /** arraste AO VIVO (estado local, sem persistir; o commit é onPatch no pointer-up) */
  onLive: (id: string, patch: ZonePatch) => void;
  onPatch: (id: string, patch: ZonePatch) => void;
  onAlert: (msg: string) => void;
};

export function usePolygonEditor(o: Opts) {
  const [active, setActive] = useState(false); // rascunho aberto (governa UI/cursor)
  const [count, setCount] = useState(0); // nº de vértices (habilita Concluir na UI)
  const draftRef = useRef<PolygonDraft | null>(null); // lido pelo rAF (drawPolygonDraft)
  const dragRef = useRef<{ id: string; index: number; pts: ZonePoint[]; orig: ZonePoint[] } | null>(
    null,
  );

  const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  // pointer → coords NORMALIZADAS do frame (mesmo letterbox do palco); null fora/sem frame.
  function toNorm(e: PointerLike): ZonePoint | null {
    const f = o.currentFrame();
    const vp = o.viewportRef.current;
    if (!f || !vp) return null;
    const r = vp.getBoundingClientRect();
    const cr = getContentRect(vp.clientWidth, vp.clientHeight, f.w, f.h);
    const nx = (e.clientX - r.left - cr.x) / cr.w;
    const ny = (e.clientY - r.top - cr.y) / cr.h;
    return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { x: nx, y: ny };
  }
  // distância em PX DO VIEWPORT entre o pointer e um ponto normalizado (alvo estável no zoom).
  function distPx(e: PointerLike, p: ZonePoint): number {
    const f = o.currentFrame();
    const vp = o.viewportRef.current;
    if (!f || !vp) return Infinity;
    const r = vp.getBoundingClientRect();
    const cr = getContentRect(vp.clientWidth, vp.clientHeight, f.w, f.h);
    return Math.hypot(r.left + cr.x + p.x * cr.w - e.clientX, r.top + cr.y + p.y * cr.h - e.clientY);
  }

  function start() {
    o.onStart();
    draftRef.current = { points: [], cursor: null };
    dragRef.current = null;
    setActive(true);
    setCount(0);
  }
  function cancel() {
    draftRef.current = null;
    dragRef.current = null;
    setActive(false);
    setCount(0);
  }
  function undo() {
    const d = draftRef.current;
    if (!d) return;
    d.points.pop();
    setCount(d.points.length);
  }
  function close() {
    const d = draftRef.current;
    if (!d || d.points.length < POLYGON_MIN_POINTS) return; // CA-2: não fecha com <3
    if (!isSimplePolygon(d.points)) {
      o.onAlert("Polígono inválido: as arestas se cruzam — ajuste os vértices (Voltar)."); // CA-2
      return; // rascunho preservado p/ correção
    }
    o.onCreate(d.points.slice());
    cancel();
  }

  // ── handlers do palco — devolvem true quando CONSUMIRAM o evento ──
  function onDown(e: PointerLike): boolean {
    const d = draftRef.current;
    if (d) {
      const p = toNorm(e);
      if (!p) return true; // clique fora do vídeo: ignora (rascunho segue vivo)
      if (d.points.length >= POLYGON_MIN_POINTS && distPx(e, d.points[0]) <= HIT_RADIUS_PX) {
        close(); // P1: fecha clicando no 1º vértice
        return true;
      }
      if (d.points.length >= POLYGON_MAX_POINTS) {
        o.onAlert(`Máximo de ${POLYGON_MAX_POINTS} vértices por zona (feche ou use Voltar).`); // CA-2
        return true;
      }
      d.points.push({ x: clamp01(p.x), y: clamp01(p.y) });
      d.cursor = p;
      setCount(d.points.length);
      return true;
    }
    // Sem rascunho: agarrar um VÉRTICE de zona poligonal existente (CA-7) — só quando nenhum
    // outro editor está ativo (o CW nos chama por último, depois de pintura/linha/retângulo).
    for (const z of o.zonesRef.current ?? []) {
      const pts = zonePolygon(z);
      if (!pts) continue;
      for (let i = 0; i < pts.length; i++)
        if (distPx(e, pts[i]) <= HIT_RADIUS_PX) {
          dragRef.current = { id: z.id, index: i, pts: pts.map((p) => ({ ...p })), orig: pts };
          return true;
        }
    }
    return false;
  }
  function onMove(e: PointerLike): boolean {
    const d = draftRef.current;
    if (d) {
      d.cursor = toNorm(e); // pré-visualização tracejada até o cursor
      return true;
    }
    const g = dragRef.current;
    if (!g) return false;
    const p = toNorm(e);
    if (p) {
      g.pts[g.index] = { x: clamp01(p.x), y: clamp01(p.y) };
      o.onLive(g.id, { points: g.pts, ...polygonBBox(g.pts) }); // bbox re-derivada junto (CA-7)
    }
    return true;
  }
  function onUp(): boolean {
    const g = dragRef.current;
    if (!g) return false;
    dragRef.current = null;
    if (isSimplePolygon(g.pts)) {
      o.onPatch(g.id, { points: g.pts, ...polygonBBox(g.pts) }); // persiste (CA-7)
    } else {
      o.onLive(g.id, { points: g.orig, ...polygonBBox(g.orig) }); // reverte: arraste cruzou arestas
      o.onAlert("Arraste desfeito: as arestas se cruzariam (CA-2).");
    }
    return true;
  }

  // Teclado do rascunho: Enter conclui, ESC cancela. CAPTURE no document p/ correr ANTES do
  // trap de foco da casca (useFocusTrap ignora ESC já consumido — checa e.defaultPrevented).
  const keysRef = useRef({ close, cancel });
  keysRef.current = { close, cancel };
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        keysRef.current.cancel(); // CA-2: ESC descarta o rascunho (a câmera fica aberta)
      } else if (e.key === "Enter") {
        e.preventDefault();
        keysRef.current.close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active]);

  return { active, count, draftRef, start, cancel, undo, close, onDown, onMove, onUp };
}
