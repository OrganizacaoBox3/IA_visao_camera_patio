// Editor de CALIBRAÇÃO do palco (spec-arquitetura-informacao §1) — o 5º MODO do CameraWorkspace,
// no MOLDE do usePolygonEditor: o hook é dono do estado, os handlers de ponteiro devolvem boolean
// ("consumi"), start/stop, e o CameraWorkspace só delega. ZERO regra nova — a matemática é a de
// sempre (vision/homography), o invariante dos pontos de estação é o de sempre (camera/
// station-points), a ocupação de tags é a de sempre (camera/takenTags), a guia de instalação é a
// de sempre (fusion/station-geometry). Isto aqui é MUDANÇA DE LUGAR, não de comportamento.
//
// POR QUE a rota /calibracao morre: o insumo dela era o PIOR possível — um JPEG PARADO do go2rtc, e
// um XADREZ quando o go2rtc não serve a câmera (calibrar às cegas). No palco o insumo é o VÍDEO
// REAL. O universo de câmeras é o MESMO (evento socket `cameras`) e a página não tinha lógica
// própria. (Auditoria: spec §1.)
//
// O QUE NÃO ESTÁ AQUI, E POR QUÊ — o DESENHO. No palco, Pausar/Congelar NÃO redesenham o canvas (o
// rAF retorna antes do drawScene): um canto clicado com a imagem parada NÃO APARECERIA. Por isso a
// marcação vive numa camada SVG IRMÃ do canvas (./CalibrationLayer), posicionada pelo CONTENT-RECT
// (o mesmo letterbox do palco) — como a CineBar. O rAF é o gate de frame: não se mexe nele.
// Consequência: este hook publica `rect` (o content-rect em px do viewport) para a camada.
//
// RBAC (risco nº 2 da spec): MEDIR é de TODOS — o operador mede distância no chão. CALIBRAR exige
// canConfigure. O guard do medir precisa ficar ACIMA do corte `!canConfigure` do palco: quem garante
// isso é a função PURA stageTarget (./useStageModes), com teste.
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { type FrameSource } from "../frame";
import { getContentRect, type Rect } from "./draw";
import {
  computeHomography,
  measureDistance,
  pixelToWorld,
  worldToPixel,
  type Correspondence,
  type Matrix3,
  type Vec2,
} from "../vision/homography";
import { getCalibration, saveCalibration, ApiError, type CameraCalibration } from "../api";
import { useStationHealth } from "../fusion/useStationHealth";
import { useStationNames } from "../fusion/useStationNames";
import { stationGeometryHints, dominantAxisFromRect } from "../fusion/station-geometry";
import { useBleReadings } from "./useBleReadings";
import {
  adoptStationPoints,
  placeStationPoint,
  removeStationPoint,
  setPrincipalStation,
  type StationPointsState,
} from "./station-points";

export type CalMode = "calibrar" | "medir";
/** dentro de "calibrar": os 4 cantos · a tag-âncora de cada canto · o ponto das estações BLE · a tag fixa de referência */
export type CalStep = "cantos" | "ancoras" | "estacao" | "referencia";

type PointerLike = { clientX: number; clientY: number };

const EMPTY_STATIONS: StationPointsState = { stations: {}, principalId: null, station: null };
/** raio de acerto (fração da imagem) p/ "pegar" um ponto já marcado — o mesmo do painel antigo */
const HIT = 0.04;
/** o content-rect pode mudar sem resize (dims do <video> chegam depois): re-sincroniza barato */
const RECT_SYNC_MS = 300;

export const CORNER_HINT = [
  "1 · próximo-esquerdo",
  "2 · próximo-direito",
  "3 · longe-direito",
  "4 · longe-esquerdo",
];

/** Cantos do retângulo em coords de MUNDO (metros), na ordem de clique: 1→(0,0) 2→(L,0) 3→(L,C) 4→(0,C). */
export function worldCorners(L: number, C: number): Vec2[] {
  return [
    { x: 0, y: 0 },
    { x: L, y: 0 },
    { x: L, y: C },
    { x: 0, y: C },
  ];
}

/**
 * GRADE métrica de conferência (PURA, testável): as linhas do mundo (0..L × 0..C) a cada `step` m,
 * projetadas de VOLTA na imagem (worldToPixel). Se ela assenta no chão, a calibração está boa — é o
 * jeito do mercado de conferir homografia a olho. Passo ≥1 m e ≤ ~13 linhas por eixo.
 */
export function gridSegments(
  H: Matrix3 | null,
  L: number,
  C: number,
): { seg: Array<[Vec2, Vec2]>; step: number } | null {
  if (!H || !Number.isFinite(L) || !Number.isFinite(C) || L <= 0 || C <= 0) return null;
  const step = Math.max(1, Math.ceil(Math.max(L, C) / 12));
  const seg: Array<[Vec2, Vec2]> = [];
  const proj = (wx: number, wy: number) => worldToPixel(H, { x: wx, y: wy });
  for (let x = 0; x <= L + 1e-6; x += step) {
    const a = proj(x, 0),
      b = proj(x, C);
    if (a && b) seg.push([a, b]);
  }
  for (let y = 0; y <= C + 1e-6; y += step) {
    const a = proj(0, y),
      b = proj(L, y);
    if (a && b) seg.push([a, b]);
  }
  return { seg, step };
}

type Opts = {
  cameraId: string;
  canConfigure: boolean;
  viewportRef: RefObject<HTMLDivElement | null>;
  /** fonte da GEOMETRIA do palco (WebRTC × MJPEG) — o mesmo currentFrame dos outros editores */
  currentFrame: () => FrameSource | null;
  /** a calibração salva mudou → a "malha" do rodapé (useCalibrationOverlay) re-lê a H do hub */
  onSaved?: () => void;
};

export function useCalibrationEditor(o: Opts) {
  const { cameraId, canConfigure } = o;
  const [active, setActive] = useState(false); // modo do palco ligado (governa consumo de ponteiro)
  const [mode, setModeState] = useState<CalMode>("calibrar");
  const [calStep, setCalStep] = useState<CalStep>("cantos");
  const [corners, setCorners] = useState<Vec2[]>([]); // cantos clicados (px 0..1), até 4, em ordem
  // MAC de uma tag BLE ÂNCORA por canto (index-aligned a `corners`); "" = canto sem âncora.
  const [cornerMacs, setCornerMacs] = useState<string[]>([]);
  const [anchorCorner, setAnchorCorner] = useState(0); // canto em edição no passo "âncoras"
  // MULTI-ANTENA: pontos de chão das estações + a PRINCIPAL + o espelho legado (`station`) — os três
  // mudam JUNTOS e guardam o invariante de retrocompat; as transições são puras (station-points.ts).
  const [pts, setPts] = useState<StationPointsState>(EMPTY_STATIONS);
  const { stations, principalId, station } = pts;
  const [selStation, setSelStation] = useState(""); // estação em edição ("" = mundo de 1 antena)
  // tag FIXA de referência (âncora de saúde): MAC + onde ela está no chão. Só entra no save com ambos.
  const [refTag, setRefTag] = useState<{ mac: string; px: Vec2 | null } | null>(null);
  const [width, setWidth] = useState("1"); // Largura (lado 1→2), metros — string p/ digitar livre
  const [length, setLength] = useState("1"); // Comprimento (lado 2→3), metros
  const [savedH, setSavedH] = useState<Matrix3 | null>(null);
  const [measurePts, setMeasurePts] = useState<Vec2[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null); // ponto sob o cursor ("pegar")
  const [rect, setRect] = useState<Rect | null>(null); // content-rect do palco → posiciona o SVG
  const dragRef = useRef<{ kind: "corner" | "measure" | "station" | "reftag"; idx: number } | null>(
    null,
  );

  // Espelhos ESTÁVEIS dos getters do palco (o currentFrame é recriado a cada render do CW): mantêm
  // os efeitos/handlers fora do ciclo de re-armar listener a cada render (idioma keysRef do poly).
  const frameRef = useRef(o.currentFrame);
  frameRef.current = o.currentFrame;
  const savedCbRef = useRef(o.onSaved);
  savedCbRef.current = o.onSaved;

  // Leituras BLE vivas: SÓ nos passos que escolhem uma tag. Efêmero (LGPD) — nada persiste.
  const btReadings = useBleReadings(
    active && mode === "calibrar" && (calStep === "referencia" || calStep === "ancoras"),
  );
  // Registro de estações (id técnico → NOME amigável). Fonte ÚNICA do rótulo: seletor, etiqueta no
  // palco e chip de saúde. A estação NASCE por auto-descoberta no hub; aqui só se lê.
  const { stations: btStations, nameOf, labelOf } = useStationNames(active && mode === "calibrar");

  // ── carga da calibração salva (só quando o modo entra em cena — câmera fechada não paga rede) ──
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    getCalibration(cameraId)
      .then((cal) => {
        if (cancelled || !cal) return;
        setSavedH(cal.H);
        if (cal.refTag)
          setRefTag({ mac: cal.refTag.mac, px: { x: cal.refTag.px.x, y: cal.refTag.px.y } });
        // Pontos das estações + principal + espelho legado, numa transição só (station-points.ts).
        const adopted = adoptStationPoints(cal.stations, cal.station ?? null);
        setPts(adopted);
        if (adopted.principalId) setSelStation(adopted.principalId);
        if (cal.points.length === 4) {
          setCorners(cal.points.map((p) => ({ x: p.px.x, y: p.px.y })));
          setCornerMacs(cal.points.map((p) => p.mac ?? "")); // âncora por canto (aditivo; "" = sem)
          setWidth(String(cal.points[1].world.x)); // (L,0)
          setLength(String(cal.points[2].world.y)); // (L,C)
        }
      })
      .catch((e) => {
        if (!cancelled) console.warn("[calibration] carga falhou — começando vazio", e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cameraId, active]);

  // Troca de câmera zera o editor (a calibração é POR câmera; herdar cantos seria mentira).
  useEffect(() => {
    setCorners([]);
    setCornerMacs([]);
    setPts(EMPTY_STATIONS);
    setRefTag(null);
    setSavedH(null);
    setMeasurePts([]);
    setNote(null);
    setErr(null);
  }, [cameraId]);

  // ── CONTENT-RECT do palco (risco nº 1): posiciona a camada SVG sobre o vídeo, com o MESMO
  // letterbox do canvas (getContentRect). Duas fontes de mudança, uma função: ResizeObserver
  // (palco/drawer) + um tick barato (as dims do <video> WebRTC chegam DEPOIS do primeiro layout, e
  // isso não gera resize). NÃO tocamos no rAF — ele é o gate de frame. setState com guarda de
  // igualdade: sem mudança, zero re-render.
  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const vp = o.viewportRef.current;
    const sync = () => {
      const el = o.viewportRef.current;
      const f = frameRef.current();
      if (!el || !f || !f.w || !f.h) return;
      const cr = getContentRect(el.clientWidth, el.clientHeight, f.w, f.h);
      setRect((p) =>
        p && p.x === cr.x && p.y === cr.y && p.w === cr.w && p.h === cr.h ? p : cr,
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    if (vp) ro.observe(vp);
    const t = window.setInterval(sync, RECT_SYNC_MS);
    return () => {
      ro.disconnect();
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ESC SAI DO MODO (spec §3.5) — não fecha a câmera. O trap de foco da casca (useFocusTrap) também
  // ouve ESC e chamaria onClose; ele registra na fase BUBBLE no MOUNT (antes deste hook), então em
  // bubble ELE rodaria primeiro e fecharia a câmera. Por isso a CAPTURE: precede toda bubble → aqui
  // marcamos preventDefault + saímos do modo, e o trap (bubble) vê defaultPrevented e NÃO fecha. E
  // cede a camadas Radix abertas (Select/popover no painel): se ELAS já trataram o ESC
  // (defaultPrevented antes), aqui não sai do modo — o ESC fecha só a camada de cima. `stop` é
  // hoisted (declaração de função).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      stop();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [active]);

  const L = parseFloat(width);
  const C = parseFloat(length);
  const dimsOk = Number.isFinite(L) && L > 0 && Number.isFinite(C) && C > 0;

  // H recomputada quando há 4 cantos + dimensões válidas.
  const liveH = useMemo(() => {
    if (corners.length !== 4 || !dimsOk) return null;
    const w = worldCorners(L, C);
    const corr: Correspondence[] = corners.map((px, i) => ({ px, world: w[i] }));
    return computeHomography(corr);
  }, [corners, L, C, dimsOk]);

  // H ativa p/ medição + grade: a recém-editada (se válida) ou a última salva.
  const activeH: Matrix3 | null = liveH && liveH.ok ? liveH.H : savedH;

  const distance =
    activeH && measurePts.length === 2
      ? measureDistance(activeH, measurePts[0], measurePts[1])
      : null;

  const grid = useMemo(() => (dimsOk ? gridSegments(activeH, L, C) : null), [activeH, L, C, dimsOk]);

  // Distância real estação ↔ tag de referência (m) — só com H + ambos os pontos.
  const distMeters = useMemo(() => {
    if (!activeH || !station || !refTag?.px) return undefined;
    const a = pixelToWorld(activeH, station);
    const b = pixelToWorld(activeH, refTag.px);
    if (!a || !b) return undefined;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }, [activeH, station, refTag]);

  // ── MULTI-ANTENA: as N estações, seus pontos e a guia de instalação ──────────────────────────
  // Ids conhecidos = os do REGISTRO do hub (auto-descobertos) ∪ os que já têm ponto salvo (estação
  // que morreu não some da calibração). Vazio = mundo de 1 antena → o ponto único legado.
  // ESTAÇÃO VIVA = postou dentro da janela de staleness (RÉPLICA do STALE_MS de
  // server/bt/bt-readings.js, 15 s — o mesmo critério da aba Estações). Só as CONECTADAS entram no
  // seletor; estação órfã/desligada (ex.: rota-a, rota-b registradas mas sem sinal) não polui a
  // calibração. ultimaVezEm ausente/0 → NaN/enorme → cai fora (fail-safe).
  const STATION_STALE_MS = 15_000;
  const liveStationIds = useMemo(() => {
    const now = Date.now();
    return new Set(
      btStations
        .filter((s) => s.id && s.ativo && now - s.ultimaVezEm <= STATION_STALE_MS)
        .map((s) => s.id),
    );
  }, [btStations]);
  // Ids no seletor = quem tem PONTO salvo (nunca some — calibrada-mas-offline segue removível) ∪ as
  // VIVAS agora. A que tem ponto mas caiu é marcada "sem sinal" na UI (via liveStationIds).
  const stationIds = useMemo(() => {
    const ids = new Set<string>(Object.keys(stations));
    for (const id of liveStationIds) ids.add(id);
    return [...ids].sort();
  }, [stations, liveStationIds]);
  const sel = selStation && stationIds.includes(selStation) ? selStation : (stationIds[0] ?? "");
  const stationMarks = useMemo(() => {
    const marks = Object.entries(stations)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, px]) => ({ id: id as string | null, px, principal: id === principalId }));
    if (marks.length > 0) return marks;
    return station ? [{ id: null as string | null, px: station, principal: true }] : [];
  }, [stations, station, principalId]);
  const selPx = sel ? (stations[sel] ?? null) : station;

  // GUIA DE INSTALAÇÃO: as estações no MUNDO (via H) + o eixo dominante presumido → avisos de
  // geometria. Texto de AJUDA, nunca bloqueio do save (quem manda é o walk-test).
  const geomHints = useMemo(() => {
    if (!activeH || stationMarks.length < 2) return [];
    const world: Vec2[] = [];
    for (const m of stationMarks) {
      const w = pixelToWorld(activeH, m.px);
      if (w) world.push(w);
    }
    return stationGeometryHints(world, dominantAxisFromRect(L, C));
  }, [activeH, stationMarks, L, C]);

  // As 3 transições dos pontos de estação (puras, testadas em station-points.ts) — aqui só o disparo.
  const placeStation = (px: Vec2) => setPts((p) => placeStationPoint(p, sel, px));
  const makePrincipal = (id: string) => setPts((p) => setPrincipalStation(p, id));
  const clearStationPoint = (id: string) => setPts((p) => removeStationPoint(p, id));

  // Saúde POR ESTAÇÃO (heartbeat/drift/RSSI@1m) ancorada na tag fixa.
  const stationsHealth = useStationHealth({
    refMac: refTag?.mac || undefined,
    distMeters,
    enabled: active && mode === "calibrar" && calStep === "referencia" && !!refTag?.mac,
  });

  // ── ponteiro: pegar/arrastar um ponto existente OU marcar um novo ────────────────────────────
  // Coords do palco → NORMALIZADAS 0..1 contra o CONTENT-RECT (o mesmo letterbox do canvas/zonas —
  // o painel antigo encolhia o wrapper até a imagem; aqui o palco tem tarja preta e ela NÃO é chão).
  function toNorm(e: PointerLike): Vec2 | null {
    const f = frameRef.current();
    const vp = o.viewportRef.current;
    if (!f || !vp) return null;
    const r = vp.getBoundingClientRect();
    const cr = getContentRect(vp.clientWidth, vp.clientHeight, f.w, f.h);
    const x = (e.clientX - r.left - cr.x) / cr.w;
    const y = (e.clientY - r.top - cr.y) / cr.h;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
  }
  function nearest(list: Vec2[], px: Vec2): number | null {
    let best: number | null = null;
    let bestD = HIT;
    list.forEach((c, i) => {
      const d = Math.hypot(c.x - px.x, c.y - px.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
  // Pontos "pegáveis" no passo corrente (no passo das estações só a EM EDIÇÃO se move — clicar no
  // chão não arrasta a antena do vizinho sem querer).
  const activePts: Vec2[] =
    mode === "medir"
      ? measurePts
      : calStep === "estacao"
        ? selPx
          ? [selPx]
          : []
        : calStep === "referencia"
          ? refTag?.px
            ? [refTag.px]
            : []
          : corners;

  /** true = CONSUMI o evento (o palco não passa adiante). Ativo → consome sempre. */
  function onDown(e: PointerLike): boolean {
    if (!active) return false;
    const px = toNorm(e);
    if (!px) return true; // clique na tarja (fora do vídeo): não é chão — ignora
    if (mode === "medir") {
      // MEDIR é de TODOS (inclusive o operador) — este é o guard que precisa viver ACIMA do
      // corte de !canConfigure do palco (spec §1, risco 2).
      const hit = nearest(measurePts, px);
      if (hit != null) dragRef.current = { kind: "measure", idx: hit };
      else setMeasurePts((p) => (p.length >= 2 ? [px] : [...p, px]));
      return true;
    }
    if (calStep === "ancoras") {
      // Passo âncoras: clicar SELECIONA o canto (não move nem cria) — a tag vem da lista.
      const hit = nearest(corners, px);
      if (hit != null) setAnchorCorner(hit);
      return true;
    }
    if (!canConfigure) return true; // calibrar exige engenharia (consome: nada de desenhar zona por baixo)
    if (calStep === "estacao") {
      const hit = nearest(selPx ? [selPx] : [], px);
      if (hit != null) dragRef.current = { kind: "station", idx: 0 };
      else placeStation(px); // clicar fixa/reposiciona a estação EM EDIÇÃO; arraste p/ ajustar
    } else if (calStep === "referencia") {
      const hit = nearest(refTag?.px ? [refTag.px] : [], px);
      if (hit != null) dragRef.current = { kind: "reftag", idx: 0 };
      else setRefTag((r) => ({ mac: r?.mac ?? "", px })); // fixa o ponto; mantém o mac
    } else {
      const hit = nearest(corners, px);
      if (hit != null) dragRef.current = { kind: "corner", idx: hit };
      else if (corners.length < 4) {
        setNote(null);
        setCorners((p) => [...p, px]); // até 4; arraste p/ ajustar, "Refazer" limpa
        setCornerMacs((m) => [...m, ""]); // âncora index-aligned aos cantos
      }
    }
    return true;
  }
  function onMove(e: PointerLike): boolean {
    if (!active) return false;
    const px = toNorm(e);
    if (!px) return true;
    const d = dragRef.current;
    if (d) {
      if (d.kind === "corner") setCorners((p) => p.map((c, i) => (i === d.idx ? px : c)));
      else if (d.kind === "station") placeStation(px);
      else if (d.kind === "reftag") setRefTag((r) => (r ? { ...r, px } : { mac: "", px }));
      else setMeasurePts((p) => p.map((c, i) => (i === d.idx ? px : c)));
      return true;
    }
    setHoverIdx(nearest(activePts, px)); // feedback: o ponto cresce quando o cursor pode pegá-lo
    return true;
  }
  function onUp(): boolean {
    if (!active) return false;
    dragRef.current = null;
    return true;
  }

  // ── ciclo do modo ────────────────────────────────────────────────────────────────────────────
  function start() {
    // O operador não calibra, mas MEDE: abrir já no passo que ele pode usar (o painel antigo abria
    // em "calibrar" e só lhe dizia "requer engenharia"). Regra de UI, não de domínio.
    if (!canConfigure) setModeState("medir");
    setActive(true);
  }
  function stop() {
    dragRef.current = null;
    setHoverIdx(null);
    setActive(false);
  }
  function setMode(m: CalMode) {
    setModeState(m);
    setMeasurePts([]);
  }

  const undoCorner = () => {
    setCorners((p) => p.slice(0, -1));
    setCornerMacs((m) => m.slice(0, -1)); // âncora acompanha o canto removido
  };
  const resetCorners = () => {
    setCorners([]);
    setCornerMacs([]);
  };
  const setCornerMac = (i: number, mac: string) =>
    setCornerMacs((m) => m.map((v, k) => (k === i ? mac : v)));
  const pickRefTag = (mac: string) => setRefTag((p) => ({ mac, px: p?.px ?? null }));
  const clearMeasure = () => setMeasurePts([]);

  /** Nome legível de um MAC-âncora (rótulo cadastrado se a tag está visível agora; senão o MAC). */
  const macName = (mac: string) =>
    btReadings.find((r) => r.mac.toUpperCase() === mac.toUpperCase())?.rotulo || mac;

  const canSave = !!liveH && liveH.ok && !saving;

  async function save() {
    if (!liveH || !liveH.ok) return;
    setSaving(true);
    setErr(null);
    setNote(null);
    const w = worldCorners(L, C);
    const payload: CameraCalibration = {
      points: corners.map((px, i) => ({
        px,
        world: w[i],
        ...(cornerMacs[i] ? { mac: cornerMacs[i] } : {}), // âncora só vai quando associada
      })),
      H: liveH.H,
      updatedAt: Date.now(),
      ...(station ? { station } : {}), // PRINCIPAL (legado) — ausente = fallback no back
      ...(Object.keys(stations).length ? { stations } : {}), // N pontos (multi-antena, aditivo)
      ...(refTag && refTag.mac && refTag.px ? { refTag: { mac: refTag.mac, px: refTag.px } } : {}),
    };
    try {
      const saved = await saveCalibration(cameraId, payload);
      setSavedH(saved.H);
      setNote("Calibração salva.");
      savedCbRef.current?.(); // a malha do rodapé re-lê a H do hub (senão só atualizaria ao reabrir)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Não foi possível salvar a calibração.");
    } finally {
      setSaving(false);
    }
  }

  return {
    // modo do palco
    active,
    start,
    stop,
    onDown,
    onMove,
    onUp,
    // camada SVG (irmã do canvas)
    rect,
    hoverIdx,
    // o que se marca
    mode,
    setMode,
    calStep,
    setCalStep,
    corners,
    cornerMacs,
    setCornerMac,
    anchorCorner,
    setAnchorCorner,
    undoCorner,
    resetCorners,
    macName,
    // dimensões + homografia
    width,
    setWidth,
    length,
    setLength,
    dimsOk,
    liveH,
    savedH,
    grid,
    // estações BLE (multi-antena)
    stationIds,
    liveStationIds, // as CONECTADAS agora (a UI marca "sem sinal" quem tem ponto mas caiu)
    stations,
    principalId,
    sel,
    setSelStation,
    selPx,
    stationMarks,
    makePrincipal,
    clearStationPoint,
    geomHints,
    nameOf,
    labelOf,
    stationsHealth,
    // tags
    btReadings,
    refTag,
    pickRefTag,
    // medir
    measurePts,
    distance,
    clearMeasure,
    // salvar
    canConfigure,
    canSave,
    saving,
    loading,
    err,
    note,
    save,
  };
}

export type CalibrationEditor = ReturnType<typeof useCalibrationEditor>;
