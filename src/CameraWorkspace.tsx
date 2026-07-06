import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { APP_CONFIG, MODE_PRESETS, type OverlayLayers, type ModeKey } from "./config";
import { type FrameSource } from "./frame";
import { fmtDuration } from "./format";
import { FrameMeter } from "./telemetry";
import { type Detection } from "./vision/model";
import { ensureDetectClient, detectFrame, getDetectBackend } from "./vision/detect";
import { filterExcludedPersons, type AtividadeCtx } from "./processors/atividade";
import { pushRead, pushPass } from "./reading/cluster";
import {
  recordSamples,
  recordAlert,
  recordReads,
  recordPass,
  recordFlow,
  recordObjectSamples,
  recordObjectEvent,
  recordFadigaSamples,
  recordFadigaEvent,
  loadDataset,
  type ZoneSample,
} from "./report/store";
import { type Dataset } from "./report/mock";
import { OBJECT_CATALOG } from "./objects/catalog";
import {
  loadZonesForCamera,
  persistZones,
  newZoneId,
  assignZone,
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
import {
  createCounter,
  createOccupancy,
  type Occupancy,
  type TripwireCounts,
} from "./vision/counting";
import { createByteTracker, type ByteTracker } from "./vision/bytetrack";
import { createLumaSource, type LumaSource } from "./vision/luma";
import { schedulerStats } from "./vision/scheduler";
import { shouldIngest } from "./camera/ingestPolicy";
import { panelSig, twSig, dominantMode, legendFor } from "./camera/derive";
import { holderFor as holderForZone, type Holder } from "./camera/holders";
import { useFocusTrap } from "./camera/useFocusTrap";
import type { HubAnalysis, Track } from "./types/analysis";
import {
  Button,
  IconButton,
  Select,
  Slider,
  Tabs,
  TabsContent,
  ScrollArea,
  Toggle,
  Tooltip,
  Badge,
} from "./ui";
import { useCineLoop } from "./camera/useCineLoop";
import { useTripwires } from "./camera/useTripwires";
import { useAuth } from "./auth";
import {
  getContentRect,
  cssVar,
  drawOccupancyHeatmap,
  drawTracks,
  drawTripwires,
  drawPaintGrid,
  drawZoneDraft,
  drawTripwireDraft,
  drawZoneOverlays,
  drawTelemetryHud,
  RISK_LABEL,
  type ZoneResult,
  type TrackBox,
} from "./camera/draw";
import { ConfigZonaDialog } from "./camera/ConfigZonaDialog";
import { useTelemetry } from "./camera/useTelemetry";
import { useWebrtcTransport } from "./camera/useWebrtcTransport";
import { useHubAnalysis, applyHubAnalysis, HUB_TRACKS_STALE_MS } from "./camera/useHubAnalysis";
import { TrackInterpolator, toDisplayTracks } from "./camera/interpolate";
import { detectionInterval, shouldRunDetection, detectScheduleOpts } from "./camera/rafSteps";
import { MODE_TONE } from "./camera/tabs/tone";
import { ZonasTab } from "./camera/tabs/ZonasTab";
import { LinhasTab } from "./camera/tabs/LinhasTab";
import { CamadasTab } from "./camera/tabs/CamadasTab";
import { TimelineTab, type TimelineItem } from "./camera/tabs/TimelineTab";
import { PresencaTab } from "./camera/tabs/PresencaTab";
import "./camera/cine.css";

const BRUSH_OPTS = [
  { value: "1", label: "1×" },
  { value: "2", label: "2×" },
  { value: "3", label: "3×" },
];

// Grade do heatmap de ocupação (camada opcional sobre o vídeo).
const HEAT_COLS = 32,
  HEAT_ROWS = 18;

// ── Cadências EXIBIÇÃO × ANÁLISE ──────────────────────────────────────────────
// Na GRADE o vídeo desenha TODO frame e a análise LEVE (motion + máquina de estado + alarme por
// zona) segue em tempo real — é a função essencial que não para com a câmera fechada; só a
// inferência PESADA cai p/ as cadências abaixo (libera a main-thread). Na câmera ABERTA (full) o
// pipeline roda completo. Invariante das cadências: o dt dos frames pulados é ACUMULADO e entra
// inteiro no frame analisado (tempo real intacto); a máquina de estado confirma transições em
// 900ms ≫ estes intervalos — nenhuma mudança de estado observável se perde.
const TILE_OBJECT_INTERVAL_MS = 4000; // detecção de pessoas (coco) na grade — full usa C.objectIntervalMs
const TILE_HEAVY_INTERVAL_MS = 4000; // OWL-ViT · ZXing · MediaPipe por zona na grade
// Piso do readback de luma (drawImage+getImageData O(pw·ph) é o maior custo síncrono do tick):
const HUB_MOTION_INTERVAL_MS = 500; // modo hub: o motor cobre a análise; o local só mantém vivo o alarme de ociosidade
const LOCAL_MOTION_MIN_INTERVAL_MS = 100; // modo local: ~10fps bastam p/ alarme minuto-escala

// Contadores de sessão "vazios" p/ o HUD no modo hub (constante única — sem alocar por frame).
const EMPTY_TW_COUNTS: Record<string, TripwireCounts> = {};

// Contrato do evento `analysis-tracks` (ADR-009) → módulo neutro ./types/analysis. RE-EXPORTADO
// aqui p/ compat: os importadores existentes (central/hooks) seguem funcionando e migram depois.
export type { HubTrack, HubZone, HubAnalysis, Track } from "./types/analysis";

// Transporte WebRTC da câmera aberta (./camera/useWebrtcTransport): o <video> roda liso por HW;
// a ANÁLISE/overlay amostram o elemento por bucket de tempo (paridade com o MJPEG ~15fps) — o
// vídeo não depende disto, só o trabalho de análise/desenho.
const WEBRTC_TICK_MS = 66;
// rVFC como gate de "frame novo" do WebRTC (o bucket acima é só TEMPO — fonte lenta reprocessava
// o mesmo quadro). O rAF segue DONO do loop (ADR-007); o callback só incrementa contadores.
// Válvula: rVFC mudo além deste prazo (pausa/estrangulamento/plataforma) → volta ao bucket puro.
const WEBRTC_VFC_STALE_MS = 1000;

// CameraWorkspace: UMA câmera, VÁRIAS zonas, cada uma com seu modo — roda o processador de cada
// zona na sua ROI e compõe overlay + painel. Vizinhos de domínio: desenho puro em ./camera/draw
// (ZoneResult); derivações puras da view em ./camera/derive; processadores em ./camera/holders.

// Props opcionais são RETROCOMPATÍVEIS por contrato: ausentes → comportamento local/MJPEG integral.
type Props = {
  cameraId: string;
  label: string;
  getFrame: () => FrameSource | null;
  mode: "tile" | "full";
  onOpen?: () => void;
  onClose?: () => void;
  onAlert?: (msg: string) => void;
  /** SYNC AO VIVO (ADR-006): revisão incrementada pela central a cada `camcfg-updated
   *  {kind:"tripwires"}`. Ausente → tripwires carregam só ao abrir/trocar a câmera. */
  tripwiresRev?: number;
  /** Fonte da ANÁLISE (ADR-009, evento `analysis-status`): "hub" = o motor server-side grava os
   *  indicadores → esta instância suprime os ingests duplicáveis (./camera/ingestPolicy) e o
   *  "hoje" das linhas vira refresh do servidor. Ausente → "local". */
  analysisEngine?: "hub" | "local";
  /** Getter ESTÁVEL do último `analysis-tracks` (tracks/zonas do MOTOR do hub). Consumido com
   *  engine==="hub" em ambos os modos: a instância vira espelho e não agenda o coco local. */
  getHubAnalysis?: () => HubAnalysis | null;
  /** Transporte do VÍDEO da câmera aberta: "webrtc" = <video-stream> (decode por HW) atrás de um
   *  canvas TRANSPARENTE; "mjpeg"/ausente = frames desenhados no canvas (caminho original). */
  transport?: "mjpeg" | "webrtc";
  /** Fallback da tela cheia: chamado 1× quando o WebRTC não estabelece vídeo (o pai remonta a
   *  câmera aberta em MJPEG). Inerte no MJPEG. */
  onWebrtcFail?: (cameraId: string) => void;
};

const C = APP_CONFIG.detection;

export function CameraWorkspace({
  cameraId,
  label,
  getFrame,
  mode,
  onOpen,
  onClose,
  onAlert,
  tripwiresRev,
  analysisEngine = "local",
  getHubAnalysis,
  transport = "mjpeg",
  onWebrtcFail,
}: Props) {
  // RBAC: canConfigure = superadmin OU engenheiro (contrato em auth.tsx). Operador opera em
  // SÓ-LEITURA (vê tudo; não cria/apaga/pinta zona nem mexe em thresholds).
  const { canConfigure } = useAuth();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lumaRef = useRef<LumaSource | null>(null); // readback RGBA→luma + ping-pong (vision/luma)
  const lastFrameElRef = useRef<unknown>(null); // identidade do último frame processado (gate de "frame novo")
  const lastFrameTsRef = useRef(0);
  // rVFC no transporte WebRTC (ver WEBRTC_VFC_STALE_MS): seq de quadros APRESENTADOS pelo <video>
  // + último consumido pelo loop; a corrente é armada por elemento (vfcVideoRef).
  const vfcSeqRef = useRef(0);
  const vfcSeenSeqRef = useRef(-1);
  const vfcLastAtRef = useRef(0); // performance.now() do último callback (válvula anti-congelamento)
  const vfcVideoRef = useRef<HTMLVideoElement | null>(null);
  const vfcHandleRef = useRef(0);
  const detsRef = useRef<Detection[]>([]);
  const lastObjAtRef = useRef(0);
  const objInFlightRef = useRef(false); // máx. 1 detectFrame em voo por câmera
  const lastHeavyAtRef = useRef<Map<string, number>>(new Map()); // última inferência PESADA por zona (gate da grade)
  const lastFrameAtRef = useRef(0);
  const gridParityRef = useRef(false); // grade: análise de atividade em frames alternados
  const lastMotionAtRef = useRef(0); // último readback de luma (piso: hub 500ms · local 100ms)
  const activityDtRef = useRef(0); // dt acumulado dos frames pulados → entregue inteiro no frame analisado
  const lastFlowAtRef = useRef(0);
  const lastRecAtRef = useRef(0);
  const lastUiRef = useRef(0);
  // Últimas versões ENVIADAS ao estado pelo tick de UI — comparar antes de setar (zero re-render sem mudança).
  const lastPanelSigRef = useRef("");
  const lastTwSigRef = useRef("");
  const lastFpsRef = useRef(-1);
  const lastDetBackendRef = useRef<string | null>(null);
  const lastPresenceRef = useRef({ now: -1, peak: -1, dwell: -1 });
  const holdersRef = useRef<Map<string, Holder>>(new Map());
  const cropsRef = useRef<Map<string, HTMLCanvasElement>>(new Map()); // recorte por zona de fadiga
  const resultsRef = useRef<Map<string, ZoneResult>>(new Map());
  const zonesRef = useRef<Zone[]>([]);
  const meterRef = useRef(new FrameMeter());
  // Última latência medida por estágio de processador (ms) — alimenta o HUD de telemetria.
  const stageMsRef = useRef<{
    detect: number | null; // objetos (OWL-ViT)
    decode: number | null; // leitura (ZXing)
    face: number | null; // fadiga: FaceLandmarker
    hand: number | null; // fadiga: HandLandmarker
    obj: number | null; // fadiga: coco/celular
  }>({ detect: null, decode: null, face: null, hand: null, obj: null });
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
  // Tracker criado sob demanda no rAF; roda SÓ em rodada NOVA de detecção (detsRev) — realimentar
  // o mesmo resultado stale zeraria a velocidade estimada e mataria a predição em rodadas lentas.
  const trackerRef = useRef<ByteTracker | null>(null);
  const detsRevRef = useRef(0); // incrementa quando detectFrame entrega resultado novo
  const consumedDetsRevRef = useRef(0); // última rodada consumida pelo tracker/counter
  const peakRef = useRef(0);
  const pausedRef = useRef(false);
  const eventIdRef = useRef(0);
  const layersRef = useRef<OverlayLayers>({ ...APP_CONFIG.overlay.layers }); // camadas visíveis (lido no rAF)
  const confRef = useRef<number>(APP_CONFIG.overlay.confidenceThreshold); // limiar global de confiança
  // Perfil "Longo alcance" (opt-in por câmera): o rAF lê o REF; o estado governa UI + persistência.
  const longRangeRef = useRef(false);
  const occRef = useRef<Occupancy | null>(null); // heatmap de ocupação (lib pura counting.ts)
  // Telemetria lateral: ring buffer por zona/indicador na cadência de UI (./camera/useTelemetry).
  const { pushHist, hist, clearZone } = useTelemetry();
  // CONGELAR + CINE-LOOP (./camera/useCineLoop). Buffer de quadros EM MEMÓRIA / EFÊMERO — LGPD:
  // nunca vai ao servidor (ADR-002; ver cineBuffer.ts).
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
  // HUD: toggle no estado (UI); o rAF lê o REF (a régua não pode custar re-render por frame).
  const [hud, setHud] = useState(false);
  const hudRef = useRef(false);
  const [detBackend, setDetBackend] = useState<string | null>(null); // null até o worker reportar
  const [presence, setPresence] = useState({ now: 0, peak: 0, dwell: 0 });
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [drawerTab, setDrawerTab] = useState<
    "zonas" | "linhas" | "timeline" | "presenca" | "camadas"
  >("zonas");
  const [cfgZoneId, setCfgZoneId] = useState<string | null>(null);
  const [layers, setLayers] = useState<OverlayLayers>({ ...APP_CONFIG.overlay.layers });
  const [conf, setConf] = useState<number>(APP_CONFIG.overlay.confidenceThreshold);
  const [longRange, setLongRange] = useState(false); // perfil por câmera (cameraConfig.longRange)
  // MODO-COMO-PRESET: modo cujo preset está aplicado à sessão (camadas + confiança + métricas).
  const [activePreset, setActivePreset] = useState<ModeKey | null>(null);
  // Histórico p/ "alertas/dia estimados" do slider de sensibilidade (carregado on-demand).
  const [histDataset, setHistDataset] = useState<Dataset | null>(null);
  const [histState, setHistState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  // Transporte de VÍDEO WebRTC da câmera aberta (./camera/useWebrtcTransport): `webrtc` governa o
  // RENDER; `webrtcRef` é o espelho lido no rAF/drawScene; `currentFrame` é a fonte da GEOMETRIA
  // do editor/tripwire. Chamado antes de useTripwires (que consome currentFrame).
  const { webrtc, webrtcRef, videoStreamRef, currentFrame } = useWebrtcTransport({
    transport,
    mode,
    cameraId,
    getFrame,
    onWebrtcFail,
    paused,
    review,
  });

  // Espelho do MOTOR DO HUB (ADR-009) — ./camera/useHubAnalysis: refs lidos no rAF/drawScene +
  // "hoje" das linhas servido pelo servidor.
  const {
    analysisEngineRef,
    getHubAnalysisRef,
    hubZonesRef,
    hubTracksTsRef,
    hubFirstSeenRef,
    hubFlowRef,
    hubFlowToday,
  } = useHubAnalysis(analysisEngine, cameraId, getHubAnalysis);
  // Interpolador DISPLAY-ONLY das caixas do hub (o MESMO puro da grade — camera/interpolate.ts).
  const hubInterpRef = useRef<TrackInterpolator>(new TrackInterpolator());

  // Tripwires (./camera/useTripwires): estado/editor + ciclo de vida (load/migração/sync ADR-006).
  // O rAF cria/atualiza `counterRef`; o desenho lê `tripwiresRef`/`twCountsRef`/`twDrawRef`.
  const {
    tripwires,
    tripwireMode,
    twCounts,
    flowBase,
    setTripwireMode,
    setTwCounts,
    counterRef,
    tripwiresRef,
    twCountsRef,
    twDrawRef,
    flowBaseRef,
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
    // `currentFrame` (não `getFrame`): o commit da LINHA mapeia o traçado pelo content-rect do
    // <video> no WebRTC (mesmo letterbox do palco/editor); no MJPEG é o getFrame() de sempre.
    getFrame: currentFrame,
    viewportRef,
    onAlertRef,
    onEnterEditMode: () => {
      setDrawMode(false);
      setPaintZoneId(null);
    },
  });

  // Espelhos do transporte WebRTC e do motor do hub vivem em useWebrtcTransport/useHubAnalysis
  // (chamados acima). Aqui seguem só os espelhos de callbacks/estado próprios deste componente.
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
  // (⏸ Pausar / ❄ Congelar CONGELAM o <video> nativo do WebRTC → useWebrtcTransport, efeito [paused,review].)
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
  // Zonas: fonte de verdade = BACKEND (compartilhado por câmera), com fallback gracioso p/ o
  // localStorage. Carga assíncrona → guarda de corrida (cancelled) + estado de "carregando" leve.
  useEffect(() => {
    let cancelled = false;
    setZonesLoading(true);
    (async () => {
      const z = await loadZonesForCamera(cameraId, label, canConfigure);
      if (cancelled) return;
      setZones(z);
      // Preset do modo predominante ao abrir (só overlays/visão da sessão; geometria intacta).
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
  // Config de câmera compartilhada: lê o cache síncrono já (sem flash) e hidrata do backend
  // best-effort — a config flui do backend sem acoplar as telas (a UI de config vive na central).
  useEffect(() => {
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
  // Histórico (read-only) ao abrir a config de uma zona de atividade — previsão de alertas/dia.
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
  // Invariante (ADR-009): o worker de detecção só nasce se o caminho LOCAL for de fato agendado
  // (gate `needPersons` no rAF) — câmera analisada pelo hub não paga tfjs/coco.
  useEffect(() => {
    const m = holdersRef.current;
    return () => {
      m.forEach((h) => h.proc.dispose());
      m.clear();
    };
  }, []);

  // Casca fullscreen NÃO vira Radix Dialog (ADR-007) → ESC + trap de foco MANUAIS (hook).
  useFocusTrap(mode === "full", fullRef, cfgOpenRef, onCloseRef);

  // Processador da zona (criação/reuso/dispose + perfil LR) → ./camera/holders.
  function holderFor(z: Zone): Holder {
    return holderForZone(holdersRef.current, cropsRef.current, z, longRangeRef.current);
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

  // Rastreio anônimo de pessoas (IDs efêmeros, sem identidade) — base da "Presença".
  // ByteTrack-lite (vision/bytetrack.ts): 2 passadas por IoU — score alto associa/nasce; score
  // baixo só SUSTENTA tracks; predição linear dt-aware mantém o id vivo em rodadas lentas;
  // salto de stream re-associa por distância à posição prevista (2º estágio). O tracker devolve
  // SÓ os emitíveis — track LOST (sem par por N rodadas) não chega aqui: não desenha nem conta
  // ocupação/contagem. Contrato downstream: tracks alimentam presença/zona/counter/heatmap.
  function updateTracks(dets: Detection[], ativ: Zone[], vidW: number, vidH: number, now: number) {
    const T = APP_CONFIG.people.track;
    const tracker =
      trackerRef.current ??
      (trackerRef.current = createByteTracker({
        highScore: APP_CONFIG.people.scoreThreshold,
        iouThreshold: T.iouThreshold,
        ttlMs: T.ttlMs,
        birthIouThreshold: T.birthIouThreshold, // dono dos knobs: config.people.track
        reassocDist: T.reassocDist,
        reassocMaxGapMs: T.reassocMaxGapMs,
        lostAfterMisses: T.lostAfterMisses,
      }));
    // Longo alcance: limiar de "person" mais baixo (alvos distantes pontuam menos) — vira o
    // corte da 1ª passada/nascimento; abaixo dele a detecção ainda entra na 2ª passada.
    const personScoreThr = longRangeRef.current
      ? APP_CONFIG.detection.longRange.peopleScoreThreshold
      : APP_CONFIG.people.scoreThreshold;
    // Invariante: `dets` JÁ vem sem as pessoas em zona de exclusão (filtro único na ORIGEM) —
    // tracker E ocupação partem da MESMA lista; aqui só resta o filtro de CLASSE.
    const persons = dets
      .filter((d) => d.class === "person")
      .map((d) => ({
        score: d.score,
        bbox: [d.bbox[0] / vidW, d.bbox[1] / vidH, d.bbox[2] / vidW, d.bbox[3] / vidH] as [
          number,
          number,
          number,
          number,
        ],
      }));
    tracksRef.current = tracker.update(persons, now, personScoreThr).map((t) => ({
      id: t.id,
      cx: t.cx,
      cy: t.cy,
      foot: t.foot,
      bbox: t.bbox,
      firstSeen: t.firstSeen,
      lastSeen: t.lastSeen,
      // Zona pela regra ÚNICA do front (zones.assignZone): desempate por maior interseção
      // bbox∩zona, depois menor área — nunca por ordem da lista.
      zone: assignZone(ativ, t.cx, t.cy, t.bbox, containsFn)?.label ?? null,
      score: t.score,
    }));
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
    // Corrente rVFC do WebRTC: UMA por elemento <video>, auto-re-agendada; o callback SÓ
    // incrementa contadores (o rAF segue dono do loop — ADR-007).
    const supportsVfc =
      typeof HTMLVideoElement !== "undefined" &&
      "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    const armVfc = (video: HTMLVideoElement) => {
      if (vfcVideoRef.current === video) return; // já armada neste elemento (idempotente por tick)
      const prevVideo = vfcVideoRef.current;
      if (prevVideo && vfcHandleRef.current) {
        try {
          prevVideo.cancelVideoFrameCallback(vfcHandleRef.current);
        } catch {
          /* corrente antiga já solta */
        }
      }
      vfcVideoRef.current = video;
      vfcLastAtRef.current = performance.now(); // referência da válvula começa AGORA (não em 0)
      const onFrame = () => {
        vfcSeqRef.current++;
        vfcLastAtRef.current = performance.now();
        if (!stopped && vfcVideoRef.current === video)
          vfcHandleRef.current = video.requestVideoFrameCallback(onFrame);
      };
      vfcHandleRef.current = video.requestVideoFrameCallback(onFrame);
    };
    // ── Estágios NOMEADOS do tick — extração 1:1 do laço, MESMA ordem/semântica (ADR-007: o rAF
    // é dono do loop e não sai do componente; cada estágio é um closure nomeado, params explícitos). ──

    // AQUISIÇÃO: fonte do frame + gate de "frame novo". MJPEG: getFrame() (relé socket.io);
    // WebRTC: o "frame" de análise é o próprio <video> (decode por HW) com `ts` em bucket de
    // WEBRTC_TICK_MS + gate rVFC (só quadro APRESENTADO novo; a válvula reabre se o rVFC calar).
    // O loop roda a ~60fps, o frame chega a ~15fps: mesmo el/ts → null pula o tick inteiro.
    const acquireStage = (): FrameSource | null => {
      let f: FrameSource | null;
      if (webrtcRef.current) {
        const video = videoStreamRef.current?.video;
        if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
        if (supportsVfc) {
          armVfc(video);
          if (
            vfcSeqRef.current === vfcSeenSeqRef.current &&
            performance.now() - vfcLastAtRef.current < WEBRTC_VFC_STALE_MS
          )
            return null;
        }
        f = {
          el: video,
          w: video.videoWidth,
          h: video.videoHeight,
          ts: Math.floor(performance.now() / WEBRTC_TICK_MS),
        };
      } else {
        f = getFrame();
      }
      if (!f || !f.w || !f.h) return null;
      if (f.el === lastFrameElRef.current && (f.ts == null || f.ts === lastFrameTsRef.current))
        return null;
      lastFrameElRef.current = f.el;
      lastFrameTsRef.current = f.ts ?? 0;
      vfcSeenSeqRef.current = vfcSeqRef.current; // tick processado consome o quadro rVFC corrente
      return f;
    };

    // CADÊNCIA do motion: na grade, atividade analisa frames ALTERNADOS; em ambos os modos vale o
    // piso por engine (hub 500ms · local 100ms). O dt dos frames pulados é ACUMULADO e entregue
    // inteiro no frame analisado — idle/tempo real não perdem nada.
    const cadenceStage = (now: number): { analyzeActivity: boolean; activityDt: number } => {
      const frameDt = lastFrameAtRef.current ? now - lastFrameAtRef.current : 0;
      lastFrameAtRef.current = now;
      gridParityRef.current = !gridParityRef.current;
      let analyzeActivity = mode === "full" || gridParityRef.current;
      if (analyzeActivity) {
        const motionMinMs =
          analysisEngineRef.current === "hub"
            ? HUB_MOTION_INTERVAL_MS
            : LOCAL_MOTION_MIN_INTERVAL_MS;
        if (now - lastMotionAtRef.current < motionMinMs) analyzeActivity = false;
        else lastMotionAtRef.current = now;
      }
      activityDtRef.current += frameDt;
      const activityDt = activityDtRef.current;
      if (analyzeActivity) activityDtRef.current = 0;
      return { analyzeActivity, activityDt };
    };

    // MOTION: readback RGBA→luma 1× por câmera, já na resolução do perfil, compartilhado com
    // TODAS as zonas via ctx.luma (kernel + ping-pong em vision/luma). Em frame não analisado não
    // há luma nova — o `prev` interno segue sendo a do último frame ANALISADO e o diff seguinte
    // cobre o intervalo inteiro (sem perder movimento).
    type MotionOut = {
      luma: Float32Array | null;
      prev: Float32Array | null;
      pw: number;
      ph: number;
    };
    const motionStage = (f: FrameSource, analyze: boolean, hasAtiv: boolean): MotionOut => {
      const pw = longRangeRef.current ? APP_CONFIG.detection.longRange.procWidth : C.procWidth,
        ph = Math.max(1, Math.round((pw * f.h) / f.w));
      if (!hasAtiv || !analyze) return { luma: null, prev: null, pw, ph };
      const s = (lumaRef.current ??= createLumaSource()).sample(f.el, pw, ph);
      return s ? { luma: s.luma, prev: s.prev, pw, ph } : { luma: null, prev: null, pw, ph };
    };

    // DETECÇÃO local: agenda o coco FORA da main (worker + scheduler global; 1 tile = 1 tarefa —
    // NÃO embrulhar detectFrame em requestInference: deadlock com maxConcurrent=1). O worker
    // nasce AQUI on-demand (câmera hub não paga tfjs; engine hub→local reentra por este gate).
    // Gate de voo: máx. 1 detectFrame em voo por câmera; o próximo usa o frame mais novo.
    const detectStage = (f: FrameSource, now: number, needPersons: boolean): void => {
      if (!needPersons) return;
      ensureDetectClient();
      const objInterval = detectionInterval(mode, C.objectIntervalMs, TILE_OBJECT_INTERVAL_MS);
      if (!shouldRunDetection(now, lastObjAtRef.current, objInterval, objInFlightRef.current))
        return;
      lastObjAtRef.current = now;
      objInFlightRef.current = true;
      const el = f.el,
        fw = f.w,
        fh = f.h;
      const { tiled, opts } = detectScheduleOpts(cameraId, mode, longRangeRef.current);
      detectFrame(el, fw, fh, tiled, opts)
        .then((res) => {
          if (res) {
            detsRef.current = res;
            detsRevRef.current++; // rodada NOVA de detecção (gate do tracker)
          }
        })
        .catch(() => {})
        .finally(() => {
          objInFlightRef.current = false;
        });
    };

    // TRACKING: o ByteTracker roda SÓ em rodada NOVA de detecção (realimentar o mesmo resultado
    // stale zeraria a velocidade estimada e mataria a predição); entre rodadas tracksRef mantém
    // as últimas posições (draw/presença seguem fluidos).
    const trackingStage = (
      dets: Detection[],
      ativ: Zone[],
      f: FrameSource,
      now: number,
      needPersons: boolean,
    ): { tracks: Track[]; freshDets: boolean } => {
      const freshDets = detsRevRef.current !== consumedDetsRevRef.current;
      if (needPersons && freshDets) {
        consumedDetsRevRef.current = detsRevRef.current;
        updateTracks(dets, ativ, f.w, f.h, now);
      }
      const tracks = tracksRef.current;
      if (tracks.length > peakRef.current) peakRef.current = tracks.length;
      return { tracks, freshDets };
    };

    // CONTAGEM + ocupação: reusa os tracks (sem inferência extra). O counter avança na cadência
    // das RODADAS de detecção (freshDets é o "update" da histerese minCrossingFrames) e SÓ com a
    // câmera aberta; âncora no PÉ do bbox (Track.foot). Knobs com dono em config.people.track.
    const countingStage = (
      tracks: Track[],
      now: number,
      countingActive: boolean,
      freshDets: boolean,
    ): void => {
      const T = APP_CONFIG.people.track;
      const counter =
        counterRef.current ??
        (counterRef.current = createCounter(tripwiresRef.current, {
          minMove: T.counterMinMove,
          ttl: T.counterTtlMs,
          maxDist: T.counterMaxDist,
          debounceMs: T.debounceMs,
          minCrossingFrames: T.minCrossingFrames,
        }));
      const occ =
        occRef.current ??
        (occRef.current = createOccupancy({
          cols: HEAT_COLS,
          rows: HEAT_ROWS,
          decay: 0.97,
          addAmount: 0.6,
          max: 6,
        }));
      const tps = tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, foot: t.foot }));
      if (countingActive && freshDets) {
        const crossings = counter.update(tps, now);
        for (const ev of crossings) {
          const wi = tripwiresRef.current.findIndex((w) => w.id === ev.tripwireId);
          pushTimeline(
            `${ev.dir === "in" ? "Entrada" : "Saída"} · Linha ${wi >= 0 ? wi + 1 : "?"}`,
            "info",
          );
          // Cruzamento PERSISTIDO — só metadados (ADR-002); fire-and-forget (store resiliente).
          // Política de ingest do modo hub: tabela única em camera/ingestPolicy (ADR-009).
          if (shouldIngest("flow", analysisEngineRef.current))
            void recordFlow({
              cameraId,
              cameraLabel: label,
              tripwireId: ev.tripwireId,
              dir: ev.dir,
              ts: Date.now(),
            });
        }
        if (crossings.length) twCountsRef.current = counter.counts(); // re-snapshota só com evento (HUD)
      }
      occ.add(tps.map((t) => ({ x: t.cx, y: t.cy }))); // decai + acumula ocupação 1×/frame (heatmap)
    };

    // ZONAS: dispatch por modo (união discriminada — pareamento errado modo↔proc é erro de tipo).
    // Inferência PESADA (leitura/objetos/fadiga rodam na MAIN thread) cai na grade p/
    // TILE_HEAVY_INTERVAL_MS por zona; ATIVIDADE fica FORA do gate (análise leve essencial).
    const zoneStage = (
      f: FrameSource,
      now: number,
      zs: Zone[],
      m: MotionOut,
      activityDt: number,
      analyzeActivity: boolean,
      dets: Detection[],
      tracks: Track[],
      hubActive: boolean,
      sampleFlow: boolean,
      recEmit: boolean,
      engine: "hub" | "local",
    ): ZoneSample[] => {
      const recSamples: ZoneSample[] = [];
      for (const z of zs) {
        // Exclusão: modo de SUPRESSÃO, sem indicador nem processador (o filtro do pé já rodou na
        // origem). Pula antes de holderFor; a zona segue sendo DESENHADA como máscara.
        if (z.modo === "exclusao") continue;
        const h = holderFor(z);
        if (z.modo !== "atividade" && mode !== "full") {
          const lastHeavy = lastHeavyAtRef.current.get(z.id) ?? 0;
          if (now - lastHeavy < TILE_HEAVY_INTERVAL_MS) continue;
          lastHeavyAtRef.current.set(z.id, now);
        }
        if (h.modo === "atividade") {
          // Frame não analisado: sem luma nova → sem process(); resultsRef mantém o último estado
          // p/ o draw (que continua todo frame). O dt pulado já está acumulado em activityDt.
          if (!analyzeActivity) continue;
          const ctx: AtividadeCtx = {
            now,
            frameDt: activityDt, // inclui o dt dos frames pulados (tempo real)
            paused: pausedRef.current,
            luma: m.luma,
            prev: m.prev,
            pw: m.pw,
            ph: m.ph,
            dets,
            frameW: f.w,
            frameH: f.h,
            tracks,
            sampleFlow,
            recEmit,
            frameEl: f.el, // fallback LR do processador: só re-rasteriza se ctx.luma vier ausente
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
          const r = h.proc.process(az, ctx);
          // Pessoas EXIBIDAS por zona vêm do zones[] do hub quando disponível — a atribuição do
          // MOTOR é a autoridade (a mesma que grava o indicador). Estado/motion/alarme locais.
          const hz = hubActive
            ? hubZonesRef.current?.find((zz) => zz.id === z.id || zz.label === z.label)
            : undefined;
          resultsRef.current.set(z.id, {
            modo: "atividade",
            view: hz ? { ...r.view, people: hz.people } : r.view,
          });
          if (r.sample) recSamples.push(r.sample);
          if (r.event) pushTimeline(r.event.text, r.event.sev);
          if (r.alert) {
            onAlertRef.current?.(`⚠ ${label}: ${r.alert.text}`);
            // Alarme nasce do MOTION local (o motor do hub não grava alarmes) → sempre ingerido
            // (tabela ADR-009 em camera/ingestPolicy).
            if (shouldIngest("alert", engine))
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
        } else if (h.modo === "leitura") {
          const r = h.proc.process(
            { x: z.x, y: z.y, w: z.w, h: z.h, ponto: z.ponto },
            { frame: f, now, cameraId, cameraLabel: label },
          );
          if (r.decodeMs != null) stageMsRef.current.decode = r.decodeMs;
          // Leitura é 100% cliente (o motor não cobre o modo) → sempre ingerida (ADR-009).
          if (shouldIngest("reads", engine)) r.reads.forEach((rd) => recordReads(pushRead(rd)));
          if (shouldIngest("pass", engine))
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
        } else if (h.modo === "objetos") {
          const r = h.proc.process(
            [{ id: z.id, label: z.label, x: z.x, y: z.y, w: z.w, h: z.h, contains: containsFn(z) }],
            z.selectedClasses,
            { frame: f, now },
          );
          if (r.detectMs != null) stageMsRef.current.detect = r.detectMs;
          // Objetos segue no cliente (o motor não cobre o modo) → sempre ingerido (ADR-009).
          if (shouldIngest("object", engine)) {
            r.events.forEach((e) => recordObjectEvent(e));
            if (r.samples) recordObjectSamples({ samples: r.samples });
          }
          r.alerts.forEach((a) => onAlertRef.current?.(a));
          const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
          resultsRef.current.set(z.id, { modo: "objetos", counts: r.counts, total, dets: r.dets });
        } else {
          // FADIGA: recorta a ROI da zona e roda o pipeline do operador nela (1 operador por zona).
          // Fica no cliente por exceção declarada da ADR-009 → sempre ingerida.
          const r = h.proc.process({ frame: cropFor(z, f), now, srcEl: f.el });
          if (r.faceMs != null) stageMsRef.current.face = r.faceMs;
          if (r.handMs != null) stageMsRef.current.hand = r.handMs;
          if (r.objMs != null) stageMsRef.current.obj = r.objMs;
          r.events.forEach((e) => {
            if (shouldIngest("fadiga", engine))
              recordFadigaEvent({ posto: z.label, type: e.type, ts: e.ts });
            pushTimeline(`${z.label}: ${e.type}`, e.type === "bocejo" ? "info" : "high");
          });
          if (r.sample && shouldIngest("fadiga", engine))
            recordFadigaSamples({ posto: z.label, ...r.sample });
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
      return recSamples;
    };

    // UI: reflete indicadores no estado na cadência de UI comparando ASSINATURAS antes de setar
    // (mesma cadência/formato; sem mudança visível → nenhum setState → zero re-render).
    const uiStage = (now: number, tracks: Track[]): void => {
      if (now - lastUiRef.current <= (mode === "full" ? 200 : 500)) return;
      lastUiRef.current = now;
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
      const pSig = panelSig(resultsRef.current);
      if (pSig !== lastPanelSigRef.current) {
        lastPanelSigRef.current = pSig;
        setPanel(new Map(resultsRef.current));
      }
      const tw = counterRef.current ? counterRef.current.counts() : {}; // in/out do painel lateral
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
      const be = getDetectBackend(); // chega assíncrono (worker "ready")
      if (be !== lastDetBackendRef.current) {
        lastDetBackendRef.current = be;
        setDetBackend(be);
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
    };

    // ── O TICK: orquestração dos estágios, na MESMA ordem do laço original (ADR-007) ──
    const loop = () => {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(loop);
      const canvas = canvasRef.current,
        viewport = viewportRef.current;
      if (!canvas || !viewport) return;
      const f = acquireStage();
      if (!f) return;
      const now = performance.now();
      meterRef.current.tick(now);
      // CINE: mesmo frame que passou pelo gate (sem decode extra). Buffer em memória/EFÊMERO —
      // nada é enviado/persistido (LGPD, ADR-002; ver cineBuffer.ts).
      captureFrame(f.el, f.w, f.h, now, Date.now());
      if (pausedRef.current) return; // ⏸ inspeção: congela o frame (não processa nem redesenha)

      const { analyzeActivity, activityDt } = cadenceStage(now);
      const zs = zonesRef.current;
      const ativ = zs.filter((z) => z.modo === "atividade");
      const excl = zs.filter((z) => z.modo === "exclusao"); // supressão de FP — sem indicador/processador
      // Linhas contam SÓ na câmera aberta: na grade a detecção esparsa (4s) "teleporta" tracks
      // (o cruzamento exige o MESMO track atravessar) e contar seria inventar número — o HUD
      // indica pausado e a detecção NÃO é agendada só por causa das linhas.
      const hasWires = tripwiresRef.current.length > 0;
      const countingActive = hasWires && mode === "full";
      // engine "hub" (ADR-009): o motor roda D-FINE+ByteTrack 24/7 → nenhuma instância agenda o
      // coco local; ambas espelham os tracks/zonas servidos. Trade-off declarado: overlay de
      // pessoas na cadência do motor (~1fps) em troca de aposentar o tfjs do cliente; o counter
      // local fica parado (o "hoje" é o do servidor). Motion/alarme, fadiga e leitura: locais.
      const engine = analysisEngineRef.current;
      const hubActive = engine === "hub";
      const needPersons = (ativ.length > 0 || countingActive) && !hubActive;

      const m = motionStage(f, analyzeActivity, ativ.length > 0);
      detectStage(f, now, needPersons);
      // Espelho do hub: HubTrack→Track + pseudo-dets, com gate de payload novo + descarte de
      // stale — sub-passo puro em ./camera/useHubAnalysis.
      applyHubAnalysis(
        hubActive,
        hubActive ? (getHubAnalysisRef.current?.() ?? null) : null,
        now,
        f.w,
        f.h,
        { tracksRef, detsRef, hubZonesRef, hubTracksTsRef, hubFirstSeenRef },
      );
      // ZONA DE EXCLUSÃO — filtro ÚNICO na ORIGEM: tracker E `occupied` das zonas veem a MESMA
      // lista (só pessoa; veículos seguem contando). Modo hub: dets já vêm filtrados → no-op.
      const dets = filterExcludedPersons(
        detsRef.current,
        excl.map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h, contains: containsFn(z) })),
        f.w,
        f.h,
      );
      const { tracks, freshDets } = trackingStage(dets, ativ, f, now, needPersons);
      countingStage(tracks, now, countingActive, freshDets);

      // flow/rec só fecham janela em frame ANALISADO (senão o recEmit cairia num frame pulado e
      // a cadência de gravação dobraria esporadicamente).
      const sampleFlow = analyzeActivity && now - lastFlowAtRef.current > 500;
      const recEmit = analyzeActivity && now - lastRecAtRef.current > 3000;
      const recSamples = zoneStage(
        f,
        now,
        zs,
        m,
        activityDt,
        analyzeActivity,
        dets,
        tracks,
        hubActive,
        sampleFlow,
        recEmit,
        engine,
      );
      if (sampleFlow) lastFlowAtRef.current = now;
      if (recEmit) {
        lastRecAtRef.current = now;
        // Ingest de ATIVIDADE segue a tabela ADR-009 (o hub grava ativ direto no pgstore).
        if (recSamples.length && shouldIngest("ativ", engine))
          recordSamples({ cameraId, samples: recSamples });
      }
      // Em revisão o palco mostra um quadro do buffer — inferência/alertas seguem rodando acima.
      if (!reviewRef.current) drawScene(canvas, viewport, f);
      uiStage(now, tracks);
      // Custo REAL do tick na main-thread (rolling → HUD): motion + agendamento + zonas + draw.
      meterRef.current.pushProc(performance.now() - now);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      // Solta a corrente rVFC e zera o dono — sem isto, armVfc veria o MESMO <video> na
      // remontagem/troca de câmera e nunca re-armaria.
      const vfcVideo = vfcVideoRef.current;
      if (vfcVideo && vfcHandleRef.current) {
        try {
          vfcVideo.cancelVideoFrameCallback(vfcHandleRef.current);
        } catch {
          /* já solta */
        }
      }
      vfcVideoRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFrame, mode, cameraId, label]);

  function drawScene(canvas: HTMLCanvasElement, viewport: HTMLDivElement, f: FrameSource) {
    const dpr = window.devicePixelRatio || 1;
    const vpW = viewport.clientWidth,
      vpH = viewport.clientHeight;
    if (canvas.width !== Math.round(vpW * dpr) || canvas.height !== Math.round(vpH * dpr)) {
      canvas.width = Math.round(vpW * dpr);
      canvas.height = Math.round(vpH * dpr);
    }
    // INVARIANTE dos atributos do canvas (travam no 1º getContext, p/ sempre): MJPEG = palco
    // OPACO (alpha:false dispensa blending no compositor; letterbox pintado via fillRect na cor
    // --cam-surface-bg). WebRTC = overlay TRANSPARENTE (alpha:true; o <video-stream> fica atrás).
    // O canvas usa `key` por transporte no JSX → cada instância só vê UM modo; drawReviewFrame
    // (camera/draw.ts) pede os MESMOS atributos p/ não depender de quem chama primeiro.
    const wrtc = webrtcRef.current;
    const ctx = canvas.getContext(
      "2d",
      wrtc ? { alpha: true, desynchronized: true } : { alpha: false, desynchronized: true },
    )!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Retângulo de conteúdo (letterbox). No WebRTC o <video> usa object-fit:contain no MESMO
    // palco → getContentRect dá exatamente o box do vídeo (zonas/tracks caem sobre ele).
    const cr = getContentRect(vpW, vpH, f.w, f.h);
    if (wrtc) {
      ctx.clearRect(0, 0, vpW, vpH);
    } else {
      ctx.fillStyle = cssVar("--cam-surface-bg", "#05080c");
      ctx.fillRect(0, 0, vpW, vpH);
      ctx.drawImage(f.el, cr.x, cr.y, cr.w, cr.h);
    }
    const detailed = mode === "full";

    // Heatmap de ocupação (camada, sob as geometrias) — grade normalizada da lib counting.ts.
    if (layersRef.current.heatmap && occRef.current) drawOccupancyHeatmap(ctx, cr, occRef.current);

    // Suavização DISPLAY-ONLY das caixas do hub (TrackInterpolator, o MESMO puro da grade): a
    // bbox crua congela+salta na cadência do motor (~1fps). Invariante: a LÓGICA (contagem/
    // exclusão/tripwire/ocupação) JÁ RODOU sobre tracksRef EXATO; aqui só muda o que se VÊ.
    // Ingere só payload FRESCO (mesmo limiar do applyHubAnalysis); modo local não interpola.
    const hubEngine = analysisEngineRef.current === "hub";
    let displayTracks: ReadonlyArray<TrackBox> = tracksRef.current;
    if (hubEngine) {
      const nowMs = performance.now();
      const hd = getHubAnalysisRef.current?.() ?? null;
      if (hd && Date.now() - hd.ts <= HUB_TRACKS_STALE_MS) hubInterpRef.current.ingest(hd, nowMs);
      displayTracks = toDisplayTracks(
        hubInterpRef.current.sample(nowMs),
        hubFirstSeenRef.current,
        nowMs,
      );
    }

    // pessoas (tracks anônimos) — Presença (camada "caixas"; atenua abaixo da confiança)
    if (layersRef.current.boxes)
      drawTracks(ctx, cr, displayTracks, confRef.current, pausedRef.current && detailed);

    // Laço por-zona (retângulo/máscara + rótulo + dets + fadiga) → ./camera/draw. Último arg
    // (1 pessoa = 1 caixa): a camada de dets omite a det de pessoa já coberta por um track.
    drawZoneOverlays(
      ctx,
      cr,
      zonesRef.current,
      resultsRef.current,
      layersRef.current,
      confRef.current,
      detailed,
      getMask,
      layersRef.current.boxes ? displayTracks.map((t) => t.bbox) : [],
    );

    // Tripwires — SEMPRE visíveis. Modo hub (ADR-009): o "hoje" é SÓ o acumulado do servidor
    // (somar a sessão local contaria cada cruzamento 2×) e paused=false (o motor conta 24/7);
    // modo local: base do servidor + sessão corrente, pausado na grade.
    drawTripwires(
      ctx,
      cr,
      tripwiresRef.current,
      hubEngine ? EMPTY_TW_COUNTS : twCountsRef.current,
      !hubEngine && mode !== "full",
      hubEngine ? hubFlowRef.current : flowBaseRef.current,
    );

    if (paintZoneId) drawPaintGrid(ctx, cr, DEFAULT_GRID.cols, DEFAULT_GRID.rows); // grade de pintura
    drawZoneDraft(ctx, drawRef.current); // retângulo de zona em arraste
    drawTripwireDraft(ctx, twDrawRef.current); // linha em traçado

    // HUD de telemetria (toggleável; só na câmera aberta), desenhado por último. overlayAge só
    // faz sentido no modo hub; dropped/recvFps são opcionais do FrameSource (lidos defensivos);
    // estágios dos processadores vêm de stageMsRef e a fila do scheduler de schedulerStats().
    if (hudRef.current && detailed) {
      const eng = analysisEngineRef.current === "hub" ? "hub" : "local";
      const age =
        eng === "hub" && hubTracksTsRef.current > 0 ? Date.now() - hubTracksTsRef.current : null;
      const fx = f as FrameSource & { dropped?: number; recvFps?: number };
      const st = stageMsRef.current;
      drawTelemetryHud(ctx, cr, {
        fps: meterRef.current.fps,
        msFrame: meterRef.current.avgProcMs,
        pipeline: eng,
        overlayAgeMs: age,
        dropped: typeof fx.dropped === "number" ? fx.dropped : undefined,
        recvFps: typeof fx.recvFps === "number" ? fx.recvFps : undefined,
        detectMs: st.detect,
        decodeMs: st.decode,
        faceMs: st.face,
        handMs: st.hand,
        objMs: st.obj,
        queue: schedulerStats(),
      });
    }
  }

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
  // `currentFrame` (fonte da GEOMETRIA do editor, WebRTC × MJPEG) vem de useWebrtcTransport.
  function vpPoint(e: ReactMouseEvent) {
    const r = viewportRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function normPoint(e: ReactMouseEvent): { nx: number; ny: number } | null {
    const f = currentFrame(),
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
    const f = currentFrame(),
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
  // Modos de edição mutuamente exclusivos (tripwire × zona × pintura não conflitam).
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

  // Write-through: aplica a edição já e persiste no BACKEND (localStorage = cache/fallback).
  // Erro do PUT → toast SEM perder a edição local; a central re-sincroniza depois.
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
  // Aplica o preset do modo (camadas + confiança); não mexe em geometria/zonas.
  function applyPreset(mode: ModeKey) {
    const p = MODE_PRESETS[mode];
    setLayers({ ...p.layers });
    setConf(p.confidenceThreshold);
    setActivePreset(mode);
  }
  // Perfil "Longo alcance" (por câmera): aplica na hora (longRangeRef → rAF/processadores) e
  // persiste via setCameraCfg (write-through; cache local mantém a UX offline).
  function onLongRangeChange(on: boolean) {
    setLongRange(on);
    longRangeRef.current = on; // efeito imediato no rAF (sem esperar o commit do estado)
    setCameraCfg(cameraId, { ...getCameraCfg(cameraId), longRange: on });
  }
  // Troca o modo de uma zona PRESERVANDO sua geometria/máscara/parâmetros e reaplica o preset.
  function changeZoneMode(z: Zone, next: ZoneMode) {
    patchZone(z.id, { modo: next });
    // "exclusao" não é um preset (não tem overlay/confiança/KPIs próprios — só suprime). O narrowing
    // do `!==` reduz `next` a ModeKey (os 4 modos com preset), então applyPreset segue tipado.
    if (next !== "exclusao") applyPreset(next);
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

  // Legenda do overlay: só as cores em uso pelos modos/classes atuais (./camera/derive).
  const legend = legendFor(zones);
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
      // title (não Tooltip) é intencional: a casca do tile é localizada pelo e2e via
      // `.tile[title='Abrir câmera']` (contrato de seletor, app.spec.ts). Trocar por <Tooltip>
      // remove o atributo e quebra o teste. Mantido como affordance nativa do card.
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
      {/* a11y (A5): heading da casca fullscreen — só p/ leitores de tela. */}
      <h1 className="sr-only">Câmera {label}</h1>
      <header className="cam-head">
        <div className="cam-title">
          <b>{label}</b>
          {paintZone ? (
            <span className="muted">pintando “{paintZone.label}”</span>
          ) : (
            <>
              <span className="muted">{zones.length} zona(s)</span>
              {activePresetDef && (
                <Tooltip
                  content={`Preset ativo: ${activePresetDef.label} — ${activePresetDef.description}${presetDirty ? " (ajustado manualmente nesta sessão)" : ""}`}
                >
                  <span>
                    <Badge tone={MODE_TONE[activePreset!]}>
                      {activePresetDef.label}
                      {presetDirty ? " ·" : ""}
                    </Badge>
                  </span>
                </Tooltip>
              )}
              {!canConfigure && (
                <Tooltip content="Edição de configuração requer perfil de engenharia">
                  <span>
                    <Badge tone="info">🔒 Somente leitura</Badge>
                  </span>
                </Tooltip>
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

      {/* Palco + drawer lado a lado (.cam-body, cine.css): o palco encolhe quando o
          drawer está aberto e o drawScene re-letterboxa (fit) — nada de crop. */}
      <div className="cam-body">
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
          {/* Vídeo WebRTC ATRÁS do canvas (decode por HW); câmera mjpeg nem monta o elemento. */}
          {webrtc && <video-stream ref={videoStreamRef} />}
          {/* `key` por transporte: os atributos do 1º getContext travam p/ sempre (opaco no MJPEG,
              transparente no WebRTC) → troca em runtime REMONTA o canvas com o alpha certo. O
              canvas vem DEPOIS do <video-stream> → pinta por cima (ordem de pintura). */}
          <canvas className="overlay" key={webrtc ? "rtc" : "mjpeg"} ref={canvasRef} />
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
                <Tooltip content="Baixar este quadro como PNG (download local — nunca enviado ao servidor)">
                  <Button onClick={downloadSnapshot} disabled={clipState === "working"}>
                    ⤓ Snapshot
                  </Button>
                </Tooltip>
                <Tooltip content="Exporta a janela do cine-loop como clipe (WebM) — download local, nunca enviado ao servidor. Fallback: montagem PNG se o navegador não suportar.">
                  <Button onClick={exportClip} disabled={clipState === "working"}>
                    {clipState === "working" ? `Gravando… ${clipPct}%` : "⤓ Exportar clipe"}
                  </Button>
                </Tooltip>
                <Button active onClick={exitReview}>
                  ▶ Ao vivo
                </Button>
              </div>
            </>
          )}
        </div>
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
            // Contagens em chip compacto (.dt-n, cine.css) p/ as 5 abas caberem em 1 linha.
            // Nome acessível continua "Zonas N" / "Linhas N" (o {" "} preserva o espaço).
            items={[
              {
                value: "zonas",
                label: (
                  <>
                    Zonas <i className="dt-n">{zones.length}</i>
                  </>
                ),
              },
              {
                value: "linhas",
                label: (
                  <>
                    Linhas <i className="dt-n">{tripwires.length}</i>
                  </>
                ),
              },
              { value: "camadas", label: "Camadas" },
              { value: "timeline", label: "Timeline" },
              { value: "presenca", label: "Presença" },
            ]}
          >
            <ScrollArea className="drawer-scroll" viewportClassName="drawer-scroll-vp">
              <TabsContent value="zonas">
                <ZonasTab
                  zonesLoading={zonesLoading}
                  zones={zones}
                  canConfigure={canConfigure}
                  panel={panel}
                  paintZoneId={paintZoneId}
                  hist={hist}
                  legend={legend}
                  setCfgZoneId={setCfgZoneId}
                  startPaint={startPaint}
                  setPaintZoneId={setPaintZoneId}
                  removeZone={removeZone}
                />
              </TabsContent>

              <TabsContent value="linhas">
                <LinhasTab
                  tripwireMode={tripwireMode}
                  canConfigure={canConfigure}
                  toggleTripwireMode={toggleTripwireMode}
                  resetCounts={resetCounts}
                  tripwires={tripwires}
                  twCounts={twCounts}
                  analysisEngine={analysisEngine}
                  hubFlowToday={hubFlowToday}
                  flowBase={flowBase}
                  invertTripwire={invertTripwire}
                  removeTripwire={removeTripwire}
                />
              </TabsContent>

              <TabsContent value="timeline">
                <TimelineTab timeline={timeline} />
              </TabsContent>

              <TabsContent value="presenca">
                <PresencaTab presence={presence} paused={paused} />
              </TabsContent>

              <TabsContent value="camadas">
                <CamadasTab
                  activePresetDef={activePresetDef}
                  activePreset={activePreset}
                  presetTone={activePreset ? MODE_TONE[activePreset] : "info"}
                  presetDirty={presetDirty}
                  applyPreset={applyPreset}
                  layers={layers}
                  setLayers={setLayers}
                  conf={conf}
                  setConf={setConf}
                  canConfigure={canConfigure}
                  longRange={longRange}
                  onLongRangeChange={onLongRangeChange}
                />
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
        {/* Toggle do HUD (going-gray: régua de medição, não anormalidade). O rAF lê o ref. */}
        <Tooltip content="HUD de telemetria sobre o vídeo: FPS exibido, ms/frame na main-thread, pipeline (hub/local), idade do overlay e latência por estágio (OWL-ViT/ZXing/MediaPipe) + fila de inferência">
          <Toggle
            aria-label="HUD de telemetria"
            pressed={hud}
            onPressedChange={(v) => {
              hudRef.current = v;
              setHud(v);
            }}
          >
            HUD
          </Toggle>
        </Tooltip>
        {/* Fonte da análise (ADR-009): NEUTRO e só no modo hub; local = nada. No modo hub o
            worker tfjs nem sobe p/ pessoas — o badge de detecção abaixo só aparece se um
            consumidor local (fadiga/celular, engine local) o iniciou. */}
        {analysisEngine === "hub" && (
          <Tooltip content="indicadores gravados pelo servidor — D-FINE">
            <span className="kb muted">análise: hub</span>
          </Tooltip>
        )}
        {/* Backend de detecção — going-gray: neutro em GPU; satura (warn) SÓ em CPU, o modo
            degradado (~10× mais lento). null = worker ainda não reportou → não exibe. */}
        {detBackend != null &&
          (detBackend === "cpu" ? (
            <Tooltip content="Detecção degradada: WebGL indisponível — tfjs rodando em CPU (~10× mais lento)">
              <span className="kb" style={{ color: "var(--state-warn-fg, #facc15)" }}>
                detecção: CPU ⚠
              </span>
            </Tooltip>
          ) : (
            <Tooltip content={`Backend de detecção (tfjs): ${detBackend}`}>
              <span className="kb muted">
                detecção: {detBackend === "webgl" || detBackend === "webgpu" ? "GPU" : detBackend}
              </span>
            </Tooltip>
          ))}
        {paused && <span className="kb muted">⏸ inspecionando</span>}
      </div>

      <ConfigZonaDialog
        zone={cfgZone}
        histState={histState}
        histDataset={histDataset}
        onClose={() => setCfgZoneId(null)}
        patchZone={patchZone}
        changeZoneMode={changeZoneMode}
      />
    </div>
  );
}
