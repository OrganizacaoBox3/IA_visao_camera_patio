// Processador — modo OBJETOS (contagem/identificação + presença por setor).
// Domínio puro: detecção (assíncrona no worker), contagem/matriz, heurística de carregamento,
// recorder (amostras 1s/emite 5s) e transições de presença com histerese. A view só desenha/painel.
import { APP_CONFIG } from "../config";
import {
  detectObjects,
  ensureObjectDetector,
  objectBackend,
  type ObjDetection,
  type ObjBackend,
} from "../objects/detector";
import { objClass } from "../objects/catalog";
import type { ObjSample, ObjectEvent } from "../report/store";
import type { FrameSource } from "../frame";
import type { Disposable } from "./types";

const OBJ_INTERVAL_MS = APP_CONFIG.objects.detectIntervalMs;
const PRESENCE_CONFIRM_MS = 1800;
// O "andaime" coco-ssd (enquanto o OWL-ViT carrega) roda na MAIN THREAD (detector.ts:93) e
// trava a UI. Sem tocar a config, afrouxamos a cadência APENAS quando o backend ainda é o
// andaime coco; já com OWL-ViT (worker) volta-se à cadência normal da config.
const COCO_SCAFFOLD_MIN_INTERVAL_MS = 1000;

export type ObjetosSetor = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  contains?: (nx: number, ny: number) => boolean;
};
export type ObjetosCtx = { frame: FrameSource; now: number };
export type ObjetosResult = {
  dets: ObjDetection[];
  counts: Record<string, number>;
  matrix: Record<string, Record<string, number>>; // setor → classe → contagem
  carregando: number;
  backend: ObjBackend;
  detectMs: number | null;
  samples: ObjSample[] | null; // a cada 5s
  events: ObjectEvent[]; // carregamento + entrada/saída
  alerts: string[]; // toasts de transição de presença
};

type Accum = {
  setor: string;
  classe: string;
  samples: number;
  countSum: number;
  peak: number;
  present: number;
};
type Presence = { confirmed: boolean; pending: boolean; since: number };

// sobreposição (fração da área da MENOR caixa coberta)
function overlap(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ix = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  return inter / Math.max(1e-6, Math.min(a[2] * a[3], b[2] * b[3]));
}

export class ObjetosProcessor implements Disposable {
  private dets: ObjDetection[] = [];
  private detecting = false;
  private lastDetAt = 0;
  private pendingDetectMs: number | null = null;
  private accum = new Map<string, Accum>();
  private presence = new Map<string, Presence>();
  private lastAccum = 0;
  private lastEmit = 0;
  private lastCargaEvt = 0;
  // Perfil "longo alcance" (opt-in POR CÂMERA — a frente C chama setLongRange conforme a config).
  // Default false = comportamento atual. Quando ligado, baixa o limiar de score na filtragem das
  // detecções de ocupação (longRange.objectScoreThreshold) p/ resgatar objetos distantes/pequenos.
  private longRange = false;

  constructor() {
    void ensureObjectDetector();
  }

  /**
   * Liga/desliga o perfil "longo alcance". OPT-IN por câmera: a frente C chama conforme a config da
   * câmera. (O tiling/minScore são aplicados na chamada de detectFrame pela frente C; aqui é só o
   * limiar de score/ocupação usado por este processador.)
   */
  setLongRange(on: boolean): void {
    this.longRange = on;
  }

  private zoneOf(setores: ObjetosSetor[], cx: number, cy: number): string {
    for (const z of setores)
      if (
        cx >= z.x &&
        cx <= z.x + z.w &&
        cy >= z.y &&
        cy <= z.y + z.h &&
        (!z.contains || z.contains(cx, cy))
      )
        return z.label;
    return setores[0]?.label ?? "Cena";
  }

  process(setores: ObjetosSetor[], classes: string[], ctx: ObjetosCtx): ObjetosResult {
    const f = ctx.frame,
      now = ctx.now;
    const events: ObjectEvent[] = [];
    const alerts: string[] = [];

    // detecção (assíncrona, throttled) — cadência maior enquanto o andaime coco roda na main thread
    const detInterval =
      objectBackend() === "coco"
        ? Math.max(OBJ_INTERVAL_MS, COCO_SCAFFOLD_MIN_INTERVAL_MS)
        : OBJ_INTERVAL_MS;
    if (!this.detecting && now - this.lastDetAt > detInterval) {
      this.lastDetAt = now;
      this.detecting = true;
      const t0 = performance.now();
      // Longo alcance: limiar de score mais baixo p/ não cortar objetos distantes (que pontuam menos).
      const scoreThr = this.longRange
        ? APP_CONFIG.detection.longRange.objectScoreThreshold
        : APP_CONFIG.detection.objectScoreThreshold;
      void detectObjects(f.el, f.w, f.h, classes, scoreThr)
        .then((res) => {
          this.dets = res;
          this.pendingDetectMs = performance.now() - t0;
        })
        .catch(() => {})
        .finally(() => {
          this.detecting = false;
        });
    }

    // contagem + matriz Setor×Classe (sobre a última detecção)
    const counts: Record<string, number> = {};
    const matrix: Record<string, Record<string, number>> = {};
    for (const s of setores) matrix[s.label] = {};
    for (const d of this.dets) {
      counts[d.key] = (counts[d.key] ?? 0) + 1;
      const z = this.zoneOf(setores, d.bbox[0] + d.bbox[2] / 2, d.bbox[1] + d.bbox[3] / 2);
      (matrix[z] ??= {})[d.key] = (matrix[z][d.key] ?? 0) + 1;
    }

    // heurística "pessoa carregando caixa"
    let carregando = 0,
      cargaSetor = "";
    const pessoas = this.dets.filter((d) => d.key === "pessoa"),
      caixas = this.dets.filter((d) => d.key === "caixa");
    for (const p of pessoas)
      for (const cx of caixas)
        if (overlap(p.bbox, cx.bbox) > 0.02) {
          carregando++;
          if (!cargaSetor)
            cargaSetor = this.zoneOf(setores, p.bbox[0] + p.bbox[2] / 2, p.bbox[1] + p.bbox[3] / 2);
          break;
        }
    if (carregando > 0 && now - this.lastCargaEvt > 4000) {
      this.lastCargaEvt = now;
      events.push({
        type: "carregamento",
        setor: cargaSetor || setores[0]?.label || "Cena",
        classe: "caixa",
        ts: Date.now(),
      });
    }

    // recorder + transições de presença (1 amostra/s)
    if (now - this.lastAccum > 1000) {
      this.lastAccum = now;
      const cur = new Map<string, number>();
      for (const d of this.dets) {
        const z = this.zoneOf(setores, d.bbox[0] + d.bbox[2] / 2, d.bbox[1] + d.bbox[3] / 2);
        const k = `${z}${d.key}`;
        cur.set(k, (cur.get(k) ?? 0) + 1);
      }
      for (const s of setores)
        for (const cl of classes) {
          const k = `${s.label}${cl}`;
          const n = cur.get(k) ?? 0;
          const a = this.accum.get(k) ?? {
            setor: s.label,
            classe: cl,
            samples: 0,
            countSum: 0,
            peak: 0,
            present: 0,
          };
          a.samples++;
          a.countSum += n;
          a.peak = Math.max(a.peak, n);
          if (n > 0) a.present++;
          this.accum.set(k, a);

          if (cl === "pessoa") continue; // presença de pessoa é ruidosa
          const present = n > 0;
          const st = this.presence.get(k);
          if (!st) {
            this.presence.set(k, { confirmed: present, pending: present, since: now });
            continue;
          }
          if (present !== st.pending) {
            st.pending = present;
            st.since = now;
          } else if (present !== st.confirmed && now - st.since >= PRESENCE_CONFIRM_MS) {
            st.confirmed = present;
            const nome = objClass(cl)?.label ?? cl,
              emoji = objClass(cl)?.emoji ?? "";
            events.push({
              type: present ? "entrada" : "saida",
              setor: s.label,
              classe: cl,
              ts: Date.now(),
            });
            alerts.push(`${emoji} ${nome} ${present ? "entrou em" : "saiu de"} ${s.label}`);
          }
        }
    }

    // emite amostras a cada 5s
    let samples: ObjSample[] | null = null;
    if (now - this.lastEmit > 5000) {
      this.lastEmit = now;
      const out = [...this.accum.values()].filter((a) => a.samples > 0);
      if (out.length) samples = out;
      this.accum.clear();
    }

    const detectMs = this.pendingDetectMs;
    this.pendingDetectMs = null;
    return {
      dets: this.dets,
      counts,
      matrix,
      carregando,
      backend: objectBackend(),
      detectMs,
      samples,
      events,
      alerts,
    };
  }

  dispose(): void {
    /* worker compartilhado; nada a liberar por instância */
  }
}
