import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { APP_CONFIG, MODE_PRESETS, type OverlayLayers, type ModeKey } from "./config";
import { type FrameSource } from "./frame";
import { fmtDuration, fmtLimit, clock } from "./format";
import { FrameMeter } from "./telemetry";
import { type Detection } from "./vision/model";
import { ensureDetectClient, detectFrame } from "./vision/detect";
import { requestInference } from "./vision/scheduler";
import { AtividadeProcessor, ACTIVITIES, sensitivityFactor, type AtividadeCtx, type ZoneView, type ZoneState } from "./processors/atividade";
import { LeituraProcessor } from "./processors/leitura";
import { ObjetosProcessor } from "./processors/objetos";
import { FadigaProcessor, type FadigaModelState } from "./processors/fadiga";
import { loadFadigaThresholds } from "./fadiga/calibration";
import { type RiskState } from "./fadiga/landmarks";
import { type FadigaScene } from "./fadiga/draw";
import { type ObjDetection } from "./objects/detector";
import { pushRead, pushPass } from "./reading/cluster";
import { recordSamples, recordAlert, recordReads, recordPass, recordObjectSamples, recordObjectEvent, recordFadigaSamples, recordFadigaEvent, loadDataset, type ZoneSample } from "./report/store";
import { type Dataset } from "./report/mock";
import { predictAlertsPerDay } from "./report/predict";
import { objClass, OBJECT_CATALOG } from "./objects/catalog";
import { loadZones, saveZones, newZoneId, DEFAULT_GRID, ZONE_MODE_LABEL, type Zone, type ZoneMode } from "./zones";
import { decodeMask, encodeMask, maskFromRect, paintBrush, cellAtNorm, maskBBoxNorm, anySet, clearMask, containsNorm, type Mask } from "./zoneMask";
import { createCounter, createOccupancy, inwardNormal, type Counter, type Occupancy, type TripwireCounts } from "./vision/counting";
import { getTripwires, saveTripwires, ApiError, type Tripwire } from "./api";
import { Button, IconButton, Input, Select, Slider, Switch, SegmentedControl, Dialog, Badge, Field, type Tone } from "./ui";
import { CineBuffer, type CineFrame } from "./camera/cineBuffer";
import { clipSupport, recordClipWebm, buildMontagePng, triggerDownload, clipFileName, type ClipFrame } from "./camera/clipExport";
import { MetricCell, type Band, type MetricState } from "./components/Sparkline";
import { useAuth } from "./auth";
import "./camera/cine.css";

const MODO_OPTS = [{ value: "atividade", label: "Atividade" }, { value: "leitura", label: "Leitura" }, { value: "objetos", label: "Objetos" }, { value: "fadiga", label: "Fadiga" }];
const BRUSH_OPTS = [{ value: "1", label: "1×" }, { value: "2", label: "2×" }, { value: "3", label: "3×" }];

// Grade do heatmap de ocupação (camada opcional sobre o vídeo).
const HEAT_COLS = 32, HEAT_ROWS = 18;

// ── Tripwires (linhas de contagem com direção) — fonte: BACKEND (compartilhado por câmera) ──
// Antes viviam em localStorage (`vp-tripwires-<id>`); AGORA carregam/persistem via api.ts
// (getTripwires/saveTripwires), compartilhados entre operadores/turnos. Coords normalizadas 0..1.
// O localStorage permanece SÓ como origem de uma MIGRAÇÃO única best-effort (ver effect de load).
const tripwireKey = (cameraId: string) => `vp-tripwires-${cameraId}`;
let twSeq = 0;
function newTripwireId(cameraId: string) { return `${cameraId}-tw${Date.now().toString(36)}${++twSeq}`; }
// Lê linhas LEGADAS do localStorage (somente p/ migração única; validação defensiva do shape).
function loadLegacyTripwires(cameraId: string): Tripwire[] {
  let raw: unknown = null;
  try { const s = localStorage.getItem(tripwireKey(cameraId)); raw = s ? JSON.parse(s) : null; } catch { raw = null; }
  if (!Array.isArray(raw)) return [];
  const out: Tripwire[] = [];
  for (const w of raw as Partial<Tripwire>[]) {
    if (!w || typeof w.id !== "string" || !w.a || !w.b) continue;
    if (typeof w.a.x !== "number" || typeof w.a.y !== "number" || typeof w.b.x !== "number" || typeof w.b.y !== "number") continue;
    out.push({ id: w.id, a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } });
  }
  return out;
}
// Remove a chave legada após migração bem-sucedida (best-effort; falha silenciosa).
function clearLegacyTripwires(cameraId: string) {
  try { localStorage.removeItem(tripwireKey(cameraId)); } catch { /* no-op */ }
}

// ── Tokens da FUNDAÇÃO (Onda A) resolvidos p/ o canvas ──
// O canvas precisa de cores literais; lemos as CSS vars de :root (index.css) e cacheamos.
// Assim a tela de câmera CONSOME os tokens em vez de cores hardcoded ("going gray").
const _cssCache = new Map<string, string>();
function cssVar(name: string, fallback: string): string {
  let v = _cssCache.get(name);
  if (v === undefined) {
    try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { v = ""; }
    if (!v) v = fallback;
    _cssCache.set(name, v);
  }
  return v;
}
// Going-gray: estado de ATIVIDADE → token semântico (canvas).
// ATIVA→neutral · LENTA/OCIOSA→warn · VAZIA→neutral-dim · ALERTA→critical.
function stateCanvasColor(s: ZoneState): string {
  switch (s) {
    case "ALERTA": return cssVar("--state-critical", "#ef4444");
    case "OCIOSA":
    case "LENTA": return cssVar("--state-warn", "#eab308");
    case "VAZIA": return cssVar("--state-neutral-dim", "#5b6b7a");
    default: return cssVar("--state-neutral", "#64748b"); // ATIVA (normal → neutro)
  }
}
// Mesma semântica p/ inline styles do painel lateral (var() resolvido pelo CSS).
function stateVar(s: ZoneState): string {
  switch (s) {
    case "ALERTA": return "var(--state-critical)";
    case "OCIOSA":
    case "LENTA": return "var(--state-warn)";
    case "VAZIA": return "var(--state-neutral-dim)";
    default: return "var(--state-neutral)";
  }
}
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const s = (h.length === 3 ? h.split("").map((c) => c + c).join("") : h).slice(0, 6);
  const n = parseInt(s || "000000", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// CameraWorkspace: UMA câmera, VÁRIAS zonas, cada uma com seu modo (atividade/leitura/objetos).
// Roda o processador de cada zona na sua ROI, compõe o overlay e o painel num lugar só.

type Rect = { x: number; y: number; w: number; h: number };
function getContentRect(vpW: number, vpH: number, vidW: number, vidH: number): Rect {
  if (!vidW || !vidH) return { x: 0, y: 0, w: vpW, h: vpH };
  const s = Math.min(vpW / vidW, vpH / vidH);
  const w = vidW * s, h = vidH * s;
  return { x: (vpW - w) / 2, y: (vpH - h) / 2, w, h };
}

// resultado por zona guardado p/ desenho + painel
type ZoneResult =
  | { modo: "atividade"; view: ZoneView }
  | { modo: "leitura"; lastCode: string | null; perMin: number; passes: number; ratePct: number; noReads: number }
  | { modo: "objetos"; counts: Record<string, number>; total: number; dets: ObjDetection[] }
  | { modo: "fadiga"; risk: RiskState; ear: number | null; phone: boolean; faceState: FadigaModelState; scene: FadigaScene };

type Holder = { modo: ZoneMode; proc: AtividadeProcessor | LeituraProcessor | ObjetosProcessor | FadigaProcessor };

// risco → cor/rótulo (going-gray: OK normal → neutro; fadiga/celular → warn; duplo → critical)
function riskCanvasColor(r: RiskState): string {
  return r === "ALERTA_DUPLO" ? cssVar("--state-critical", "#ef4444")
    : r === "OK" ? cssVar("--state-neutral", "#64748b")
    : cssVar("--state-warn", "#eab308");
}
const RISK_LABEL: Record<RiskState, string> = { OK: "OK", ALERTA_FADIGA: "Fadiga", ALERTA_CELULAR: "Celular", ALERTA_DUPLO: "Duplo" };
const RISK_TONE: Record<RiskState, Tone> = { OK: "ok", ALERTA_FADIGA: "warn", ALERTA_CELULAR: "warn", ALERTA_DUPLO: "alert" };

// taxa de leitura → cor (verde ≥95 · âmbar ≥80 · vermelho abaixo). Espelha a semântica do relatório.
const MODE_TONE: Record<ZoneMode, Tone> = { atividade: "ok", leitura: "info", objetos: "warn", fadiga: "info" };

// ── TELEMETRIA "NUNCA NÚMERO CRU" (Onda B item 10) ───────────────────────────────────────
// Cada indicador numérico do painel lateral vira valor + sparkline + FAIXA-ALVO (banda verde/
// aceitável), com realce quando fora da faixa (tokens --state-warn / --state-critical). As
// faixas-alvo DERIVAM dos thresholds já existentes; premissas documentadas abaixo:
//
//  • Movimento (atividade): unidades de view.motion (= min(1, motionEMA/(motionActiveRatio·6))).
//    A zona vira ATIVA quando motionEMA > motionActiveRatio·sf, i.e. view.motion > sf/6.
//    Faixa-alvo = [sf/6, 1] (movimento saudável). Abaixo = LENTA/parada → warn/critical (estado).
//  • Ocupação (atividade): faixa-alvo = [1, OCC_HI] pessoas (zona guarnecida, sem superlotar).
//    Acima de OCC_HI = warn. OCC_HI é heurístico (não há ocupação-alvo por zona ainda) — A CONFIRMAR.
//  • Taxa de leitura: faixa-alvo = [95, 100]% (via rateToMetric: ≥95 ok, ≥80 warn, abaixo
//    critical — alinhado a reading.rateAlertPct=80).
//  • No-reads: faixa-alvo = [0, 0] (ideal é zero). >0 = warn, ≥NOREAD_CRIT = critical.
//  • Lidas/min e Total de objetos: SEM faixa-alvo fixa (depende da linha/cena) → só valor +
//    tendência. A CONFIRMAR se houver meta de throughput por ponto/cena.
//  • EAR (fadiga): faixa-alvo = [eyesClosedEarThreshold, EAR_HI] (olhos abertos). Abaixo do
//    limiar de olhos fechados = sinal de fadiga → realce conforme o RISCO da zona.
const HIST_LEN = 32;                          // tamanho do ring buffer por indicador (sparkline)
const OCC_HI = 8;                             // teto heurístico de ocupação por zona — A CONFIRMAR
const EAR_HI = 0.45;                          // teto de escala do EAR p/ a sparkline
const NOREAD_CRIT = 3;                        // no-reads: ≥ isto vira critical (1..2 = warn)

// estado da zona/risco/taxa → estado da MÉTRICA (cor da telemetria, tokens --state-*)
function stateToMetric(s: ZoneState): MetricState { return s === "ALERTA" ? "critical" : s === "ATIVA" ? "ok" : "warn"; }
function riskToMetric(r: RiskState): MetricState { return r === "ALERTA_DUPLO" ? "critical" : r === "OK" ? "ok" : "warn"; }
function rateToMetric(pct: number): MetricState { return pct >= 95 ? "ok" : pct >= 80 ? "warn" : "critical"; }
function noReadMetric(n: number): MetricState { return n >= NOREAD_CRIT ? "critical" : n > 0 ? "warn" : "ok"; }
function occMetric(n: number): MetricState { return n > OCC_HI ? "warn" : "ok"; } // baixa ocupação não "grita" (zona pode estar legitimamente vazia)
const NOREAD_BAND: Band = { lo: 0, hi: 0 };
const RATE_BAND: Band = { lo: 95, hi: 100 };
const OCC_BAND: Band = { lo: 1, hi: OCC_HI };

// MODO-COMO-PRESET: o workspace tem N zonas (cada uma com seu modo), mas overlays/confiança
// são GLOBAIS da sessão. O "preset ativo" segue o modo PREDOMINANTE entre as zonas
// (empate → ordem atividade>leitura>objetos>fadiga). Trocar o modo de uma zona reaplica o preset.
const PRESET_ORDER: ModeKey[] = ["atividade", "leitura", "objetos", "fadiga"];
function dominantMode(zs: Zone[]): ModeKey {
  if (!zs.length) return "atividade";
  const counts: Record<string, number> = {};
  for (const z of zs) counts[z.modo] = (counts[z.modo] ?? 0) + 1;
  return PRESET_ORDER.reduce((best, m) => ((counts[m] ?? 0) > (counts[best] ?? 0) ? m : best), PRESET_ORDER[0]);
}

// Overlay compacto de fadiga DENTRO do retângulo da zona (olhos/boca + bbox de celular).
// Landmarks são normalizados ao recorte → mapeados direto no rect da zona. (Mesh completo fica na câmera dedicada.)
const FAD_LEFT = APP_CONFIG.fadiga.eyeIndices.left, FAD_RIGHT = APP_CONFIG.fadiga.eyeIndices.right, FAD_MOUTH = APP_CONFIG.fadiga.mouthIndices.draw;
function drawFadigaZone(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: FadigaScene) {
  const lm = s.landmarks;
  if (lm && lm.length) {
    ctx.fillStyle = "rgba(56,189,248,0.95)";
    for (const idx of [...FAD_LEFT, ...FAD_RIGHT]) { const p = lm[idx]; if (!p) continue; ctx.beginPath(); ctx.arc(x + p.x * w, y + p.y * h, 2, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = s.yawnDetected ? "rgba(248,113,113,0.95)" : "rgba(251,191,36,0.95)";
    for (const idx of FAD_MOUTH) { const p = lm[idx]; if (!p) continue; ctx.beginPath(); ctx.arc(x + p.x * w, y + p.y * h, 2.2, 0, Math.PI * 2); ctx.fill(); }
  }
  if (s.phone) {
    const vw = s.videoWidth || w, vh = s.videoHeight || h;
    ctx.strokeStyle = "rgba(250,204,21,0.95)"; ctx.lineWidth = 2;
    ctx.strokeRect(x + (s.phone.x / vw) * w, y + (s.phone.y / vh) * h, (s.phone.width / vw) * w, (s.phone.height / vh) * h);
  }
}
type Track = { id: number; cx: number; cy: number; bbox: [number, number, number, number]; firstSeen: number; lastSeen: number; zone: string | null; score: number };
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
};

const C = APP_CONFIG.detection;

export function CameraWorkspace({ cameraId, label, getFrame, mode, demoMode = true, onOpen, onClose, onAlert }: Props) {
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
  const lastFrameElRef = useRef<unknown>(null);          // identidade do último frame processado (gate de "frame novo")
  const lastFrameTsRef = useRef(0);
  const detsRef = useRef<Detection[]>([]);
  const lastObjAtRef = useRef(0);
  const lastFrameAtRef = useRef(0);
  const lastFlowAtRef = useRef(0);
  const lastRecAtRef = useRef(0);
  const lastUiRef = useRef(0);
  const holdersRef = useRef<Map<string, Holder>>(new Map());
  const cropsRef = useRef<Map<string, HTMLCanvasElement>>(new Map()); // recorte por zona de fadiga
  const resultsRef = useRef<Map<string, ZoneResult>>(new Map());
  const zonesRef = useRef<Zone[]>([]);
  const meterRef = useRef(new FrameMeter());
  const onAlertRef = useRef(onAlert);
  const onCloseRef = useRef(onClose);          // estável p/ o handler de ESC (evita re-armar o listener a cada render)
  const fullRef = useRef<HTMLDivElement | null>(null);  // raiz do overlay em tela cheia (foco preso)
  const cfgOpenRef = useRef(false);            // diálogo de config aberto → deixa o Radix tratar ESC/Tab
  const drawRef = useRef<{ active: boolean; sx: number; sy: number; cx: number; cy: number } | null>(null);
  const maskCacheRef = useRef<Map<string, { enc?: string; mask: Mask }>>(new Map()); // máscaras decodificadas
  const paintingRef = useRef(false);
  const eraseRef = useRef(false);
  const tracksRef = useRef<Track[]>([]);          // presença (IDs anônimos + permanência)
  const trackIdRef = useRef(0);
  const peakRef = useRef(0);
  const pausedRef = useRef(false);
  const eventIdRef = useRef(0);
  const layersRef = useRef<OverlayLayers>({ ...APP_CONFIG.overlay.layers });   // camadas visíveis (lido no rAF)
  const confRef = useRef<number>(APP_CONFIG.overlay.confidenceThreshold);       // limiar global de confiança
  // Tripwires + ocupação (Onda C item 13): counter/occupancy da lib pura counting.ts (criados sob demanda no rAF).
  const counterRef = useRef<Counter | null>(null);
  const occRef = useRef<Occupancy | null>(null);
  const tripwiresRef = useRef<Tripwire[]>([]);                   // lido no rAF (desenho + setTripwires)
  const twCountsRef = useRef<Record<string, TripwireCounts>>({}); // snapshot p/ o HUD no canvas (sem alocar por frame)
  const twDrawRef = useRef<{ active: boolean; sx: number; sy: number; cx: number; cy: number } | null>(null); // linha em traçado (viewport px)
  // Telemetria lateral (Onda B item 10): ring buffer leve por zona/indicador, alimentado pelo
  // loop já existente na cadência de UI (sem custo extra de inferência). Map<zoneId, {key: série}>.
  const histRef = useRef<Map<string, Record<string, number[]>>>(new Map());
  // ── CONGELAR + CINE-LOOP (Onda B) ──
  // Buffer de quadros EM MEMÓRIA / EFÊMERO (LGPD: nunca vai ao servidor; ver cineBuffer.ts).
  const cineRef = useRef<CineBuffer | null>(null);
  if (cineRef.current === null) cineRef.current = new CineBuffer({ maxSeconds: 10, captureWidth: 480 });
  const reviewRef = useRef(false);   // lido no rAF: em revisão o palco PARA de avançar (mas a inferência de fundo segue)
  const scrubRef = useRef(0);        // índice do quadro em revisão (lido pelo render de revisão)

  const [zones, setZones] = useState<Zone[]>([]);
  const [panel, setPanel] = useState<Map<string, ZoneResult>>(new Map());
  const [drawMode, setDrawMode] = useState(false);
  const [tripwires, setTripwires] = useState<Tripwire[]>([]);
  const [tripwireMode, setTripwireMode] = useState(false);                       // editor de linha ativo (gated por canConfigure)
  const [twCounts, setTwCounts] = useState<Record<string, TripwireCounts>>({});  // contadores in/out p/ o painel lateral
  const [paintZoneId, setPaintZoneId] = useState<string | null>(null);
  const [brush, setBrush] = useState(2);
  const [erase, setErase] = useState(false);
  const [paused, setPaused] = useState(false);
  const [perf, setPerf] = useState({ fps: 0 });
  const [presence, setPresence] = useState({ now: 0, peak: 0, dwell: 0 });
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [drawerTab, setDrawerTab] = useState<"zonas" | "linhas" | "timeline" | "presenca" | "camadas">("zonas");
  const [cfgZoneId, setCfgZoneId] = useState<string | null>(null);
  // Onda 2: camadas + slider de confiança (estado local; inicia de APP_CONFIG.overlay).
  const [layers, setLayers] = useState<OverlayLayers>({ ...APP_CONFIG.overlay.layers });
  const [conf, setConf] = useState<number>(APP_CONFIG.overlay.confidenceThreshold);
  // MODO-COMO-PRESET: modo cujo preset está aplicado à sessão (camadas + confiança + métricas em destaque).
  const [activePreset, setActivePreset] = useState<ModeKey | null>(null);
  // Histórico p/ "alertas/dia estimados" do slider de sensibilidade (carregado on-demand).
  const [histDataset, setHistDataset] = useState<Dataset | null>(null);
  const [histState, setHistState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  // CONGELAR + CINE: modo revisão, índice do scrubber e play do cine-loop.
  const [review, setReview] = useState(false);
  const [scrubIndex, setScrubIndex] = useState(0);
  const [cinePlaying, setCinePlaying] = useState(false);
  const [cineSize, setCineSize] = useState(0);   // nº de quadros no buffer (atualiza o range do slider)
  const [reviewTip, setReviewTip] = useState<string | null>(null); // aviso quando o buffer está vazio
  // EXPORT DE CLIPE (local): estado da geração + progresso (0..100) p/ desabilitar/rotular o botão.
  const [clipState, setClipState] = useState<"idle" | "working" | "error">("idle");
  const [clipPct, setClipPct] = useState(0);
  const clipBusyRef = useRef(false);          // trava reentrância (1 export por vez)
  const clipUrlRef = useRef<string | null>(null); // object URL do último download (revogado no cleanup)

  useEffect(() => { onAlertRef.current = onAlert; }, [onAlert]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { cfgOpenRef.current = !!cfgZoneId; }, [cfgZoneId]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { reviewRef.current = review; }, [review]);
  useEffect(() => { scrubRef.current = scrubIndex; }, [scrubIndex]);
  // LGPD: ao desmontar a câmera, descarta TODO o buffer em memória (fecha os bitmaps)
  // e revoga qualquer object URL de export pendente (sem vazar memória).
  useEffect(() => { const cb = cineRef.current; return () => { cb?.dispose(); if (clipUrlRef.current) { URL.revokeObjectURL(clipUrlRef.current); clipUrlRef.current = null; } }; }, []);
  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { confRef.current = conf; }, [conf]);
  useEffect(() => {
    const z = loadZones(cameraId, label); setZones(z);
    // MODO-COMO-PRESET: ao abrir a câmera, carrega o preset do modo predominante (camadas + confiança).
    // Não toca na GEOMETRIA/zonas persistidas — só governa overlays/visão/métricas da sessão.
    const dom = dominantMode(z); const p = MODE_PRESETS[dom];
    setLayers({ ...p.layers }); setConf(p.confidenceThreshold); setActivePreset(dom);
  }, [cameraId, label]);
  // Tripwires: carrega do BACKEND ao abrir/trocar a câmera (compartilhado; leitura p/ todos).
  // Robustez: se o load falhar, degrada p/ lista vazia (contagem/heatmap seguem). Migração única
  // best-effort: se o backend vier vazio E houver legado em localStorage E o usuário puder configurar
  // (PUT exige engenharia), sobe o legado uma vez e limpa a chave local. Sem canConfigure, só usa o
  // backend (nada se perde: o legado permanece no localStorage até alguém com permissão migrar).
  useEffect(() => {
    let cancelled = false;
    setTripwireMode(false);
    (async () => {
      let list: Tripwire[] = [];
      try { list = await getTripwires(cameraId); }
      catch (e) { console.error("[tripwires] load falhou — degradando p/ lista vazia", e); list = []; }
      if (cancelled) return;
      if (list.length === 0 && canConfigure) {
        const legacy = loadLegacyTripwires(cameraId);
        if (legacy.length) {
          try { const saved = await saveTripwires(cameraId, legacy); if (cancelled) return; list = saved; clearLegacyTripwires(cameraId); }
          catch (e) { if (cancelled) return; console.error("[tripwires] migração best-effort falhou — usando legado nesta sessão", e); list = legacy; }
        }
      }
      if (!cancelled) setTripwires(list);
    })();
    return () => { cancelled = true; };
  }, [cameraId, canConfigure]);
  // Re-set da geometria no counter quando as linhas mudam (preserva contadores por id) + reflete no painel.
  useEffect(() => {
    tripwiresRef.current = tripwires;
    if (counterRef.current) { counterRef.current.setTripwires(tripwires); twCountsRef.current = counterRef.current.counts(); }
    setTwCounts(counterRef.current ? counterRef.current.counts() : {});
  }, [tripwires]);
  // Carrega o histórico (read-only) ao abrir a config de uma zona de atividade — p/ a previsão de alertas/dia.
  useEffect(() => {
    const z = cfgZoneId ? zonesRef.current.find((zz) => zz.id === cfgZoneId) : null;
    if (!z || z.modo !== "atividade") { setHistState("idle"); return; }
    let cancelled = false;
    setHistState("loading");
    loadDataset()
      .then((ds) => { if (!cancelled) { setHistDataset(ds); setHistState("ready"); } })
      .catch(() => { if (!cancelled) setHistState("error"); });
    return () => { cancelled = true; };
  }, [cfgZoneId]);
  useEffect(() => { ensureDetectClient(); }, []);
  useEffect(() => { const m = holdersRef.current; return () => { m.forEach((h) => h.proc.dispose()); m.clear(); }; }, []);

  // Overlay em tela cheia: ESC fecha + foco preso (focus trap) enquanto aberto (acessibilidade).
  // Quando o diálogo de config está aberto, deferimos ESC/Tab ao Radix (que tem o próprio trap).
  useEffect(() => {
    if (mode !== "full") return;
    const root = fullRef.current; if (!root) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
        .filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1 && (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement));
    const onKey = (e: KeyboardEvent) => {
      if (cfgOpenRef.current) return; // diálogo aberto → Radix trata
      if (e.key === "Escape") { e.preventDefault(); onCloseRef.current?.(); return; }
      if (e.key !== "Tab") return;
      const list = focusables(); if (!list.length) { e.preventDefault(); root.focus(); return; }
      const first = list[0], last = list[list.length - 1], active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus(); }
    };
    root.focus({ preventScroll: true });
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prevFocus?.focus?.(); };
  }, [mode]);

  function holderFor(z: Zone): Holder {
    const cur = holdersRef.current.get(z.id);
    if (cur && cur.modo === z.modo) return cur;
    cur?.proc.dispose();
    if (cur?.modo === "fadiga") cropsRef.current.delete(z.id);
    const proc = z.modo === "leitura" ? new LeituraProcessor() : z.modo === "objetos" ? new ObjetosProcessor() : z.modo === "fadiga" ? new FadigaProcessor() : new AtividadeProcessor(performance.now());
    if (z.modo === "fadiga") (proc as FadigaProcessor).setThresholds(loadFadigaThresholds()); // calibração global
    const h: Holder = { modo: z.modo, proc };
    holdersRef.current.set(z.id, h);
    return h;
  }

  // Recorte da ROI da zona (cap ~480px) → FrameSource alimentado ao FadigaProcessor.
  // Reusa o canvas por zona (identidade estável); o newFrame usa a identidade do frame real (srcEl).
  function cropFor(z: Zone, f: FrameSource): FrameSource {
    let cv = cropsRef.current.get(z.id);
    if (!cv) { cv = document.createElement("canvas"); cropsRef.current.set(z.id, cv); }
    const sw = Math.max(1, Math.round(z.w * f.w)), sh = Math.max(1, Math.round(z.h * f.h));
    const scale = Math.min(1, 480 / sw), cw = Math.max(1, Math.round(sw * scale)), ch = Math.max(1, Math.round(sh * scale));
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    cv.getContext("2d")!.drawImage(f.el, z.x * f.w, z.y * f.h, sw, sh, 0, 0, cw, ch);
    return { el: cv, w: cw, h: ch };
  }

  function containsFn(z: Zone): ((nx: number, ny: number) => boolean) | undefined {
    const m = getMask(z); return m && anySet(m) ? (nx: number, ny: number) => containsNorm(m, nx, ny) : undefined;
  }
  function zoneAtAtiv(ativ: Zone[], cx: number, cy: number): string | null {
    for (const z of ativ) { if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue; const cn = containsFn(z); if (!cn || cn(cx, cy)) return z.label; }
    return null;
  }

  // Rastreio anônimo de pessoas (IDs efêmeros, sem identidade) — base da "Presença".
  function updateTracks(dets: Detection[], ativ: Zone[], vidW: number, vidH: number, now: number) {
    const P = APP_CONFIG.people;
    const persons = dets.filter((d) => d.class === "person" && d.score >= P.scoreThreshold).map((d) => ({
      cx: (d.bbox[0] + d.bbox[2] / 2) / vidW, cy: (d.bbox[1] + d.bbox[3] / 2) / vidH,
      bbox: [d.bbox[0] / vidW, d.bbox[1] / vidH, d.bbox[2] / vidW, d.bbox[3] / vidH] as [number, number, number, number],
      score: d.score,
    }));
    const used = new Set<number>();
    for (const p of persons) {
      let best: Track | null = null; let bestD: number = P.trackMaxDist;
      for (const t of tracksRef.current) { if (used.has(t.id)) continue; const d = Math.hypot(t.cx - p.cx, t.cy - p.cy); if (d < bestD) { bestD = d; best = t; } }
      if (best) { used.add(best.id); best.cx = p.cx; best.cy = p.cy; best.bbox = p.bbox; best.lastSeen = now; best.zone = zoneAtAtiv(ativ, p.cx, p.cy); best.score = p.score; }
      else tracksRef.current.push({ id: ++trackIdRef.current, cx: p.cx, cy: p.cy, bbox: p.bbox, firstSeen: now, lastSeen: now, zone: zoneAtAtiv(ativ, p.cx, p.cy), score: p.score });
    }
    tracksRef.current = tracksRef.current.filter((t) => now - t.lastSeen <= P.trackTimeoutMs);
  }

  function pushTimeline(text: string, sev: TimelineItem["sev"]) {
    setTimeline((p) => [{ id: ++eventIdRef.current, ts: Date.now(), text, sev }, ...p].slice(0, APP_CONFIG.timeline.maxItems));
  }

  // Telemetria: empurra uma amostra no ring buffer do indicador (mantém só HIST_LEN pontos).
  function pushHist(zoneId: string, key: string, val: number) {
    let m = histRef.current.get(zoneId);
    if (!m) { m = {}; histRef.current.set(zoneId, m); }
    const arr = m[key] ?? (m[key] = []);
    arr.push(val);
    if (arr.length > HIST_LEN) arr.shift();
  }
  // Série recente de um indicador (vazio se ainda não houver amostras).
  function hist(zoneId: string, key: string): number[] { return histRef.current.get(zoneId)?.[key] ?? []; }

  useEffect(() => {
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      rafRef.current = requestAnimationFrame(loop);
      const canvas = canvasRef.current, viewport = viewportRef.current;
      if (!canvas || !viewport) return;
      const proc = procRef.current ?? (procRef.current = document.createElement("canvas")); // canvas de motion offscreen
      const f = getFrame();
      if (!f || !f.w || !f.h) return;
      // ── GATE de "frame novo": o loop roda no refresh do monitor (~60fps), mas o frame chega a
      //    ~15fps. Se o ImageBitmap (identidade do `el`) / `ts` não mudou desde o último processamento,
      //    pula o tick inteiro (motion + luma + detecção + draw) — evita reprocessar o mesmo pixel ~4×.
      //    (mesmo padrão do FadigaProcessor: `idEl !== snap.lastEl`). ──
      if (f.el === lastFrameElRef.current && (f.ts == null || f.ts === lastFrameTsRef.current)) return;
      lastFrameElRef.current = f.el; lastFrameTsRef.current = f.ts ?? 0;
      const now = performance.now();
      meterRef.current.tick(now);
      // CINE: alimenta o ring buffer com o MESMO frame que já passou pelo gate (sem decode extra).
      // Só na câmera aberta (full) e fora da revisão — em revisão o buffer fica congelado/estável.
      // LGPD: tudo em memória/efêmero; nada é enviado/persistido (ver cineBuffer.ts).
      if (mode === "full" && !reviewRef.current) cineRef.current?.capture(f.el, f.w, f.h, now, Date.now());
      if (pausedRef.current) return; // ⏸ inspeção: congela o frame (não processa nem redesenha)
      const frameDt = lastFrameAtRef.current ? now - lastFrameAtRef.current : 0; lastFrameAtRef.current = now;
      const zs = zonesRef.current;
      const ativ = zs.filter((z) => z.modo === "atividade");

      // ── nível de frame: motion luma + coco-ssd (só se houver zona de atividade) ──
      const pw = C.procWidth, ph = Math.max(1, Math.round((pw * f.h) / f.w));
      let luma: Float32Array | null = null; let prev = prevLumaRef.current;
      if (ativ.length) {
        const size = pw * ph;
        if (proc.width !== pw || proc.height !== ph || lumaSizeRef.current !== size) {
          proc.width = pw; proc.height = ph; lumaSizeRef.current = size;
          prevLumaRef.current = null; curLumaRef.current = null; prev = null; // tamanho mudou → invalida buffers
        }
        const pctx = proc.getContext("2d", { willReadFrequently: true })!;
        pctx.drawImage(f.el, 0, 0, pw, ph);
        const img = pctx.getImageData(0, 0, pw, ph).data;
        // buffer reutilizável p/ a luma atual (swap com o anterior no fim) — evita new Float32Array por frame (P2)
        let cur = curLumaRef.current;
        if (!cur || cur.length !== size) cur = new Float32Array(size);
        for (let i = 0, j = 0; i < img.length; i += 4, j++) cur[j] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
        luma = cur;
        // Inferência FORA da main thread (worker), via SCHEDULER global (fila única + prioridade).
        // A câmera aberta (full) detecta na cadência rápida, com tiling e prioridade "high"; as tiles
        // do mosaico vão mais devagar, sem tiling e com prioridade "low" (cedem a vez à câmera de foco).
        const objInterval = mode === "full" ? C.objectIntervalMs : C.objectIntervalMsTile;
        if (now - lastObjAtRef.current > objInterval) {
          lastObjAtRef.current = now;
          const el = f.el, fw = f.w, fh = f.h, tiled = mode === "full";
          requestInference(
            { key: `${cameraId}:atividade`, run: () => detectFrame(el, fw, fh, tiled) },
            { priority: mode === "full" ? "high" : "low" },
          ).then((res) => { if (res) detsRef.current = res; }).catch(() => {});
        }
      }
      const dets = detsRef.current;
      if (ativ.length) updateTracks(dets, ativ, f.w, f.h, now);
      const tracks = tracksRef.current;
      if (tracks.length > peakRef.current) peakRef.current = tracks.length;

      // ── Tripwires + ocupação (Onda C item 13) — REUSA os tracks já existentes (sem inferência extra) ──
      // counter/occupancy criados 1x (sob demanda); a geometria é re-setada via effect quando as linhas mudam.
      const counter = counterRef.current ?? (counterRef.current = createCounter(tripwiresRef.current, { minMove: 0.01, ttl: 1500 }));
      const occ = occRef.current ?? (occRef.current = createOccupancy({ cols: HEAT_COLS, rows: HEAT_ROWS, decay: 0.97, addAmount: 0.6, max: 6 }));
      const tps = tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy }));
      const crossings = counter.update(tps, now);
      for (const ev of crossings) {
        const wi = tripwiresRef.current.findIndex((w) => w.id === ev.tripwireId);
        pushTimeline(`${ev.dir === "in" ? "Entrada" : "Saída"} · Linha ${wi >= 0 ? wi + 1 : "?"}`, "info");
      }
      if (crossings.length) twCountsRef.current = counter.counts(); // só re-snapshota quando há evento (HUD do canvas)
      occ.add(tps.map((t) => ({ x: t.cx, y: t.cy })));               // decai + acumula ocupação 1x/frame (heatmap)

      const sampleFlow = now - lastFlowAtRef.current > 500;
      const recEmit = now - lastRecAtRef.current > 3000;
      const recSamples: ZoneSample[] = [];

      // ── por zona ──
      for (const z of zs) {
        const h = holderFor(z);
        if (z.modo === "atividade") {
          const ctx: AtividadeCtx = { now, frameDt, demoMode, paused: pausedRef.current, luma, prev, pw, ph, dets, frameW: f.w, frameH: f.h, tracks, sampleFlow, recEmit };
          const az = { id: z.id, label: z.label, x: z.x, y: z.y, w: z.w, h: z.h, idleAlertMs: z.idleAlertMs, sensitivity: z.sensitivity, atividade: z.atividade, contains: containsFn(z) };
          const r = (h.proc as AtividadeProcessor).process(az, ctx);
          resultsRef.current.set(z.id, { modo: "atividade", view: r.view });
          if (r.sample) recSamples.push(r.sample);
          if (r.event) pushTimeline(r.event.text, r.event.sev);
          if (r.alert) { onAlertRef.current?.(`⚠ ${label}: ${r.alert.text}`); recordAlert({ cameraId, cameraLabel: label, zoneId: r.alert.zoneId, area: r.alert.area, atividade: r.alert.atividade, ts: Date.now(), durationMin: r.alert.durationMin }); }
        } else if (z.modo === "leitura") {
          const r = (h.proc as LeituraProcessor).process({ x: z.x, y: z.y, w: z.w, h: z.h, ponto: z.ponto }, { frame: f, now, cameraId, cameraLabel: label });
          r.reads.forEach((rd) => recordReads(pushRead(rd)));
          r.passes.forEach((ps) => { const pr = pushPass(ps); if (pr.newPassage) recordPass(ps.ponto, ps.ts); });
          const prevR = resultsRef.current.get(z.id);
          const lastCode = r.reads.length ? r.reads[r.reads.length - 1].code : (prevR && prevR.modo === "leitura" ? prevR.lastCode : null);
          resultsRef.current.set(z.id, { modo: "leitura", lastCode, perMin: r.perMin, passes: r.passesCount, ratePct: r.ratePct, noReads: r.noReads });
        } else if (z.modo === "objetos") {
          const r = (h.proc as ObjetosProcessor).process([{ id: z.id, label: z.label, x: z.x, y: z.y, w: z.w, h: z.h, contains: containsFn(z) }], z.selectedClasses, { frame: f, now });
          r.events.forEach((e) => recordObjectEvent(e));
          r.alerts.forEach((a) => onAlertRef.current?.(a));
          if (r.samples) recordObjectSamples({ samples: r.samples });
          const total = Object.values(r.counts).reduce((a, b) => a + b, 0);
          resultsRef.current.set(z.id, { modo: "objetos", counts: r.counts, total, dets: r.dets });
        } else {
          // FADIGA: recorta a ROI da zona e roda o pipeline do operador nela (1 operador por zona).
          const r = (h.proc as FadigaProcessor).process({ frame: cropFor(z, f), now, srcEl: f.el });
          r.events.forEach((e) => { recordFadigaEvent({ posto: z.label, type: e.type, ts: e.ts }); pushTimeline(`${z.label}: ${e.type}`, e.type === "bocejo" ? "info" : "high"); });
          if (r.sample) recordFadigaSamples({ posto: z.label, ...r.sample });
          if (r.alertRisk) onAlertRef.current?.(`⚠ ${label} · ${z.label}: ${RISK_LABEL[r.alertRisk]}`);
          const s = r.snapshot;
          resultsRef.current.set(z.id, { modo: "fadiga", risk: s.risk, ear: s.ear, phone: !!s.phone, faceState: s.faceState, scene: r.scene });
        }
      }

      // swap dos buffers de luma: a atual vira "anterior"; a anterior é reciclada p/ o próximo frame
      if (luma) { curLumaRef.current = prevLumaRef.current; prevLumaRef.current = luma; }
      if (sampleFlow) lastFlowAtRef.current = now;
      if (recEmit) { lastRecAtRef.current = now; if (recSamples.length) recordSamples({ cameraId, samples: recSamples }); }

      // Em revisão o palco mostra um quadro do buffer (render dedicado) — NÃO sobrescreve com o ao vivo.
      // A inferência/alertas de fundo seguem rodando acima (só o desenho do palco para de avançar).
      if (!reviewRef.current) drawScene(canvas, viewport, f);

      if (now - lastUiRef.current > (mode === "full" ? 200 : 500)) {
        lastUiRef.current = now;
        // Telemetria lateral: amostra os indicadores na cadência de UI (sem custo de inferência).
        for (const [zid, r] of resultsRef.current) {
          if (r.modo === "atividade") { pushHist(zid, "motion", r.view.motion); pushHist(zid, "people", r.view.people); }
          else if (r.modo === "leitura") { pushHist(zid, "rate", r.ratePct); pushHist(zid, "perMin", r.perMin); pushHist(zid, "noReads", r.noReads); }
          else if (r.modo === "objetos") { pushHist(zid, "total", r.total); }
          else if (r.modo === "fadiga" && r.ear != null) { pushHist(zid, "ear", r.ear); }
        }
        setPanel(new Map(resultsRef.current));
        setTwCounts(counterRef.current ? counterRef.current.counts() : {}); // reflete contadores in/out no painel lateral
        setPerf({ fps: Math.round(meterRef.current.fps) });
        const dwellable = tracks.filter((t) => now - t.firstSeen >= APP_CONFIG.people.dwellMinMs);
        const dwell = dwellable.length ? dwellable.reduce((a, t) => a + (now - t.firstSeen), 0) / dwellable.length : 0;
        setPresence({ now: tracks.length, peak: peakRef.current, dwell });
      }
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { stopped = true; if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [getFrame, mode, demoMode, cameraId, label]);

  function drawScene(canvas: HTMLCanvasElement, viewport: HTMLDivElement, f: FrameSource) {
    const dpr = window.devicePixelRatio || 1;
    const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
    if (canvas.width !== Math.round(vpW * dpr) || canvas.height !== Math.round(vpH * dpr)) { canvas.width = Math.round(vpW * dpr); canvas.height = Math.round(vpH * dpr); }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vpW, vpH);
    const cr = getContentRect(vpW, vpH, f.w, f.h);
    ctx.drawImage(f.el, cr.x, cr.y, cr.w, cr.h);
    const detailed = mode === "full";

    // Heatmap de ocupação (camada) — agora UNIFICADO na lib pura counting.ts (occ.grid() já normalizado 0..1).
    // Desenhado sob as geometrias, com ramp warn→critical (tokens). O toggle "heatmap" continua governando.
    if (layersRef.current.heatmap && occRef.current) {
      const occ = occRef.current, g = occ.grid(), cols = occ.cols, rows = occ.rows;
      let max = 0; for (let i = 0; i < g.length; i++) if (g[i] > max) max = g[i];
      if (max > 0.05) {
        const cw = cr.w / cols, ch = cr.h / rows;
        const warn = hexToRgb(cssVar("--state-warn", "#eab308"));
        const crit = hexToRgb(cssVar("--state-critical", "#ef4444"));
        for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
          const v = g[rr * cols + cc]; if (v < 0.05) continue; // já é raw/max (0..1)
          const R = Math.round(warn[0] + (crit[0] - warn[0]) * v);
          const G = Math.round(warn[1] + (crit[1] - warn[1]) * v);
          const B = Math.round(warn[2] + (crit[2] - warn[2]) * v);
          ctx.fillStyle = `rgba(${R},${G},${B},${(0.12 + 0.45 * v).toFixed(3)})`;
          ctx.fillRect(cr.x + cc * cw, cr.y + rr * ch, cw + 0.5, ch + 0.5);
        }
      }
    }

    // pessoas (tracks anônimos) — Presença (camada "caixas"; atenua abaixo da confiança)
    if (layersRef.current.boxes) {
      ctx.lineWidth = 1.5;
      const personStroke = cssVar("--state-info", "#38bdf8");
      const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.7)");
      const personFg = cssVar("--state-info-fg", "#bae6fd");
      for (const t of tracksRef.current) {
        ctx.globalAlpha = t.score < confRef.current ? 0.3 : 1;
        const x = cr.x + t.bbox[0] * cr.w, y = cr.y + t.bbox[1] * cr.h, w = t.bbox[2] * cr.w, h = t.bbox[3] * cr.h;
        ctx.strokeStyle = personStroke; ctx.strokeRect(x, y, w, h);
        const inspecting = pausedRef.current && detailed;
        const tag = inspecting ? `Pessoa ${t.id} · ${fmtDuration(performance.now() - t.firstSeen)}${t.zone ? " · " + t.zone : ""}` : `Pessoa ${t.id}`;
        ctx.font = inspecting ? "bold 12px ui-sans-serif, system-ui" : "10px monospace";
        const tw = ctx.measureText(tag).width + 8;
        ctx.fillStyle = scrim; ctx.fillRect(x, y - 15, tw, 14);
        ctx.fillStyle = personFg; ctx.fillText(tag, x + 4, y - 4);
      }
      ctx.globalAlpha = 1;
    }

    for (const z of zonesRef.current) {
      const x = cr.x + z.x * cr.w, y = cr.y + z.y * cr.h, w = z.w * cr.w, h = z.h * cr.h;
      const r = resultsRef.current.get(z.id);
      let color = cssVar("--state-neutral", "#64748b"); let label2 = `${z.label} · ${ZONE_MODE_LABEL[z.modo]}`;
      if (r?.modo === "atividade") { color = stateCanvasColor(r.view.state); label2 = `${z.label} · ${r.view.state} · ${r.view.people}p`; }
      else if (r?.modo === "leitura") { color = cssVar("--state-info", "#38bdf8"); label2 = `${z.label} · ${r.lastCode ?? "leitura…"}`; }
      else if (r?.modo === "objetos") {
        color = cssVar("--state-neutral", "#64748b"); // contagem = operação normal (going-gray); classes mantêm cor categórica
        const parts = Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${objClass(k)?.emoji ?? ""}${n}`);
        label2 = `${z.label} · ${parts.length ? parts.join(" ") : "0"}`;
        if (layersRef.current.boxes) {
          const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.7)");
          for (const d of r.dets) {
            if (d.score < confRef.current) continue; // slider global de confiança filtra detecções
            const cx = d.bbox[0] + d.bbox[2] / 2, cy = d.bbox[1] + d.bbox[3] / 2;
            if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue;
            const oc = objClass(d.key); const cc = oc?.color ?? color;
            const bx = cr.x + d.bbox[0] * cr.w, by = cr.y + d.bbox[1] * cr.h;
            ctx.lineWidth = 1.5; ctx.strokeStyle = cc; ctx.strokeRect(bx, by, d.bbox[2] * cr.w, d.bbox[3] * cr.h);
            if (detailed) { // rótulo da classe acima da bbox (só no modo cheio, p/ não poluir o tile)
              const tag = `${oc?.emoji ?? ""} ${oc?.label ?? d.key}`;
              ctx.font = "10px ui-sans-serif, system-ui"; const tw = ctx.measureText(tag).width + 6;
              ctx.fillStyle = scrim; ctx.fillRect(bx, by - 13, tw, 12);
              ctx.fillStyle = cc; ctx.fillText(tag, bx + 3, by - 4);
            }
          }
        }
      }
      else if (r?.modo === "fadiga") { color = riskCanvasColor(r.risk); label2 = `${z.label} · ${RISK_LABEL[r.risk]}${r.ear != null ? ` · EAR ${r.ear.toFixed(2)}` : ""}${r.phone ? " · 📱" : ""}`; }
      const mask = getMask(z);
      const hasMask = !!(mask && anySet(mask));
      const alerting = r?.modo === "atividade" && r.view.state === "ALERTA";
      if (hasMask && mask) {
        // área irregular: pinta as células marcadas na cor do modo (camada "máscara")
        if (layersRef.current.mask) {
          const cw = cr.w / mask.cols, ch = cr.h / mask.rows;
          ctx.fillStyle = color + (alerting ? "3a" : "26");
          for (let rr = 0; rr < mask.rows; rr++) for (let cc = 0; cc < mask.cols; cc++) if (mask.bits[rr * mask.cols + cc]) ctx.fillRect(cr.x + cc * cw, cr.y + rr * ch, cw + 0.5, ch + 0.5);
        }
        if (layersRef.current.zones) { ctx.lineWidth = alerting ? 2 : 1; ctx.strokeStyle = color; ctx.strokeRect(x, y, w, h); } // contorno da bbox
      } else if (layersRef.current.zones) {
        ctx.lineWidth = alerting ? 3 : 2; ctx.strokeStyle = color; ctx.fillStyle = color + "1f";
        ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      }
      if (layersRef.current.zones) {
        ctx.font = "bold 11px ui-sans-serif, system-ui"; const tw = ctx.measureText(label2).width + 10;
        ctx.fillStyle = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)"); ctx.fillRect(x, y, tw, 17); ctx.fillStyle = color; ctx.fillText(label2, x + 5, y + 12);
        if (detailed && r?.modo === "atividade" && r.view.state !== "ATIVA" && r.view.state !== "LENTA") { ctx.font = "10px monospace"; ctx.fillStyle = cssVar("--cam-overlay-fg", "#cbd5e1"); ctx.fillText(`parada ${fmtDuration(r.view.idleMs)}`, x + 5, y + 28); }
      }
      if (layersRef.current.boxes && detailed && r?.modo === "fadiga") drawFadigaZone(ctx, x, y, w, h, r.scene);
    }

    // Tripwires (linhas de contagem com direção) — SEMPRE visíveis (operador vê linhas + contagens).
    // Linha a→b (token --state-info) + seta de direção "in" via inwardNormal (token --state-neutral) + HUD in/out.
    const wires = tripwiresRef.current;
    if (wires.length) {
      const info = cssVar("--state-info", "#38bdf8");
      const neutral = cssVar("--state-neutral", "#64748b");
      const scrim = cssVar("--cam-overlay-scrim", "rgba(5,8,12,0.8)");
      const counts = twCountsRef.current;
      for (let wi = 0; wi < wires.length; wi++) {
        const w = wires[wi];
        const ax = cr.x + w.a.x * cr.w, ay = cr.y + w.a.y * cr.h;
        const bx = cr.x + w.b.x * cr.w, by = cr.y + w.b.y * cr.h;
        ctx.lineWidth = 2.5; ctx.strokeStyle = info;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
        ctx.fillStyle = info;
        ctx.beginPath(); ctx.arc(ax, ay, 3, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(bx, by, 3, 0, Math.PI * 2); ctx.fill();
        // seta da direção "in": normal mapeada p/ tela (compensa o aspecto do letterbox) a partir do ponto médio
        const n = inwardNormal(w);
        let dx = n.x * cr.w, dy = n.y * cr.h; const dl = Math.hypot(dx, dy) || 1;
        const AR = 16; dx = (dx / dl) * AR; dy = (dy / dl) * AR;
        const mx = (ax + bx) / 2, my = (ay + by) / 2, ex = mx + dx, ey = my + dy;
        ctx.strokeStyle = neutral; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey); ctx.stroke();
        const ang = Math.atan2(dy, dx), ha = 0.5, hl = 6;
        ctx.beginPath();
        ctx.moveTo(ex, ey); ctx.lineTo(ex - hl * Math.cos(ang - ha), ey - hl * Math.sin(ang - ha));
        ctx.moveTo(ex, ey); ctx.lineTo(ex - hl * Math.cos(ang + ha), ey - hl * Math.sin(ang + ha));
        ctx.stroke();
        // HUD discreto: in/out por linha (do lado oposto à seta p/ não cobri-la)
        const c = counts[w.id] ?? { in: 0, out: 0 };
        const tag = `L${wi + 1}  in ${c.in}  out ${c.out}`;
        ctx.font = "bold 11px ui-sans-serif, system-ui";
        const tw = ctx.measureText(tag).width + 10;
        const hx = mx - dx - tw / 2, hy = my - dy - 18;
        ctx.fillStyle = scrim; ctx.fillRect(hx, hy, tw, 16);
        ctx.fillStyle = info; ctx.fillText(tag, hx + 5, hy + 12);
      }
    }

    // grade de pintura (ao editar a máscara de uma zona)
    if (paintZoneId) {
      const cols = DEFAULT_GRID.cols, rows = DEFAULT_GRID.rows, cw = cr.w / cols, ch = cr.h / rows;
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(148,163,184,0.28)";
      ctx.beginPath();
      for (let c = 0; c <= cols; c++) { ctx.moveTo(cr.x + c * cw, cr.y); ctx.lineTo(cr.x + c * cw, cr.y + cr.h); }
      for (let rr = 0; rr <= rows; rr++) { ctx.moveTo(cr.x, cr.y + rr * ch); ctx.lineTo(cr.x + cr.w, cr.y + rr * ch); }
      ctx.stroke();
    }

    const d = drawRef.current;
    if (d?.active) { const x = Math.min(d.sx, d.cx), y = Math.min(d.sy, d.cy); ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = "#38bdf8"; ctx.strokeRect(x, y, Math.abs(d.cx - d.sx), Math.abs(d.cy - d.sy)); ctx.setLineDash([]); }

    // tripwire em traçado (clique em A, arrasta até B)
    const td = twDrawRef.current;
    if (td?.active) {
      ctx.setLineDash([6, 4]); ctx.lineWidth = 2; ctx.strokeStyle = cssVar("--state-info", "#38bdf8");
      ctx.beginPath(); ctx.moveTo(td.sx, td.sy); ctx.lineTo(td.cx, td.cy); ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // ── CONGELAR + CINE-LOOP: render do quadro em revisão ──
  // Desenha SÓ a imagem do buffer (letterbox idêntico ao ao vivo) + HUD de tempo relativo.
  // Não reusa os overlays do ao vivo: eles correspondem ao frame corrente, não ao quadro revisado.
  function drawReviewFrame(canvas: HTMLCanvasElement, viewport: HTMLDivElement, fr: CineFrame) {
    const dpr = window.devicePixelRatio || 1;
    const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
    if (canvas.width !== Math.round(vpW * dpr) || canvas.height !== Math.round(vpH * dpr)) { canvas.width = Math.round(vpW * dpr); canvas.height = Math.round(vpH * dpr); }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vpW, vpH);
    const cr = getContentRect(vpW, vpH, fr.w, fr.h);
    ctx.drawImage(fr.bmp, cr.x, cr.y, cr.w, cr.h);
  }

  // Renderiza o quadro selecionado sempre que o índice/modo mudar (e ao redimensionar via tick do loop).
  useEffect(() => {
    if (!review) return;
    const canvas = canvasRef.current, viewport = viewportRef.current;
    if (!canvas || !viewport) return;
    const fr = cineRef.current?.get(scrubIndex);
    if (fr) drawReviewFrame(canvas, viewport, fr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review, scrubIndex, cineSize]);

  // Cine-loop (play): avança o scrubber ~12 quadros/s, em loop, sem tocar no buffer.
  useEffect(() => {
    if (!review || !cinePlaying) return;
    let raf = 0; let last = 0;
    const step = (t: number) => {
      raf = requestAnimationFrame(step);
      if (t - last < 80) return; last = t; // ~12 fps de reprodução
      const n = cineRef.current?.size() ?? 0;
      if (n <= 1) return;
      setScrubIndex((i) => (i + 1 >= n ? 0 : i + 1));
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [review, cinePlaying]);

  // Entra em revisão (CONGELAR): trava o palco no último quadro do buffer.
  function enterReview() {
    const n = cineRef.current?.size() ?? 0;
    if (n === 0) { setReviewTip("Sem quadros no buffer ainda — aguarde o vídeo ao vivo."); setTimeout(() => setReviewTip(null), 2500); return; }
    setReviewTip(null);
    setCineSize(n);
    setScrubIndex(n - 1);
    setCinePlaying(false);
    setReview(true);
  }
  // Volta ao vivo: sai da revisão e limpa o estado de scrub (o buffer segue, efêmero).
  // Libera também o object URL do último export (memória).
  function exitReview() {
    setReview(false);
    setCinePlaying(false);
    setScrubIndex(0);
    if (clipUrlRef.current) { URL.revokeObjectURL(clipUrlRef.current); clipUrlRef.current = null; }
  }
  function scrubBy(delta: number) {
    setCinePlaying(false);
    const n = cineRef.current?.size() ?? 0;
    if (n === 0) return;
    setScrubIndex((i) => Math.max(0, Math.min(n - 1, i + delta)));
  }

  // SNAPSHOT LOCAL — download manual iniciado pelo operador. NUNCA vai ao servidor.
  // Renderiza o quadro (revisão: do buffer; ao vivo: o frame corrente) numa resolução própria
  // e dispara um download via canvas.toBlob → <a download>. Ação 100% local (LGPD).
  function downloadSnapshot() {
    const fr = review ? cineRef.current?.get(scrubIndex) ?? null : null;
    const tmp = document.createElement("canvas");
    let src: CanvasImageSource; let w: number; let h: number; let stampTs: number;
    if (fr) { src = fr.bmp; w = fr.bmp.width; h = fr.bmp.height; stampTs = fr.wallTs; }
    else { const f = getFrame(); if (!f) return; src = f.el; w = f.w; h = f.h; stampTs = Date.now(); }
    tmp.width = w; tmp.height = h;
    const ctx = tmp.getContext("2d"); if (!ctx) return;
    ctx.drawImage(src, 0, 0, w, h);
    tmp.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const d = new Date(stampTs);
      const pad = (n: number) => String(n).padStart(2, "0");
      a.href = url;
      a.download = `${cameraId}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  }
  // EXPORT DE CLIPE LOCAL — a partir dos quadros do buffer (janela atual de revisão).
  // Abordagem: MediaRecorder sobre canvas.captureStream desenhando os quadros do buffer na
  // taxa do cine-loop → Blob WebM. Fallback gracioso (sem deps): um único PNG em grade
  // (montagem de quadros-chave) quando MediaRecorder/WebM não está disponível.
  // LGPD: tudo montado EM MEMÓRIA; o resultado é SEMPRE um DOWNLOAD LOCAL manual
  // (<a download>) nomeado por câmera + timestamp. NADA é enviado/persistido no servidor.
  async function exportClip() {
    if (clipBusyRef.current) return;             // 1 export por vez (botão também desabilita)
    const snap = cineRef.current?.framesSnapshot() ?? [];
    if (snap.length === 0) { setReviewTip("Sem quadros no buffer ainda — aguarde o vídeo ao vivo."); setTimeout(() => setReviewTip(null), 2500); return; }
    // Achata os quadros p/ o exportador (apenas desenha os bitmaps; NÃO os fecha — o buffer é dono).
    const frames: ClipFrame[] = snap.map((fr) => ({ img: fr.bmp, dw: fr.bmp.width, dh: fr.bmp.height, ts: fr.ts }));
    const stampTs = snap[snap.length - 1].wallTs;
    const onProgress = (done: number, total: number) => setClipPct(total ? Math.round((done / total) * 100) : 0);

    clipBusyRef.current = true;
    setClipState("working");
    setClipPct(0);
    try {
      let blob: Blob; let ext: string;
      if (clipSupport() === "webm") {
        blob = await recordClipWebm(frames, { fps: 12, onProgress });
        ext = "webm";
      } else {
        blob = await buildMontagePng(frames, { onProgress });
        ext = "png";
        setReviewTip("Clipe (vídeo) não suportado neste navegador — exportada uma montagem PNG dos quadros-chave.");
        setTimeout(() => setReviewTip(null), 4000);
      }
      // download LOCAL manual (LGPD); revoga a URL anterior e agenda a desta.
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      const url = triggerDownload(blob, clipFileName(cameraId, stampTs, ext));
      clipUrlRef.current = url;
      setTimeout(() => { if (clipUrlRef.current === url) { URL.revokeObjectURL(url); clipUrlRef.current = null; } }, 60000);
      setClipState("idle");
    } catch {
      setClipState("error");
      setReviewTip("Falha ao exportar o clipe neste navegador.");
      setTimeout(() => { setReviewTip(null); setClipState("idle"); }, 4000);
    } finally {
      clipBusyRef.current = false;
      setClipPct(0);
    }
  }

  // ── máscara (blueprint em grade) ──
  function getMask(z: Zone): Mask | null {
    const c = maskCacheRef.current.get(z.id);
    if (paintZoneId === z.id && c) return c.mask;            // ao vivo durante a pintura
    if (!z.mask) return null;
    if (c && c.enc === z.mask) return c.mask;
    const m = decodeMask(z.mask); if (m) maskCacheRef.current.set(z.id, { enc: z.mask, mask: m });
    return m;
  }
  function ensureMaskForPaint(z: Zone): Mask {
    const c = maskCacheRef.current.get(z.id);
    if (c && paintZoneId === z.id) return c.mask;
    const m = decodeMask(z.mask) ?? maskFromRect(DEFAULT_GRID.cols, DEFAULT_GRID.rows, z.x, z.y, z.w, z.h);
    maskCacheRef.current.set(z.id, { enc: z.mask, mask: m });
    return m;
  }

  // ── editor de zonas ──
  function vpPoint(e: ReactMouseEvent) { const r = viewportRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function normPoint(e: ReactMouseEvent): { nx: number; ny: number } | null {
    const f = getFrame(), viewport = viewportRef.current; if (!f || !viewport) return null;
    const r = viewport.getBoundingClientRect();
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const nx = (e.clientX - r.left - cr.x) / cr.w, ny = (e.clientY - r.top - cr.y) / cr.h;
    return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { nx, ny };
  }
  function paintAt(e: ReactMouseEvent) {
    const z = zonesRef.current.find((z) => z.id === paintZoneId); if (!z) return;
    const m = ensureMaskForPaint(z); const p = normPoint(e); if (!p) return;
    const { col, row } = cellAtNorm(m, p.nx, p.ny);
    paintBrush(m, col, row, brush - 1, !eraseRef.current);
  }
  function commitPaint() {
    const z = zonesRef.current.find((zz) => zz.id === paintZoneId); if (!z) return;
    const c = maskCacheRef.current.get(z.id); if (!c) return;
    const enc = encodeMask(c.mask); maskCacheRef.current.set(z.id, { enc, mask: c.mask });
    const bb = maskBBoxNorm(c.mask);
    patchZone(z.id, bb ? { mask: enc, x: bb.x, y: bb.y, w: bb.w, h: bb.h } : { mask: enc });
  }
  function onDown(e: ReactMouseEvent) {
    if (mode !== "full" || reviewRef.current) return; // em revisão o palco mostra o buffer — sem edição de zona
    if (!canConfigure) return; // RBAC: operador não cria/edita/pinta zonas (defensivo; controles já desabilitados)

    if (paintZoneId) { paintingRef.current = true; eraseRef.current = e.altKey || e.button === 2 || erase; paintAt(e); return; }
    if (tripwireMode) { const p = vpPoint(e); twDrawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y }; return; }
    if (drawMode) { const p = vpPoint(e); drawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y }; }
  }
  function onMove(e: ReactMouseEvent) {
    if (paintingRef.current) { paintAt(e); return; }
    if (twDrawRef.current?.active) { const p = vpPoint(e); twDrawRef.current.cx = p.x; twDrawRef.current.cy = p.y; return; }
    if (drawRef.current?.active) { const p = vpPoint(e); drawRef.current.cx = p.x; drawRef.current.cy = p.y; }
  }
  function onUp() {
    if (paintingRef.current) { paintingRef.current = false; commitPaint(); return; }
    if (twDrawRef.current?.active) { commitTripwire(); return; }
    const d = drawRef.current; if (!d?.active) return; drawRef.current = null;
    const f = getFrame(), viewport = viewportRef.current; if (!f || !viewport) return;
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const x0 = Math.min(d.sx, d.cx), y0 = Math.min(d.sy, d.cy), w = Math.abs(d.cx - d.sx), h = Math.abs(d.cy - d.sy);
    if (w < 16 || h < 16) return;
    const id = newZoneId(cameraId);
    const nz: Zone = { id, label: `Área ${zonesRef.current.length + 1}`, x: Math.max(0, (x0 - cr.x) / cr.w), y: Math.max(0, (y0 - cr.y) / cr.h), w: Math.min(1, w / cr.w), h: Math.min(1, h / cr.h), modo: "atividade" as ZoneMode, idleAlertMs: APP_CONFIG.zones.defaultIdleAlertMs, sensitivity: 5, atividade: "Indefinida", ponto: APP_CONFIG.reading.defaultPonto, selectedClasses: OBJECT_CATALOG.map((o) => o.key) };
    setZones((p) => persist([...p, nz]));
  }
  // ── editor de tripwires (linhas de contagem) — distinto do editor de zonas ──
  function commitTripwire() {
    const d = twDrawRef.current; twDrawRef.current = null; if (!d) return;
    if (Math.hypot(d.cx - d.sx, d.cy - d.sy) < 20) return; // linha muito curta → ignora (evita clique acidental)
    const f = getFrame(), viewport = viewportRef.current; if (!f || !viewport) return;
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const cl = (v: number) => Math.max(0, Math.min(1, v));
    const a = { x: cl((d.sx - cr.x) / cr.w), y: cl((d.sy - cr.y) / cr.h) };
    const b = { x: cl((d.cx - cr.x) / cr.w), y: cl((d.cy - cr.y) / cr.h) };
    const w: Tripwire = { id: newTripwireId(cameraId), a, b };
    const prev = tripwires; persistTw([...prev, w], prev);
  }
  // Persiste no BACKEND de forma OTIMISTA: aplica `next` já, e em erro faz rollback p/ `prev` +
  // toast (via onAlert). O PUT exige perfil de engenharia no backend; estas ações já estão gated
  // por canConfigure no front, então um 403 só aparece em borda (ex.: perfil revogado) — tratado.
  function persistTw(next: Tripwire[], prev: Tripwire[]) {
    setTripwires(next); // otimista (o counter re-seta via effect; preserva contadores por id)
    saveTripwires(cameraId, next).catch((e) => {
      setTripwires(prev); // rollback
      const msg = e instanceof ApiError ? e.message : "Não foi possível salvar as linhas de contagem.";
      onAlertRef.current?.(`⚠ ${label}: ${msg}`);
    });
  }
  // Inverte a direção (troca a↔b → Entrada↔Saída). O counter preserva contadores por id ao re-setar.
  function invertTripwire(id: string) { const prev = tripwires; persistTw(prev.map((w) => (w.id === id ? { id: w.id, a: w.b, b: w.a } : w)), prev); }
  function removeTripwire(id: string) { const prev = tripwires; persistTw(prev.filter((w) => w.id !== id), prev); }
  // Zera os contadores da SESSÃO (geometria mantida); reflete no HUD e no painel.
  function resetCounts() {
    counterRef.current?.reset();
    twCountsRef.current = counterRef.current ? counterRef.current.counts() : {};
    setTwCounts(counterRef.current ? counterRef.current.counts() : {});
  }
  // Modos de edição mutuamente exclusivos (não conflitar tripwire × zona × pintura).
  function toggleDrawMode() { setDrawMode((v) => { const nv = !v; if (nv) { setTripwireMode(false); setPaintZoneId(null); } return nv; }); }
  function toggleTripwireMode() { setTripwireMode((v) => { const nv = !v; if (nv) { setDrawMode(false); setPaintZoneId(null); } return nv; }); }

  function persist(next: Zone[]): Zone[] { saveZones(cameraId, next); return next; }
  function patchZone(id: string, patch: Partial<Zone>) { setZones((p) => persist(p.map((z) => (z.id === id ? { ...z, ...patch } : z)))); }
  // MODO-COMO-PRESET: recarrega de uma vez camadas + confiança a partir do preset do modo,
  // e marca o preset ativo (governa o que o painel destaca). Não mexe em geometria/zonas.
  function applyPreset(mode: ModeKey) { const p = MODE_PRESETS[mode]; setLayers({ ...p.layers }); setConf(p.confidenceThreshold); setActivePreset(mode); }
  // Troca o modo de uma zona PRESERVANDO sua geometria/máscara/parâmetros e reaplica o preset.
  function changeZoneMode(z: Zone, next: ZoneMode) { patchZone(z.id, { modo: next }); applyPreset(next); }
  function removeZone(id: string) { holdersRef.current.get(id)?.proc.dispose(); holdersRef.current.delete(id); cropsRef.current.delete(id); resultsRef.current.delete(id); maskCacheRef.current.delete(id); histRef.current.delete(id); if (paintZoneId === id) setPaintZoneId(null); setZones((p) => persist(p.filter((z) => z.id !== id))); }
  function startPaint(z: Zone) { setDrawMode(false); setTripwireMode(false); ensureMaskForPaint(z); setPaintZoneId(z.id); }
  function clearActive() { const z = zonesRef.current.find((zz) => zz.id === paintZoneId); if (!z) return; clearMask(ensureMaskForPaint(z)); commitPaint(); }
  const paintZone = paintZoneId ? zones.find((z) => z.id === paintZoneId) ?? null : null;

  const summary = zones.map((z) => { const r = panel.get(z.id); const m = r?.modo === "atividade" ? r.view.state : r?.modo === "leitura" ? (r.lastCode ?? "—") : r?.modo === "objetos" ? `${r.total} obj` : r?.modo === "fadiga" ? RISK_LABEL[r.risk] : ZONE_MODE_LABEL[z.modo]; return `${z.label}:${m}`; }).join(" · ");
  const alertCount = [...panel.values()].filter((r) => r.modo === "atividade" && r.view.state === "ALERTA").length;

  // Legenda do overlay: só as cores realmente em uso (pelos modos/classes das zonas atuais).
  const legend: { color: string; label: string }[] = (() => {
    const out: { color: string; label: string }[] = [];
    const modes = new Set(zones.map((z) => z.modo));
    if (modes.has("atividade")) {
      out.push({ color: "var(--state-neutral)", label: "Ativa" }, { color: "var(--state-warn)", label: "Lenta/Ociosa" }, { color: "var(--state-critical)", label: "Alerta" }, { color: "var(--state-info)", label: "Pessoa" });
    }
    if (modes.has("leitura")) out.push({ color: "var(--state-info)", label: "Faixa de leitura" });
    if (modes.has("objetos")) {
      const keys = new Set(zones.filter((z) => z.modo === "objetos").flatMap((z) => z.selectedClasses));
      for (const k of keys) { const o = objClass(k); if (o) out.push({ color: o.color, label: o.label }); }
    }
    if (modes.has("fadiga")) out.push({ color: "var(--state-neutral)", label: "OK" }, { color: "var(--state-warn)", label: "Alerta" }, { color: "var(--state-critical)", label: "Duplo" });
    return out;
  })();
  const cfgZone = cfgZoneId ? zones.find((z) => z.id === cfgZoneId) ?? null : null;
  // Preset ativo + se o operador divergiu dele manualmente nesta sessão (sobrepondo o preset).
  const activePresetDef = activePreset ? MODE_PRESETS[activePreset] : null;
  const presetDirty = !!activePresetDef && (
    conf !== activePresetDef.confidenceThreshold ||
    (Object.keys(activePresetDef.layers) as (keyof OverlayLayers)[]).some((k) => layers[k] !== activePresetDef.layers[k])
  );

  // ── TILE ──
  if (mode === "tile") {
    return (
      <div className={`tile ${alertCount ? "alerting" : ""}`} onClick={onOpen} title="Abrir câmera">
        <div className="viewport tile-vp" ref={viewportRef}>
          <canvas ref={canvasRef} />
          <div className="tile-badges">{alertCount > 0 && <span className="tb alert">⚠ {alertCount}</span>}</div>
        </div>
        <div className="tile-foot"><span className="tile-name">{label}</span><span className="tile-meta">{zones.length} zona(s){alertCount ? ` · ${alertCount} alerta` : ""}</span></div>
      </div>
    );
  }

  // ── FULL (workspace) ──
  return (
    <div className="cam" ref={fullRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Câmera ${label} em tela cheia`}>
      <header className="cam-head">
        <div className="cam-title"><b>{label}</b>{paintZone ? <span className="muted">pintando “{paintZone.label}”</span> : (<>
          <span className="muted">{zones.length} zona(s)</span>
          {activePresetDef && <span title={`Preset ativo: ${activePresetDef.label} — ${activePresetDef.description}${presetDirty ? " (ajustado manualmente nesta sessão)" : ""}`}><Badge tone={MODE_TONE[activePreset!]}>{activePresetDef.label}{presetDirty ? " ·" : ""}</Badge></span>}
          {!canConfigure && <span title="Edição de configuração requer perfil de engenharia"><Badge tone="info">🔒 Somente leitura</Badge></span>}
        </>)}</div>
        <div className="spacer" />
        {paintZone ? (<>
          <IconButton label="Pincel (pintar)" active={!erase} onClick={() => setErase(false)}>🖌</IconButton>
          <IconButton label="Borracha (Alt/botão-direito também apagam)" active={erase} onClick={() => setErase(true)}>🧽</IconButton>
          <Select value={String(brush)} onChange={(v) => setBrush(Number(v))} options={BRUSH_OPTS} ariaLabel="Tamanho do pincel" />
          <Button onClick={clearActive}>Limpar</Button>
          <Button active onClick={() => setPaintZoneId(null)}>✓ Concluir</Button>
        </>) : (<>
          <Button active={review} onClick={() => (review ? exitReview() : enterReview())} title="Congela o palco e abre a revisão dos últimos ~10s (cine-loop). Buffer em memória, nunca enviado ao servidor.">{review ? "▶ Ao vivo" : "❄ Congelar"}</Button>
          <Button active={paused} disabled={review} onClick={() => setPaused((v) => !v)} title="Congela o frame e rotula quem está em cena">{paused ? "▶ Retomar" : "⏸ Pausar"}</Button>
          <Button active={drawMode} disabled={review || !canConfigure} onClick={toggleDrawMode} title={canConfigure ? "Desenhar uma nova zona sobre o vídeo" : "Requer perfil de engenharia"}>{drawMode ? "Desenhando…" : "✎ Zona"}</Button>
          <Button active={tripwireMode} disabled={review || !canConfigure} onClick={toggleTripwireMode} title={canConfigure ? "Desenhar uma linha de contagem (clique em A e arraste até B)" : "Requer perfil de engenharia"}>{tripwireMode ? "Traçando…" : "⇄ Linha"}</Button>
          <IconButton label="Fechar" onClick={onClose}>✕</IconButton>
        </>)}
        {reviewTip && <span className="muted" style={{ color: "var(--state-warn-fg, #fde68a)" }}>{reviewTip}</span>}
      </header>

      <div className={`cam-stage ${drawMode || tripwireMode || paintZone ? "draw-cursor" : ""}`} ref={viewportRef} style={{ background: "var(--cam-surface-bg)" }} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onContextMenu={(e) => { if (paintZone) e.preventDefault(); }}>
        <canvas className="overlay" ref={canvasRef} />
        {review && (<>
          <div className="cine-flag"><span className="dot" /> REVISÃO · cine-loop (buffer em memória)</div>
          <div className="cine-bar">
            <IconButton label="Quadro anterior" onClick={() => scrubBy(-1)}>‹</IconButton>
            <IconButton label={cinePlaying ? "Pausar reprodução" : "Reproduzir cine-loop"} active={cinePlaying} onClick={() => setCinePlaying((v) => !v)}>{cinePlaying ? "⏸" : "▶"}</IconButton>
            <IconButton label="Próximo quadro" onClick={() => scrubBy(1)}>›</IconButton>
            <div className="cine-slider">
              <Slider value={scrubIndex} min={0} max={Math.max(0, cineSize - 1)} step={1} onChange={(v) => { setCinePlaying(false); setScrubIndex(v); }} ariaLabel="Posição no cine-loop" />
            </div>
            <span className="cine-time">{cineRef.current ? `${cineRef.current.relativeSeconds(scrubIndex).toFixed(1)}s` : "0.0s"}</span>
            <span className="cine-count">{cineSize ? scrubIndex + 1 : 0}/{cineSize}</span>
            <span className="cine-spacer" />
            <Button onClick={downloadSnapshot} disabled={clipState === "working"} title="Baixar este quadro como PNG (download local — nunca enviado ao servidor)">⤓ Snapshot</Button>
            <Button onClick={exportClip} disabled={clipState === "working"} title="Exporta a janela do cine-loop como clipe (WebM) — download local, nunca enviado ao servidor. Fallback: montagem PNG se o navegador não suportar.">{clipState === "working" ? `Gravando… ${clipPct}%` : "⤓ Exportar clipe"}</Button>
            <Button active onClick={exitReview}>▶ Ao vivo</Button>
          </div>
        </>)}
        <aside className="cam-drawer" style={{ background: "var(--cam-panel-bg)", color: "var(--cam-panel-fg)", borderLeftColor: "var(--cam-panel-border)" }}>
          <SegmentedControl value={drawerTab} onChange={(v) => setDrawerTab(v as "zonas" | "linhas" | "timeline" | "presenca" | "camadas")} ariaLabel="Aba do painel"
            options={[{ value: "zonas", label: `Zonas (${zones.length})` }, { value: "linhas", label: `Linhas (${tripwires.length})` }, { value: "camadas", label: "Camadas" }, { value: "timeline", label: "Timeline" }, { value: "presenca", label: "Presença" }]} />
          <div style={{ height: "var(--sp-2)" }} />
          <div className="drawer-body">
            {drawerTab === "zonas" && zones.length === 0 && <p className="empty-note">{canConfigure ? "Use “✎ Zona” para desenhar uma área e escolher o modo." : "Nenhuma zona configurada. A edição de zonas requer perfil de engenharia."}</p>}
            {drawerTab === "zonas" && zones.map((z) => { const r = panel.get(z.id); const st = r?.modo === "atividade" ? r.view.state : "ATIVA"; return (
              <div key={z.id} className={`zone ${st}`}>
                <div className="row">
                  <span className="zone-head"><b className="zone-name" title={z.label}>{z.label}</b><Badge tone={MODE_TONE[z.modo]}>{ZONE_MODE_LABEL[z.modo]}</Badge></span>
                  <span className="zone-tools">
                    <button className="del" disabled={!canConfigure} title={canConfigure ? "Configurar zona (modo e parâmetros)" : "Configuração requer perfil de engenharia"} aria-label="Configurar zona" onClick={() => canConfigure && setCfgZoneId(z.id)}>⚙</button>
                    <button className={`del ${paintZoneId === z.id ? "on" : ""}`} disabled={!canConfigure} title={canConfigure ? "Pintar a área (blueprint em grade)" : "Edição requer perfil de engenharia"} aria-label="Pintar área" onClick={() => canConfigure && (paintZoneId === z.id ? setPaintZoneId(null) : startPaint(z))}>🖌</button>
                    <button className="del" disabled={!canConfigure} title={canConfigure ? "Remover zona" : "Remover requer perfil de engenharia"} aria-label="Remover zona" onClick={() => canConfigure && removeZone(z.id)}>✕</button>
                  </span>
                </div>

                {z.modo === "atividade" && (r?.modo === "atividade" ? (() => {
                  const ms = stateToMetric(r.view.state);
                  const activeThr = sensitivityFactor(z.sensitivity) / 6; // limiar ATIVA em unidades de view.motion
                  return (<>
                    {/* estado/parada: indicadores categóricos/temporais (mantidos como KPI) */}
                    <div className="kpis ws-kpis">
                      <div className="kpi"><div className="v" style={{ color: stateVar(r.view.state), fontSize: 13 }}>{r.view.state}</div><div className="l">estado</div></div>
                      <div className="kpi"><div className="v">{fmtDuration(r.view.idleMs)}</div><div className="l">parada</div></div>
                    </div>
                    {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                    <MetricCell label="Movimento" value={`${Math.round(r.view.motion * 100)}%`} values={hist(z.id, "motion")} band={{ lo: activeThr, hi: 1 }} bandLabel="alvo: zona ativa" state={ms} min={0} max={1} />
                    <MetricCell label="Ocupação" value={`${r.view.people}`} values={hist(z.id, "people")} band={OCC_BAND} bandLabel={`alvo 1–${OCC_HI} pessoas`} state={occMetric(r.view.people)} min={0} />
                    <div className="zone-flow"><span>Fluxo</span><span className={`flow-chip ${r.view.flowLevel}`}>{r.view.flowLevel}</span><span className="spark">{r.view.flow.map((s, i) => <i key={i} style={{ height: `${Math.max(6, Math.round(s * 100))}%` }} />)}</span></div>
                  </>);
                })() : <p className="ws-wait">iniciando…</p>)}

                {z.modo === "leitura" && (r?.modo === "leitura" ? (<>
                  {/* telemetria "nunca número cru": valor + sparkline + faixa-alvo */}
                  <MetricCell label="Taxa de leitura" value={`${r.ratePct}%`} values={hist(z.id, "rate")} band={RATE_BAND} bandLabel="alvo ≥ 95%" state={rateToMetric(r.ratePct)} min={0} max={100} />
                  <MetricCell label="Lidas/min" value={`${r.perMin}`} values={hist(z.id, "perMin")} min={0} />
                  <MetricCell label="No-reads" value={`${r.noReads}`} values={hist(z.id, "noReads")} band={NOREAD_BAND} bandLabel="alvo 0" state={noReadMetric(r.noReads)} min={0} />
                  <div className="ws-code"><span className="muted">último código</span><code>{r.lastCode ?? "—"}</code></div>
                  <div className="ws-metric-row">Ponto <b>{z.ponto}</b> · {r.passes} passagens</div>
                </>) : <p className="ws-wait">iniciando…</p>)}

                {z.modo === "objetos" && (<>
                  <div className="ws-counts">
                    {z.selectedClasses.length === 0 && <span className="muted">nenhuma classe — abra ⚙</span>}
                    {z.selectedClasses.map((k) => { const o = objClass(k); const n = r?.modo === "objetos" ? (r.counts[k] ?? 0) : 0; return (
                      <span key={k} className={`count-chip ${n > 0 ? "on" : ""}`} style={n > 0 ? { borderColor: o?.color, color: o?.color } : undefined} title={o?.label}>{o?.emoji} <b>{n}</b></span>
                    ); })}
                  </div>
                  {/* telemetria: total em cena com tendência (sem faixa-alvo fixa — depende da cena) */}
                  <MetricCell label="Total em cena" value={`${r?.modo === "objetos" ? r.total : 0}`} values={hist(z.id, "total")} min={0} />
                </>)}

                {z.modo === "fadiga" && (<>
                  <div className="ws-fadiga">
                    {r?.modo === "fadiga" && r.faceState === "ready" ? (<>
                      <Badge tone={RISK_TONE[r.risk]}>{RISK_LABEL[r.risk]}</Badge>
                      <span className="muted">📱 {r.phone ? "sim" : "não"}</span>
                    </>) : <span className="muted">{r?.modo === "fadiga" ? (r.faceState === "loading" ? "carregando modelo…" : "modelo falhou") : "iniciando…"}</span>}
                  </div>
                  {r?.modo === "fadiga" && r.faceState === "ready" && (
                    /* telemetria "nunca número cru": EAR com faixa-alvo (olhos abertos) */
                    <MetricCell label="EAR (abertura ocular)" value={r.ear == null ? "--" : r.ear.toFixed(2)} values={hist(z.id, "ear")} band={{ lo: APP_CONFIG.fadiga.eyesClosedEarThreshold, hi: EAR_HI }} bandLabel={`alvo ≥ ${APP_CONFIG.fadiga.eyesClosedEarThreshold.toFixed(2)}`} state={riskToMetric(r.risk)} min={0} max={EAR_HI} />
                  )}
                  <p className="empty-note" style={{ margin: "4px 0 0" }}>Monitora 1 operador na ROI da zona (recorte). Som/calibração na câmera dedicada.</p>
                </>)}
              </div>
            ); })}
            {drawerTab === "zonas" && legend.length > 0 && (
              <div className="ws-legend">
                <div className="ws-legend-title">Legenda do overlay</div>
                <div className="ws-legend-items">{legend.map((e, i) => (<span key={i} className="leg"><i style={{ background: e.color }} />{e.label}</span>))}</div>
              </div>
            )}

            {drawerTab === "linhas" && (<>
              <div className="row" style={{ gap: "var(--sp-2)", marginBottom: "var(--sp-2)" }}>
                <Button size="sm" active={tripwireMode} disabled={!canConfigure} onClick={toggleTripwireMode} title={canConfigure ? "Clique em A e arraste até B sobre o vídeo" : "Edição requer perfil de engenharia"}>{tripwireMode ? "Traçando…" : "⇄ Nova linha"}</Button>
                <Button size="sm" onClick={resetCounts} title="Zera os contadores in/out desta sessão (geometria mantida)">↺ Zerar contagem</Button>
              </div>
              {tripwires.length === 0 && <p className="empty-note">{canConfigure ? "Use “⇄ Nova linha” e arraste sobre o vídeo (A→B). Cruzar da esquerda→direita da seta conta como Entrada; o sentido oposto, Saída." : "Nenhuma linha de contagem configurada. A edição requer perfil de engenharia."}</p>}
              {tripwires.map((w, i) => { const c = twCounts[w.id] ?? { in: 0, out: 0 }; return (
                <div key={w.id} className="zone">
                  <div className="row">
                    <span className="zone-head"><b className="zone-name">Linha {i + 1}</b><Badge tone="info">contagem</Badge></span>
                    <span className="zone-tools">
                      <button className="del" disabled={!canConfigure} title={canConfigure ? "Inverter direção (troca Entrada↔Saída)" : "Edição requer perfil de engenharia"} aria-label="Inverter direção" onClick={() => canConfigure && invertTripwire(w.id)}>⇄</button>
                      <button className="del" disabled={!canConfigure} title={canConfigure ? "Remover linha" : "Remover requer perfil de engenharia"} aria-label="Remover linha" onClick={() => canConfigure && removeTripwire(w.id)}>✕</button>
                    </span>
                  </div>
                  <div className="kpis ws-kpis">
                    <div className="kpi"><div className="v" style={{ color: "var(--state-info)" }}>{c.in}</div><div className="l">entradas</div></div>
                    <div className="kpi"><div className="v" style={{ color: "var(--state-neutral)" }}>{c.out}</div><div className="l">saídas</div></div>
                  </div>
                </div>
              ); })}
              <p className="empty-note" style={{ marginTop: "var(--sp-2)" }}>A contagem reusa o rastreio de pessoas já em cena (sem inferência extra) — depende de ao menos uma zona de Atividade ativa p/ detectar pessoas. Contadores são por sessão.</p>
            </>)}

            {drawerTab === "timeline" && (timeline.length === 0
              ? <p className="empty-note">Sem eventos.</p>
              : <ul className="tl">{timeline.map((e) => (<li key={e.id}><span className={`dot ${e.sev}`} /><span className="t">{clock(new Date(e.ts))}</span><span>{e.text}</span></li>))}</ul>)}

            {drawerTab === "presenca" && (<>
              <div className="kpis">
                <div className="kpi"><div className="v">{presence.now}</div><div className="l">agora</div></div>
                <div className="kpi"><div className="v">{presence.peak}</div><div className="l">pico</div></div>
                <div className="kpi"><div className="v">{fmtDuration(presence.dwell)}</div><div className="l">permanência</div></div>
              </div>
              <p className="empty-note" style={{ marginTop: 8 }}>Pessoas recebem ID efêmero (sem identidade); reseta por sessão.{paused ? " ⏸ Pausado: rótulos com tempo em cena." : ""}</p>
            </>)}

            {drawerTab === "camadas" && (<>
              {activePresetDef && (
                <div style={{ marginBottom: "var(--sp-3)", padding: "var(--sp-2)", borderRadius: 8, border: "1px solid var(--cam-panel-border)", background: "var(--cam-surface-bg)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-2)", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".4px", color: "var(--text-dim)" }}>Preset ativo</span>
                    <Badge tone={MODE_TONE[activePreset!]}>{activePresetDef.label}</Badge>
                    {presetDirty && <span style={{ fontSize: 11, color: "var(--state-warn-fg, #fde68a)" }}>· ajustado</span>}
                  </div>
                  <div style={{ fontSize: 12, color: "var(--cam-panel-fg)" }}>{activePresetDef.description}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {activePresetDef.metrics.map((m) => (
                      <span key={m.key} style={{ fontSize: 11, padding: "2px 7px", borderRadius: 999, border: "1px solid var(--cam-panel-border)", color: "var(--cam-panel-fg)" }}>{m.label}</span>
                    ))}
                  </div>
                  {presetDirty && (
                    <div style={{ marginTop: "var(--sp-2)" }}>
                      <Button size="sm" onClick={() => applyPreset(activePreset!)} title="Restaura camadas e confiança do preset deste modo.">↺ Reaplicar preset</Button>
                    </div>
                  )}
                </div>
              )}
              {([["boxes", "Caixas / detecções"], ["mask", "Máscara (área pintada)"], ["zones", "Zonas (retângulos)"], ["heatmap", "Heatmap de ocupação"]] as [keyof OverlayLayers, string][]).map(([k, lbl]) => (
                <div key={k} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid var(--cam-panel-border)" }}>
                  <span>{lbl}</span>
                  <Switch checked={layers[k]} onCheckedChange={(v) => setLayers((s) => ({ ...s, [k]: v }))} ariaLabel={lbl} />
                </div>
              ))}
              <div style={{ marginTop: "var(--sp-3)" }}>
                <Field label={`Confiança mínima · ${Math.round(conf * 100)}%`} hint="Filtra/atenua detecções abaixo do limiar sobre o vídeo (em tempo real).">
                  <div className="cfg-slider"><span className="ss-end">0</span><Slider value={Math.round(conf * 100)} min={0} max={100} step={5} onChange={(v) => setConf(v / 100)} ariaLabel="Confiança mínima" /><span className="ss-end">100</span></div>
                </Field>
              </div>
              <p className="empty-note" style={{ marginTop: "var(--sp-2)" }}>Camadas e confiança seguem o preset do modo ativo; ajustes manuais valem só nesta sessão e sobrepõem o preset (padrões em APP_CONFIG.overlay / MODE_PRESETS). Heatmap acumula a presença de pessoas.</p>
            </>)}
          </div>
        </aside>
      </div>

      <div className="cam-kpibar">
        <span className="kb">◉ <b>{presence.now}</b> pessoas</span>
        <span className="kb">⏱ <b>{fmtDuration(presence.dwell)}</b> permanência</span>
        <span className="kb muted">pico {presence.peak}</span>
        <span className="kb muted" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary || "sem zonas"}</span>
        <span className="kb muted">FPS {perf.fps}</span>
        {paused && <span className="kb muted">⏸ inspecionando</span>}
      </div>

      <Dialog open={!!cfgZone} onOpenChange={(o) => { if (!o) setCfgZoneId(null); }}
        title={cfgZone ? `Configurar — ${cfgZone.label}` : "Configurar zona"}
        description="Ajuste o modo e os parâmetros desta zona. As mudanças valem na hora."
        footer={<Button active onClick={() => setCfgZoneId(null)}>Concluir</Button>}>
        {cfgZone && (() => { const z = cfgZone; return (
          <div className="cfg-form">
            <Field label="Nome da zona" htmlFor={`cfg-name-${z.id}`}>
              <Input id={`cfg-name-${z.id}`} value={z.label} onChange={(e) => patchZone(z.id, { label: e.target.value })} />
            </Field>
            <Field label="Modo" hint="Modo = preset completo: troca camadas, confiança e métricas em destaque. Geometria/zonas preservadas.">
              <Select value={z.modo} onChange={(v) => changeZoneMode(z, v as ZoneMode)} options={MODO_OPTS} ariaLabel="Modo da zona" />
            </Field>

            {z.modo === "atividade" && (<>
              <Field label="Atividade" hint="Rótulo do processo executado na área (para o relatório).">
                <Select value={z.atividade} onChange={(v) => patchZone(z.id, { atividade: v })} options={ACTIVITIES.map((a) => ({ value: a, label: a }))} ariaLabel="Atividade da zona" />
              </Field>
              <Field label="Alerta se parada acima de" hint={demoMode ? `Modo demo força ${fmtLimit(APP_CONFIG.zones.demoIdleAlertMs)}.` : undefined}>
                <Select value={String(z.idleAlertMs)} disabled={demoMode} onChange={(v) => patchZone(z.id, { idleAlertMs: Number(v) })} options={APP_CONFIG.zones.limitPresetsMs.map((ms) => ({ value: String(ms), label: fmtLimit(ms) }))} ariaLabel="Limite de parada" />
              </Field>
              <Field label={`Sensibilidade ao movimento · ${z.sensitivity}`} hint="Menor = ignora micro-movimentos; maior = detecta o mínimo.">
                <div className="cfg-slider"><span className="ss-end">−</span><Slider value={z.sensitivity} min={1} max={10} step={1} onChange={(v) => patchZone(z.id, { sensitivity: v })} ariaLabel="Sensibilidade" /><span className="ss-end">+</span></div>
                <div style={{ marginTop: "var(--sp-1)", fontSize: 11, color: "var(--text-dim)" }} aria-live="polite">
                  {histState === "loading" && <span className="muted">estimando alertas/dia…</span>}
                  {histState === "error" && <span className="muted">histórico indisponível — sem estimativa</span>}
                  {histState === "ready" && histDataset && (() => {
                    const p = predictAlertsPerDay(histDataset, z.label, z.sensitivity);
                    if (p.status === "no-data") return <span className="muted">sem dados suficientes p/ estimar alertas/dia</span>;
                    return <span>≈ <b style={{ fontFamily: "var(--mono)", color: "var(--text)" }}>{p.perDay}</b> alerta(s)/dia estimados <span className="muted">(base {p.baselinePerDay}/dia · {p.days}d{demoMode ? " · limite curto demo eleva o real" : ""})</span></span>;
                  })()}
                </div>
              </Field>
            </>)}

            {z.modo === "leitura" && (
              <Field label="Ponto de leitura" hint="Identifica este leitor no histórico/relatório.">
                <Input value={z.ponto} onChange={(e) => patchZone(z.id, { ponto: e.target.value })} />
              </Field>
            )}

            {z.modo === "objetos" && (
              <Field label="Classes a contar" hint="Toque para incluir/excluir cada objeto.">
                <div className="ws-cfg ws-chips">{OBJECT_CATALOG.map((o) => { const on = z.selectedClasses.includes(o.key); return (
                  <button key={o.key} type="button" className={`cfg-chip ${on ? "on" : ""}`} style={on ? { borderColor: o.color, color: o.color } : undefined}
                    onClick={() => patchZone(z.id, { selectedClasses: on ? z.selectedClasses.filter((k) => k !== o.key) : [...z.selectedClasses, o.key] })}>{o.emoji} {o.label}</button>
                ); })}</div>
              </Field>
            )}

            {z.modo === "fadiga" && (
              <p className="empty-note">Monitora 1 operador na ROI da zona (recorte). Som e calibração de limiares ficam na câmera dedicada de fadiga.</p>
            )}
          </div>
        ); })()}
      </Dialog>
    </div>
  );
}
