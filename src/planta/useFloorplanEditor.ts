// useFloorplanEditor — o DONO do gesto de edição da Planta BLE: arrastar as antenas no mapa
// top-down, colocar/remover, e digitar a coordenada na tabela. É o MOLDE do useCalibrationEditor /
// usePolygonEditor trazido para o chão em METROS: o hook é dono do estado de posição, os handlers
// de ponteiro convertem o cursor de volta ao mundo (transform.unproject) e mexem no conjunto; a
// camada SVG (FloorplanEditLayer) só MOSTRA. Uma responsabilidade: o CONJUNTO de antenas posicionadas.
//
// POR QUE em metros e não em 0..1 normalizado (a diferença para a calibração): lá o chão é o
// letterbox do vídeo (toNorm → fração da imagem); AQUI o "palco" é a própria planta em metros, então
// o análogo do toNorm é `transform.unproject` (px do canvas → metros) e o clamp é à CAIXA do galpão
// [0,widthM]×[0,heightM], não a 0..1. Sem polígono, sem teste de auto-interseção — antena é PONTO.
//
// COMMIT ao SOLTAR (como o polígono no onPatch): arrastar persiste no onUp; colocar/remover/digitar
// persistem na hora. O onCommit recebe o Record<id,Vec2> INTEIRO (a planta salva é o conjunto todo).
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Vec2 } from "../api";
import type { TopdownTransform } from "../fusion/topdown";
import type { FloorplanSetupRow } from "./useFloorplanMap";

type PointerLike = { clientX: number; clientY: number };

/** raio de acerto em PX DO VIEWPORT p/ "pegar" uma antena marcada — o mesmo alvo de dedo do editor
 *  de polígono (HIT_RADIUS_PX≈14; P7: o operador usa TABLET). */
export const HIT_RADIUS_PX = 14;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Grampeia um ponto (metros) à CAIXA do galpão [0,widthM]×[0,heightM]. Dimensão ≤ 0 → eixo colado
 *  no zero (galpão ainda sem medida não deixa a antena escapar para coordenada negativa). */
export function clampToBox(p: Vec2, widthM: number, heightM: number): Vec2 {
  return {
    x: clamp(p.x, 0, widthM > 0 ? widthM : 0),
    y: clamp(p.y, 0, heightM > 0 ? heightM : 0),
  };
}

/** COLOCAR/MOVER a antena `id` em `at` — transição PURA do conjunto (espelha placeStationPoint de
 *  camera/station-points.ts, mas aqui é Record<id,Vec2> em metros, sem o conceito de "principal"). */
export function placeStationAt(
  pos: Record<string, Vec2>,
  id: string,
  at: Vec2,
): Record<string, Vec2> {
  return { ...pos, [id]: at };
}

/** REMOVER a antena `id` do conjunto — transição PURA (espelha removeStationPoint). */
export function removeStationAt(pos: Record<string, Vec2>, id: string): Record<string, Vec2> {
  if (!(id in pos)) return pos;
  const next = { ...pos };
  delete next[id];
  return next;
}

/** Antena posicionada MAIS PRÓXIMA do ponteiro, dentro de `radiusPx` px de VIEWPORT (alvo estável no
 *  zoom, como o distPx do usePolygonEditor). Compara projetando cada posição de volta ao canvas. */
export function hitStation(
  pos: Record<string, Vec2>,
  pointerPx: Vec2,
  project: (w: Vec2) => Vec2,
  radiusPx: number,
): string | null {
  let best: string | null = null;
  let bestD = radiusPx;
  for (const [id, p] of Object.entries(pos)) {
    const c = project(p);
    const d = Math.hypot(c.x - pointerPx.x, c.y - pointerPx.y);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best;
}

type Args = {
  widthM: number;
  heightM: number;
  /** Toda antena conhecida (posicionada ou não) — a fonte das posições SALVAS e dos rótulos. */
  rows: FloorplanSetupRow[];
  /** O transform ATUAL do canvas (com project+unproject); null até o primeiro layout. */
  transform: TopdownTransform | null;
  /** O contêiner do canvas (o mesmo que a SVG cobre) — dá o rect para converter o ponteiro. */
  containerRef: RefObject<HTMLElement | null>;
  /** Persiste o conjunto INTEIRO de posições (a página liga ao save da planta). */
  onCommit: (stations: Record<string, Vec2>) => void;
};

export type FloorplanEditor = {
  /** Posições EM EDIÇÃO (metros) por id — a fonte da verdade enquanto se edita. */
  pos: Record<string, Vec2>;
  /** Antena sob o cursor (cresce no realce); null se nenhuma. */
  hoverId: string | null;
  /** Antena sendo arrastada agora; null fora do arraste. */
  draggingId: string | null;
  onDown: (e: PointerLike & { pointerId?: number; currentTarget?: Element }) => void;
  onMove: (e: PointerLike) => void;
  onUp: (e?: { pointerId?: number; currentTarget?: Element }) => void;
  /** Coloca uma antena não-posicionada (no centro do galpão, ou num ponto dado) + commit. */
  place: (id: string, at?: Vec2) => void;
  /** Tira a antena do mapa + commit. */
  remove: (id: string) => void;
  /** Da tabela: fixa X,Y (metros, já com clamp à caixa) + commit. */
  setCoord: (id: string, x: number, y: number) => void;
};

export function useFloorplanEditor(args: Args): FloorplanEditor {
  const { widthM, heightM, rows, transform, containerRef, onCommit } = args;
  const [pos, setPos] = useState<Record<string, Vec2>>({});
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

  // Espelhos ESTÁVEIS dos getters recriados a cada render (idioma frameRef da calibração): mantêm os
  // handlers de ponteiro livres de fechar sobre valores velhos sem re-armar nada.
  const tfRef = useRef(transform);
  tfRef.current = transform;
  const boxRef = useRef({ widthM, heightM });
  boxRef.current = { widthM, heightM };
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  // ── SEED das posições salvas → estado de edição. Re-semeia quando as posições SALVAS mudam por
  // fora (carga da planta, save concluído), NUNCA durante um arraste (senão o commit-de-volta
  // atropelaria o gesto em curso). Depois de um commit nosso, as `rows` voltam iguais ao `pos`, então
  // esta re-semeadura é no-op. A `savedSig` ignora `live` (muda a cada poll ~2 s e não é posição). ──
  const savedSig = useMemo(
    () =>
      JSON.stringify(
        rows
          .filter((r) => r.pos)
          .map((r) => [r.id, r.pos!.x, r.pos!.y]),
      ),
    [rows],
  );
  useEffect(() => {
    if (dragRef.current) return;
    const seeded: Record<string, Vec2> = {};
    for (const r of rows) if (r.pos) seeded[r.id] = { x: r.pos.x, y: r.pos.y };
    setPos(seeded);
    // savedSig resume as posições; rows entra só para ler os pontos na re-semeadura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSig]);

  /** Ponteiro (px de tela) → MUNDO (metros), grampeado à caixa. null sem transform/contêiner. */
  const pointerToWorld = useCallback((e: PointerLike): Vec2 | null => {
    const tf = tfRef.current;
    const el = containerRef.current;
    if (!tf || !el) return null;
    const r = el.getBoundingClientRect();
    const world = tf.unproject({ x: e.clientX - r.left, y: e.clientY - r.top });
    return clampToBox(world, boxRef.current.widthM, boxRef.current.heightM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Ponteiro (px de tela) → px RELATIVO ao contêiner (o espaço em que o transform projeta). */
  const pointerToCanvas = useCallback((e: PointerLike): Vec2 | null => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = useCallback((next: Record<string, Vec2>) => {
    commitRef.current(next);
  }, []);

  const onDown = useCallback(
    (e: PointerLike & { pointerId?: number; currentTarget?: Element }) => {
      const tf = tfRef.current;
      const canvasPt = pointerToCanvas(e);
      if (!tf || !canvasPt) return;
      // Pegou uma antena já posicionada? (hit-test em px de viewport). Sim → começa o arraste.
      const hit = hitStation(pos, canvasPt, tf.project, HIT_RADIUS_PX);
      if (hit) {
        dragRef.current = hit;
        setDraggingId(hit);
        // Captura o ponteiro no contêiner: o arraste segue mesmo se o cursor sair do canvas (mais
        // robusto que depender de o ponteiro ficar dentro — o análogo do gesto contínuo do palco).
        const el = e.currentTarget;
        if (el && "setPointerCapture" in el && e.pointerId != null) {
          try {
            (el as Element).setPointerCapture(e.pointerId);
          } catch {
            /* alguns ambientes não suportam — o arraste ainda funciona dentro do canvas */
          }
        }
      }
      // Clique no vazio NÃO cria antena (não há id novo a inventar): colocar é ação da tabela
      // (botão "colocar no mapa"), depois se arrasta. Fica só o hit-test.
    },
    [pos, pointerToCanvas],
  );

  const onMove = useCallback(
    (e: PointerLike) => {
      const id = dragRef.current;
      if (id) {
        const world = pointerToWorld(e);
        if (world) setPos((p) => placeStationAt(p, id, world));
        return;
      }
      // Sem arraste: feedback de "pegável" — a antena sob o cursor cresce.
      const tf = tfRef.current;
      const canvasPt = pointerToCanvas(e);
      setHoverId(tf && canvasPt ? hitStation(pos, canvasPt, tf.project, HIT_RADIUS_PX) : null);
    },
    [pos, pointerToWorld, pointerToCanvas],
  );

  const onUp = useCallback(
    (e?: { pointerId?: number; currentTarget?: Element }) => {
      const id = dragRef.current;
      dragRef.current = null;
      setDraggingId(null);
      if (e?.currentTarget && "releasePointerCapture" in e.currentTarget && e.pointerId != null) {
        try {
          (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        } catch {
          /* idem */
        }
      }
      // Persiste ao SOLTAR (como o polígono no onPatch). Lê o estado mais recente via updater.
      if (id)
        setPos((p) => {
          commit(p);
          return p;
        });
    },
    [commit],
  );

  const place = useCallback(
    (id: string, at?: Vec2) => {
      const box = boxRef.current;
      const target = clampToBox(
        at ?? { x: box.widthM / 2, y: box.heightM / 2 },
        box.widthM,
        box.heightM,
      );
      setPos((p) => {
        const next = placeStationAt(p, id, target);
        commit(next);
        return next;
      });
    },
    [commit],
  );

  const remove = useCallback(
    (id: string) => {
      setPos((p) => {
        const next = removeStationAt(p, id);
        commit(next);
        return next;
      });
    },
    [commit],
  );

  const setCoord = useCallback(
    (id: string, x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const box = boxRef.current;
      const at = clampToBox({ x, y }, box.widthM, box.heightM);
      setPos((p) => {
        const next = placeStationAt(p, id, at);
        commit(next);
        return next;
      });
    },
    [commit],
  );

  return { pos, hoverId, draggingId, onDown, onMove, onUp, place, remove, setCoord };
}
