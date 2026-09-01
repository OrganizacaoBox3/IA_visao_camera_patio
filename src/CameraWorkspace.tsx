import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { APP_CONFIG, MODE_PRESETS, type OverlayLayers, type ModeKey } from "./config";
import { type FrameSource } from "./frame";
import { FrameMeter } from "./telemetry";
import { type Detection } from "./vision/model";
import { ensureDetectClient, detectFrame, getDetectBackend } from "./vision/detect";
import { filterExcludedPersons, type AtividadeCtx } from "./processors/atividade";
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
import {
  loadZonesForCamera,
  persistZones,
  withDefaults,
  nextZoneLabel,
  assignZone,
  ZONE_MODE_LABEL,
  type Zone,
  type ZoneMode,
} from "./zones";
import { loadCamConfig, getCameraCfg, setCameraCfg } from "./cameraConfig";
import { ApiError } from "./api";
import { useCalibrationOverlay } from "./camera/useCalibrationOverlay";
import { useCalibrationEditor } from "./camera/useCalibrationEditor";
import { CalibrationLayer } from "./camera/CalibrationLayer";
import { useZoneMasks } from "./camera/useZoneMasks";
import { usePolygonEditor } from "./camera/usePolygonEditor";
import { useStageModes, sceneLayers, activeStageMode } from "./camera/useStageModes";
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
import { cropZone } from "./camera/cropZone";
import type { ObjBackend } from "./objects/detector";
import { useFocusTrap } from "./camera/useFocusTrap";
import type { HubAnalysis, Track } from "./types/analysis";
import { useCineLoop } from "./camera/useCineLoop";
import { useTripwires } from "./camera/useTripwires";
import { useAuth } from "./auth";
import {
  getContentRect,
  cssVar,
  drawOccupancyHeatmap,
  drawTracks,
  drawTripwires,
  drawTripwireDraft,
  drawPolygonEditor,
  drawZoneOverlays,
  drawTelemetryHud,
  drawCalibrationOverlay,
  RISK_LABEL,
  type HubZoneState,
  type ZoneResult,
  type TrackBox,
} from "./camera/draw";
import { ConfigZonaDialog } from "./camera/ConfigZonaDialog";
import { CamHeader } from "./camera/CamHeader";
import { CamKpiBar } from "./camera/CamKpiBar";
import { ExibicaoPopover } from "./camera/ExibicaoPopover";
import { CineBar } from "./camera/CineBar";
import { useTelemetry } from "./camera/useTelemetry";
import { useWebrtcTransport } from "./camera/useWebrtcTransport";
import { useHubAnalysis, applyHubAnalysis, HUB_TRACKS_STALE_MS } from "./camera/useHubAnalysis";
import { TrackInterpolator, toDisplayTracks } from "./camera/interpolate";
import { createCadenceMeter } from "./camera/cadence";
import { detectionInterval, shouldRunDetection, detectScheduleOpts } from "./camera/rafSteps";
import { CamDrawer, type DrawerTab } from "./camera/CamDrawer";
import { type TimelineItem } from "./camera/tabs/TimelineTab";
import "./camera/cine.css";

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
  /** SYNC AO VIVO da CALIBRAÇÃO (mesmo idioma do tripwiresRev/ADR-006): revisão incrementada pela
   *  central a cada `camcfg-updated {kind:"calibration"}` → a câmera re-busca o H. Ausente →
   *  calibração carrega só ao abrir/trocar a câmera (comportamento anterior). */
  calibrationRev?: number;
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
  calibrationRev,
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
  // Máscara efetiva por zona (cache + fábricas de `contains`) — ./camera/useZoneMasks. É a casa da
  // precedência points>mask (P5) e do consumo rasterizado do polígono (P6). O PINCEL saiu (F5): a
  // máscara é rasterização INTERNA do polígono + leitura das zonas legadas já pintadas.
  const zm = useZoneMasks();
  const [paused, setPaused] = useState(false);
  const [perf, setPerf] = useState({ fps: 0 });
  // HUD: toggle no estado (UI); o rAF lê o REF (a régua não pode custar re-render por frame).
  // Setter ÚNICO (mesmo idioma do setFloorOn/useCalibrationOverlay): ref (rAF) + estado (UI)
  // mudam numa só unidade — nenhum caminho escreve um sem o outro.
  const [hud, setHudState] = useState(false);
  const hudRef = useRef(false);
  const setHud = (v: boolean) => {
    hudRef.current = v;
    setHudState(v);
  };
  const [detBackend, setDetBackend] = useState<string | null>(null); // null até o worker reportar
  // Detector do modo OBJETOS: o processador já reportava o backend a cada rodada e o resultado era
  // DESCARTADO aqui — por isso "0 caixas" e "o modelo nunca carregou" ficavam idênticos na tela
  // (falso-OK). Vira estado (o ref evita re-render: muda 2-3× na vida da página).
  const [objBackend, setObjBackend] = useState<ObjBackend>("carregando");
  const objBackendRef = useRef<ObjBackend>("carregando");
  const [presence, setPresence] = useState({ now: 0, peak: 0, dwell: 0 });
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  // Default = uma aba de OBSERVAÇÃO (Zona/Linha saíram das abas — viram modos do palco). Pessoas é a
  // vista diária do operador.
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("presenca");
  const [cfgZoneId, setCfgZoneId] = useState<string | null>(null);
  const [layersOpen, setLayersOpen] = useState(false); // popover Exibição → trap defere ao Radix (cfgOpenRef)
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

  // (A fusão tag↔pessoa — useCameraTagLabels/useFloorTags/useFunnelDiagnosis — migrou para o
  //  repo mvp_trilateracao_BLE; ADR-018. O rótulo da pessoa é o genérico "Pessoa": drawTracks sem
  //  labelFor → personLabel(undefined, id) — o gate anti-número segue em drawTracks.test.ts.)

  // Malha da calibração (grade do chão via homografia + pontos cadastrados) — SÓ na câmera ABERTA.
  // Toggle opt-in; refs (onRef/dataRef) lidos no rAF/drawScene sem re-armar o laço de desenho.
  const calib = useCalibrationOverlay(cameraId, mode === "full");
  // SYNC AO VIVO da calibração (ADR-006): salva em OUTRO posto → a central incrementa a rev
  // (`camcfg-updated {kind:"calibration"}`) → a malha re-busca o H. (Era a fusão quem consumia a
  // rev; a re-busca do H é da CÂMERA e permanece.) rev 0/ausente = carga inicial já cobre.
  const calibRefreshRef = useRef(calib.refresh);
  calibRefreshRef.current = calib.refresh;
  useEffect(() => {
    if (calibrationRev) calibRefreshRef.current();
  }, [calibrationRev]);

  // MODO CALIBRAR do palco (spec-arquitetura-informacao §1 — a rota /calibracao morre): 5º modo, no
  // molde do usePolygonEditor. O hook é dono de cantos/âncoras/estações/refTag/L×C/H/save; aqui só
  // a fiação (1 hook + a delegação de ponteiro no useStageModes + a camada SVG + 1 TabsContent).
  // Salvou → `calib.refresh()`: a malha do rodapé passa a desenhar a H NOVA (sem reabrir a câmera).
  const cal = useCalibrationEditor({
    cameraId,
    canConfigure,
    viewportRef,
    currentFrame,
    onSaved: calib.refresh,
  });

  // Espelho de cal.active p/ o rAF/drawScene: o loop de desenho é armado com deps fixas e fecha
  // sobre um drawScene STALE (cal.active é state, não muda as deps do efeito). O gate de camadas
  // do MODO (sceneLayers) tem que ler o valor CORRENTE — via ref, o idioma da casa (hudRef/etc.).
  const calActiveRef = useRef(false);
  useEffect(() => {
    calActiveRef.current = cal.active;
  }, [cal.active]);

  // Interpolador DISPLAY-ONLY das caixas do hub (o MESMO puro da grade — camera/interpolate.ts).
  const hubInterpRef = useRef<TrackInterpolator>(new TrackInterpolator());
  // Réguas de latência do HUD (spec-overlay-tempo-real Onda 0): cadência real do analysis-tracks
  // (EMA c/ dedupe por ts — camera/cadence.ts) + latencyMs do último payload fresco. Refs no rAF.
  const hubCadenceRef = useRef(createCadenceMeter());
  const hubLatencyRef = useRef<number | null>(null);

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
      poly.cancel(); // editor de linha derruba o editor de zona (modos exclusivos)
      cal.stop(); // …e a calibração (5º modo — exclusão mútua)
    },
  });

  // EDITOR DA ZONA (spec-zona-unificada F3) — a zona É um polígono: preset retângulo (arraste),
  // rascunho livre (clique a clique) e EDIÇÃO (mover a forma · arrastar/inserir/remover vértice).
  // Tudo em ./camera/usePolygonEditor; aqui só a fiação: os handlers delegam (onDown/onMove/onUp)
  // e criação/patch reusam persist/patchZone.
  const poly = usePolygonEditor({
    viewportRef,
    currentFrame,
    zonesRef,
    onStart: () => {
      setTripwireMode(false);
      cal.stop();
    },
    // Rótulo = próximo índice LIVRE (não `length + 1`, que colidia após apagar zona do meio — e o
    // hub agora rejeita rótulo duplicado, porque zonas homônimas somavam a contagem uma da outra).
    onCreate: (points) =>
      setZones((p) => persist([...p, withDefaults({ label: nextZoneLabel(p), points }, cameraId)])),
    onLive: (id, patch) => setZones((p) => p.map((z) => (z.id === id ? { ...z, ...patch } : z))),
    onPatch: (id, patch) => patchZone(id, patch),
    onAlert: (m) => onAlertRef.current?.(`⚠ ${label}: ${m}`),
  });

  // PONTEIRO do palco (./camera/useStageModes): o multiplexador dos modos. A ORDEM é pura e testada
  // (stageTarget) — é lá que a calibração fica ACIMA do corte de `!canConfigure`, para o operador
  // não perder o MEDIR (spec §1, risco 2).
  const stage = useStageModes({
    mode,
    canConfigure,
    viewportRef,
    reviewRef,
    poly,
    cal,
    tripwireMode,
    twDrawRef,
    commitTripwire,
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
    cfgOpenRef.current = !!cfgZoneId || layersOpen; // zona OU exibição aberta → Radix trata ESC/Tab
  }, [cfgZoneId, layersOpen]);
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

  // Recorte da ROI da zona (cap ~480px) → FrameSource do FadigaProcessor · ./camera/cropZone.
  // Reusa o canvas por zona (identidade estável); o newFrame usa a identidade do frame real (srcEl).
  const cropFor = (z: Zone, f: FrameSource): FrameSource => cropZone(cropsRef.current, z, f);

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
        birthContainment: T.birthContainment, // duplicata PARCIAL (contida) não nasce 2º track
        reassocDist: T.reassocDist,
        reassocMaxGapMs: T.reassocMaxGapMs,
        lostAfterMisses: T.lostAfterMisses,
        // ESTADO ESTACIONÁRIO: os 4 knobs agora VÊM do config (antes o tracker herdava os defaults
        // internos, que só COINCIDIAM — mudar o config não movia nada; #F4-w). config.people.track
        // é a fonte única (o mesmo que eval/front-tournament.mjs lê).
        stationaryTolerance: T.stationaryTolerance,
        stationaryEnterRounds: T.stationaryEnterRounds,
        stationaryMaxMisses: T.stationaryMaxMisses,
        stationaryMaxMs: T.stationaryMaxMs,
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
      zone: assignZone(ativ, t.cx, t.cy, t.bbox, zm.containsFn)?.label ?? null,
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
        // Proibida: o PRODUTOR do alerta é o MOTOR DO HUB (presence-alert.js) — sem processador
        // cliente nesta onda; instanciar o fallback dispararia alerta de INATIVIDADE falso.
        if (z.modo === "exclusao" || z.modo === "proibida") continue;
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
            // P6: o laço POR PIXEL (e a ocupação) consomem a máscara — rasterizada p/ polígono.
            contains: zm.pixelContainsFn(z),
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
          // Dedup por câmera já é feita no LeituraProcessor (dedupWindowMs/passDebounceMs); o
          // agregador multi-câmera por ponto saiu na faxina ADR-016 (store write-only) — cada
          // leitura emitida conta como caixa nova (newBox) e multi-read não é mais computado.
          if (shouldIngest("reads", engine))
            r.reads.forEach((rd) => recordReads({ ...rd, newBox: true, becameMulti: false }));
          if (shouldIngest("pass", engine)) r.passes.forEach((ps) => recordPass(ps.ponto, ps.ts));
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
            [
              {
                id: z.id,
                label: z.label,
                x: z.x,
                y: z.y,
                w: z.w,
                h: z.h,
                contains: zm.containsFn(z),
                targetOccupancy: z.targetOccupancy,
                occupancyToleranceMs: z.occupancyToleranceMs,
              },
            ],
            z.selectedClasses,
            { frame: f, now },
          );
          if (r.detectMs != null) stageMsRef.current.detect = r.detectMs;
          // O backend do detector PARA DE SER DESCARTADO: sobe ao estado que a aba Zonas lê.
          if (r.backend !== objBackendRef.current)
            setObjBackend((objBackendRef.current = r.backend));
          // Objetos segue no cliente (o motor não cobre o modo) → sempre ingerido (ADR-009).
          if (shouldIngest("object", engine)) {
            r.events.forEach((e) => recordObjectEvent(e));
            if (r.samples) recordObjectSamples({ samples: r.samples });
          }
          r.alerts.forEach((a) => onAlertRef.current?.(a));
          // Lotação fora do alvo (⚠ NOS TEXTOS DE onAlert É CONTRATO — ver nota mais abaixo): só
          // este tipo de alerta do modo objetos leva o prefixo "⚠", de propósito — é o que faz
          // alertMetaFromText derivar cameraId/zona e o alarme chegar ao Andon/WhatsApp; entrada/
          // saída de presença (r.alerts acima) segue como toast informativo, sem alarme.
          r.occupancyAlerts.forEach((oa) => {
            const dir = oa.count > oa.target ? "acima" : "abaixo";
            onAlertRef.current?.(
              `⚠ ${label} · ${oa.setor}: lotação ${dir} do esperado — ${oa.count} pessoa(s) (esperado ${oa.target})`,
            );
          });
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
        excl.map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h, contains: zm.containsFn(z) })),
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
    // GATE DE CAMADAS POR MODO (spec §3.1 — a causa-raiz do "totalmente sobreposto"): em CALIBRAR
    // TODA camada de operação cai (tracks/zonas/tripwires/floor-tags/malha-SALVA/HUD) e o palco fica
    // só com o vídeo + a calibração VIVA (CalibrationLayer, SVG irmão). Mata a DUPLA-GRADE (malha
    // salva no canvas × grade viva no SVG) numa tacada. Decisão PURA e testada (useStageModes).
    const ov = sceneLayers({ calActive: calActiveRef.current });

    // Heatmap de ocupação (camada, sob as geometrias) — grade normalizada da lib counting.ts.
    if (ov.heatmap && layersRef.current.heatmap && occRef.current)
      drawOccupancyHeatmap(ctx, cr, occRef.current);

    // Suavização DISPLAY-ONLY das caixas do hub (TrackInterpolator, o MESMO puro da grade): a
    // bbox crua congela+salta na cadência do motor (~1fps). Invariante: a LÓGICA (contagem/
    // exclusão/tripwire/ocupação) JÁ RODOU sobre tracksRef EXATO; aqui só muda o que se VÊ.
    // Ingere só payload FRESCO (mesmo limiar do applyHubAnalysis); modo local não interpola.
    const hubEngine = analysisEngineRef.current === "hub";
    let displayTracks: ReadonlyArray<TrackBox> = tracksRef.current;
    // Estado da zona PROIBIDA do MOTOR (`zonesProibidas`, campo do contrato — types/analysis.ts):
    // só de payload FRESCO; hub antigo (sem o campo) → null e o desenho fica em ARMADA quieta.
    let hubProibidas: ReadonlyArray<HubZoneState> | null = null;
    if (hubEngine) {
      const nowMs = performance.now();
      const hd = getHubAnalysisRef.current?.() ?? null;
      if (hd && Date.now() - hd.ts <= HUB_TRACKS_STALE_MS) {
        hubInterpRef.current.ingest(hd, nowMs);
        hubProibidas = hd.zonesProibidas ?? null;
        // Réguas do HUD (Onda 0): cadência real dos payloads + latência hub do último fresco.
        hubCadenceRef.current.observe(hd.ts, nowMs);
        hubLatencyRef.current = typeof hd.latencyMs === "number" ? hd.latencyMs : null;
      }
      // Onda 2/modo síncrono: instante do QUADRO exibido (WebRTC atrasado ⇒ interpolação exata).
      const { syncDelayMs: sy, videoLagMs: vl } = APP_CONFIG.overlay;
      const vLag = webrtcRef.current ? (sy > 0 ? sy : vl.webrtc) : vl.mjpeg;
      displayTracks = toDisplayTracks(
        hubInterpRef.current.sample(nowMs, vLag),
        hubFirstSeenRef.current,
        nowMs,
      );
    }

    // pessoas (tracks anônimos) — Presença (camada "caixas"; atenua abaixo da confiança).
    // Sem labelFor (a fusão BLE migrou — ADR-018): personLabel(undefined, id) → "Pessoa".
    if (ov.tracks && layersRef.current.boxes)
      drawTracks(ctx, cr, displayTracks, confRef.current, pausedRef.current && detailed);

    // Laço por-zona (retângulo/máscara + rótulo + dets + fadiga) → ./camera/draw. Último arg
    // (1 pessoa = 1 caixa): a camada de dets omite a det de pessoa já coberta por um track.
    if (ov.zones)
      drawZoneOverlays(
        ctx,
        cr,
        zonesRef.current,
        resultsRef.current,
        layersRef.current,
        confRef.current,
        detailed,
        zm.getMask,
        layersRef.current.boxes ? displayTracks.map((t) => t.bbox) : [],
        hubProibidas, // fio VIOLADA (zonesProibidas do motor); null → ARMADA quieta (aditivo)
      );

    // Malha da calibração SALVA (toggle opt-in): grade do chão via homografia + pontos cadastrados.
    // ov.calibrationMesh a DESLIGA em Calibrar — senão ela e a grade VIVA do CalibrationLayer (SVG)
    // são DUAS grades idênticas empilhadas (a causa-raiz medida da queixa "totalmente sobrepostos").
    if (ov.calibrationMesh && calib.onRef.current) {
      const c = calib.dataRef.current;
      if (c.points.length) drawCalibrationOverlay(ctx, cr, c.points, c.H);
    }

    // Tripwires — visíveis FORA de Calibrar (ov.tripwires). Modo hub (ADR-009): o "hoje" é SÓ o
    // acumulado do servidor (somar a sessão local contaria cada cruzamento 2×) e paused=false (o
    // motor conta 24/7); modo local: base do servidor + sessão corrente, pausado na grade.
    if (ov.tripwires)
      drawTripwires(
        ctx,
        cr,
        tripwiresRef.current,
        hubEngine ? EMPTY_TW_COUNTS : twCountsRef.current,
        !hubEngine && mode !== "full",
        hubEngine ? hubFlowRef.current : flowBaseRef.current,
      );

    drawTripwireDraft(ctx, twDrawRef.current); // linha em traçado
    // EDITOR DA ZONA (F3): preset retângulo em arraste · rascunho do polígono · midpoints fantasma
    // e vértice selecionado da zona em edição · aresta VERMELHA da auto-interseção (antes de soltar).
    drawPolygonEditor(ctx, cr, zonesRef.current, poly.draftRef.current, poly.overlayRef.current);

    // HUD de telemetria (toggleável; só na câmera aberta), desenhado por último. overlayAge só
    // faz sentido no modo hub; dropped/recvFps são opcionais do FrameSource (lidos defensivos);
    // estágios dos processadores vêm de stageMsRef e a fila do scheduler de schedulerStats().
    if (ov.hud && hudRef.current && detailed) {
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
        // Réguas de latência (Onda 0/CA-1) — durações LOCAIS, sem skew: `vid` = idade
        // chegada→draw do frame EXIBIDO (só MJPEG; WebRTC não carimba ts → linha omitida).
        frameAgeMs: typeof fx.ts === "number" && fx.ts > 0 ? Date.now() - fx.ts : undefined,
        trackIntervalMs: eng === "hub" ? hubCadenceRef.current.intervalMs() : undefined,
        hubLatencyMs: eng === "hub" ? hubLatencyRef.current : undefined,
        interp: eng === "hub" ? hubInterpRef.current.stats() : null, // ramo do desenho + coasting
        syncActive: wrtc && APP_CONFIG.overlay.syncDelayMs > 0, // só aí exato<100% é anomalia
        detectMs: st.detect,
        decodeMs: st.decode,
        faceMs: st.face,
        handMs: st.hand,
        objMs: st.obj,
        queue: schedulerStats(),
      });
    }
  }

  // ── editores do palco ── (ponteiro → ./camera/useStageModes · zona → ./camera/usePolygonEditor)
  // Modos de edição mutuamente exclusivos (zona × linha × CALIBRAÇÃO).
  // CALIBRAR (spec §3): liga o modo no palco — e o palco INTEIRO se reconfigura (o gate sceneLayers
  // apaga as camadas de operação; o header some com Zona/Polígono/Linha; o drawer vira SÓ o passo-a-
  // passo da calibração; ESC sai). Não há mais 7ª aba espremida: calibrar é MODO, não aba. Desligar
  // NÃO descarta o trabalho (o hook segue montado: cantos/L×C sobrevivem).
  function toggleCalibration() {
    if (cal.active) {
      cal.stop();
      return;
    }
    setTripwireMode(false);
    poly.cancel();
    cal.start();
  }

  // ⚠ NOS TEXTOS DE onAlert É CONTRATO, NÃO DECORAÇÃO (não "limpe" numa varredura de ícones):
  // DashboardPage.handleAlert usa `msg.includes("⚠")` p/ escolher o TOM do toast e
  // `alertMetaFromText` faz o parse do padrão "⚠ <câmera>[ · <zona>]: …" p/ derivar cameraId/zona
  // dos campos ESTRUTURADOS do emit `alert` (hub → andon/webhook). Os glifos de UI (que eram
  // ícone) viraram Lucide; estes são PROTOCOLO e ficam.

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
    // "exclusao" e "proibida" não são presets (exclusão só suprime; proibida é alarmada pelo MOTOR
    // do hub). O narrowing do `!==` reduz `next` a ModeKey (os 4 modos com preset) e applyPreset
    // segue tipado.
    if (next !== "exclusao" && next !== "proibida") applyPreset(next);
  }
  function removeZone(id: string) {
    holdersRef.current.get(id)?.proc.dispose();
    holdersRef.current.delete(id);
    cropsRef.current.delete(id);
    resultsRef.current.delete(id);
    zm.drop(id);
    clearZone(id);
    poly.deselect(); // a seleção do editor não pode apontar p/ uma zona que não existe mais
    setZones((p) => persist(p.filter((z) => z.id !== id)));
  }

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
      // A11y (R-C): a casca clicável ganha role/tabIndex/teclado — abrir a câmera não pode
      // ser só-mouse (WCAG). Fica <div role="button"> (não <button>) p/ NÃO herdar chrome
      // nativo nem exigir reset da .tile compartilhada; o foco visível mora em .tile:focus-visible.
      <div
        className={`tile ${alertCount ? "alerting" : ""}`}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen?.(); // onOpen é opcional (espelha onClick={onOpen}, no-op se indefinido)
          }
        }}
        role="button"
        tabIndex={0}
        // aria-label distingue os tiles entre si (o `title` é IDÊNTICO em todos e é contrato de
        // SELETOR do e2e: `.tile[title='Abrir câmera']` — permanece, mas não é mais o nome).
        aria-label={`Abrir câmera ${label}`}
        title="Abrir câmera"
      >
        <div className="viewport tile-vp" ref={viewportRef}>
          {/* O canvas é a IMAGEM da câmera: o nome acessível do tile (aria-label acima) já
              descreve o conteúdo — o canvas em si não acrescenta nada ao leitor de tela. */}
          <canvas ref={canvasRef} aria-hidden />
          <div className="tile-badges">
            {/* Emoji ⚠ → Lucide (regra 11). Nunca só-por-cor: ícone + número + texto acessível. */}
            {alertCount > 0 && (
              <span className="tb alert">
                <TriangleAlert size={12} strokeWidth={1.75} aria-hidden /> {alertCount}
                <span className="sr-only">
                  {alertCount === 1 ? "1 zona em alerta" : `${alertCount} zonas em alerta`}
                </span>
              </span>
            )}
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
      {/* Barra de ferramentas do palco → ./camera/CamHeader (JSX puro; nenhum canvas/rAF lá). */}
      <CamHeader
        label={label}
        zonesCount={zones.length}
        canConfigure={canConfigure}
        activePreset={activePreset}
        activePresetDef={activePresetDef}
        presetDirty={presetDirty}
        review={review}
        enterReview={enterReview}
        exitReview={exitReview}
        paused={paused}
        setPaused={setPaused}
        tripwireMode={tripwireMode}
        toggleTripwireMode={toggleTripwireMode}
        poly={poly}
        calActive={cal.active}
        calMode={cal.mode}
        toggleCalibration={toggleCalibration}
        reviewTip={reviewTip}
        editTip={poly.hint}
        // EXIBIÇÃO (spec §3-C): o popover ÚNICO de config-de-exibição; reúne o que estava PARTIDO entre a KPI bar e a aba Camadas.
        layersControl={
          <ExibicaoPopover
            open={layersOpen}
            onOpenChange={setLayersOpen}
            hud={hud}
            setHud={setHud}
            calib={calib}
            layers={layers}
            setLayers={setLayers}
            conf={conf}
            setConf={setConf}
            preset={{ active: activePreset, dirty: presetDirty, apply: applyPreset }}
            canConfigure={canConfigure}
            longRange={longRange}
            onLongRangeChange={onLongRangeChange}
          />
        }
        onClose={onClose}
      />

      {/* Palco + drawer lado a lado (.cam-body, cine.css): o palco encolhe quando o
          drawer está aberto e o drawScene re-letterboxa (fit) — nada de crop. */}
      <div className="cam-body relative">
        <div
          className={`cam-stage ${poly.active || tripwireMode || cal.active ? "draw-cursor" : ""}`}
          ref={viewportRef}
          onMouseDown={stage.onDown}
          onMouseMove={stage.onMove}
          onMouseUp={stage.onUp}
          onMouseLeave={stage.onUp}
        >
          {/* Vídeo WebRTC ATRÁS do canvas (decode por HW); câmera mjpeg nem monta o elemento. */}
          {webrtc && <video-stream ref={videoStreamRef} />}
          {/* `key` por transporte: os atributos do 1º getContext travam p/ sempre (opaco no MJPEG,
              transparente no WebRTC) → troca em runtime REMONTA o canvas com o alpha certo. O
              canvas vem DEPOIS do <video-stream> → pinta por cima (ordem de pintura).
              a11y: o palco é uma IMAGEM (vídeo + geometria) — role/aria-label dão o nome; os
              NÚMEROS têm alternativa textual na barra de KPIs abaixo ("a imagem é soberana":
              número nunca vive sobre o vídeo). */}
          <canvas
            className="overlay"
            key={webrtc ? "rtc" : "mjpeg"}
            ref={canvasRef}
            role="img"
            aria-label={`Vídeo ao vivo de ${label} com as marcações de análise (zonas, linhas e pessoas). Os indicadores em texto estão na barra abaixo.`}
          />
          {/* Marcação da CALIBRAÇÃO → ./camera/CalibrationLayer: SVG IRMÃO do canvas (como a
              CineBar), posicionado pelo content-rect. Com ⏸ Pausar o rAF retorna ANTES do
              drawScene — desenhar os cantos no canvas os faria SUMIR justo quando o operador
              congela a imagem para clicar com precisão (spec §1, risco 1). O rAF fica intocado. */}
          <CalibrationLayer cal={cal} />
          {/* Barra do cine-loop → ./camera/CineBar (irmã do canvas, nunca ancestral). */}
          {review && (
            <CineBar
              cineRef={cineRef}
              cineSize={cineSize}
              scrubIndex={scrubIndex}
              setScrubIndex={setScrubIndex}
              cinePlaying={cinePlaying}
              setCinePlaying={setCinePlaying}
              scrubBy={scrubBy}
              downloadSnapshot={downloadSnapshot}
              exportClip={exportClip}
              clipState={clipState}
              clipPct={clipPct}
              exitReview={exitReview}
            />
          )}
        </div>
        {/* Painel lateral (abas) → ./camera/CamDrawer: JSX puro, nenhum canvas/rAF lá. */}
        <CamDrawer
          // Qual painel contextual: o modo de edição ARMADO (activeStageMode, pura+testada) —
          // Calibrar/Linha/Área → o painel daquele modo; nenhum → as abas de observação. `areaMode`
          // = o editor da zona armado pelo toggle "Área" (o gesto decide retângulo × polígono).
          mode={activeStageMode({
            calActive: cal.active,
            tripwireMode,
            areaMode: poly.active,
          })}
          tab={drawerTab}
          onTab={setDrawerTab}
          zonas={{
            zonesLoading,
            zones,
            canConfigure,
            panel,
            hist,
            legend,
            setCfgZoneId,
            removeZone,
            objBackend,
          }}
          linhas={{
            tripwireMode,
            canConfigure,
            toggleTripwireMode,
            resetCounts,
            tripwires,
            twCounts,
            analysisEngine,
            hubFlowToday,
            flowBase,
            invertTripwire,
            removeTripwire,
          }}
          timeline={timeline}
          presence={presence}
          paused={paused}
          cal={cal}
          onCalibrate={toggleCalibration}
        />
      </div>

      {/* Barra de KPIs (rodapé) → ./camera/CamKpiBar. "A imagem é soberana" (ADR-003): o número
          vive AQUI, no painel — nunca sobre o vídeo. */}
      <CamKpiBar
        presence={presence}
        fps={perf.fps}
        summary={summary}
        analysisEngine={analysisEngine}
        detBackend={detBackend}
        paused={paused}
      />

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
