// Processador — modo FADIGA (operador). Domínio puro: dona os modelos (MediaPipe Face/Hand +
// coco-ssd), faz EAR/MAR+EMA, gesto, score adaptativo de celular, motor de risco e recorder.
// Devolve snapshot + cena (p/ desenho) + efeitos; a view cuida de IO (toast/beep/gravação/desenho).
import { APP_CONFIG } from "../config";
import { loadDetector } from "../vision/model";
import { createFaceLandmarker, createHandLandmarker } from "../fadiga/models";
import {
  calcEar,
  calcMar,
  inferManualSignal,
  normalizedLandmarksRect,
  earZones,
  rectIntersectionArea,
  rectIou,
  type Landmark,
  type Handedness,
  type ManualSignal,
  type RiskState,
  type PhoneDetection,
  type HandDetection,
  type Rect,
} from "../fadiga/landmarks";
import type { FaceLandmarker, HandLandmarker } from "@mediapipe/tasks-vision";
import type { FrameSource } from "../frame";
import type { Disposable } from "./types";

const F = APP_CONFIG.fadiga;

// O detector de celular (coco-ssd) roda na MAIN THREAD (P3) e bloqueia o desenho/UI por
// dezenas de ms. Sem tocar a config, aplicamos um piso de cadência maior que F.objectIntervalMs
// (220ms) para reduzir a frequência desse bloqueio. (face/mãos seguem a cadência da config.)
const PHONE_DETECT_MIN_INTERVAL_MS = 500;

// Cadências REBAIXADAS quando `ctx.slow` (view em modo GRADE/tile): na grade não há operador
// olhando o overlay de perto, então inferir a 66/90ms é desperdício de CPU/GPU × N tiles.
// A semântica dos alertas (janelas de confirmação/histerese em updateRisk) fica INTACTA —
// só a latência de detecção aumenta (~0,6s face/mãos, ~1,5s celular), aceitável na grade.
// Na câmera ABERTA (full) valem os intervalos da config, como antes.
const SLOW_FACE_INTERVAL_MS = 600;
const SLOW_HAND_INTERVAL_MS = 600;
const SLOW_OBJECT_INTERVAL_MS = 1500;

export type FadigaModelState = "loading" | "ready" | "error";
export type FadigaCounters = { fadiga: number; bocejo: number; celular: number; duplo: number };
// Liga/desliga cada pipeline em runtime (operador). `risk` desligado força risco OK (sem alertas).
export type FadigaFlags = { face: boolean; hands: boolean; phone: boolean; risk: boolean };
export const FADIGA_FLAGS_ALL: FadigaFlags = { face: true, hands: true, phone: true, risk: true };
// Limiares calibráveis na UI (default = APP_CONFIG.fadiga). earClosed↓ e marYawn↑ = mais rígido.
export type FadigaThresholds = {
  earClosed: number;
  marYawn: number;
  phoneScore: number;
  fatigueMs: number;
};
export type FadigaEv = { type: "fadiga" | "celular" | "duplo" | "bocejo"; ts: number };
export type FadigaSampleAccum = {
  samples: number;
  ok: number;
  fadiga: number;
  celular: number;
  duplo: number;
  earSum: number;
  earSamples: number;
};
export type FadigaScene = {
  landmarks: Landmark[] | null;
  ear: number | null;
  mar: number | null;
  yawnDetected: boolean;
  phone: PhoneDetection;
  hands: HandDetection;
  confirmedSignal: ManualSignal;
  riskState: RiskState;
  videoWidth: number;
  videoHeight: number;
};
export type FadigaSnapshot = {
  ear: number | null;
  mar: number | null;
  yawn: boolean;
  signal: ManualSignal;
  handCount: number;
  phone: PhoneDetection;
  risk: RiskState;
  faceState: FadigaModelState;
  counters: FadigaCounters;
};
export type FadigaResult = {
  snapshot: FadigaSnapshot;
  scene: FadigaScene;
  events: FadigaEv[]; // histórico (sem posto — a view adiciona)
  alertRisk: RiskState | null; // transição p/ não-OK (a view dá toast + beep)
  sample: FadigaSampleAccum | null;
  faceMs: number | null; // latência da inferência facial (telemetria por modelo)
  handMs: number | null; // latência da inferência de mãos
  objMs: number | null; // latência da detecção de celular (coco-ssd, assíncrona)
};

export class FadigaProcessor implements Disposable {
  private face: FaceLandmarker | null = null;
  private hand: HandLandmarker | null = null;
  private obj: Awaited<ReturnType<typeof loadDetector>> | null = null;
  private faceState: FadigaModelState = "loading";
  private objState: FadigaModelState = "loading";
  private alive = true;

  private det = {
    landmarks: null as Landmark[] | null,
    ear: null as number | null,
    mar: null as number | null,
    yawn: false,
    hands: [] as HandDetection,
    manualSignal: "SEM_SINAL" as ManualSignal,
    phone: null as PhoneDetection,
    lastEl: null as unknown,
    lastFaceAt: 0,
    lastHandAt: 0,
    lastObjAt: 0,
    lastPhoneAt: 0,
    objInFlight: false,
    pendingObjMs: null as number | null,
  };
  private smooth = { ear: null as number | null, mar: null as number | null };
  private win = {
    eyesClosedSince: null as number | null,
    yawnSince: null as number | null,
    phoneSince: null as number | null,
    signalSince: null as number | null,
  };
  private trans = { lastChangeAt: 0, clearSince: null as number | null };
  private risk: RiskState = "OK";
  private counters: FadigaCounters = { fadiga: 0, bocejo: 0, celular: 0, duplo: 0 };
  private accum: FadigaSampleAccum = {
    samples: 0,
    ok: 0,
    fadiga: 0,
    celular: 0,
    duplo: 0,
    earSum: 0,
    earSamples: 0,
  };
  private lastAccum = 0;
  private lastEmit = 0;
  private ts = 0;
  private th: FadigaThresholds = {
    earClosed: F.eyesClosedEarThreshold,
    marYawn: F.yawnMarThreshold,
    phoneScore: F.phoneAdjustedScoreThreshold,
    fatigueMs: F.fatigueConfirmationMs,
  };

  /** Calibração em runtime dos limiares (UI). Mescla parcial sobre os atuais. */
  setThresholds(p: Partial<FadigaThresholds>): void {
    this.th = { ...this.th, ...p };
  }

  constructor() {
    createFaceLandmarker()
      .then((m) => {
        if (this.alive) {
          this.face = m;
          this.faceState = "ready";
        } else m.close();
      })
      .catch(() => {
        this.faceState = "error";
      });
    createHandLandmarker()
      .then((m) => {
        if (this.alive) this.hand = m;
        else m.close();
      })
      .catch(() => {});
    loadDetector()
      .then((m) => {
        if (this.alive) {
          this.obj = m;
          this.objState = "ready";
        }
      })
      .catch(() => {
        this.objState = "error";
      });
  }

  // motor de risco — muta estado interno e devolve eventos/alerta desta chamada
  private updateRisk(now: number): { events: FadigaEv[]; alertRisk: RiskState | null } {
    const events: FadigaEv[] = [];
    const e = this.smooth.ear,
      m = this.smooth.mar,
      w = this.win;
    w.eyesClosedSince = e != null && e < this.th.earClosed ? (w.eyesClosedSince ?? now) : null;
    w.yawnSince = m != null && m >= this.th.marYawn ? (w.yawnSince ?? now) : null;
    w.phoneSince = this.det.phone ? (w.phoneSince ?? now) : null;

    const eyesConfirmed = w.eyesClosedSince != null && now - w.eyesClosedSince >= this.th.fatigueMs;
    const yawnConfirmed = w.yawnSince != null && now - w.yawnSince >= F.yawnConfirmationMs;
    const fatigue = eyesConfirmed || yawnConfirmed;
    const phoneConfirmed = w.phoneSince != null && now - w.phoneSince >= F.phoneConfirmationMs;

    if (yawnConfirmed !== this.det.yawn) {
      this.det.yawn = yawnConfirmed;
      if (yawnConfirmed) {
        this.counters.bocejo++;
        events.push({ type: "bocejo", ts: Date.now() });
      }
    }

    const detected: RiskState =
      fatigue && phoneConfirmed
        ? "ALERTA_DUPLO"
        : fatigue
          ? "ALERTA_FADIGA"
          : phoneConfirmed
            ? "ALERTA_CELULAR"
            : "OK";
    let next = detected;
    const prev = this.risk,
      t = this.trans,
      inAlert = prev !== "OK";
    if (inAlert && detected === "OK") {
      t.clearSince = t.clearSince ?? now;
      next = now - t.clearSince >= F.recoveryGraceMs ? "OK" : prev;
    } else t.clearSince = null;
    if (inAlert && detected !== "OK" && detected !== prev)
      next = now - t.lastChangeAt >= F.minAlertStateHoldMs ? detected : prev;

    let alertRisk: RiskState | null = null;
    if (next !== prev) {
      t.lastChangeAt = now;
      this.risk = next;
      if (next !== "OK") {
        alertRisk = next;
        const type =
          next === "ALERTA_FADIGA" ? "fadiga" : next === "ALERTA_CELULAR" ? "celular" : "duplo";
        events.push({ type, ts: Date.now() });
        if (next === "ALERTA_FADIGA") this.counters.fadiga++;
        else if (next === "ALERTA_CELULAR") this.counters.celular++;
        else this.counters.duplo++;
      }
    }
    return { events, alertRisk };
  }

  // `srcEl` (opcional): identidade do frame de ORIGEM. Como zona, a view passa um canvas de recorte
  // com identidade estável (o conteúdo muda, o objeto não) — então o newFrame usa o frame real.
  process(ctx: {
    frame: FrameSource;
    now: number;
    flags?: FadigaFlags;
    srcEl?: unknown;
    /** true = view em GRADE (tile): rebaixa a cadência de inferência (ver SLOW_*_INTERVAL_MS). */
    slow?: boolean;
  }): FadigaResult {
    const f = ctx.frame,
      now = ctx.now,
      snap = this.det;
    const flags = ctx.flags ?? FADIGA_FLAGS_ALL;
    const faceEveryMs = ctx.slow ? Math.max(F.faceIntervalMs, SLOW_FACE_INTERVAL_MS) : F.faceIntervalMs;
    const handEveryMs = ctx.slow ? Math.max(F.handIntervalMs, SLOW_HAND_INTERVAL_MS) : F.handIntervalMs;
    const objEveryMs = Math.max(
      F.objectIntervalMs,
      ctx.slow ? SLOW_OBJECT_INTERVAL_MS : PHONE_DETECT_MIN_INTERVAL_MS,
    );
    let faceMs: number | null = null,
      handMs: number | null = null;
    const idEl = ctx.srcEl ?? f.el;
    const newFrame = idEl !== snap.lastEl;
    snap.lastEl = idEl;
    const ts = (this.ts = Math.max(this.ts + 1, Math.round(now))); // monotônico p/ MediaPipe

    // Detectores desligados pelo operador: zera o estado derivado (UI/risco consistentes).
    if (!flags.face) {
      snap.landmarks = null;
      snap.ear = null;
      snap.mar = null;
      this.smooth.ear = null;
      this.smooth.mar = null;
      this.win.eyesClosedSince = null;
      this.win.yawnSince = null;
    }
    if (!flags.hands) {
      snap.hands = [];
      snap.manualSignal = "SEM_SINAL";
      this.win.signalSince = null;
    }
    if (!flags.phone) {
      snap.phone = null;
      this.win.phoneSince = null;
    }

    // FACE (EAR/MAR + EMA)
    if (
      flags.face &&
      this.face &&
      this.faceState === "ready" &&
      newFrame &&
      now - snap.lastFaceAt >= faceEveryMs
    ) {
      snap.lastFaceAt = now;
      const t0 = performance.now();
      try {
        const res = this.face.detectForVideo(f.el as unknown as HTMLVideoElement, ts);
        faceMs = performance.now() - t0;
        const lm = (res.faceLandmarks?.[0] ?? null) as Landmark[] | null;
        const earRaw = lm ? calcEar(lm) : null,
          marRaw = lm ? calcMar(lm) : null;
        const a = F.signalSmoothingAlpha;
        this.smooth.ear =
          earRaw == null
            ? null
            : this.smooth.ear == null
              ? earRaw
              : a * earRaw + (1 - a) * this.smooth.ear;
        this.smooth.mar =
          marRaw == null
            ? null
            : this.smooth.mar == null
              ? marRaw
              : a * marRaw + (1 - a) * this.smooth.mar;
        snap.landmarks = lm;
        snap.ear = this.smooth.ear;
        snap.mar = this.smooth.mar;
      } catch {
        /* timestamp/frame */
      }
    }

    // MÃOS (gesto)
    if (flags.hands && this.hand && newFrame && now - snap.lastHandAt >= handEveryMs) {
      snap.lastHandAt = now;
      const t0 = performance.now();
      try {
        const hr = this.hand.detectForVideo(f.el as unknown as HTMLVideoElement, ts);
        handMs = performance.now() - t0;
        const lms = hr.landmarks ?? [],
          hands_ = hr.handednesses ?? [];
        const hands: HandDetection = lms.map((hm, i) => {
          const cat = hands_[i]?.[0]?.categoryName;
          const hd: Handedness = cat === "Left" || cat === "Right" ? cat : "Unknown";
          return {
            landmarks: hm as Landmark[],
            handedness: hd,
            signal: inferManualSignal(hm as Landmark[], hd),
          };
        });
        snap.hands = hands;
        const strongest = hands.find((h) => h.signal !== "SEM_SINAL")?.signal ?? "SEM_SINAL";
        const w = this.win;
        if (strongest !== "SEM_SINAL") {
          if (w.signalSince == null || snap.manualSignal !== strongest) w.signalSince = now;
          if (w.signalSince != null && now - w.signalSince >= F.handGestureConfirmationMs)
            snap.manualSignal = strongest;
        } else {
          w.signalSince = null;
          snap.manualSignal = "SEM_SINAL";
        }
      } catch {
        /* ignore */
      }
    }

    // CELULAR (coco-ssd async + score adaptativo por contexto)
    if (
      flags.phone &&
      this.obj &&
      this.objState === "ready" &&
      newFrame &&
      now - snap.lastObjAt >= objEveryMs &&
      !snap.objInFlight
    ) {
      snap.lastObjAt = now;
      snap.objInFlight = true;
      const tObj = performance.now();
      void this.obj
        .detect(f.el as unknown as HTMLCanvasElement, 24, 0.18)
        .then((preds) => {
          snap.pendingObjMs = performance.now() - tObj;
          const vw = f.w,
            vh = f.h;
          const faceRect = snap.landmarks ? normalizedLandmarksRect(snap.landmarks, vw, vh) : null;
          const ezones = faceRect ? earZones(faceRect) : [];
          const handRects = snap.hands
            .map((h) => normalizedLandmarksRect(h.landmarks, vw, vh))
            .filter((r): r is Rect => r != null);
          const best = preds
            .filter(
              (d) => d.class === F.phoneClassName && Number(d.score || 0) >= F.phoneMinRawScore,
            )
            .map((d) => {
              const [x, y, width, height] = d.bbox;
              const rect: Rect = { x, y, width, height };
              const area = Math.max(1, width * height);
              const earB = ezones.some(
                (z) => rectIntersectionArea(rect, z) / area >= 0.1 || rectIou(rect, z) >= 0.04,
              )
                ? F.phoneAdaptiveBoostEar
                : 0;
              const handB = handRects.some(
                (h) => rectIntersectionArea(rect, h) / area >= 0.12 || rectIou(rect, h) >= 0.04,
              )
                ? F.phoneAdaptiveBoostHand
                : 0;
              const raw = Number(d.score || 0);
              return { raw, adj: Math.min(1, raw + earB + handB), bbox: rect };
            })
            .filter((d) => d.adj >= this.th.phoneScore || d.raw >= F.phoneScoreThreshold)
            .sort((a, b) => b.adj - a.adj)[0];
          if (best) {
            snap.phone = { ...best.bbox, score: best.adj };
            snap.lastPhoneAt = now;
          } else if (!(snap.phone && now - snap.lastPhoneAt <= F.phoneRetainMs)) snap.phone = null;
        })
        .catch(() => {
          snap.phone = null;
        })
        .finally(() => {
          snap.objInFlight = false;
        });
    }

    // motor de risco — pulado (e forçado a OK) quando o operador desliga o toggle de risco
    let events: FadigaEv[] = [],
      alertRisk: RiskState | null = null;
    if (flags.risk) ({ events, alertRisk } = this.updateRisk(now));
    else if (this.risk !== "OK") {
      this.risk = "OK";
      this.trans.clearSince = null;
      this.win.eyesClosedSince = null;
      this.win.yawnSince = null;
      this.win.phoneSince = null;
    }

    // recorder (tempo em cada estado de risco): 1 amostra/s, emite a cada 5s
    if (now - this.lastAccum > 1000) {
      this.lastAccum = now;
      const ac = this.accum,
        r = this.risk;
      ac.samples++;
      if (r === "OK") ac.ok++;
      else if (r === "ALERTA_FADIGA") ac.fadiga++;
      else if (r === "ALERTA_CELULAR") ac.celular++;
      else ac.duplo++;
      if (this.smooth.ear != null) {
        ac.earSum += this.smooth.ear;
        ac.earSamples++;
      }
    }
    let sample: FadigaSampleAccum | null = null;
    if (now - this.lastEmit > 5000) {
      this.lastEmit = now;
      if (this.accum.samples > 0) {
        sample = { ...this.accum };
        this.accum = {
          samples: 0,
          ok: 0,
          fadiga: 0,
          celular: 0,
          duplo: 0,
          earSum: 0,
          earSamples: 0,
        };
      }
    }

    const snapshot: FadigaSnapshot = {
      ear: snap.ear,
      mar: snap.mar,
      yawn: snap.yawn,
      signal: snap.manualSignal,
      handCount: snap.hands.length,
      phone: snap.phone,
      risk: this.risk,
      faceState: this.faceState,
      counters: { ...this.counters },
    };
    const scene: FadigaScene = {
      landmarks: snap.landmarks,
      ear: snap.ear,
      mar: snap.mar,
      yawnDetected: snap.yawn,
      phone: snap.phone,
      hands: snap.hands,
      confirmedSignal: snap.manualSignal,
      riskState: this.risk,
      videoWidth: f.w,
      videoHeight: f.h,
    };
    const objMs = snap.pendingObjMs;
    snap.pendingObjMs = null;
    return { snapshot, scene, events, alertRisk, sample, faceMs, handMs, objMs };
  }

  dispose(): void {
    this.alive = false;
    this.face?.close();
    this.face = null;
    this.hand?.close();
    this.hand = null;
    this.obj = null;
  }
}
