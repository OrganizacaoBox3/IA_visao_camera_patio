// ── EDITOR DA ZONA do palco: a zona É um polígono (spec-zona-unificada F3/F5 · área-um-botão) ───
// Antes eram TRÊS primitivas (retângulo · pincel · polígono) e a mais usada — o retângulo — não
// tinha edição NENHUMA: nascia por arraste e morria no X. Aqui só existe UMA: `points`.
//   • UM só ponto de entrada (`startArea`): arma o modo ÁREA. Com o rascunho VAZIO (count===0) o
//     PRIMEIRO gesto decide a forma (o dono: "são duas portas para a MESMA tarefa"):
//       – ARRASTE (deslocamento ≥ DRAG_THRESHOLD_PX) → RETÂNGULO de 4 vértices (o caso comum,
//         mesas — a MESMA gestualidade de sempre, "the default rectangle can be changed to a polygon");
//       – CLIQUE (pointerup sem passar o limiar) → 1º vértice de um POLÍGONO ponto a ponto; os
//         cliques seguintes adicionam vértices; fecha no 1º vértice, em Concluir ou com Enter.
//     Com o rascunho JÁ iniciado como polígono (count>0) é SEMPRE polígono: arraste não vira mais
//     retângulo (a forma já se comprometeu). O que NASCE daqui — retângulo ou polígono — é EDITÁVEL.
//   • EDIÇÃO (o pedido do dono, "quero poder EDITAR OS PONTOS depois") — modelo de MAPAS
//     (Mapbox GL Draw / Leaflet-Geoman), não de VMS (o Frigate nem implementa inserção):
//       – clicar a zona SELECIONA; arrastar o INTERIOR move a forma inteira (translação);
//       – arrastar um VÉRTICE move (já existia);
//       – arrastar/clicar um MIDPOINT (o ponto claro no meio da aresta) INSERE um vértice ali;
//       – Delete/Backspace com o vértice selecionado — ou Alt+clique nele — REMOVE.
//     NUNCA por clique-direito (P7: o operador usa TABLET). Alvo de toque generoso (HIT_RADIUS_PX).
// Auto-interseção: bloqueada na COLOCAÇÃO (Geoman) — a aresta fica VERMELHA no palco antes de
// soltar (draw.ts) e o commit reverte. Avisar é mais barato que desfazer.
//
// O rAF lê REFS, nunca estado (draftRef/overlayRef) — estado no rAF é o bug clássico deste arquivo.
import { useEffect, useRef, useState, type RefObject } from "react";
import { type FrameSource } from "../frame";
import { getContentRect, type EditorOverlay, type PolygonDraft } from "./draw";
import {
  isSimplePolygon,
  polygonBBox,
  polygonContainsFn,
  POLYGON_MAX_POINTS,
  POLYGON_MIN_POINTS,
  zonePolygon,
  type Zone,
  type ZonePoint,
} from "../zones";

// Alvo de toque GENEROSO (px do viewport): raio p/ fechar no 1º vértice, p/ agarrar um vértice e
// p/ pegar um midpoint (P7: operador pode usar tablet — o alvo visual de 4px seria hostil ao dedo).
const HIT_RADIUS_PX = 14;
// Piso do RETÂNGULO: um arraste que resulte em zona menor que isto não vira zona (o piso de sempre).
const MIN_RECT_PX = 16;
// Limiar do GESTO (px do container): o 1º gesto do modo Área decide a forma. Abaixo dele o pointerup
// é um CLIQUE (→ 1º vértice do polígono); ao cruzá-lo durante o arraste, compromete-se com o
// RETÂNGULO (o preview passa a desenhar). ~5px: o wobble do dedo/mouse não conta como arraste.
const DRAG_THRESHOLD_PX = 5;

type PointerLike = { clientX: number; clientY: number; altKey?: boolean };
type ZonePatch = { points: ZonePoint[]; x: number; y: number; w: number; h: number };

/** Seleção corrente. `n` (nº de vértices) vem de quem MEXEU nos pontos — não de zonesRef, que só
 *  atualiza no efeito seguinte ao setState (a dica textual ficaria 1 render atrás do dado).
 *  (O que o rAF DESENHA — rascunho, preset e seleção — mora em ./draw: PolygonDraft/EditorOverlay.) */
export type Selection = { id: string; index: number | null; n: number };

// `dirty` = a geometria JÁ difere da persistida. Sem ele, SELECIONAR uma zona (clicar e soltar, sem
// mover nada) dispararia um onPatch → um PUT no backend com pontos IDÊNTICOS. Nasce true só na
// INSERÇÃO por midpoint (aí o vértice já entrou no down). Bug pré-existente do arraste de vértice
// (agarrar e soltar já persistia) — pego pelo teste do editor novo.
type Drag = { id: string; pts: ZonePoint[]; orig: ZonePoint[]; dirty: boolean } & (
  | { kind: "vertex"; index: number }
  | { kind: "shape"; from: ZonePoint }
);

type Opts = {
  viewportRef: RefObject<HTMLDivElement | null>;
  /** fonte da GEOMETRIA do palco (WebRTC × MJPEG) — o mesmo currentFrame do editor de zonas */
  currentFrame: () => FrameSource | null;
  zonesRef: RefObject<Zone[]>;
  /** desliga os demais editores (linha/calibração) ao entrar num modo de zona */
  onStart: () => void;
  onCreate: (points: ZonePoint[]) => void;
  /** arraste AO VIVO (estado local, sem persistir; o commit é onPatch no pointer-up) */
  onLive: (id: string, patch: ZonePatch) => void;
  onPatch: (id: string, patch: ZonePatch) => void;
  onAlert: (msg: string) => void;
};

export function usePolygonEditor(o: Opts) {
  const [active, setActiveState] = useState(false); // modo ÁREA armado (governa UI/cursor/toggle)
  const [count, setCount] = useState(0); // nº de vértices do rascunho polígono (0 = retângulo/indeciso)
  const [sel, setSelState] = useState<Selection | null>(null); // seleção (teclado + dica textual)
  const draftRef = useRef<PolygonDraft | null>(null); // rascunho POLÍGONO (null até o clique decidir); rAF
  const overlayRef = useRef<EditorOverlay>({ rect: null, editId: null, selected: null }); // idem
  const dragRef = useRef<Drag | null>(null);
  // 1º gesto do modo Área ainda INDECISO: o ponto de início (normalizado). onMove decide arraste
  // (→ rect) vs clique (→ 1º vértice no onUp). Ref, não estado: o rAF/handlers leem sem re-render.
  const pendingRef = useRef<ZonePoint | null>(null);
  const activeRef = useRef(false); // espelho do modo p/ os handlers (sem depender do closure)
  const selRef = useRef<Selection | null>(null);

  // Setter ÚNICO da SELEÇÃO (idioma da casa): ref (handlers) + overlay (rAF) + estado (UI/teclado)
  // mudam numa só unidade — nenhum caminho escreve um sem o outro.
  function select(s: Selection | null) {
    selRef.current = s;
    overlayRef.current.editId = s?.id ?? null;
    overlayRef.current.selected = s?.index ?? null;
    setSelState(s);
  }
  function setActive(v: boolean) {
    activeRef.current = v;
    setActiveState(v);
  }

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
    return Math.hypot(
      r.left + cr.x + p.x * cr.w - e.clientX,
      r.top + cr.y + p.y * cr.h - e.clientY,
    );
  }
  /** tamanho do retângulo de conteúdo em PX (piso do preset retângulo); null sem frame/palco. */
  function contentSize(): { w: number; h: number } | null {
    const f = o.currentFrame();
    const vp = o.viewportRef.current;
    if (!f || !vp) return null;
    const cr = getContentRect(vp.clientWidth, vp.clientHeight, f.w, f.h);
    return { w: cr.w, h: cr.h };
  }
  const midpoint = (a: ZonePoint, b: ZonePoint): ZonePoint => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });

  // ── modos ──
  function startArea() {
    // Arma o modo ÁREA com o rascunho VAZIO: o 1º gesto (arraste × clique) é que decide a forma.
    o.onStart();
    draftRef.current = null; // ainda não é polígono (só vira no 1º CLIQUE)
    dragRef.current = null;
    overlayRef.current.rect = null; // nem retângulo (só vira ao cruzar o limiar de ARRASTE)
    pendingRef.current = null;
    select(null);
    setActive(true);
    setCount(0);
  }
  function cancel() {
    draftRef.current = null;
    dragRef.current = null;
    overlayRef.current.rect = null;
    pendingRef.current = null;
    select(null);
    setActive(false);
    setCount(0);
  }
  /** limpa só a SELEÇÃO (o modo segue); usado pelo ESC e ao remover a zona no painel. */
  function deselect() {
    if (selRef.current) select(null);
  }
  function undo() {
    const d = draftRef.current;
    if (!d) return;
    d.points.pop();
    // Esvaziou o rascunho: volta ao INDECISO (o 1º gesto decide de novo — arraste × clique).
    if (d.points.length === 0) draftRef.current = null;
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

  // ── edição de vértice (mouse E teclado — P7: nada exclusivo de clique-direito) ──
  /** REMOVE o vértice `i` de `pts`: barra o mínimo de 3 e a auto-interseção (a remoção PODE cruzar). */
  function removeVertex(id: string, pts: ZonePoint[], i: number) {
    if (pts.length <= POLYGON_MIN_POINTS) {
      o.onAlert(`Mínimo de ${POLYGON_MIN_POINTS} vértices por zona — remova a zona inteira.`);
      return;
    }
    const next = pts.filter((_, k) => k !== i);
    if (!isSimplePolygon(next)) {
      o.onAlert("Remoção desfeita: sem esse vértice as arestas se cruzariam.");
      return;
    }
    o.onPatch(id, { points: next, ...polygonBBox(next) });
    select({ id, index: null, n: next.length });
  }
  /** Delete/Backspace: remove o vértice SELECIONADO (o mesmo caminho do Alt+clique). */
  function removeSelected() {
    const s = selRef.current;
    if (!s || s.index === null) return;
    const z = o.zonesRef.current?.find((zz) => zz.id === s.id);
    const pts = z ? zonePolygon(z) : null;
    if (!pts || s.index >= pts.length) return;
    removeVertex(s.id, pts, s.index);
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
    if (activeRef.current) {
      // Modo ÁREA armado e rascunho VAZIO (draftRef null ⇒ o clique ainda não decidiu polígono):
      // registra o início; o GESTO decide no onMove/onUp (arraste→rect · clique→1º vértice).
      const p = toNorm(e);
      if (!p) return true; // fora do vídeo: consome, o modo segue armado (o dedo escorrega na borda)
      pendingRef.current = p;
      return true;
    }
    const zones = o.zonesRef.current ?? [];
    // 1) VÉRTICE de qualquer zona (é o que está DESENHADO — alvo visível = alvo clicável).
    //    Alt+clique REMOVE (Mapbox/CVAT); clique normal agarra p/ arrastar.
    for (const z of zones) {
      const pts = zonePolygon(z);
      if (!pts) continue;
      for (let i = 0; i < pts.length; i++)
        if (distPx(e, pts[i]) <= HIT_RADIUS_PX) {
          if (e.altKey) {
            removeVertex(z.id, pts, i);
            return true;
          }
          select({ id: z.id, index: i, n: pts.length });
          dragRef.current = {
            kind: "vertex",
            id: z.id,
            index: i,
            pts: pts.map((p) => ({ ...p })),
            orig: pts,
            dirty: false, // agarrar e soltar sem mover NÃO persiste (não há o que salvar)
          };
          return true;
        }
    }
    // 2) MIDPOINT — só da zona SELECIONADA (é a única cujos midpoints estão VISÍVEIS): insere um
    //    vértice ali e já sai arrastando (o padrão dominante: Mapbox/Geoman/Leaflet).
    const s = selRef.current;
    const selZone = s ? zones.find((z) => z.id === s.id) : undefined;
    const selPts = selZone ? zonePolygon(selZone) : null;
    if (s && selPts)
      for (let i = 0; i < selPts.length; i++) {
        const m = midpoint(selPts[i], selPts[(i + 1) % selPts.length]);
        if (distPx(e, m) > HIT_RADIUS_PX) continue;
        if (selPts.length >= POLYGON_MAX_POINTS) {
          o.onAlert(`Máximo de ${POLYGON_MAX_POINTS} vértices por zona.`);
          return true;
        }
        const next = selPts.slice(0, i + 1).concat([m], selPts.slice(i + 1));
        select({ id: s.id, index: i + 1, n: next.length });
        // dirty JÁ nasce true: o vértice ENTROU no down — clicar o midpoint e soltar sem arrastar
        // é uma inserção legítima (e tem de persistir).
        dragRef.current = {
          kind: "vertex",
          id: s.id,
          index: i + 1,
          pts: next,
          orig: selPts,
          dirty: true,
        };
        o.onLive(s.id, { points: next, ...polygonBBox(next) }); // o vértice novo aparece já
        return true;
      }
    // 3) INTERIOR de um polígono: seleciona e MOVE a forma inteira (o `simple_select` do Mapbox —
    //    hoje, mover uma zona 2 m para a esquerda exigia REDESENHAR). Sobreposição: vence a de
    //    MENOR área (a mais específica — o mesmo desempate do assignZone).
    const p = toNorm(e);
    if (p) {
      let hit: { z: Zone; pts: ZonePoint[]; area: number } | null = null;
      for (const z of zones) {
        const pts = zonePolygon(z);
        if (!pts || !polygonContainsFn(pts)(p.x, p.y)) continue;
        const bb = polygonBBox(pts);
        const area = bb.w * bb.h;
        if (!hit || area < hit.area) hit = { z, pts, area };
      }
      if (hit) {
        select({ id: hit.z.id, index: null, n: hit.pts.length });
        dragRef.current = {
          kind: "shape",
          id: hit.z.id,
          pts: hit.pts.map((q) => ({ ...q })),
          orig: hit.pts,
          from: p,
          dirty: false, // SELECIONAR (clicar e soltar) não pode virar um PUT de geometria idêntica
        };
        return true;
      }
    }
    deselect(); // clique no vazio: larga a seleção (e NÃO consome o evento)
    return false;
  }

  function onMove(e: PointerLike): boolean {
    const d = draftRef.current;
    if (d) {
      d.cursor = toNorm(e); // pré-visualização tracejada até o cursor
      return true;
    }
    const pend = pendingRef.current;
    if (pend) {
      // 1º gesto INDECISO: cruzou o limiar de arraste? → compromete-se com o RETÂNGULO (o preview
      // passa a desenhar). Até lá nada é desenhado (a decisão do gesto é o que a spec pede).
      if (distPx(e, pend) >= DRAG_THRESHOLD_PX) {
        const p = toNorm(e);
        overlayRef.current.rect = { a: pend, b: p ?? pend };
        pendingRef.current = null;
      }
      return true;
    }
    const r = overlayRef.current.rect;
    if (r) {
      const p = toNorm(e);
      if (p) r.b = p; // fora do vídeo: mantém o último canto válido (nunca "escapa" o retângulo)
      return true;
    }
    const g = dragRef.current;
    if (!g) return false;
    const p = toNorm(e);
    if (!p) return true;
    if (g.kind === "vertex") {
      const v = { x: clamp01(p.x), y: clamp01(p.y) };
      const cur = g.pts[g.index];
      if (cur.x === v.x && cur.y === v.y) return true; // não mexeu: nada a redesenhar/persistir
      g.pts[g.index] = v;
    } else {
      // TRANSLAÇÃO: o clamp é da FORMA (bbox), não de cada ponto — clampar ponto a ponto
      // DEFORMARIA o polígono ao encostar na borda. Translação preserva a simplicidade.
      const bb = polygonBBox(g.orig);
      const dx = Math.min(Math.max(p.x - g.from.x, -bb.x), 1 - (bb.x + bb.w));
      const dy = Math.min(Math.max(p.y - g.from.y, -bb.y), 1 - (bb.y + bb.h));
      if (dx === 0 && dy === 0) return true; // idem: clique parado no interior é SELEÇÃO, não move
      for (let i = 0; i < g.orig.length; i++)
        g.pts[i] = { x: g.orig[i].x + dx, y: g.orig[i].y + dy };
    }
    g.dirty = true;
    o.onLive(g.id, { points: g.pts, ...polygonBBox(g.pts) }); // bbox re-derivada junto (CA-7)
    return true;
  }

  function onUp(): boolean {
    const r = overlayRef.current.rect;
    if (r) {
      overlayRef.current.rect = null;
      const cs = contentSize();
      if (!cs) return true;
      const w = Math.abs(r.b.x - r.a.x) * cs.w,
        h = Math.abs(r.b.y - r.a.y) * cs.h;
      if (w < MIN_RECT_PX || h < MIN_RECT_PX) return true; // clique sem arraste: não vira zona
      // O PRESET: 4 vértices no sentido horário — daqui em diante é polígono como qualquer outro.
      const x0 = Math.min(r.a.x, r.b.x),
        y0 = Math.min(r.a.y, r.b.y),
        x1 = Math.max(r.a.x, r.b.x),
        y1 = Math.max(r.a.y, r.b.y);
      o.onCreate([
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
      ]);
      return true; // o modo Área SEGUE armado (arraste = nova zona) — sair é desligar o toggle
    }
    const pend = pendingRef.current;
    if (pend) {
      // CLIQUE sem arraste (não cruzou o limiar): vira o 1º VÉRTICE de um polígono ponto a ponto.
      // Daqui em diante draftRef guia o onDown (cliques adicionam vértice; arraste NÃO vira rect).
      pendingRef.current = null;
      draftRef.current = { points: [{ x: clamp01(pend.x), y: clamp01(pend.y) }], cursor: pend };
      setCount(1);
      return true;
    }
    const g = dragRef.current;
    if (!g) return false;
    dragRef.current = null;
    if (!g.dirty) return true; // só SELECIONOU (ou agarrou e soltou): não há geometria nova p/ salvar
    if (isSimplePolygon(g.pts)) {
      o.onPatch(g.id, { points: g.pts, ...polygonBBox(g.pts) }); // persiste (CA-7)
    } else {
      o.onLive(g.id, { points: g.orig, ...polygonBBox(g.orig) }); // reverte: arraste cruzou arestas
      o.onAlert("Arraste desfeito: as arestas se cruzariam (CA-2).");
      if (selRef.current) select({ ...selRef.current, n: g.orig.length });
    }
    return true;
  }

  // Teclado: Enter conclui o rascunho, ESC cancela, Delete/Backspace remove o vértice selecionado.
  // CAPTURE no document p/ correr ANTES do trap de foco da casca (useFocusTrap ignora ESC já
  // consumido — checa e.defaultPrevented). ⚠ ESC é CONSUMIDO com o modo ÁREA armado (rascunho aberto
  // OU só o toggle ligado, ainda indeciso): ESC SAI do modo e a câmera fica aberta — como o Calibrar.
  // Com apenas uma SELEÇÃO (sem modo armado) ele a limpa e SEGUE (a casca fecha a câmera, ADR-007).
  const keysRef = useRef({ close, cancel, deselect, removeSelected });
  keysRef.current = { close, cancel, deselect, removeSelected };
  const keysOn = active || !!sel;
  useEffect(() => {
    if (!keysOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Um layer MODAL do Radix (Select/Menu aberto, ou o Dialog de config `.ui-dialog`) tem
        // precedência no ESC: o Radix dismissa no CAPTURE do document e ABORTA se o evento já veio
        // com preventDefault (o mesmo mecanismo do trap da casca). Se o poly consumisse aqui, o
        // Dialog/Select NÃO fecharia. Então, com um layer aberto, o poly NÃO toca o ESC — só larga a
        // seleção (sem preventDefault) e deixa o evento seguir. (Mesmo seletor do Dialog.tsx.)
        if (document.querySelector('.ui-dialog, [role="listbox"], [role="menu"]')) {
          keysRef.current.deselect();
          return;
        }
        if (draftRef.current || activeRef.current) {
          e.preventDefault();
          keysRef.current.cancel(); // CA-2: ESC descarta o rascunho / sai do modo Área (câmera aberta)
        } else keysRef.current.deselect();
        return;
      }
      if (e.key === "Enter") {
        if (!draftRef.current) return;
        e.preventDefault();
        keysRef.current.close();
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // O listener é do DOCUMENT em capture: sem esta guarda, apagar um caractere no campo de um
      // diálogo (config da zona) removeria um VÉRTICE e engoliria a tecla.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (draftRef.current || !selRef.current || selRef.current.index === null) return;
      e.preventDefault();
      keysRef.current.removeSelected();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [keysOn]);

  // DICA da barra (nunca só-por-cor: a interação é ENSINADA em texto — nenhum VMS do mercado o faz).
  // Modo Área ARMADO e ainda VAZIO: ensina o gesto que decide a forma (going-gray: texto, não ícone).
  // Do contrário, o nº de vértices vem da SELEÇÃO (fresco por construção), não de zonesRef (1 atrás).
  const hint =
    active && count === 0
      ? "Arraste um retângulo, ou clique para desenhar ponto a ponto."
      : sel === null
        ? null
        : sel.index !== null
          ? `Vértice ${sel.index + 1} de ${sel.n} — arraste para mover · Delete (ou Alt+clique) remove`
          : `Zona selecionada · ${sel.n} vértices — arraste dentro para mover · o ponto claro na aresta insere um vértice`;

  return {
    active,
    count,
    hint,
    draftRef,
    overlayRef,
    startArea,
    cancel,
    deselect,
    undo,
    close,
    onDown,
    onMove,
    onUp,
  };
}
