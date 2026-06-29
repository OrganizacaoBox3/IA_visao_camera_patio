// Processador de zona — modo LEITURA (código de barras numa faixa/ROI).
// Domínio puro: gerencia decode (assíncrono, no worker), detecção de passagem (motion) e dedup,
// drenando os eventos a cada process(). A view cuida de cluster/gravação/desenho/painel (SRP).
import { APP_CONFIG } from "../config";
import { decodeFromCanvas, ensureDecoder, decoderKind, type DecoderKind } from "../reading/decoder";
import type { ReadEvent, PassEvent } from "../reading/cluster";
import type { FrameSource } from "../frame";
import type { Disposable } from "./types";

const R = APP_CONFIG.reading;

export type LeituraZone = { x: number; y: number; w: number; h: number; ponto: string };
export type LeituraCtx = { frame: FrameSource; now: number; cameraId: string; cameraLabel: string };
export type LeituraResult = {
  reads: ReadEvent[]; // leituras novas (já deduplicadas) desde o último process()
  passes: PassEvent[]; // passagens de caixa detectadas
  perMin: number; // throughput recente
  passesCount: number; // total acumulado de passagens
  boxesCount: number; // total acumulado de caixas lidas (distintas)
  ratePct: number; // taxa de leitura = caixas/passagens (%)
  noReads: number; // passagens sem leitura = passagens - caixas
  kind: DecoderKind; // backend do decodificador
  decodeMs: number | null; // latência da última decodificação concluída (telemetria)
};

export class LeituraProcessor implements Disposable {
  private proc = document.createElement("canvas");
  private motion = document.createElement("canvas");
  private prevLuma: Float32Array | null = null;
  private curLuma: Float32Array | null = null; // buffer reutilizável (swap c/ prevLuma) — evita new por frame
  private decoding = false;
  private lastDecodeAt = 0;
  private lastEmit: { code: string; ts: number } | null = null;
  private readTs: number[] = [];
  private passState: "clear" | "occupied" = "clear";
  private lastPassAt = 0;
  private passesCount = 0;
  private boxesCount = 0;
  private kind: DecoderKind = decoderKind();
  private pendingReads: ReadEvent[] = [];
  private pendingPasses: PassEvent[] = [];
  private pendingDecodeMs: number | null = null;

  constructor() {
    void ensureDecoder().then(() => {
      this.kind = decoderKind();
    });
  }

  process(zone: LeituraZone, ctx: LeituraCtx): LeituraResult {
    const f = ctx.frame,
      now = ctx.now;
    const sx = Math.round(zone.x * f.w),
      sy = Math.round(zone.y * f.h);
    const sw = Math.max(1, Math.round(zone.w * f.w)),
      sh = Math.max(1, Math.round(zone.h * f.h));

    // ── PASSAGEM de caixa (motion na ROI; borda de subida = entrou caixa) ──
    const mpw = R.motionProcWidth,
      mph = Math.max(1, Math.round((mpw * sh) / sw));
    if (this.motion.width !== mpw || this.motion.height !== mph) {
      this.motion.width = mpw;
      this.motion.height = mph;
      this.prevLuma = null;
      this.curLuma = null;
    }
    const mctx = this.motion.getContext("2d", { willReadFrequently: true });
    if (mctx) {
      mctx.drawImage(f.el, sx, sy, sw, sh, 0, 0, mpw, mph);
      const mdata = mctx.getImageData(0, 0, mpw, mph).data;
      const size = mpw * mph;
      let luma = this.curLuma;
      if (!luma || luma.length !== size) luma = new Float32Array(size); // (re)aloca só na 1ª vez / ao mudar de tamanho
      for (let i = 0, j = 0; i < mdata.length; i += 4, j++)
        luma[j] = 0.299 * mdata[i] + 0.587 * mdata[i + 1] + 0.114 * mdata[i + 2];
      const prev = this.prevLuma;
      if (prev) {
        let changed = 0;
        const total = luma.length;
        for (let k = 0; k < total; k++)
          if (Math.abs(luma[k] - prev[k]) > R.motionPixelDelta) changed++;
        const ratio = total > 0 ? changed / total : 0;
        if (this.passState === "clear" && ratio > R.passEnterRatio) {
          this.passState = "occupied";
          if (now - this.lastPassAt > R.passDebounceMs) {
            this.lastPassAt = now;
            this.passesCount++;
            this.pendingPasses.push({ cameraId: ctx.cameraId, ponto: zone.ponto, ts: Date.now() });
          }
        } else if (this.passState === "occupied" && ratio < R.passClearRatio) {
          this.passState = "clear";
        }
      }
      // swap: a luma atual vira "anterior"; o buffer antigo é reciclado p/ a próxima leitura
      this.curLuma = this.prevLuma;
      this.prevLuma = luma;
    }

    // ── DECODE throttled na ROI (largura limitada → mais rápido) ──
    if (!this.decoding && now - this.lastDecodeAt > R.decodeIntervalMs) {
      this.lastDecodeAt = now;
      this.decoding = true;
      const roiW = Math.min(sw, 1080),
        roiH = Math.max(1, Math.round((roiW * sh) / sw));
      if (this.proc.width !== roiW || this.proc.height !== roiH) {
        this.proc.width = roiW;
        this.proc.height = roiH;
      }
      const pctx = this.proc.getContext("2d", { willReadFrequently: true });
      if (pctx) {
        pctx.drawImage(f.el, sx, sy, sw, sh, 0, 0, roiW, roiH);
        const t0 = performance.now();
        void decodeFromCanvas(this.proc)
          .then((res) => {
            this.pendingDecodeMs = performance.now() - t0;
            if (!res) return;
            const ts = Date.now();
            const last = this.lastEmit;
            if (last && last.code === res.code && ts - last.ts < R.dedupWindowMs) {
              last.ts = ts;
              return;
            } // mesma caixa em cena
            this.lastEmit = { code: res.code, ts };
            this.readTs.push(ts);
            this.boxesCount++;
            this.pendingReads.push({
              cameraId: ctx.cameraId,
              cameraLabel: ctx.cameraLabel,
              ponto: zone.ponto,
              code: res.code,
              format: res.format,
              ts,
            });
          })
          .catch(() => {})
          .finally(() => {
            this.decoding = false;
          });
      } else this.decoding = false;
    }

    // throughput recente
    const cutoff = Date.now() - R.recentWindowMs;
    this.readTs = this.readTs.filter((t) => t >= cutoff);
    const perMin = Math.round(this.readTs.length / (R.recentWindowMs / 60_000));

    // drena eventos acumulados
    const reads = this.pendingReads;
    this.pendingReads = [];
    const passes = this.pendingPasses;
    this.pendingPasses = [];
    const decodeMs = this.pendingDecodeMs;
    this.pendingDecodeMs = null;
    return {
      reads,
      passes,
      perMin,
      passesCount: this.passesCount,
      boxesCount: this.boxesCount,
      ratePct: this.passesCount ? Math.round((this.boxesCount / this.passesCount) * 100) : 100,
      noReads: Math.max(0, this.passesCount - this.boxesCount),
      kind: this.kind,
      decodeMs,
    };
  }

  dispose(): void {
    /* o worker de decode é compartilhado; nada a liberar por instância */
  }
}
