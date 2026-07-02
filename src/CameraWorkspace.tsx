import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { APP_CONFIG, MODE_PRESETS, type OverlayLayers, type ModeKey } from "./config";
import { type FrameSource } from "./frame";
import { fmtDuration, clock } from "./format";
import { FrameMeter } from "./telemetry";
import { type Detection } from "./vision/model";
import { ensureDetectClient, detectFrame } from "./vision/detect";
import {
  AtividadeProcessor,
  sensitivityFactor,
  type AtividadeCtx,
} from "./processors/atividade";
import { LeituraProcessor } from "./processors/leitura";
import { ObjetosProcessor } from "./processors/objetos";
import { FadigaProcessor } from "./processors/fadiga";
import { loadFadigaThresholds } from "./fadiga/calibration";
import { type RiskState } from "./fadiga/landmarks";
import { pushRead, pushPass } from "./reading/cluster";
import {
  recordSamples,
  recordAlert,
  recordReads,
  recordPass,
  recordObjectSamples,
  recordObjectEvent,
  recordFadigaSamples,
  recordFadigaEvent,
  loadDataset,
  type ZoneSample,
} from "./report/store";
import { type Dataset } from "./report/mock";
import { objClass, OBJECT_CATALOG } from "./objects/catalog";
import {
  loadZonesForCamera,
  persistZones,
  newZoneId,
  DEFAULT_GRID,
  ZONE_MODE_LABEL,
  type Zone,
  type ZoneMode,
} from "./zones";
import { loadCamConfig, getCameraCfg, setCameraCfg } from "./cameraConfig";
import { ApiError } from "./api";
import {
  decodeMask,
  encodeMask,
  maskFromRect,
  paintBrush,
  cellAtNorm,
  maskBBoxNorm,
  anySet,
  clearMask,
  containsNorm,
  type Mask,
} from "./zoneMask";
import { createCounter, createOccupancy, type Occupancy } from "./vision/counting";
import {
  Button,
  IconButton,
  Select,
  Slider,
  Switch,
  ToggleRow,
  Tabs,
  TabsContent,
  ScrollArea,
  Toggle,
  Tooltip,
  Badge,
  Field,
  type Tone,
} from "./ui";
import { useCineLoop } from "./camera/useCineLoop";
import { useTripwires } from "./camera/useTripwires";
import { MetricCell } from "./components/Sparkline";
import { useAuth } from "./auth";
import {
  getContentRect,
  stateVar,
  drawOccupancyHeatmap,
  drawTracks,
  drawTripwires,
  drawPaintGrid,
  drawZoneDraft,
  drawTripwireDraft,
  drawZoneOverlays,
  RISK_LABEL,
  type ZoneResult,
} from "./camera/draw";
import { ConfigZonaDialog } from "./camera/ConfigZonaDialog";
import {
  OCC_HI,
  EAR_HI,
  NOREAD_BAND,
  RATE_BAND,
  OCC_BAND,
  stateToMetric,
  riskToMetric,
  rateToMetric,
  noReadMetric,
  occMetric,
  useTelemetry,
} from "./camera/useTelemetry";
import "./camera/cine.css";

const BRUSH_OPTS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
];

// Grade do heatmap de ocupação (camada opcional sobre o vídeo).
const HEAT_COLS = 32,
  HEAT_ROWS = 18;

// ── P0 + P2 (analises/plano-performance-imagem.md): EXIBIÇÃO × ANÁLISE na grade ──
// Na GRADE (tiles, mode ≠ "full") o vídeo é desenhado TODO frame (drawScene) e a análise LEVE —
// motion + máquina de estado por zona (ATIVA/LENTA/OCIOSA/VAZIA/ALERTA) + alarmes — segue em TEMPO
// REAL, pois é a funcionalidade essencial que não pode parar quando a câmera não está aberta. Só a
// inferência PESADA é rebaixada a uma cadência muito menor, p/ liberar a main thread e deixar o
// vídeo fluido. Na câmera ABERTA (full) tudo volta à cadência normal (pipeline completo, como hoje).
// Consequência aceita: na grade, ocupação/contagem (coco), objetos (OWL-ViT), leitura (ZXing) e
// fadiga (MediaPipe) atualizam mais devagar; ao ABRIR a câmera, tudo volta a atualizar na hora.
// Constantes locais (NÃO editar config.ts — outra frente). Substituem o throttle de tile p/ o pesado.
const TILE_OBJECT_INTERVAL_MS = 4000; // coco (detecção de pessoas/objetos) na grade — vs C.objectIntervalMs na aberta
const TILE_HEAVY_INTERVAL_MS = 4000; // OWL-ViT (objetos) · ZXing (leitura) · MediaPipe/coco (fadiga) na grade

// Tripwires (linhas de contagem com direção): estado/ciclo de vida em ./camera/useTripwires.

// CameraWorkspace: UMA câmera, VÁRIAS zonas, cada uma com seu modo (atividade/leitura/objetos).
// Roda o processador de cada zona na sua ROI, compõe o overlay e o painel num lugar só.
// Helpers puros de geometria/cor/desenho ficam em ./camera/draw; telemetria em ./camera/useTelemetry.

// resultado por zona guardado p/ desenho + painel → tipo em ./camera/draw (ZoneResult).

type Holder = {
  modo: ZoneMode;
  proc: AtividadeProcessor | LeituraProcessor | ObjetosProcessor | FadigaProcessor;
};

// risco → rótulo (RISK_LABEL) + cor de canvas (riskCanvasColor) em ./camera/draw.
const RISK_TONE: Record<RiskState, Tone> = {
  OK: "ok",
  ALERTA_FADIGA: "warn",
  ALERTA_CELULAR: "warn",
  ALERTA_DUPLO: "alert",
};

// ── (plano-performance-bit 1.10) assinatura BARATA do snapshot do painel ──
// Serializa, por zona, SÓ o que o JSX do painel exibe (id + estado + números na granularidade
// mostrada: % de motion, segundos de parada, EAR com 2 casas…). O tick de UI compara a assinatura
// com a anterior e só chama setPanel quando algo VISÍVEL mudou — sem mudança, zero re-render
// (antes, objetos novos a cada 200/500ms re-renderizavam ~800 linhas de JSX à toa).
// Campos NÃO exibidos no painel (dets de objetos, scene de fadiga, occupied/alerts de atividade)
// ficam de fora de propósito: eles alimentam o overlay do canvas via resultsRef, não o JSX.
function panelSig(results: Map<string, ZoneResult>): string {
  let sig = "";
  for (const [id, r] of results) {
    if (r.modo === "atividade") {
      const v = r.view;
      sig += `${id}|a|${v.state}|${Math.round(v.motion * 100)}|${Math.floor(v.idleMs / 1000)}|${v.people}|${v.flowLevel}|${v.flow.map((s) => Math.round(s * 100)).join(",")};`;
    } else if (r.modo === "leitura") {
      sig += `${id}|l|${r.lastCode ?? ""}|${r.ratePct}|${r.perMin}|${r.noReads}|${r.passes};`;
    } else if (r.modo === "objetos") {
      let c = "";
      for (const k in r.counts) c += `${k}:${r.counts[k]},`;
      sig += `${id}|o|${r.total}|${c};`;
    } else {
      sig += `${id}|f|${r.risk}|${r.ear == null ? "" : r.ear.toFixed(2)}|${r.phone ? 1 : 0}|${r.faceState};`;
    }
  }
  return sig;
}

// Idem p/ os contadores de tripwire mostrados no painel "linhas" ({ [wireId]: {in,out} }).
function twSig(counts: Record<string, { in: number; out: number }>): string {
  let sig = "";
  for (const id in counts) sig += `${id}:${counts[id].in}:${counts[id].out};`;
  return sig;
}

// taxa de leitura → cor (verde ≥95 · âmbar ≥80 · vermelho abaixo). Espelha a semântica do relatório.
const MODE_TONE: Record<ZoneMode, Tone> = {
  atividade: "ok",
  leitura: "info",
  objetos: "warn",
  fadiga: "info",
};

// Telemetria "nunca número cru" (constantes/bandas/metric fns/useTelemetry) em ./camera/useTelemetry.

// MODO-COMO-PRESET: o workspace tem N zonas (cada uma com seu modo), mas overlays/confiança
// são GLOBAIS da sessão. O "preset ativo" segue o modo PREDOMINANTE entre as zonas
// (empate → ordem atividade>leitura>objetos>fadiga). Trocar o modo de uma zona reaplica o preset.
const PRESET_ORDER: ModeKey[] = ["atividade", "leitura", "objetos", "fadiga"];
function dominantMode(zs: Zone[]): ModeKey {
  if (!zs.length) return "atividade";
  const counts: Record<string, number> = {};
  for (const z of zs) counts[z.modo] = (counts[z.modo] ?? 0) + 1;
  return PRESET_ORDER.reduce(
    (best, m) => ((counts[m] ?? 0) > (counts[best] ?? 0) ? m : best),
    PRESET_ORDER[0],
  );
}

// Overlay compacto de fadiga DENTRO da zona (drawFadigaZone) em ./camera/draw.
type Track = {
  id: number;
  cx: number;
  cy: number;
  bbox: [number, number, number, number];
  firstSeen: number;
  lastSeen: number;
  zone: string | null;
  score: number;
};
type TimelineItem = { id: number; ts: number; text: string; sev: "info" | "warn" | "high" };

type Props = {
  cameraId: string;
  label: string;
  getFrame: () => FrameSource | null;
  mode: "tile" | "full";
  demoMode?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  onAlert?: (msg: string) => void;
  // SYNC AO VIVO (ADR-006): contador de revisão por câmera, incrementado pela central
  // (DashboardPage) quando o backend emite `camcfg-updated {kind:"tripwires", cameraId}`.
  // OPCIONAL/retrocompatível: se a central não passar, o CameraWorkspace mantém o
  // comportamento atual (carrega os tripwires só ao abrir/trocar a câmera).
  tripwiresRev?: number;
};

const C = APP_CONFIG.detection;

export function CameraWorkspace({
  cameraId,
  label,
  getFrame,
  mode,
  demoMode = true,
  onOpen,
  onClose,
  onAlert,
  tripwiresRev,
}: Props) {
  // RBAC Setup × Live (Onda C item 12): canConfigure = superadmin OU engenheiro (contrato em auth.tsx).
  // Operador (sem canConfigure) opera a tela em SÓ-LEITURA: vê ao vivo/overlays/telemetria/cine-loop/
  // camadas, mas NÃO edita configuração (criar/apagar/pintar zona, thresholds/sensibilidade/limite).
  const { canConfigure } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const procRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const prevLumaRef = useRef<Float32Array | null>(null);
  const curLumaRef = useRef<Float32Array | null>(null); // buffer reutilizável (swap c/ prev) — evita new Float32Array por frame
  const lumaSizeRef = useRef(0);
  const lastFrameElRef = useRef<unknown>(null); // identidade do último frame processado (gate de "frame novo")
  const lastFrameTsRef = useRef(0);
  const detsRef = useRef<Detection[]>([]);
  const lastObjAtRef = useRef(0);
  const objInFlightRef = useRef(false); // P0: na grade, pula a detecção coco enquanto já há uma em voo
  const lastHeavyAtRef = useRef<Map<string, number>>(new Map()); // P2: última inferência PESADA por zona (gate de tile)
  const lastFrameAtRef = useRef(0);
  const lastFlowAtRef = useRef(0);
  const lastRecAtRef = useRef(0);
  const lastUiRef = useRef(0);
  // (1.10) últimas versões ENVIADAS ao estado pelo tick de UI — comparar antes de setar.
  const lastPanelSigRef = useRef("");
  const lastTwSigRef = useRef("");
  const lastFpsRef = useRef(-1);
  const lastPresenceRef = useRef({ now: -1, peak: -1, dwell: -1 });
  const holdersRef = useRef<Map<string, Holder>>(new Map());
  const cropsRef = useRef<Map<string, HTMLCanvasElement>>(new Map()); // recorte por zona de fadiga
  const resultsRef = useRef<Map<string, ZoneResult>>(new Map());
  const zonesRef = useRef<Zone[]>([]);
  const meterRef = useRef(new FrameMeter());
  const onAlertRef = useRef(onAlert);
  const onCloseRef = useRef(onClose); // estável p/ o handler de ESC (evita re-armar o listener a cada render)
  const fullRef = useRef<HTMLDivElement | null>(null); // raiz do overlay em tela cheia (foco preso)
  const cfgOpenRef = useRef(false); // diálogo de config aberto → deixa o Radix tratar ESC/Tab
  const drawRef = useRef<{
    active: boolean;
    sx: number;
    sy: number;
    cx: number;
    cy: number;
  } | null>(null);
  const maskCacheRef = useRef<Map<string, { enc?: string; mask: Mask }>>(new Map()); // máscaras decodificadas
  const paintingRef = useRef(false);
  const eraseRef = useRef(false);
  const tracksRef = useRef<Track[]>([]); // presença (IDs anônimos + permanência)
  const trackIdRef = useRef(0);
  const peakRef = useRef(0);
  const pausedRef = useRef(false);
  const eventIdRef = useRef(0);
  const layersRef = useRef<OverlayLayers>({ ...APP_CONFIG.overlay.layers }); // camadas visíveis (lido no rAF)
  const confRef = useRef<number>(APP_CONFIG.overlay.confidenceThreshold); // limiar global de confiança
  // Perfil "Longo alcance / Panorâmica" (opt-in por câmera). O rAF lê o REF (identidade estável);
  // o estado governa a UI + persistência. Default false = comportamento atual (zero regressão).
  const longRangeRef = useRef(false);
  // Ocupação (Onda C item 13): heatmap da lib pura counting.ts (criado sob demanda no rAF).
  // Os tripwires/counter vivem no hook ./camera/useTripwires (ver abaixo).
  const occRef = useRef<Occupancy | null>(null);
  // Telemetria lateral (Onda B item 10): ring buffer leve por zona/indicador, alimentado pelo
  // loop já existente na cadência de UI (sem custo extra de inferência). Hook em ./camera/useTelemetry.
  const { pushHist, hist, clearZone } = useTelemetry();
  // ── CONGELAR + CINE-LOOP (Onda B) ── hook dedicado (./camera/useCineLoop).
  // Buffer de quadros EM MEMÓRIA / EFÊMERO (LGPD: nunca vai ao servidor; ver cineBuffer.ts).
  // Expõe estado/handlers p/ o JSX + `cineRef`/`reviewRef`/`captureFrame` p/ o rAF principal.
  const {
    review,
    scrubIndex,
    cinePlaying,
    cineSize,
    reviewTip,
    clipState,
    clipPct,
    setScrubIndex,
    setCinePlaying,
    enterReview,
    exitReview,
    scrubBy,
    downloadSnapshot,
    exportClip,
    captureFrame,
    cineRef,
    reviewRef,
  } = useCineLoop({ mode, cameraId, getFrame, canvasRef, viewportRef });

  const [zones, setZones] = useState<Zone[]>([]);
  const [zonesLoading, setZonesLoading] = useState(true); // carga assíncrona do backend (leve)
  const [panel, setPanel] = useState<Map<string, ZoneResult>>(new Map());
  const [drawMode, setDrawMode] = useState(false);
  const [paintZoneId, setPaintZoneId] = useState<string | null>(null);
  const [brush, setBrush] = useState(2);
  const [erase, setErase] = useState(false);
  const [paused, setPaused] = useState(false);
  const [perf, setPerf] = useState({ fps: 0 });
  const [presence, setPresence] = useState({ now: 0, peak: 0, dwell: 0 });
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [drawerTab, setDrawerTab] = useState<
    "zonas" | "linhas" | "timeline" | "presenca" | "camadas"
  >("zonas");
  const [cfgZoneId, setCfgZoneId] = useState<string | null>(null);
  // Onda 2: camadas + slider de confiança (estado local; inicia de APP_CONFIG.overlay).
  const [layers, setLayers] = useState<OverlayLayers>({ ...APP_CONFIG.overlay.layers });
  const [conf, setConf] = useState<number>(APP_CONFIG.overlay.confidenceThreshold);
  // Perfil "Longo alcance / Panorâmica" (opt-in por câmera; ver cameraConfig.longRange).
  const [longRange, setLongRange] = useState(false);
  // MODO-COMO-PRESET: modo cujo preset está aplicado à sessão (camadas + confiança + métricas em destaque).
  const [activePreset, setActivePreset] = useState<ModeKey | null>(null);
  // Histórico p/ "alertas/dia estimados" do slider de sensibilidade (carregado on-demand).
  const [histDataset, setHistDataset] = useState<Dataset | null>(null);
  const [histState, setHistState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  // ── Tripwires (linhas de contagem) ── hook dedicado (./camera/useTripwires).
  // Estado/refs/editor + ciclo de vida (load/migração/sync ADR-006 + fiação do counter).
  // O rAF principal cria/atualiza `counterRef`; o desenho lê `tripwiresRef`/`twCountsRef`/`twDrawRef`;
  // os handlers de ponteiro leem `tripwireMode`/`twDrawRef` e chamam `commitTripwire`.
  const {
    tripwires,
    tripwireMode,
    twCounts,
    setTripwireMode,
    setTwCounts,
    counterRef,
    tripwiresRef,
    twCountsRef,
    twDrawRef,
    commitTripwire,
    invertTripwire,
    removeTripwire,
    resetCounts,
    toggleTripwireMode,
  } = useTripwires({
    cameraId,
    label,
    canConfigure,
    tripwiresRev,
    getFrame,
    viewportRef,
    onAlertRef,
    onEnterEditMode: () => {
      setDrawMode(false);
      setPaintZoneId(null);
    },
  });

  useEffect(() => {
    onAlertRef.current = onAlert;
  }, [onAlert]);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    cfgOpenRef.current = !!cfgZoneId;
  }, [cfgZoneId]);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  useEffect(() => {
    zonesRef.current = zones;
  }, [zones]);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);
  useEffect(() => {
    confRef.current = conf;
  }, [conf]);
  useEffect(() => {
    longRangeRef.current = longRange;
  }, [longRange]);
  // Zonas: fonte de verdade = BACKEND (compartilhado por câmera), com FALLBACK gracioso p/ o
  // localStorage e a SEMENTE de zonas padrão. A carga é ASSÍNCRONA (antes era síncrona via
  // localStorage) → effect com guarda de corrida (cancelled) + estado de "carregando" leve.
  useEffect(() => {
    let cancelled = false;
    setZonesLoading(true);
    (async () => {
      const z = await loadZonesForCamera(cameraId, label, canConfigure);
      if (cancelled) return;
      setZones(z);
      // MODO-COMO-PRESET: ao abrir a câmera, carrega o preset do modo predominante (camadas + confiança).
      // Não toca na GEOMETRIA/zonas persistidas — só governa overlays/visão/métricas da sessão.
      const dom = dominantMode(z);
      const p = MODE_PRESETS[dom];
      setLayers({ ...p.layers });
      setConf(p.confidenceThreshold);
      setActivePreset(dom);
      setZonesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [cameraId, label, canConfigure]);
  // Config de câmera (compartilhada): hidrata/migra o cache local a partir do backend ao abrir a
  // câmera (best-effort, fire-and-forget). A UI de config vive na central, que lê o cache síncrono
  // getCameraCfg; refrescá-lo aqui faz a config fluir do backend sem acoplar as telas.
  useEffect(() => {
    // Perfil "Longo alcance": lê o cache SÍNCRONO já (sem flash), depois hidrata do backend.
    setLongRange(getCameraCfg(cameraId).longRange);
    let cancelled = false;
    loadCamConfig(cameraId, canConfigure)
      .then((cfg) => {
        if (!cancelled) setLongRange(cfg.longRange);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [cameraId, canConfigure]);
  // Tripwires: load/migração/sync ao vivo + re-set do counter → hook ./camera/useTripwires.
  // Carrega o histórico (read-only) ao abrir a config de uma zona de atividade — p/ a previsão de alertas/dia.
  useEffect(() => {
    const z = cfgZoneId ? zonesRef.current.find((zz) => zz.id === cfgZoneId) : null;
    if (!z || z.modo !== "atividade") {
      setHistState("idle");
      return;
    }
    let cancelled = false;
    setHistState("loading");
    loadDataset()
      .then((ds) => {
        if (!cancelled) {
          setHistDataset(ds);
          setHistState("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setHistState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [cfgZoneId]);
  useEffect(() => {
    ensureDetectClient();
  }, []);
  useEffect(() => {
    const m = holdersRef.current;
    return () => {
      m.forEach((h) => h.proc.dispose());
      m.clear();
    };
  }, []);

  // Overlay em tela cheia: ESC fecha + foco preso (focus trap) enquanto aberto (acessibilidade).
  // Quando o diálogo de config está aberto, deferimos ESC/Tab ao Radix (que tem o próprio trap).
  useEffect(() => {
    if (mode !== "full") return;
    const root = fullRef.current;
    if (!root) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) =>
          !el.hasAttribute("disabled") &&
          el.tabIndex !== -1 &&
          (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement),
      );
    const onKey = (e: KeyboardEvent) => {
      if (cfgOpenRef.current) return; // diálogo aberto → Radix trata
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const list = focusables();
      if (!list.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = list[0],
        last = list[list.length - 1],
        active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    root.focus({ preventScroll: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prevFocus?.focus?.();
    };
  }, [mode]);

  // Aplica o perfil "Longo alcance" ao processador (só atividade/objetos o consomem). Idempotente:
  // AtividadeProcessor.setLongRange faz early-return se não mudou; ObjetosProcessor só seta um bool.
  function applyLongRange(h: Holder) {
    const lr = longRangeRef.current;
    if (h.modo === "atividade") (h.proc as AtividadeProcessor).setLongRange(lr);
    else if (h.modo === "objetos") (h.proc as ObjetosProcessor).setLongRange(lr);
  }
  function holderFor(z: Zone): Holder {
    const cur = holdersRef.current.get(z.id);
    if (cur && cur.modo === z.modo) {
      applyLongRange(cur); // mantém o perfil em dia quando o toggle muda em runtime
      return cur;
    }
    cur?.proc.dispose();
    if (cur?.modo === "fadiga") cropsRef.current.delete(z.id);
    const proc =
      z.modo === "leitura"
        ? new LeituraProcessor()
        : z.modo === "objetos"
          ? new ObjetosProcessor()
          : z.modo === "fadiga"
            ? new FadigaProcessor()
            : new AtividadeProcessor(performance.now());
    if (z.modo === "fadiga") (proc as FadigaProcessor).setThresholds(loadFadigaThresholds()); // calibração global
    const h: Holder = { modo: z.modo, proc };
    holdersRef.current.set(z.id, h);
    applyLongRange(h); // processador recém-criado herda o perfil atual da câmera
    return h;
  }

  // Recorte da ROI da zona (cap ~480px) → FrameSource alimentado ao FadigaProcessor.
  // Reusa o canvas por zona (identidade estável); o newFrame usa a identidade do frame real (srcEl).
  function cropFor(z: Zone, f: FrameSource): FrameSource {
    let cv = cropsRef.current.get(z.id);
    if (!cv) {
      cv = document.createElement("canvas");
      cropsRef.current.set(z.id, cv);
    }
    const sw = Math.max(1, Math.round(z.w * f.w)),
      sh = Math.max(1, Math.round(z.h * f.h));
    const scale = Math.min(1, 480 / sw),
      cw = Math.max(1, Math.round(sw * scale)),
      ch = Math.max(1, Math.round(sh * scale));
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw;
      cv.height = ch;
    }
    cv.getContext("2d")!.drawImage(f.el, z.x * f.w, z.y * f.h, sw, sh, 0, 0, cw, ch);
    return { el: cv, w: cw, h: ch };
  }

  function containsFn(z: Zone): ((nx: number, ny: number) => boolean) | undefined {
    const m = getMask(z);
    return m && anySet(m) ? (nx: number, ny: number) => containsNorm(m, nx, ny) : undefined;
  }
  function zoneAtAtiv(ativ: Zone[], cx: number, cy: number): string | null {
    for (const z of ativ) {
      if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue;
      const cn = containsFn(z);
      if (!cn || cn(cx, cy)) return z.label;
    }
    return null;
  }

  // Rastreio anônimo de pessoas (IDs efêmeros, sem identidade) — base da "Presença".
  function updateTracks(dets: Detection[], ativ: Zone[], vidW: number, vidH: number, now: number) {
    const P = APP_CONFIG.people;
    // Longo alcance: limiar de confiança de "person" mais baixo (alvos distantes pontuam menos).
    const personScoreThr = longRangeRef.current
      ? APP_CONFIG.detection.longRange.peopleScoreThreshold
      : P.scoreThreshold;
    const persons = dets
      .filter((d) => d.class === "person" && d.score >= personScoreThr)
      .map((d) => ({
        cx: (d.bbox[0] + d.bbox[2] / 2) / vidW,
        cy: (d.bbox[1] + d.bbox[3] / 2) / vidH,
        bbox: [d.bbox[0] / vidW, d.bbox[1] / vidH, d.bbox[2] / vidW, d.bbox[3] / vidH] as [
          number,
          number,
          number,
          number,
        ],
        score: d.score,
      }));
    const used = new Set<number>();
    for (const p of persons) {
      let best: Track | null = null;
      let bestD: number = P.trackMaxDist;
      for (const t of tracksRef.current) {
        if (used.has(t.id)) continue;
        const d = Math.hypot(t.cx - p.cx, t.cy - p.cy);
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (best) {
        used.add(best.id);
        best.cx = p.cx;
        best.cy = p.cy;
        best.bbox = p.bbox;
        best.lastSeen = now;
        best.zone = zoneAtAtiv(ativ, p.cx, p.cy);
        best.score = p.score;
      } else
        tracksRef.current.push({
          id: ++trackIdRef.current,
          cx: p.cx,
          cy: p.cy,
          bbox: p.bbox,
          firstSeen: now,
          lastSeen: now,
          zone: zoneAtAtiv(ativ, p.cx, p.cy),
          score: p.score,
        });
    }
    tracksRef.current = tracksRef.current.filter((t) => now - t.lastSeen <= P.trackTimeoutMs);
  }

  function pushTimeline(text: string, sev: TimelineItem["sev"]) {
    setTimeline((p) =>
      [{ id: ++eventIdRef.current, ts: Date.now(), text, sev }, ...p].slice(
        0,
        APP_CONFIG.timeline.maxItems,
      ),
    );
  }

  useEffect(() => {
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(loop);
      const canvas = canvasRef.current,
        viewport = viewportRef.current;
      if (!canvas || !viewport) return;
      const proc = procRef.current ?? (procRef.current = document.createElement("canvas")); // canvas de motion offscreen
      const f = getFrame();
      if (!f || !f.w || !f.h) return;
      // ── GATE de "frame novo": o loop roda no refresh do monitor (~60fps), mas o frame chega a
      //    ~15fps. Se o ImageBitmap (identidade do `el`) / `ts` não mudou desde o último processamento,
      //    pula o tick inteiro (motion + luma + detecção + draw) — evita reprocessar o mesmo pixel ~4×.
      //    (mesmo padrão do FadigaProcessor: `idEl !== snap.lastEl`). ──
      if (f.el === lastFrameElRef.current && (f.ts == null || f.ts === lastFrameTsRef.current))
        return;
      lastFrameElRef.current = f.el;
      lastFrameTsRef.current = f.ts ?? 0;
      const now = performance.now();
      meterRef.current.tick(now);
      // CINE: alimenta o ring buffer com o MESMO frame que já passou pelo gate (sem decode extra).
      // Só na câmera aberta (full) e fora da revisão — em revisão o buffer fica congelado/estável.
      // LGPD: tudo em memória/efêmero; nada é enviado/persistido (ver cineBuffer.ts).
      captureFrame(f.el, f.w, f.h, now, Date.now());
      if (pausedRef.current) return; // ⏸ inspeção: congela o frame (não processa nem redesenha)
      const frameDt = lastFrameAtRef.current ? now - lastFrameAtRef.current : 0;
      lastFrameAtRef.current = now;
      const zs = zonesRef.current;
      const ativ = zs.filter((z) => z.modo === "atividade");

      // ── nível de frame: motion luma + coco-ssd (só se houver zona de atividade) ──
      // (2.5) LONGO ALCANCE: a luma de movimento é produzida AQUI, 1× por câmera, já na resolução
      // do perfil (longRange.procWidth=480) e compartilhada com TODAS as zonas via ctx.luma — antes
      // cada AtividadeProcessor re-rasterizava o frame inteiro a 480px por frame. Os ratios/limiares
      // LR seguem no processador (inalterados). Toggle em runtime: pw muda → o check de tamanho
      // abaixo invalida canvas/buffers de luma (sem vazamento, sem diff entre resoluções distintas).
      const pw = longRangeRef.current ? APP_CONFIG.detection.longRange.procWidth : C.procWidth,
        ph = Math.max(1, Math.round((pw * f.h) / f.w));
      let luma: Float32Array | null = null;
      let prev = prevLumaRef.current;
      if (ativ.length) {
        const size = pw * ph;
        if (proc.width !== pw || proc.height !== ph || lumaSizeRef.current !== size) {
          proc.width = pw;
          proc.height = ph;
          lumaSizeRef.current = size;
          prevLumaRef.current = null;
          curLumaRef.current = null;
          prev = null; // tamanho mudou → invalida buffers
        }
        const pctx = proc.getContext("2d", { willReadFrequently: true })!;
        pctx.drawImage(f.el, 0, 0, pw, ph);
        const img = pctx.getImageData(0, 0, pw, ph).data;
        // buffer reutilizável p/ a luma atual (swap com o anterior no fim) — evita new Float32Array por frame (P2)
        let cur = curLumaRef.current;
        if (!cur || cur.length !== size) cur = new Float32Array(size);
        for (let i = 0, j = 0; i < img.length; i += 4, j++)
          cur[j] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
        luma = cur;
        // Inferência FORA da main thread (worker), via SCHEDULER global (fila única + prioridade).
        // (2.4a) 1 TILE = 1 TAREFA: `detectFrame` recebe `schedule` e enfileira CADA tile como uma
        // tarefa própria (`${key}:t<i>`) — a câmera ABERTA (high) intercala entre os tiles de um
        // lote da grade (low) em vez de esperar o lote inteiro (~0,5–1,3s com 16 tiles LR). Por isso
        // NÃO se embrulha mais detectFrame em requestInference (deadlock com maxConcurrent=1).
        // O gate de voo (objBusy) agora vale TAMBÉM no full: com os tiles em tarefas separadas, a
        // coalescência por key única deixou de descartar o lote pendente — o gate garante no máximo
        // 1 detectFrame em voo por câmera (o próximo dispara com o frame mais novo ao concluir).
        // Na GRADE roda numa cadência MUITO menor (TILE_OBJECT_INTERVAL_MS); com longo alcance,
        // detect.ts ainda faz TILE ROTATION (K de 16 tiles por chamada, fundindo com cache — 2.4b).
        // O motion (acima) e a máquina de estado por zona seguem em tempo real.
        const objInterval = mode === "full" ? C.objectIntervalMs : TILE_OBJECT_INTERVAL_MS;
        const objBusy = objInFlightRef.current;
        if (now - lastObjAtRef.current > objInterval && !objBusy) {
          lastObjAtRef.current = now;
          objInFlightRef.current = true;
          const el = f.el,
            fw = f.w,
            fh = f.h,
            tiled = mode === "full";
          // Longo alcance: liga o tiling na GRADE (mesmo fora do full) + tile maior + limiar baixo.
          const LR = APP_CONFIG.detection.longRange;
          const schedule = {
            key: `${cameraId}:atividade`,
            priority: mode === "full" ? ("high" as const) : ("low" as const),
          };
          const opts = longRangeRef.current
            ? { tiles: LR.tiles, tileWidth: LR.detectTileWidth, minScore: LR.minScore, schedule }
            : { schedule };
          detectFrame(el, fw, fh, tiled, opts)
            .then((res) => {
              if (res) detsRef.current = res;
            })
            .catch(() => {})
            .finally(() => {
              objInFlightRef.current = false;
            });
        }
      }
      const dets = detsRef.current;
      if (ativ.length) updateTracks(dets, ativ, f.w, f.h, now);
      const tracks = tracksRef.current;
      if (tracks.length > peakRef.current) peakRef.current = tracks.length;

      // ── Tripwires + ocupação (Onda C item 13) — REUSA os tracks já existentes (sem inferência extra) ──
      // counter/occupancy criados 1x (sob demanda); a geometria é re-setada via effect quando as linhas mudam.
      const counter =
        counterRef.current ??
        (counterRef.current = createCounter(tripwiresRef.current, { minMove: 0.01, ttl: 1500 }));
      const occ =
        occRef.current ??
        (occRef.current = createOccupancy({
          cols: HEAT_COLS,
          rows: HEAT_ROWS,
          decay: 0.97,
          addAmount: 0.6,
          max: 6,
        }));
      const tps = tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy }));
      const crossings = counter.update(tps, now);
      for (const ev of crossings) {
        const wi = tripwiresRef.current.findIndex((w) => w.id === ev.tripwireId);
        pushTimeline(
          `${ev.dir === "in" ? "Entrada" : "Saída"} · Linha ${wi >= 0 ? wi + 1 : "?"}`,
          "info",
        );
      }
      if (crossings.length) twCountsRef.current = counter.counts(); // só re-snapshota quando há evento (HUD do canvas)
      occ.add(tps.map((t) => ({ x: t.cx, y: t.cy }))); // decai + acumula ocupação 1x/frame (heatmap)

      const sampleFlow = now - lastFlowAtRef.current > 500;
      const recEmit = now - lastRecAtRef.current > 3000;
      const recSamples: ZoneSample[] = [];

      // ── por zona ──
      for (const z of zs) {
        const h = holderFor(z);
        // P0/P2: leitura (ZXing), objetos (OWL-ViT) e fadiga (MediaPipe/coco) rodam o processador na
        // MAIN THREAD → são a maior fonte de jank na grade. Na GRADE (tile) rebaixamos essa inferência
        // PESADA a TILE_HEAVY_INTERVAL_MS por zona; nos frames pulados mantemos o ÚLTIMO resultado em
        // resultsRef (overlay/painel atualizam devagar). Na câmera ABERTA (full) roda todo frame.
        // ATIVIDADE fica FORA deste gate: motion + máquina de estado + alarme por zona seguem em tempo
        // real inclusive na grade (análise LEVE essencial — não pode parar com a câmera fechada).
        if (z.modo !== "atividade" && mode !== "full") {
          const lastHeavy = lastHeavyAtRef.current.get(z.id) ?? 0;
          if (now - lastHeavy < TILE_HEAVY_INTERVAL_MS) continue;
          lastHeavyAtRef.current.set(z.id, now);
        }
        if (z.modo === "atividade") {
          const ctx: AtividadeCtx = {
            now,
            frameDt,
            demoMode,
            paused: pausedRef.current,
            luma,
            prev,
            pw,
            ph,
            dets,
            frameW: f.w,
            frameH: f.h,
            tracks,
            sampleFlow,
            recEmit,
            // (2.5) Fallback do modo longo alcance: a luma LR já é produzida ACIMA (1× por câmera,
            // em longRange.procWidth) e chega via ctx.luma; o processador só re-rasteriza a partir
            // de frameEl se ctx.luma vier ausente (callers que não produzem a luma no frame).
            frameEl: f.el,
          };
          const az = {
            id: z.id,
            label: z.label,
            x: z.x,
            y: z.y,
            w: z.w,
            h: z.h,
            idleAlertMs: z.idleAlertMs,
            sensitivity: z.sensitivity,
            atividade: z.atividade,
            contains: containsFn(z),
          };
          const r = (h.proc as AtividadeProcessor).process(az, ctx);
          resultsRef.current.set(z.id, { modo: "atividade", view: r.view });
          if (r.sample) recSamples.push(r.sample);
          if (r.event) pushTimeline(r.event.text, r.event.sev);
          if (r.alert) {
            onAlertRef.current?.(`⚠ ${label}: ${r.alert.text}`);
            recordAlert({
              cameraId,
              cameraLabel: label,
              zoneId: r.alert.zoneId,
              area: r.alert.area,
              atividade: r.alert.atividade,
              ts: Date.now(),
              durationMin: r.alert.durationMin,
            });
          }
        } else if (z.modo === "leitura") {
          const r = (h.proc as LeituraProcessor).process(
            { x: z.x, y: z.y, w: z.w, h: z.h, ponto: z.ponto },
            { frame: f, now, cameraId, cameraLabel: label },
          );
          r.reads.forEach((rd) => recordReads(pushRead(rd)));
          r.passes.forEach((ps) => {
            const pr = pushPass(ps);
            if (pr.newPassage) recordPass(ps.ponto, ps.ts);
          });
          const prevR = resultsRef.current.get(z.id);
          const lastCode = r.reads.length
            ? r.reads[r.reads.length - 1].code
            : prevR && prevR.modo === "leitura"
              ? prevR.lastCode
              : null;
          resultsRef.current.set(z.id, {
            modo: "leitura",
            lastCode,
            perMin: r.perMin,
            passes: r.passesCount,
            ratePct: r.ratePct,
            noReads: r.noReads,
          });
        } else if (z.modo === "objetos") {
          const r = (h.proc as ObjetosProcessor).process(
            [{ id: z.id, label: z.label, x: z.x, y: z.y, w: z.w, h: z.h, contains: containsFn(z) }],
            z.selectedClasses,
            { frame: f, now },
          );
          r.events.forEach((e) => recordObjectEvent(e));
          r.alerts.forEach((a) => onAlertRef.current?.(a));
          if (r.samples) recordObjectSamples({ samples: r.samples });
          const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
          resultsRef.current.set(z.id, { modo: "objetos", counts: r.counts, total, dets: r.dets });
        } else {
          // FADIGA: recorta a ROI da zona e roda o pipeline do operador nela (1 operador por zona).
          const r = (h.proc as FadigaProcessor).process({ frame: cropFor(z, f), now, srcEl: f.el });
          r.events.forEach((e) => {
            recordFadigaEvent({ posto: z.label, type: e.type, ts: e.ts });
            pushTimeline(`${z.label}: ${e.type}`, e.type === "bocejo" ? "info" : "high");
          });
          if (r.sample) recordFadigaSamples({ posto: z.label, ...r.sample });
          if (r.alertRisk)
            onAlertRef.current?.(`⚠ ${label} · ${z.label}: ${RISK_LABEL[r.alertRisk]}`);
          const s = r.snapshot;
          resultsRef.current.set(z.id, {
            modo: "fadiga",
            risk: s.risk,
            ear: s.ear,
            phone: !!s.phone,
            faceState: s.faceState,
            scene: r.scene,
          });
        }
      }

      // swap dos buffers de luma: a atual vira "anterior"; a anterior é reciclada p/ o próximo frame
      if (luma) {
        curLumaRef.current = prevLumaRef.current;
        prevLumaRef.current = luma;
      }
      if (sampleFlow) lastFlowAtRef.current = now;
      if (recEmit) {
        lastRecAtRef.current = now;
        if (recSamples.length) recordSamples({ cameraId, samples: recSamples });
      }

      // Em revisão o palco mostra um quadro do buffer (render dedicado) — NÃO sobrescreve com o ao vivo.
      // A inferência/alertas de fundo seguem rodando acima (só o desenho do palco para de avançar).
      if (!reviewRef.current) drawScene(canvas, viewport, f);

      if (now - lastUiRef.current > (mode === "full" ? 200 : 500)) {
        lastUiRef.current = now;
        // Telemetria lateral: amostra os indicadores na cadência de UI (sem custo de inferência).
        for (const [zid, r] of resultsRef.current) {
          if (r.modo === "atividade") {
            pushHist(zid, "motion", r.view.motion);
            pushHist(zid, "people", r.view.people);
          } else if (r.modo === "leitura") {
            pushHist(zid, "rate", r.ratePct);
            pushHist(zid, "perMin", r.perMin);
            pushHist(zid, "noReads", r.noReads);
          } else if (r.modo === "objetos") {
            pushHist(zid, "total", r.total);
          } else if (r.modo === "fadiga" && r.ear != null) {
            pushHist(zid, "ear", r.ear);
          }
        }
        // (1.10) comparar antes de setar: cada setState abaixo criava objeto NOVO a cada tick e
        // re-renderizava todo o JSX mesmo sem mudança visível. Mesma cadência, mesmo formato de
        // dado — só que sem mudança → nenhum setState → zero re-render.
        const pSig = panelSig(resultsRef.current);
        if (pSig !== lastPanelSigRef.current) {
          lastPanelSigRef.current = pSig;
          setPanel(new Map(resultsRef.current));
        }
        const tw = counterRef.current ? counterRef.current.counts() : {}; // contadores in/out do painel lateral
        const tSig = twSig(tw);
        if (tSig !== lastTwSigRef.current) {
          lastTwSigRef.current = tSig;
          setTwCounts(tw);
        }
        const fps = Math.round(meterRef.current.fps);
        if (fps !== lastFpsRef.current) {
          lastFpsRef.current = fps;
          setPerf({ fps });
        }
        const dwellable = tracks.filter((t) => now - t.firstSeen >= APP_CONFIG.people.dwellMinMs);
        const dwell = dwellable.length
          ? dwellable.reduce((a, t) => a + (now - t.firstSeen), 0) / dwellable.length
          : 0;
        const lp = lastPresenceRef.current;
        if (tracks.length !== lp.now || peakRef.current !== lp.peak || dwell !== lp.dwell) {
          lastPresenceRef.current = { now: tracks.length, peak: peakRef.current, dwell };
          setPresence({ now: tracks.length, peak: peakRef.current, dwell });
        }
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFrame, mode, demoMode, cameraId, label]);

  function drawScene(canvas: HTMLCanvasElement, viewport: HTMLDivElement, f: FrameSource) {
    const dpr = window.devicePixelRatio || 1;
    const vpW = viewport.clientWidth,
      vpH = viewport.clientHeight;
    if (canvas.width !== Math.round(vpW * dpr) || canvas.height !== Math.round(vpH * dpr)) {
      canvas.width = Math.round(vpW * dpr);
      canvas.height = Math.round(vpH * dpr);
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vpW, vpH);
    const cr = getContentRect(vpW, vpH, f.w, f.h);
    ctx.drawImage(f.el, cr.x, cr.y, cr.w, cr.h);
    const detailed = mode === "full";

    // Heatmap de ocupação (camada) — agora UNIFICADO na lib pura counting.ts (occ.grid() já normalizado 0..1).
    // Desenhado sob as geometrias, com ramp warn→critical (tokens). O toggle "heatmap" continua governando.
    if (layersRef.current.heatmap && occRef.current)
      drawOccupancyHeatmap(ctx, cr, occRef.current);

    // pessoas (tracks anônimos) — Presença (camada "caixas"; atenua abaixo da confiança)
    if (layersRef.current.boxes)
      drawTracks(ctx, cr, tracksRef.current, confRef.current, pausedRef.current && detailed);

    // Laço por-zona (retângulo/máscara + rótulo + detecções + overlay de fadiga) → ./camera/draw.
    // Passa os valores já resolvidos (refs/estado) + getMask; os gates de camada seguem lá dentro.
    drawZoneOverlays(
      ctx,
      cr,
      zonesRef.current,
      resultsRef.current,
      layersRef.current,
      confRef.current,
      detailed,
      getMask,
    );

    // Tripwires (linhas de contagem com direção) — SEMPRE visíveis (operador vê linhas + contagens).
    // Linha a→b (token --state-info) + seta de direção "in" via inwardNormal (token --state-neutral) + HUD in/out.
    drawTripwires(ctx, cr, tripwiresRef.current, twCountsRef.current);

    // grade de pintura (ao editar a máscara de uma zona)
    if (paintZoneId) drawPaintGrid(ctx, cr, DEFAULT_GRID.cols, DEFAULT_GRID.rows);

    // retângulo de uma nova zona em arraste
    drawZoneDraft(ctx, drawRef.current);

    // tripwire em traçado (clique em A, arrasta até B)
    drawTripwireDraft(ctx, twDrawRef.current);
  }

  // Cine-loop / revisão / snapshot / export de clipe → hook ./camera/useCineLoop
  // (render do quadro de revisão, play, enterReview/exitReview/scrubBy, downloadSnapshot, exportClip).

  // ── máscara (blueprint em grade) ──
  function getMask(z: Zone): Mask | null {
    const c = maskCacheRef.current.get(z.id);
    if (paintZoneId === z.id && c) return c.mask; // ao vivo durante a pintura
    if (!z.mask) return null;
    if (c && c.enc === z.mask) return c.mask;
    const m = decodeMask(z.mask);
    if (m) maskCacheRef.current.set(z.id, { enc: z.mask, mask: m });
    return m;
  }
  function ensureMaskForPaint(z: Zone): Mask {
    const c = maskCacheRef.current.get(z.id);
    if (c && paintZoneId === z.id) return c.mask;
    const m =
      decodeMask(z.mask) ?? maskFromRect(DEFAULT_GRID.cols, DEFAULT_GRID.rows, z.x, z.y, z.w, z.h);
    maskCacheRef.current.set(z.id, { enc: z.mask, mask: m });
    return m;
  }

  // ── editor de zonas ──
  function vpPoint(e: ReactMouseEvent) {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function normPoint(e: ReactMouseEvent): { nx: number; ny: number } | null {
    const f = getFrame(),
      viewport = viewportRef.current;
    if (!f || !viewport) return null;
    const r = viewport.getBoundingClientRect();
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const nx = (e.clientX - r.left - cr.x) / cr.w,
      ny = (e.clientY - r.top - cr.y) / cr.h;
    return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { nx, ny };
  }
  function paintAt(e: ReactMouseEvent) {
    const z = zonesRef.current.find((z) => z.id === paintZoneId);
    if (!z) return;
    const m = ensureMaskForPaint(z);
    const p = normPoint(e);
    if (!p) return;
    const { col, row } = cellAtNorm(m, p.nx, p.ny);
    paintBrush(m, col, row, brush - 1, !eraseRef.current);
  }
  function commitPaint() {
    const z = zonesRef.current.find((zz) => zz.id === paintZoneId);
    if (!z) return;
    const c = maskCacheRef.current.get(z.id);
    if (!c) return;
    const enc = encodeMask(c.mask);
    maskCacheRef.current.set(z.id, { enc, mask: c.mask });
    const bb = maskBBoxNorm(c.mask);
    patchZone(z.id, bb ? { mask: enc, x: bb.x, y: bb.y, w: bb.w, h: bb.h } : { mask: enc });
  }
  function onDown(e: ReactMouseEvent) {
    if (mode !== "full" || reviewRef.current) return; // em revisão o palco mostra o buffer — sem edição de zona
    if (!canConfigure) return; // RBAC: operador não cria/edita/pinta zonas (defensivo; controles já desabilitados)

    if (paintZoneId) {
      paintingRef.current = true;
      eraseRef.current = e.altKey || e.button === 2 || erase;
      paintAt(e);
      return;
    }
    if (tripwireMode) {
      const p = vpPoint(e);
      twDrawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
      return;
    }
    if (drawMode) {
      const p = vpPoint(e);
      drawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y };
    }
  }
  function onMove(e: ReactMouseEvent) {
    if (paintingRef.current) {
      paintAt(e);
      return;
    }
    if (twDrawRef.current?.active) {
      const p = vpPoint(e);
      twDrawRef.current.cx = p.x;
      twDrawRef.current.cy = p.y;
      return;
    }
    if (drawRef.current?.active) {
      const p = vpPoint(e);
      drawRef.current.cx = p.x;
      drawRef.current.cy = p.y;
    }
  }
  function onUp() {
    if (paintingRef.current) {
      paintingRef.current = false;
      commitPaint();
      return;
    }
    if (twDrawRef.current?.active) {
      commitTripwire();
      return;
    }
    const d = drawRef.current;
    if (!d?.active) return;
    drawRef.current = null;
    const f = getFrame(),
      viewport = viewportRef.current;
    if (!f || !viewport) return;
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const x0 = Math.min(d.sx, d.cx),
      y0 = Math.min(d.sy, d.cy),
      w = Math.abs(d.cx - d.sx),
      h = Math.abs(d.cy - d.sy);
    if (w < 16 || h < 16) return;
    const id = newZoneId(cameraId);
    const nz: Zone = {
      id,
      label: `Área ${zonesRef.current.length + 1}`,
      x: Math.max(0, (x0 - cr.x) / cr.w),
      y: Math.max(0, (y0 - cr.y) / cr.h),
      w: Math.min(1, w / cr.w),
      h: Math.min(1, h / cr.h),
      modo: "atividade" as ZoneMode,
      idleAlertMs: APP_CONFIG.zones.defaultIdleAlertMs,
      sensitivity: 5,
      atividade: "Indefinida",
      ponto: APP_CONFIG.reading.defaultPonto,
      selectedClasses: OBJECT_CATALOG.map((o) => o.key),
    };
    setZones((p) => persist([...p, nz]));
  }
  // Editor de tripwires (commitTripwire/invertTripwire/removeTripwire/resetCounts/toggleTripwireMode)
  // → hook ./camera/useTripwires. O onUp acima chama `commitTripwire` ao soltar uma linha traçada.
  // Modos de edição mutuamente exclusivos (não conflitar tripwire × zona × pintura).
  function toggleDrawMode() {
    setDrawMode((v) => {
      const nv = !v;
      if (nv) {
        setTripwireMode(false);
        setPaintZoneId(null);
      }
      return nv;
    });
  }

  // Write-through: aplica a edição já (retorna `next` p/ o setZones) e persiste no BACKEND, mantendo
  // o localStorage como cache/fallback. Em erro do PUT: toast (padrão existente) SEM perder a edição
  // local — o cache local garante a persistência offline; a central re-sincroniza depois.
  function persist(next: Zone[]): Zone[] {
    persistZones(cameraId, next).catch((e) => {
      const msg = e instanceof ApiError ? e.message : "Não foi possível salvar as zonas.";
      onAlertRef.current?.(`⚠ ${label}: ${msg}`);
    });
    return next;
  }
  function patchZone(id: string, patch: Partial<Zone>) {
    setZones((p) => persist(p.map((z) => (z.id === id ? { ...z, ...patch } : z))));
  }
  // MODO-COMO-PRESET: recarrega de uma vez camadas + confiança a partir do preset do modo,
  // e marca o preset ativo (governa o que o painel destaca). Não mexe em geometria/zonas.
  function applyPreset(mode: ModeKey) {
    const p = MODE_PRESETS[mode];
    setLayers({ ...p.layers });
    setConf(p.confidenceThreshold);
    setActivePreset(mode);
  }
  // Perfil "Longo alcance / Panorâmica" (por câmera, gated por canConfigure). Aplica na hora
  // (longRangeRef → próxima detecção usa opts; holderFor propaga setLongRange aos processadores) e
  // PERSISTE no backend via setCameraCfg (write-through; cache local mantém a UX offline).
  function onLongRangeChange(on: boolean) {
    setLongRange(on);
    longRangeRef.current = on; // efeito imediato no rAF (sem esperar o commit do estado)
    setCameraCfg(cameraId, { ...getCameraCfg(cameraId), longRange: on });
  }
  // Troca o modo de uma zona PRESERVANDO sua geometria/máscara/parâmetros e reaplica o preset.
  function changeZoneMode(z: Zone, next: ZoneMode) {
    patchZone(z.id, { modo: next });
    applyPreset(next);
  }
  function removeZone(id: string) {
    holdersRef.current.get(id)?.proc.dispose();
    holdersRef.current.delete(id);
    cropsRef.current.delete(id);
    resultsRef.current.delete(id);
    maskCacheRef.current.delete(id);
    clearZone(id);
    if (paintZoneId === id) setPaintZoneId(null);
    setZones((p) => persist(p.filter((z) => z.id !== id)));
  }
  function startPaint(z: Zone) {
    setDrawMode(false);
    setTripwireMode(false);
    ensureMaskForPaint(z);
    setPaintZoneId(z.id);
  }
  function clearActive() {
    const z = zonesRef.current.find((zz) => zz.id === paintZoneId);
    if (!z) return;
    clearMask(ensureMaskForPaint(z));
    commitPaint();
  }
  const paintZone = paintZoneId ? (zones.find((z) => z.id === paintZoneId) ?? null) : null;

  const summary = zones
    .map((z) => {
      const r = panel.get(z.id);
      const m =
        r?.modo === "atividade"
          ? r.view.state
          : r?.modo === "leitura"
            ? (r.lastCode ?? "—")
            : r?.modo === "objetos"
              ? `${r.total} obj`
              : r?.modo === "fadiga"
                ? RISK_LABEL[r.risk]
                : ZONE_MODE_LABEL[z.modo];
      return `${z.label}:${m}`;
    })
    .join(" · ");
  const alertCount = [...panel.values()].filter(
    (r) => r.modo === "atividade" && r.view.state === "ALERTA",
  ).length;

  // Legenda do overlay: só as cores realmente em uso (pelos modos/classes das zonas atuais).
  const legend: { color: string; label: string }[] = (() => {
    const out: { color: string; label: string }[] = [];
    const modes = new Set(zones.map((z) => z.modo));
    if (modes.has("atividade")) {
      out.push(
        { color: "var(--state-neutral)", label: "Ativa" },
        { color: "var(--state-warn)", label: "Lenta/Ociosa" },
        { color: "var(--state-critical)", label: "Alerta" },
        { color: "var(--state-info)", label: "Pessoa" },
      );
    }
    if (modes.has("leitura")) out.push({ color: "var(--state-info)", label: "Faixa de leitura" });
    if (modes.has("objetos")) {
      const keys = new Set(
        zones.filter((z) => z.modo === "objetos").flatMap((z) => z.selectedClasses),
      );
      for (const k of keys) {
        const o = objClass(k);
        if (o) out.push({ color: o.color, label: o.label });
      }
    }
    if (modes.has("fadiga"))
      out.push(
        { color: "var(--state-neutral)", label: "OK" },
        { color: "var(--state-warn)", label: "Alerta" },
        { color: "var(--state-critical)", label: "Duplo" },
      );
    return out;
  })();
  const cfgZone = cfgZoneId ? (zones.find((z) => z.id === cfgZoneId) ?? null) : null;
  // Preset ativo + se o operador divergiu dele manualmente nesta sessão (sobrepondo o preset).
  const activePresetDef = activePreset ? MODE_PRESETS[activePreset] : null;
  const presetDirty =
    !!activePresetDef &&
    (conf !== activePresetDef.confidenceThreshold ||
      (Object.keys(activePresetDef.layers) as (keyof OverlayLayers)[]).some(
        (k) => layers[k] !== activePresetDef.layers[k],
      ));

  // ── TILE ──
  if (mode === "tile") {
    return (
      <div className={`tile ${alertCount ? "alerting" : ""}`} onClick={onOpen} title="Abrir câmera">
        <div className="viewport tile-vp" ref={viewportRef}>
          <canvas ref={canvasRef} />
          <div className="tile-badges">
            {alertCount > 0 && <span className="tb alert">⚠ {alertCount}</span>}
          </div>
        </div>
        <div className="tile-foot">
          <span className="tile-name">{label}</span>
          <span className="tile-meta">
            {zones.length} zona(s){alertCount ? ` · ${alertCount} alerta` : ""}
          </span>
        </div>
      </div>
    );
  }

  // ── FULL (workspace) ──
  return (
    <div
      className="cam"
      ref={fullRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Câmera ${label} em tela cheia`}
    >
      <header className="cam-head">
        <div className="cam-title">
          <b>{label}</b>
          {paintZone ? (
            <span className="muted">pintando “{paintZone.label}”</span>
          ) : (
            <>
              <span className="muted">{zones.length} zona(s)</span>
              {activePresetDef && (
                <span
                  title={`Preset ativo: ${activePresetDef.label} — ${activePresetDef.description}${presetDirty ? " (ajustado manualmente nesta sessão)" : ""}`}
                >
                  <Badge tone={MODE_TONE[activePreset!]}>
                    {activePresetDef.label}
                    {presetDirty ? " ·" : ""}
                  </Badge>
                </span>
              )}
              {!canConfigure && (
                <span title="Edição de configuração requer perfil de engenharia">
                  <Badge tone="info">🔒 Somente leitura</Badge>
                </span>
              )}
            </>
          )}
        </div>
        <div className="spacer" />
        {paintZone ? (
          <>
            <IconButton label="Pincel (pintar)" active={!erase} onClick={() => setErase(false)}>
              🖌
            </IconButton>
            <IconButton
              label="Borracha (Alt/botão-direito também apagam)"
              active={erase}
              onClick={() => setErase(true)}
            >
              🧽
            </IconButton>
            <Select
              value={String(brush)}
              onChange={(v) => setBrush(Number(v))}
              options={BRUSH_OPTS}
              ariaLabel="Tamanho do pincel"
            />
            <Button onClick={clearActive}>Limpar</Button>
            <Button active onClick={() => setPaintZoneId(null)}>
              ✓ Concluir
            </Button>
          </>
        ) : (
          <>
            <Tooltip content="Congela o palco e abre a revisão dos últimos ~10s (cine-loop). Buffer em memória, nunca enviado ao servidor.">
              <Toggle pressed={review} onPressedChange={(v) => (v ? enterReview() : exitReview())}>
                {review ? "▶ Ao vivo" : "❄ Congelar"}
              </Toggle>
            </Tooltip>
            <Tooltip content="Congela o frame e rotula quem está em cena">
              <Toggle pressed={paused} disabled={review} onPressedChange={(v) => setPaused(v)}>
                {paused ? "▶ Retomar" : "⏸ Pausar"}
              </Toggle>
            </Tooltip>
            <Tooltip
              content={
                canConfigure
                  ? "Desenhar uma nova zona sobre o vídeo"
                  : "Requer perfil de engenharia"
              }
            >
              <Toggle
                pressed={drawMode}
                disabled={review || !canConfigure}
                onPressedChange={() => toggleDrawMode()}
              >
                {drawMode ? "Desenhando…" : "✎ Zona"}
              </Toggle>
            </Tooltip>
            <Tooltip
              content={
                canConfigure
                  ? "Desenhar uma linha de contagem (clique em A e arraste até B)"
                  : "Requer perfil de engenharia"
              }
            >
              <Toggle
                pressed={tripwireMode}
                disabled={review || !canConfigure}
                onPressedChange={() => toggleTripwireMode()}
              >
                {tripwireMode ? "Traçando…" : "⇄ Linha"}
              </Toggle>
            </Tooltip>
            <IconButton label="Fechar" onClick={onClose}>
              ✕
            </IconButton>
          </>
        )}
        {reviewTip && (
          <span className="muted" style={{ color: "var(--state-warn-fg, #fde68a)" }}>
            {reviewTip}
          </span>
        )}
      </header>

      <div
        className={`cam-stage ${drawMode || tripwireMode || paintZone ? "draw-cursor" : ""}`}
        ref={viewportRef}
        style={{ background: "var(--cam-surface-bg)" }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
        onContextMenu={(e) => {
          if (paintZone) e.preventDefault();
        }}
      >
        <canvas className="overlay" ref={canvasRef} />
        {review && (
          <>
            <div className="cine-flag">
              <span className="dot" /> REVISÃO · cine-loop (buffer em memória)
            </div>
            <div className="cine-bar">
              <IconButton label="Quadro anterior" onClick={() => scrubBy(-1)}>
                ‹
              </IconButton>
              <Tooltip content={cinePlaying ? "Pausar reprodução" : "Reproduzir cine-loop"}>
                <Toggle
                  aria-label={cinePlaying ? "Pausar reprodução" : "Reproduzir cine-loop"}
                  pressed={cinePlaying}
                  onPressedChange={(v) => setCinePlaying(v)}
                >
                  {cinePlaying ? "⏸" : "▶"}
                </Toggle>
              </Tooltip>
              <IconButton label="Próximo quadro" onClick={() => scrubBy(1)}>
                ›
              </IconButton>
              <div className="cine-slider">
                <Slider
                  value={scrubIndex}
                  min={0}
                  max={Math.max(0, cineSize - 1)}
                  step={1}
                  onChange={(v) => {
                    setCinePlaying(false);
                    setScrubIndex(v);
                  }}
                  ariaLabel="Posição no cine-loop"
                />
              </div>
              <span className="cine-time">
                {cineRef.current
                  ? `${cineRef.current.relativeSeconds(scrubIndex).toFixed(1)}s`
                  : "0.0s"}
              </span>
              <span className="cine-count">
                {cineSize ? scrubIndex + 1 : 0}/{cineSize}
              </span>
              <span className="cine-spacer" />
              <Button
                onClick={downloadSnapshot}
                disabled={clipState === "working"}
                title="Baixar este quadro como PNG (download local — nunca enviado ao servidor)"
              >
                ⤓ Snapshot
              </Button>
              <Button
                onClick={exportClip}
                disabled={clipState === "working"}
                title="Exporta a janela do cine-loop como clipe (WebM) — download local, nunca enviado ao servidor. Fallback: montagem PNG se o navegador não suportar."
              >
                {clipState === "working" ? `Gravando… ${clipPct}%` : "⤓ Exportar clipe"}
              </Button>
              <Button active onClick={exitReview}>
                ▶ Ao vivo
              </Button>
            </div>
          </>
        )}
        <aside
          className="cam-drawer"
          style={{
            background: "var(--cam-panel-bg)",
            color: "var(--cam-panel-fg)",
            borderLeftColor: "var(--cam-panel-border)",
          }}
        >
          <Tabs
            className="drawer-tabs"
            value={drawerTab}
            onValueChange={(v) =>
              setDrawerTab(v as "zonas" | "linhas" | "timeline" | "presenca" | "camadas")
            }
            ariaLabel="Aba do painel"
            items={[
              { value: "zonas", label: `Zonas (${zones.length})` },
              { value: "linhas", label: `Linhas (${tripwires.length})` },
              { value: "camadas", label: "Camadas" },
              { value: "timeline", label: "Timeline" },
              { value: "presenca", label: "Presença" },
            ]}
          >
            <ScrollArea className="drawer-scroll" viewportClassName="drawer-scroll-vp">
              <TabsContent value="zonas">
                {zonesLoading && <p className="empty-note">Carregando zonas…</p>}
                {!zonesLoading && zones.length === 0 && (
                  <p className="empty-note">
                    {canConfigure
                      ? "Use “✎ Zona” para desenhar uma área e escolher o modo."
                      : "Nenhuma zona configurada. A edição de zonas requer perfil de engenharia."}
                  </p>
                )}
                {zones.map((z) => {
                  const r = panel.get(z.id);
                  const st = r?.modo === "atividade" ? r.view.state : "ATIVA";
                  return (
                    <div key={z.id} className={`zone ${st}`}>
                      <div className="row">
                        <span className="zone-head">
                          <b className="zone-name" title={z.label}>
                            {z.label}
                          </b>
                          <Badge tone={MODE_TONE[z.modo]}>{ZONE_MODE_LABEL[z.modo]}</Badge>
                        </span>
                        <span className="zone-tools">
                          <Tooltip
                            content={
                              canConfigure
                                ? "Configurar zona (modo e parâmetros)"
                                : "Configuração requer perfil de engenharia"
                            }
                          >
                            <button
                              className="del"
                              disabled={!canConfigure}
                              aria-label="Configurar zona"
                              onClick={() => canConfigure && setCfgZoneId(z.id)}
                            >
                              ⚙
                            </button>
                          </Tooltip>
                          <Tooltip
                            content={
                              canConfigure
                                ? "Pintar a área (blueprint em grade)"
                                : "Edição requer perfil de engenharia"
                            }
                          >
                            <button
                              className={`del ${paintZoneId === z.id ? "on" : ""}`}
                              disabled={!canConfigure}
                              aria-label="Pintar área"
                              onClick={() =>
                                canConfigure &&
                                (paintZoneId === z.id ? setPaintZoneId(null) : startPaint(z))
                              }
                            >
                              🖌
                            </button>
                          </Tooltip>
                          <Tooltip
                            content={
                              canConfigure ? "Remover zona" : "Remover requer perfil de engenharia"
                            }
                          >
                            <button
                              className="del"
                              disabled={!canConfigure}
                              aria-label="Remover zona"
                              onClick={() => canConfigure && removeZone(z.id)}
                            >
                              ✕
                            </button>
                          </Tooltip>
                        </span>
                      </div>

                      {z.modo === "atividade" &&
                        (r?.modo === "atividade" ? (
                          (() => {
                            const ms = stateToMetric(r.view.state);
                            const activeThr = sensitivityFactor(z.sensitivity) / 6; // limiar ATIVA em unidades de view.motion
                            return (
                              <>
                                {/* estado/parada: indicadores categóricos/temporais (mantidos como KPI) */}
                                <div className="kpis ws-kpis">
                                  <div className="kpi">
                                    <div
                                      className="v"
                                      style={{ color: stateVar(r.view.state), fontSize: 13 }}
                                    >
                                      {r.view.state}
                                    </div>
                                    <div className="l">estado</div>
                                  </div>
                                  <div className="kpi">
                                    <div className="v">{fmtDuration(r.view.idleMs)}</div>
                                    <div className="l">parada</div>
                                  </div>
                                </div>
                                {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                                <MetricCell
                                  label="Movimento"
                                  value={`${Math.round(r.view.motion * 100)}%`}
                                  values={hist(z.id, "motion")}
                                  band={{ lo: activeThr, hi: 1 }}
                                  bandLabel="alvo: zona ativa"
                                  state={ms}
                                  min={0}
                                  max={1}
                                />
                                <MetricCell
                                  label="Ocupação"
                                  value={`${r.view.people}`}
                                  values={hist(z.id, "people")}
                                  band={OCC_BAND}
                                  bandLabel={`alvo 1–${OCC_HI} pessoas`}
                                  state={occMetric(r.view.people)}
                                  min={0}
                                />
                                <div className="zone-flow">
                                  <span>Fluxo</span>
                                  <span className={`flow-chip ${r.view.flowLevel}`}>
                                    {r.view.flowLevel}
                                  </span>
                                  <span className="spark">
                                    {r.view.flow.map((s, i) => (
                                      <i
                                        key={i}
                                        style={{ height: `${Math.max(6, Math.round(s * 100))}%` }}
                                      />
                                    ))}
                                  </span>
                                </div>
                              </>
                            );
                          })()
                        ) : (
                          <p className="ws-wait">iniciando…</p>
                        ))}

                      {z.modo === "leitura" &&
                        (r?.modo === "leitura" ? (
                          <>
                            {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                            <MetricCell
                              label="Taxa de leitura"
                              value={`${r.ratePct}%`}
                              values={hist(z.id, "rate")}
                              band={RATE_BAND}
                              bandLabel="alvo ≥ 95%"
                              state={rateToMetric(r.ratePct)}
                              min={0}
                              max={100}
                            />
                            <MetricCell
                              label="Lidas/min"
                              value={`${r.perMin}`}
                              values={hist(z.id, "perMin")}
                              min={0}
                            />
                            <MetricCell
                              label="No-reads"
                              value={`${r.noReads}`}
                              values={hist(z.id, "noReads")}
                              band={NOREAD_BAND}
                              bandLabel="alvo 0"
                              state={noReadMetric(r.noReads)}
                              min={0}
                            />
                            <div className="ws-code">
                              <span className="muted">último código</span>
                              <code>{r.lastCode ?? "—"}</code>
                            </div>
                            <div className="ws-metric-row">
                              Ponto <b>{z.ponto}</b> · {r.passes} passagens
                            </div>
                          </>
                        ) : (
                          <p className="ws-wait">iniciando…</p>
                        ))}

                      {z.modo === "objetos" && (
                        <>
                          <div className="ws-counts">
                            {z.selectedClasses.length === 0 && (
                              <span className="muted">nenhuma classe — abra ⚙</span>
                            )}
                            {z.selectedClasses.map((k) => {
                              const o = objClass(k);
                              const n = r?.modo === "objetos" ? (r.counts[k] ?? 0) : 0;
                              return (
                                <span
                                  key={k}
                                  className={`count-chip ${n > 0 ? "on" : ""}`}
                                  style={
                                    n > 0 ? { borderColor: o?.color, color: o?.color } : undefined
                                  }
                                  title={o?.label}
                                >
                                  {o?.emoji} <b>{n}</b>
                                </span>
                              );
                            })}
                          </div>
                          {/* telemetria: total em cena com tendência (sem faixa-alvo fixa — depende da cena) */}
                          <MetricCell
                            label="Total em cena"
                            value={`${r?.modo === "objetos" ? r.total : 0}`}
                            values={hist(z.id, "total")}
                            min={0}
                          />
                        </>
                      )}

                      {z.modo === "fadiga" && (
                        <>
                          <div className="ws-fadiga">
                            {r?.modo === "fadiga" && r.faceState === "ready" ? (
                              <>
                                <Badge tone={RISK_TONE[r.risk]}>{RISK_LABEL[r.risk]}</Badge>
                                <span className="muted">📱 {r.phone ? "sim" : "não"}</span>
                              </>
                            ) : (
                              <span className="muted">
                                {r?.modo === "fadiga"
                                  ? r.faceState === "loading"
                                    ? "carregando modelo…"
                                    : "modelo falhou"
                                  : "iniciando…"}
                              </span>
                            )}
                          </div>
                          {r?.modo === "fadiga" && r.faceState === "ready" && (
                            /* telemetria "nunca número cru": EAR com faixa-alvo (olhos abertos) */
                            <MetricCell
                              label="EAR (abertura ocular)"
                              value={r.ear == null ? "--" : r.ear.toFixed(2)}
                              values={hist(z.id, "ear")}
                              band={{ lo: APP_CONFIG.fadiga.eyesClosedEarThreshold, hi: EAR_HI }}
                              bandLabel={`alvo ≥ ${APP_CONFIG.fadiga.eyesClosedEarThreshold.toFixed(2)}`}
                              state={riskToMetric(r.risk)}
                              min={0}
                              max={EAR_HI}
                            />
                          )}
                          <p className="empty-note" style={{ margin: "4px 0 0" }}>
                            Monitora 1 operador na ROI da zona (recorte). Som/calibração na câmera
                            dedicada.
                          </p>
                        </>
                      )}
                    </div>
                  );
                })}
                {legend.length > 0 && (
                  <div className="ws-legend">
                    <div className="ws-legend-title">Legenda do overlay</div>
                    <div className="ws-legend-items">
                      {legend.map((e, i) => (
                        <span key={i} className="leg">
                          <i style={{ background: e.color }} />
                          {e.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </TabsContent>

              <TabsContent value="linhas">
                <div className="row" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-2)" }}>
                  <Button
                    size="sm"
                    active={tripwireMode}
                    disabled={!canConfigure}
                    onClick={toggleTripwireMode}
                    title={
                      canConfigure
                        ? "Clique em A e arraste até B sobre o vídeo"
                        : "Edição requer perfil de engenharia"
                    }
                  >
                    {tripwireMode ? "Traçando…" : "⇄ Nova linha"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={resetCounts}
                    title="Zera os contadores in/out desta sessão (geometria mantida)"
                  >
                    ↺ Zerar contagem
                  </Button>
                </div>
                {tripwires.length === 0 && (
                  <p className="empty-note">
                    {canConfigure
                      ? "Use “⇄ Nova linha” e arraste sobre o vídeo (A→B). Cruzar da esquerda→direita da seta conta como Entrada; o sentido oposto, Saída."
                      : "Nenhuma linha de contagem configurada. A edição requer perfil de engenharia."}
                  </p>
                )}
                {tripwires.map((w, i) => {
                  const c = twCounts[w.id] ?? { in: 0, out: 0 };
                  return (
                    <div key={w.id} className="zone">
                      <div className="row">
                        <span className="zone-head">
                          <b className="zone-name">Linha {i + 1}</b>
                          <Badge tone="info">contagem</Badge>
                        </span>
                        <span className="zone-tools">
                          <Tooltip
                            content={
                              canConfigure
                                ? "Inverter direção (troca Entrada↔Saída)"
                                : "Edição requer perfil de engenharia"
                            }
                          >
                            <button
                              className="del"
                              disabled={!canConfigure}
                              aria-label="Inverter direção"
                              onClick={() => canConfigure && invertTripwire(w.id)}
                            >
                              ⇄
                            </button>
                          </Tooltip>
                          <Tooltip
                            content={
                              canConfigure ? "Remover linha" : "Remover requer perfil de engenharia"
                            }
                          >
                            <button
                              className="del"
                              disabled={!canConfigure}
                              aria-label="Remover linha"
                              onClick={() => canConfigure && removeTripwire(w.id)}
                            >
                              ✕
                            </button>
                          </Tooltip>
                        </span>
                      </div>
                      <div className="kpis ws-kpis">
                        <div className="kpi">
                          <div className="v" style={{ color: "var(--state-info)" }}>
                            {c.in}
                          </div>
                          <div className="l">entradas</div>
                        </div>
                        <div className="kpi">
                          <div className="v" style={{ color: "var(--state-neutral)" }}>
                            {c.out}
                          </div>
                          <div className="l">saídas</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <p className="empty-note" style={{ marginTop: "var(--sp-2)" }}>
                  A contagem reusa o rastreio de pessoas já em cena (sem inferência extra) — depende
                  de ao menos uma zona de Atividade ativa p/ detectar pessoas. Contadores são por
                  sessão.
                </p>
              </TabsContent>

              <TabsContent value="timeline">
                {timeline.length === 0 ? (
                  <p className="empty-note">Sem eventos.</p>
                ) : (
                  <ul className="tl">
                    {timeline.map((e) => (
                      <li key={e.id}>
                        <span className={`dot ${e.sev}`} />
                        <span className="t">{clock(new Date(e.ts))}</span>
                        <span>{e.text}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="presenca">
                <div className="kpis">
                  <div className="kpi">
                    <div className="v">{presence.now}</div>
                    <div className="l">agora</div>
                  </div>
                  <div className="kpi">
                    <div className="v">{presence.peak}</div>
                    <div className="l">pico</div>
                  </div>
                  <div className="kpi">
                    <div className="v">{fmtDuration(presence.dwell)}</div>
                    <div className="l">permanência</div>
                  </div>
                </div>
                <p className="empty-note" style={{ marginTop: 8 }}>
                  Pessoas recebem ID efêmero (sem identidade); reseta por sessão.
                  {paused ? " ⏸ Pausado: rótulos com tempo em cena." : ""}
                </p>
              </TabsContent>

              <TabsContent value="camadas">
                {activePresetDef && (
                  <div
                    style={{
                      marginBottom: "var(--sp-3)",
                      padding: "var(--sp-2)",
                      borderRadius: 8,
                      border: "1px solid var(--cam-panel-border)",
                      background: "var(--cam-surface-bg)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "var(--sp-2)",
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: ".4px",
                          color: "var(--text-dim)",
                        }}
                      >
                        Preset ativo
                      </span>
                      <Badge tone={MODE_TONE[activePreset!]}>{activePresetDef.label}</Badge>
                      {presetDirty && (
                        <span style={{ fontSize: 11, color: "var(--state-warn-fg, #fde68a)" }}>
                          · ajustado
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--cam-panel-fg)" }}>
                      {activePresetDef.description}
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                      {activePresetDef.metrics.map((m) => (
                        <span
                          key={m.key}
                          style={{
                            fontSize: 11,
                            padding: "2px 7px",
                            borderRadius: 999,
                            border: "1px solid var(--cam-panel-border)",
                            color: "var(--cam-panel-fg)",
                          }}
                        >
                          {m.label}
                        </span>
                      ))}
                    </div>
                    {presetDirty && (
                      <div style={{ marginTop: "var(--sp-2)" }}>
                        <Button
                          size="sm"
                          onClick={() => applyPreset(activePreset!)}
                          title="Restaura camadas e confiança do preset deste modo."
                        >
                          ↺ Reaplicar preset
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                {(
                  [
                    ["boxes", "Caixas / detecções"],
                    ["mask", "Máscara (área pintada)"],
                    ["zones", "Zonas (retângulos)"],
                    ["heatmap", "Heatmap de ocupação"],
                  ] as [keyof OverlayLayers, string][]
                ).map(([k, lbl]) => (
                  <ToggleRow
                    key={k}
                    label={lbl}
                    checked={layers[k]}
                    onCheckedChange={(v) => setLayers((s) => ({ ...s, [k]: v }))}
                  />
                ))}
                <div style={{ marginTop: "var(--sp-3)" }}>
                  <Field
                    label={`Confiança mínima · ${Math.round(conf * 100)}%`}
                    hint="Filtra/atenua detecções abaixo do limiar sobre o vídeo (em tempo real)."
                  >
                    <div className="cfg-slider">
                      <span className="ss-end">0</span>
                      <Slider
                        value={Math.round(conf * 100)}
                        min={0}
                        max={100}
                        step={5}
                        onChange={(v) => setConf(v / 100)}
                        ariaLabel="Confiança mínima"
                      />
                      <span className="ss-end">100</span>
                    </div>
                  </Field>
                </div>
                <p className="empty-note" style={{ marginTop: "var(--sp-2)" }}>
                  Camadas e confiança seguem o preset do modo ativo; ajustes manuais valem só nesta
                  sessão e sobrepõem o preset (padrões em APP_CONFIG.overlay / MODE_PRESETS).
                  Heatmap acumula a presença de pessoas.
                </p>

                {/* Perfil de detecção da CÂMERA (persiste no backend) — só engenharia edita. */}
                {canConfigure && (
                  <div
                    style={{
                      marginTop: "var(--sp-3)",
                      padding: "var(--sp-2)",
                      borderRadius: 8,
                      border: "1px solid var(--cam-panel-border)",
                      background: "var(--cam-surface-bg)",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "var(--sp-2)",
                      }}
                    >
                      <span>Longo alcance / Panorâmica</span>
                      <Switch
                        checked={longRange}
                        onCheckedChange={onLongRangeChange}
                        ariaLabel="Longo alcance / Panorâmica"
                      />
                    </div>
                    <p className="empty-note" style={{ margin: "6px 0 0" }}>
                      Para câmeras panorâmicas/de longo alcance (ex.: rua vista de cima): detecta
                      objetos pequenos/distantes com mais tiles e limiares menores; usa mais CPU.
                    </p>
                  </div>
                )}
              </TabsContent>
            </ScrollArea>
          </Tabs>
        </aside>
      </div>

      <div className="cam-kpibar">
        <span className="kb">
          ◉ <b>{presence.now}</b> pessoas
        </span>
        <span className="kb">
          ⏱ <b>{fmtDuration(presence.dwell)}</b> permanência
        </span>
        <span className="kb muted">pico {presence.peak}</span>
        <span
          className="kb muted"
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {summary || "sem zonas"}
        </span>
        <span className="kb muted">FPS {perf.fps}</span>
        {paused && <span className="kb muted">⏸ inspecionando</span>}
      </div>

      <ConfigZonaDialog
        zone={cfgZone}
        demoMode={demoMode}
        histState={histState}
        histDataset={histDataset}
        onClose={() => setCfgZoneId(null)}
        patchZone={patchZone}
        changeZoneMode={changeZoneMode}
      />
    </div>
  );
}
