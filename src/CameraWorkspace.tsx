import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { APP_CONFIG } from "./config";
import { type FrameSource } from "./frame";
import { fmtDuration, fmtLimit, clock } from "./format";
import { FrameMeter } from "./telemetry";
import { type Detection } from "./vision/model";
import { ensureDetectClient, detectFrame } from "./vision/detect";
import { requestInference } from "./vision/scheduler";
import { AtividadeProcessor, STATE_COLOR, ACTIVITIES, type AtividadeCtx, type ZoneView } from "./processors/atividade";
import { LeituraProcessor } from "./processors/leitura";
import { ObjetosProcessor } from "./processors/objetos";
import { FadigaProcessor, type FadigaModelState } from "./processors/fadiga";
import { loadFadigaThresholds } from "./fadiga/calibration";
import { type RiskState } from "./fadiga/landmarks";
import { type FadigaScene } from "./fadiga/draw";
import { type ObjDetection } from "./objects/detector";
import { pushRead, pushPass } from "./reading/cluster";
import { recordSamples, recordAlert, recordReads, recordPass, recordObjectSamples, recordObjectEvent, recordFadigaSamples, recordFadigaEvent, type ZoneSample } from "./report/store";
import { objClass, OBJECT_CATALOG } from "./objects/catalog";
import { loadZones, saveZones, newZoneId, DEFAULT_GRID, ZONE_MODE_LABEL, type Zone, type ZoneMode } from "./zones";
import { decodeMask, encodeMask, maskFromRect, paintBrush, cellAtNorm, maskBBoxNorm, anySet, clearMask, containsNorm, type Mask } from "./zoneMask";
import { Button, IconButton, Input, Select, Slider, SegmentedControl, Dialog, Badge, Field, type Tone } from "./ui";

const MODO_OPTS = [{ value: "atividade", label: "Atividade" }, { value: "leitura", label: "Leitura" }, { value: "objetos", label: "Objetos" }, { value: "fadiga", label: "Fadiga" }];
const BRUSH_OPTS = [{ value: "1", label: "1×" }, { value: "2", label: "2×" }, { value: "3", label: "3×" }];

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

// risco → cor/rótulo (espelha o RISK_CLS da FadigaView, na linguagem semântica das zonas)
const RISK_COLOR: Record<RiskState, string> = { OK: "#22c55e", ALERTA_FADIGA: "#eab308", ALERTA_CELULAR: "#eab308", ALERTA_DUPLO: "#ef4444" };
const RISK_LABEL: Record<RiskState, string> = { OK: "OK", ALERTA_FADIGA: "Fadiga", ALERTA_CELULAR: "Celular", ALERTA_DUPLO: "Duplo" };
const RISK_TONE: Record<RiskState, Tone> = { OK: "ok", ALERTA_FADIGA: "warn", ALERTA_CELULAR: "warn", ALERTA_DUPLO: "alert" };

// taxa de leitura → cor (verde ≥95 · âmbar ≥80 · vermelho abaixo). Espelha a semântica do relatório.
function rateColor(pct: number): string { return pct >= 95 ? "#22c55e" : pct >= 80 ? "#eab308" : "#ef4444"; }
const MODE_TONE: Record<ZoneMode, Tone> = { atividade: "ok", leitura: "info", objetos: "warn", fadiga: "info" };

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
type Track = { id: number; cx: number; cy: number; bbox: [number, number, number, number]; firstSeen: number; lastSeen: number; zone: string | null };
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

  const [zones, setZones] = useState<Zone[]>([]);
  const [panel, setPanel] = useState<Map<string, ZoneResult>>(new Map());
  const [drawMode, setDrawMode] = useState(false);
  const [paintZoneId, setPaintZoneId] = useState<string | null>(null);
  const [brush, setBrush] = useState(2);
  const [erase, setErase] = useState(false);
  const [paused, setPaused] = useState(false);
  const [perf, setPerf] = useState({ fps: 0 });
  const [presence, setPresence] = useState({ now: 0, peak: 0, dwell: 0 });
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [drawerTab, setDrawerTab] = useState<"zonas" | "timeline" | "presenca">("zonas");
  const [cfgZoneId, setCfgZoneId] = useState<string | null>(null);

  useEffect(() => { onAlertRef.current = onAlert; }, [onAlert]);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { cfgOpenRef.current = !!cfgZoneId; }, [cfgZoneId]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { zonesRef.current = zones; }, [zones]);
  useEffect(() => { const z = loadZones(cameraId, label); setZones(z); }, [cameraId, label]);
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
    }));
    const used = new Set<number>();
    for (const p of persons) {
      let best: Track | null = null; let bestD: number = P.trackMaxDist;
      for (const t of tracksRef.current) { if (used.has(t.id)) continue; const d = Math.hypot(t.cx - p.cx, t.cy - p.cy); if (d < bestD) { bestD = d; best = t; } }
      if (best) { used.add(best.id); best.cx = p.cx; best.cy = p.cy; best.bbox = p.bbox; best.lastSeen = now; best.zone = zoneAtAtiv(ativ, p.cx, p.cy); }
      else tracksRef.current.push({ id: ++trackIdRef.current, cx: p.cx, cy: p.cy, bbox: p.bbox, firstSeen: now, lastSeen: now, zone: zoneAtAtiv(ativ, p.cx, p.cy) });
    }
    tracksRef.current = tracksRef.current.filter((t) => now - t.lastSeen <= P.trackTimeoutMs);
  }

  function pushTimeline(text: string, sev: TimelineItem["sev"]) {
    setTimeline((p) => [{ id: ++eventIdRef.current, ts: Date.now(), text, sev }, ...p].slice(0, APP_CONFIG.timeline.maxItems));
  }

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

      drawScene(canvas, viewport, f);

      if (now - lastUiRef.current > (mode === "full" ? 200 : 500)) {
        lastUiRef.current = now;
        setPanel(new Map(resultsRef.current));
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

    // pessoas (tracks anônimos) — Presença
    ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(56,189,248,0.85)";
    for (const t of tracksRef.current) {
      const x = cr.x + t.bbox[0] * cr.w, y = cr.y + t.bbox[1] * cr.h, w = t.bbox[2] * cr.w, h = t.bbox[3] * cr.h;
      ctx.strokeRect(x, y, w, h);
      const inspecting = pausedRef.current && detailed;
      const tag = inspecting ? `Pessoa ${t.id} · ${fmtDuration(performance.now() - t.firstSeen)}${t.zone ? " · " + t.zone : ""}` : `Pessoa ${t.id}`;
      ctx.font = inspecting ? "bold 12px ui-sans-serif, system-ui" : "10px monospace";
      const tw = ctx.measureText(tag).width + 8;
      ctx.fillStyle = "rgba(5,8,12,0.82)"; ctx.fillRect(x, y - 15, tw, 14);
      ctx.fillStyle = "#bae6fd"; ctx.fillText(tag, x + 4, y - 4);
    }

    for (const z of zonesRef.current) {
      const x = cr.x + z.x * cr.w, y = cr.y + z.y * cr.h, w = z.w * cr.w, h = z.h * cr.h;
      const r = resultsRef.current.get(z.id);
      let color = "#94a3b8"; let label2 = `${z.label} · ${ZONE_MODE_LABEL[z.modo]}`;
      if (r?.modo === "atividade") { color = STATE_COLOR[r.view.state]; label2 = `${z.label} · ${r.view.state} · ${r.view.people}p`; }
      else if (r?.modo === "leitura") { color = "#38bdf8"; label2 = `${z.label} · ${r.lastCode ?? "leitura…"}`; }
      else if (r?.modo === "objetos") {
        color = "#f59e0b";
        const parts = Object.entries(r.counts).filter(([, n]) => n > 0).map(([k, n]) => `${objClass(k)?.emoji ?? ""}${n}`);
        label2 = `${z.label} · ${parts.length ? parts.join(" ") : "0"}`;
        for (const d of r.dets) {
          const cx = d.bbox[0] + d.bbox[2] / 2, cy = d.bbox[1] + d.bbox[3] / 2;
          if (cx < z.x || cx > z.x + z.w || cy < z.y || cy > z.y + z.h) continue;
          const oc = objClass(d.key); const cc = oc?.color ?? "#f59e0b";
          const bx = cr.x + d.bbox[0] * cr.w, by = cr.y + d.bbox[1] * cr.h;
          ctx.lineWidth = 1.5; ctx.strokeStyle = cc; ctx.strokeRect(bx, by, d.bbox[2] * cr.w, d.bbox[3] * cr.h);
          if (detailed) { // rótulo da classe acima da bbox (só no modo cheio, p/ não poluir o tile)
            const tag = `${oc?.emoji ?? ""} ${oc?.label ?? d.key}`;
            ctx.font = "10px ui-sans-serif, system-ui"; const tw = ctx.measureText(tag).width + 6;
            ctx.fillStyle = "rgba(5,8,12,0.82)"; ctx.fillRect(bx, by - 13, tw, 12);
            ctx.fillStyle = cc; ctx.fillText(tag, bx + 3, by - 4);
          }
        }
      }
      else if (r?.modo === "fadiga") { color = RISK_COLOR[r.risk]; label2 = `${z.label} · ${RISK_LABEL[r.risk]}${r.ear != null ? ` · EAR ${r.ear.toFixed(2)}` : ""}${r.phone ? " · 📱" : ""}`; }
      const mask = getMask(z);
      const alerting = r?.modo === "atividade" && r.view.state === "ALERTA";
      if (mask && anySet(mask)) {
        // área irregular: pinta as células marcadas na cor do modo
        const cw = cr.w / mask.cols, ch = cr.h / mask.rows;
        ctx.fillStyle = color + (alerting ? "3a" : "26");
        for (let rr = 0; rr < mask.rows; rr++) for (let cc = 0; cc < mask.cols; cc++) if (mask.bits[rr * mask.cols + cc]) ctx.fillRect(cr.x + cc * cw, cr.y + rr * ch, cw + 0.5, ch + 0.5);
        ctx.lineWidth = alerting ? 2 : 1; ctx.strokeStyle = color; ctx.strokeRect(x, y, w, h); // contorno sutil da bbox
      } else {
        ctx.lineWidth = alerting ? 3 : 2; ctx.strokeStyle = color; ctx.fillStyle = color + "1f";
        ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      }
      ctx.font = "bold 11px ui-sans-serif, system-ui"; const tw = ctx.measureText(label2).width + 10;
      ctx.fillStyle = "rgba(5,8,12,0.8)"; ctx.fillRect(x, y, tw, 17); ctx.fillStyle = color; ctx.fillText(label2, x + 5, y + 12);
      if (detailed && r?.modo === "atividade" && r.view.state !== "ATIVA" && r.view.state !== "LENTA") { ctx.font = "10px monospace"; ctx.fillStyle = "#cbd5e1"; ctx.fillText(`parada ${fmtDuration(r.view.idleMs)}`, x + 5, y + 28); }
      if (detailed && r?.modo === "fadiga") drawFadigaZone(ctx, x, y, w, h, r.scene);
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
    if (mode !== "full") return;
    if (paintZoneId) { paintingRef.current = true; eraseRef.current = e.altKey || e.button === 2 || erase; paintAt(e); return; }
    if (drawMode) { const p = vpPoint(e); drawRef.current = { active: true, sx: p.x, sy: p.y, cx: p.x, cy: p.y }; }
  }
  function onMove(e: ReactMouseEvent) {
    if (paintingRef.current) { paintAt(e); return; }
    if (drawRef.current?.active) { const p = vpPoint(e); drawRef.current.cx = p.x; drawRef.current.cy = p.y; }
  }
  function onUp() {
    if (paintingRef.current) { paintingRef.current = false; commitPaint(); return; }
    const d = drawRef.current; if (!d?.active) return; drawRef.current = null;
    const f = getFrame(), viewport = viewportRef.current; if (!f || !viewport) return;
    const cr = getContentRect(viewport.clientWidth, viewport.clientHeight, f.w, f.h);
    const x0 = Math.min(d.sx, d.cx), y0 = Math.min(d.sy, d.cy), w = Math.abs(d.cx - d.sx), h = Math.abs(d.cy - d.sy);
    if (w < 16 || h < 16) return;
    const id = newZoneId(cameraId);
    const nz: Zone = { id, label: `Área ${zonesRef.current.length + 1}`, x: Math.max(0, (x0 - cr.x) / cr.w), y: Math.max(0, (y0 - cr.y) / cr.h), w: Math.min(1, w / cr.w), h: Math.min(1, h / cr.h), modo: "atividade" as ZoneMode, idleAlertMs: APP_CONFIG.zones.defaultIdleAlertMs, sensitivity: 5, atividade: "Indefinida", ponto: APP_CONFIG.reading.defaultPonto, selectedClasses: OBJECT_CATALOG.map((o) => o.key) };
    setZones((p) => persist([...p, nz]));
  }
  function persist(next: Zone[]): Zone[] { saveZones(cameraId, next); return next; }
  function patchZone(id: string, patch: Partial<Zone>) { setZones((p) => persist(p.map((z) => (z.id === id ? { ...z, ...patch } : z)))); }
  function removeZone(id: string) { holdersRef.current.get(id)?.proc.dispose(); holdersRef.current.delete(id); cropsRef.current.delete(id); resultsRef.current.delete(id); maskCacheRef.current.delete(id); if (paintZoneId === id) setPaintZoneId(null); setZones((p) => persist(p.filter((z) => z.id !== id))); }
  function startPaint(z: Zone) { setDrawMode(false); ensureMaskForPaint(z); setPaintZoneId(z.id); }
  function clearActive() { const z = zonesRef.current.find((zz) => zz.id === paintZoneId); if (!z) return; clearMask(ensureMaskForPaint(z)); commitPaint(); }
  const paintZone = paintZoneId ? zones.find((z) => z.id === paintZoneId) ?? null : null;

  const summary = zones.map((z) => { const r = panel.get(z.id); const m = r?.modo === "atividade" ? r.view.state : r?.modo === "leitura" ? (r.lastCode ?? "—") : r?.modo === "objetos" ? `${r.total} obj` : r?.modo === "fadiga" ? RISK_LABEL[r.risk] : ZONE_MODE_LABEL[z.modo]; return `${z.label}:${m}`; }).join(" · ");
  const alertCount = [...panel.values()].filter((r) => r.modo === "atividade" && r.view.state === "ALERTA").length;

  // Legenda do overlay: só as cores realmente em uso (pelos modos/classes das zonas atuais).
  const legend: { color: string; label: string }[] = (() => {
    const out: { color: string; label: string }[] = [];
    const modes = new Set(zones.map((z) => z.modo));
    if (modes.has("atividade")) {
      out.push({ color: STATE_COLOR.ATIVA, label: "Ativa" }, { color: STATE_COLOR.LENTA, label: "Lenta" }, { color: STATE_COLOR.OCIOSA, label: "Ociosa" }, { color: STATE_COLOR.ALERTA, label: "Alerta" }, { color: "#38bdf8", label: "Pessoa" });
    }
    if (modes.has("leitura")) out.push({ color: "#38bdf8", label: "Faixa de leitura" });
    if (modes.has("objetos")) {
      const keys = new Set(zones.filter((z) => z.modo === "objetos").flatMap((z) => z.selectedClasses));
      for (const k of keys) { const o = objClass(k); if (o) out.push({ color: o.color, label: o.label }); }
    }
    if (modes.has("fadiga")) out.push({ color: "#22c55e", label: "OK" }, { color: "#eab308", label: "Alerta" }, { color: "#ef4444", label: "Duplo" });
    return out;
  })();
  const cfgZone = cfgZoneId ? zones.find((z) => z.id === cfgZoneId) ?? null : null;

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
        <div className="cam-title"><b>{label}</b>{paintZone ? <span className="muted">pintando “{paintZone.label}”</span> : <span className="muted">{zones.length} zona(s)</span>}</div>
        <div className="spacer" />
        {paintZone ? (<>
          <IconButton label="Pincel (pintar)" active={!erase} onClick={() => setErase(false)}>🖌</IconButton>
          <IconButton label="Borracha (Alt/botão-direito também apagam)" active={erase} onClick={() => setErase(true)}>🧽</IconButton>
          <Select value={String(brush)} onChange={(v) => setBrush(Number(v))} options={BRUSH_OPTS} ariaLabel="Tamanho do pincel" />
          <Button onClick={clearActive}>Limpar</Button>
          <Button active onClick={() => setPaintZoneId(null)}>✓ Concluir</Button>
        </>) : (<>
          <Button active={paused} onClick={() => setPaused((v) => !v)} title="Congela o frame e rotula quem está em cena">{paused ? "▶ Retomar" : "⏸ Pausar"}</Button>
          <Button active={drawMode} onClick={() => setDrawMode((v) => !v)}>{drawMode ? "Desenhando…" : "✎ Zona"}</Button>
          <IconButton label="Fechar" onClick={onClose}>✕</IconButton>
        </>)}
      </header>

      <div className={`cam-stage ${drawMode || paintZone ? "draw-cursor" : ""}`} ref={viewportRef} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onContextMenu={(e) => { if (paintZone) e.preventDefault(); }}>
        <canvas className="overlay" ref={canvasRef} />
        <aside className="cam-drawer">
          <SegmentedControl value={drawerTab} onChange={(v) => setDrawerTab(v as "zonas" | "timeline" | "presenca")} ariaLabel="Aba do painel"
            options={[{ value: "zonas", label: `Zonas (${zones.length})` }, { value: "timeline", label: "Timeline" }, { value: "presenca", label: "Presença" }]} />
          <div style={{ height: "var(--sp-2)" }} />
          <div className="drawer-body">
            {drawerTab === "zonas" && zones.length === 0 && <p className="empty-note">Use “✎ Zona” para desenhar uma área e escolher o modo.</p>}
            {drawerTab === "zonas" && zones.map((z) => { const r = panel.get(z.id); const st = r?.modo === "atividade" ? r.view.state : "ATIVA"; return (
              <div key={z.id} className={`zone ${st}`}>
                <div className="row">
                  <span className="zone-head"><b className="zone-name" title={z.label}>{z.label}</b><Badge tone={MODE_TONE[z.modo]}>{ZONE_MODE_LABEL[z.modo]}</Badge></span>
                  <span className="zone-tools">
                    <button className="del" title="Configurar zona (modo e parâmetros)" aria-label="Configurar zona" onClick={() => setCfgZoneId(z.id)}>⚙</button>
                    <button className={`del ${paintZoneId === z.id ? "on" : ""}`} title="Pintar a área (blueprint em grade)" aria-label="Pintar área" onClick={() => (paintZoneId === z.id ? setPaintZoneId(null) : startPaint(z))}>🖌</button>
                    <button className="del" title="Remover zona" aria-label="Remover zona" onClick={() => removeZone(z.id)}>✕</button>
                  </span>
                </div>

                {z.modo === "atividade" && (r?.modo === "atividade" ? (<>
                  <div className="kpis ws-kpis">
                    <div className="kpi"><div className="v" style={{ color: STATE_COLOR[r.view.state], fontSize: 13 }}>{r.view.state}</div><div className="l">estado</div></div>
                    <div className="kpi"><div className="v">{r.view.people}</div><div className="l">pessoas</div></div>
                    <div className="kpi"><div className="v">{fmtDuration(r.view.idleMs)}</div><div className="l">parada</div></div>
                  </div>
                  <div className="zone-flow"><span>Fluxo</span><span className={`flow-chip ${r.view.flowLevel}`}>{r.view.flowLevel}</span><span className="spark">{r.view.flow.map((s, i) => <i key={i} style={{ height: `${Math.max(6, Math.round(s * 100))}%` }} />)}</span></div>
                  <div className="bar"><i style={{ width: `${Math.round(r.view.motion * 100)}%`, background: STATE_COLOR[r.view.state] }} /></div>
                </>) : <p className="ws-wait">iniciando…</p>)}

                {z.modo === "leitura" && (<>
                  <div className="kpis ws-kpis">
                    <div className="kpi"><div className="v" style={{ color: r?.modo === "leitura" ? rateColor(r.ratePct) : undefined }}>{r?.modo === "leitura" ? `${r.ratePct}%` : "—"}</div><div className="l">taxa</div></div>
                    <div className="kpi"><div className="v">{r?.modo === "leitura" ? r.perMin : "—"}</div><div className="l">lidas/min</div></div>
                    <div className="kpi"><div className="v" style={{ color: r?.modo === "leitura" && r.noReads > 0 ? "var(--alert)" : undefined }}>{r?.modo === "leitura" ? r.noReads : "—"}</div><div className="l">no-reads</div></div>
                  </div>
                  <div className="ws-code"><span className="muted">último código</span><code>{r?.modo === "leitura" ? (r.lastCode ?? "—") : "—"}</code></div>
                  <div className="ws-metric-row">Ponto <b>{z.ponto}</b> · {r?.modo === "leitura" ? r.passes : 0} passagens</div>
                </>)}

                {z.modo === "objetos" && (<>
                  <div className="ws-counts">
                    {z.selectedClasses.length === 0 && <span className="muted">nenhuma classe — abra ⚙</span>}
                    {z.selectedClasses.map((k) => { const o = objClass(k); const n = r?.modo === "objetos" ? (r.counts[k] ?? 0) : 0; return (
                      <span key={k} className={`count-chip ${n > 0 ? "on" : ""}`} style={n > 0 ? { borderColor: o?.color, color: o?.color } : undefined} title={o?.label}>{o?.emoji} <b>{n}</b></span>
                    ); })}
                  </div>
                  <div className="ws-metric-row">Total em cena <b>{r?.modo === "objetos" ? r.total : 0}</b></div>
                </>)}

                {z.modo === "fadiga" && (<>
                  <div className="ws-fadiga">
                    {r?.modo === "fadiga" && r.faceState === "ready" ? (<>
                      <Badge tone={RISK_TONE[r.risk]}>{RISK_LABEL[r.risk]}</Badge>
                      <span className="muted">EAR <b>{r.ear == null ? "--" : r.ear.toFixed(2)}</b></span>
                      <span className="muted">📱 {r.phone ? "sim" : "não"}</span>
                    </>) : <span className="muted">{r?.modo === "fadiga" ? (r.faceState === "loading" ? "carregando modelo…" : "modelo falhou") : "iniciando…"}</span>}
                  </div>
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
            <Field label="Modo" hint="O que esta área monitora.">
              <Select value={z.modo} onChange={(v) => patchZone(z.id, { modo: v as ZoneMode })} options={MODO_OPTS} ariaLabel="Modo da zona" />
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
