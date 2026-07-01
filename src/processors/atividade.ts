// Processador de zona — modo ATIVIDADE (ocupação/ociosidade/fluxo de uma área).
// Domínio puro (sem React/IO): recebe o contexto do frame + a zona e devolve o estado + efeitos.
// A view cuida da apresentação (timeline, toast, beep, gravação). SRP + DRY.
import { APP_CONFIG } from "../config";
import { fmtDuration } from "../format";
import type { Detection } from "../vision/model";
import type { ZoneSample } from "../report/store";
import type { Severity, Disposable } from "./types";

export type ZoneState = "ATIVA" | "LENTA" | "OCIOSA" | "VAZIA" | "ALERTA";
export type FlowLevel = "Alto" | "Médio" | "Baixo";

// Zona no modo atividade (geometria normalizada + limites/calibração).
// `contains` (opcional): predicado de máscara — quando presente, só pontos dentro dela contam (área irregular).
export type AtividadeZone = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  idleAlertMs: number;
  sensitivity: number;
  atividade: string;
  contains?: (nx: number, ny: number) => boolean;
};
export type ZoneView = {
  id: string;
  label: string;
  state: ZoneState;
  motion: number;
  idleMs: number;
  occupied: boolean;
  alerts: number;
  people: number;
  flow: number[];
  flowLevel: FlowLevel;
};

export const STATE_COLOR: Record<ZoneState, string> = {
  ATIVA: "#22c55e",
  LENTA: "#fb923c",
  OCIOSA: "#eab308",
  VAZIA: "#64748b",
  ALERTA: "#ef4444",
};
export const ACTIVITIES = [
  "Indefinida",
  "Carga",
  "Descarga",
  "Expedição",
  "Estoque",
  "Picking",
  "Espera",
  "Produção",
] as const;

export function activityForLabel(label: string): string {
  const f = ACTIVITIES.find(
    (a) => a !== "Indefinida" && label.toLowerCase().includes(a.toLowerCase()),
  );
  return f ?? "Indefinida";
}
// Sensibilidade 1..10 → fator nos limiares de movimento (5 ≈ 1.0; maior = detecta movimento mais sutil).
export function sensitivityFactor(s: number): number {
  return Math.pow(2, (5 - (s ?? 5)) / 4);
}

// Contexto do frame — calculado UMA vez por frame pela view e compartilhado entre as zonas (DRY/perf).
export type AtividadeCtx = {
  now: number;
  frameDt: number;
  demoMode: boolean;
  paused: boolean;
  luma: Float32Array | null;
  prev: Float32Array | null;
  pw: number;
  ph: number;
  dets: Detection[];
  frameW: number;
  frameH: number;
  tracks: { zone: string | null }[];
  sampleFlow: boolean;
  recEmit: boolean;
  // Fonte do frame (opcional). Só usada no modo LONGO ALCANCE, em que o processador reamostra a
  // luma numa resolução MAIOR (detection.longRange.procWidth) que a luma default do frame (ctx.luma,
  // em detection.procWidth). A frente C a preenche; ausente → cai na luma do ctx (sem regressão).
  frameEl?: CanvasImageSource;
};

export type AtividadeResult = {
  view: ZoneView;
  sample: ZoneSample | null; // histórico (a cada recEmit)
  event: { text: string; sev: Severity } | null; // entrada na timeline
  alert: {
    zoneId: string;
    area: string;
    atividade: string;
    durationMin: number;
    text: string;
  } | null; // ao entrar em ALERTA
  beep: boolean; // a view decide tocar (só em tela cheia)
};

const C = APP_CONFIG.detection;

type Runtime = {
  motionEMA: number;
  occupied: boolean;
  lastActivityAt: number;
  idleMs: number;
  state: ZoneState;
  pendingState: ZoneState;
  pendingSince: number;
  alerts: number;
  totalIdleMs: number;
  lastBeepAt: number;
  flow: number[];
  recIdleMs: number;
  recFrames: number;
  recActiveFrames: number;
};

/** Estado e lógica de UMA zona de atividade. Uma instância por zona (mantém o runtime). */
export class AtividadeProcessor implements Disposable {
  private rt: Runtime;
  // Perfil "longo alcance" (opt-in POR CÂMERA — a frente C chama setLongRange conforme a config).
  // Default false = comportamento atual. Quando ligado, a detecção de MOVIMENTO usa os valores de
  // APP_CONFIG.detection.longRange (procWidth maior + ratios menores) e o processador mantém o SEU
  // próprio canvas/buffers de luma (o frame chega maior que a luma default do ctx).
  private longRange = false;
  private lrCanvas: HTMLCanvasElement | null = null;
  private lrCur: Float32Array | null = null; // buffer da luma atual (ping-pong com lrPrev)
  private lrPrev: Float32Array | null = null; // buffer da luma anterior
  private lrW = 0;
  private lrH = 0;
  constructor(now: number) {
    this.rt = {
      motionEMA: 0,
      occupied: false,
      lastActivityAt: now,
      idleMs: 0,
      state: "ATIVA",
      pendingState: "ATIVA",
      pendingSince: now,
      alerts: 0,
      totalIdleMs: 0,
      lastBeepAt: 0,
      flow: [],
      recIdleMs: 0,
      recFrames: 0,
      recActiveFrames: 0,
    };
  }

  /**
   * Liga/desliga o perfil "longo alcance" desta zona. OPT-IN por câmera: a frente C chama conforme
   * a config da câmera. Ligado → detecção de movimento usa APP_CONFIG.detection.longRange. Ao
   * desligar, libera o canvas/buffers próprios (não vaza memória entre trocas de perfil).
   */
  setLongRange(on: boolean): void {
    if (on === this.longRange) return;
    this.longRange = on;
    if (!on) this.releaseLongRange();
  }

  // Libera o canvas e os buffers de luma do modo longo alcance (GC os coleta).
  private releaseLongRange(): void {
    this.lrCanvas = null;
    this.lrCur = null;
    this.lrPrev = null;
    this.lrW = 0;
    this.lrH = 0;
  }

  process(z: AtividadeZone, ctx: AtividadeCtx): AtividadeResult {
    const rt = this.rt;
    const { now } = ctx;

    // Perfil de MOVIMENTO. Default = APP_CONFIG.detection (luma do ctx, em detection.procWidth).
    // Longo alcance = APP_CONFIG.detection.longRange: reamostra a luma numa resolução MAIOR
    // (procWidth) p/ captar movimento distante e usa ratios menores (mais sensível). O canvas e os
    // dois buffers de luma são próprios do processador e só REALOCAM quando a dimensão muda; a cada
    // frame fazem ping-pong (atual↔anterior), sem alocar por frame → não vaza memória.
    const lr = this.longRange ? APP_CONFIG.detection.longRange : null;
    const motionActive = lr ? lr.motionActiveRatio : C.motionActiveRatio;
    const motionSlow = lr ? lr.motionSlowRatio : C.motionSlowRatio;
    let luma = ctx.luma,
      prev = ctx.prev,
      pw = ctx.pw,
      ph = ctx.ph;
    if (lr && ctx.frameEl && ctx.frameW > 0 && ctx.frameH > 0) {
      const w = lr.procWidth,
        h = Math.max(1, Math.round((w * ctx.frameH) / ctx.frameW)),
        size = w * h;
      if (this.lrW !== w || this.lrH !== h) {
        if (!this.lrCanvas) this.lrCanvas = document.createElement("canvas");
        this.lrCanvas.width = w;
        this.lrCanvas.height = h;
        this.lrW = w;
        this.lrH = h;
        this.lrCur = null;
        this.lrPrev = null; // dimensão mudou → invalida a luma anterior (não há diff neste frame)
      }
      const g = this.lrCanvas!.getContext("2d", { willReadFrequently: true });
      if (g) {
        g.drawImage(ctx.frameEl, 0, 0, w, h);
        const img = g.getImageData(0, 0, w, h).data;
        let cur = this.lrCur; // recicla o buffer livre (o "anterior" de 2 frames atrás)
        if (!cur || cur.length !== size) cur = new Float32Array(size);
        for (let i = 0, j = 0; i < img.length; i += 4, j++)
          cur[j] = 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
        luma = cur;
        prev = this.lrPrev;
        pw = w;
        ph = h;
        // swap: o buffer anterior fica livre p/ o próximo frame; a luma atual vira "anterior"
        this.lrCur = this.lrPrev;
        this.lrPrev = cur;
      }
    }

    // movimento na ROI da zona (diff de luminância); com máscara, só células pintadas contam
    let changed = 0,
      total = 0;
    if (prev && luma) {
      const x0 = Math.floor(z.x * pw),
        x1 = Math.ceil((z.x + z.w) * pw),
        y0 = Math.floor(z.y * ph),
        y1 = Math.ceil((z.y + z.h) * ph);
      const mask = z.contains;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const idx = y * pw + x;
          if (idx < 0 || idx >= luma.length) continue;
          if (mask && !mask(x / pw, y / ph)) continue;
          total++;
          if (Math.abs(luma[idx] - prev[idx]) > C.motionPixelDelta) changed++;
        }
    }
    const ratio = total > 0 ? changed / total : 0;
    rt.motionEMA = rt.motionEMA * (1 - C.signalSmoothingAlpha) + ratio * C.signalSmoothingAlpha;

    // ocupação (objetos) — consome o detect já feito no nível do frame
    let occupied = false;
    for (const d of ctx.dets) {
      if (d.score < C.objectScoreThreshold) continue;
      if (!(C.occupancyClasses as readonly string[]).includes(d.class)) continue;
      const cx = (d.bbox[0] + d.bbox[2] / 2) / ctx.frameW,
        cy = (d.bbox[1] + d.bbox[3] / 2) / ctx.frameH;
      if (
        cx >= z.x &&
        cx <= z.x + z.w &&
        cy >= z.y &&
        cy <= z.y + z.h &&
        (!z.contains || z.contains(cx, cy))
      ) {
        occupied = true;
        break;
      }
    }
    rt.occupied = occupied;

    const sf = sensitivityFactor(z.sensitivity);
    const strong = rt.motionEMA > motionActive * sf;
    const slow = !strong && rt.motionEMA > motionSlow * sf;
    if (strong || slow) rt.lastActivityAt = now;
    rt.idleMs = now - rt.lastActivityAt;

    const idleLimit = ctx.demoMode
      ? APP_CONFIG.zones.demoIdleAlertMs
      : (z.idleAlertMs ?? APP_CONFIG.zones.defaultIdleAlertMs);
    let target: ZoneState;
    if (rt.idleMs > idleLimit) target = "ALERTA";
    else if (slow) target = "LENTA";
    else if (rt.idleMs < C.activeHoldMs) target = "ATIVA";
    else if (occupied) target = "OCIOSA";
    else target = "VAZIA";

    if (target !== rt.pendingState) {
      rt.pendingState = target;
      rt.pendingSince = now;
    }
    const confirmMs = target === "ALERTA" ? 0 : C.stateConfirmationMs;

    let event: AtividadeResult["event"] = null;
    let alert: AtividadeResult["alert"] = null;
    let beep = false;
    if (target !== rt.state && now - rt.pendingSince >= confirmMs) {
      const prevSt = rt.state;
      rt.state = target;
      if (target === "ALERTA") {
        rt.alerts++;
        if (now - rt.lastBeepAt >= APP_CONFIG.audio.alertBeepCooldownMs) {
          rt.lastBeepAt = now;
          beep = true;
        }
        const text = `${z.label} sem movimentação há ${fmtDuration(rt.idleMs)}.`;
        event = { text, sev: "high" };
        alert = {
          zoneId: z.id,
          area: z.label,
          atividade: z.atividade,
          durationMin: Math.max(1, Math.round(rt.idleMs / 60000)),
          text,
        };
      } else if (prevSt === "ALERTA")
        event = { text: `${z.label} retomou atividade.`, sev: "info" };
      else if (target === "LENTA")
        event = { text: `${z.label} com baixa movimentação (gargalo).`, sev: "warn" };
      else if (target === "VAZIA")
        event = { text: `${z.label} vazia / sem movimento.`, sev: "warn" };
    }
    if (rt.state !== "ATIVA" && !ctx.paused) rt.totalIdleMs += ctx.frameDt;

    const people = ctx.tracks.filter((t) => t.zone === z.label).length;

    // histórico (indicadores): acumula e emite a cada recEmit
    rt.recFrames++;
    if (rt.state !== "ATIVA" && !ctx.paused) rt.recIdleMs += ctx.frameDt;
    if (rt.state === "ATIVA" || rt.state === "LENTA") rt.recActiveFrames++;
    let sample: ZoneSample | null = null;
    if (ctx.recEmit) {
      sample = {
        zoneId: z.id,
        label: z.label,
        atividade: z.atividade,
        idleMs: rt.recIdleMs,
        frames: rt.recFrames,
        activeFrames: rt.recActiveFrames,
        people,
      };
      rt.recIdleMs = 0;
      rt.recFrames = 0;
      rt.recActiveFrames = 0;
    }

    if (ctx.sampleFlow) {
      rt.flow.push(Math.min(1, rt.motionEMA / motionActive));
      if (rt.flow.length > 40) rt.flow.shift();
    }
    const flowAvg = rt.flow.length ? rt.flow.reduce((a, b) => a + b, 0) / rt.flow.length : 0;
    const flowLevel: FlowLevel = flowAvg > 0.6 ? "Alto" : flowAvg > 0.2 ? "Médio" : "Baixo";

    const view: ZoneView = {
      id: z.id,
      label: z.label,
      state: rt.state,
      motion: Math.min(1, rt.motionEMA / (motionActive * 6)),
      idleMs: rt.idleMs,
      occupied,
      alerts: rt.alerts,
      people,
      flow: rt.flow.slice(-40),
      flowLevel,
    };
    return { view, sample, event, alert, beep };
  }

  dispose(): void {
    this.releaseLongRange(); // libera canvas/buffers do modo longo alcance
  }
}
