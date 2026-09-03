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
import { assignZoneByOverlap, DEFAULT_OCCUPANCY_TOLERANCE_MS } from "../zones";
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
  // Lotação (contagem de pessoas): alvo opcional de nº de pessoas. Ausente = alerta desligado.
  targetOccupancy?: number;
  occupancyToleranceMs?: number;
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
  // Lotação fora do alvo por ≥ occupancyToleranceMs (setor com targetOccupancy configurado).
  // Separado de `alerts` de propósito: este vai pro canal de alarme (WhatsApp/Andon) via
  // prefixo "⚠" que a view acrescenta — entrada/saída de presença NÃO deve virar alarme.
  occupancyAlerts: { setor: string; count: number; target: number }[];
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
  // Lotação: quando a contagem de pessoas do setor está fora do alvo, desde quando (`since`) e
  // se já disparamos o alarme dessa deviação (`alerted`, evita repetir a cada tick enquanto
  // persiste — só dispara de novo depois de voltar ao alvo e desviar de novo).
  private occupancyState = new Map<string, { since: number; alerted: boolean }>();
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

  // Setor do objeto por SOBREPOSIÇÃO (zones.assignZoneByOverlap — SÓ modo Objetos, decisão de
  // produto: basta parte da caixa estar na área, não o centro — assignZone/centro-in-polygon é
  // estrito demais e sub-contava gente na borda). Com setores SOBREPOSTOS, desempate por maior
  // interseção bbox∩setor, depois menor área. Fora de TODOS os setores → null: NÃO cai mais no
  // 1º setor por fallback (esse fallback fazia toda detecção do frame contar em qualquer setor
  // chamado com uma lista de 1 elemento — o padrão real de chamada deste processador — anulando
  // o filtro geométrico por completo; era o bug por trás da contagem "imprecisa" relatada).
  private zoneOf(
    setores: ObjetosSetor[],
    bbox: readonly [number, number, number, number],
  ): string | null {
    const z = assignZoneByOverlap(setores, bbox, (s) => s.contains);
    return z?.label ?? null;
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
      // Piso de score do OWL-ViT — knobs de `objects`, NÃO os de `detection` (esses são do
      // COCO-SSD, escala 0.5-0.95; o zero-shot pontua bem mais baixo e o 0.5 emprestado
      // descartava pessoa real em cena interna: ver objects.minScore no config, com o medido).
      // Longo alcance: piso ainda menor p/ não cortar objeto distante (que pontua menos).
      const scoreThr = this.longRange
        ? APP_CONFIG.objects.minScoreLongRange
        : APP_CONFIG.objects.minScore;
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

    // contagem + matriz Setor×Classe (sobre a última detecção) — SÓ o que está (parcialmente)
    // dentro de algum setor conta; fora de todos → excluído (não vira contagem de setor nenhum).
    const counts: Record<string, number> = {};
    const matrix: Record<string, Record<string, number>> = {};
    for (const s of setores) matrix[s.label] = {};
    for (const d of this.dets) {
      const z = this.zoneOf(setores, d.bbox);
      if (z == null) continue;
      counts[d.key] = (counts[d.key] ?? 0) + 1;
      (matrix[z] ??= {})[d.key] = (matrix[z][d.key] ?? 0) + 1;
    }

    // Lotação: setor com targetOccupancy configurado e contagem de "pessoa" fora do alvo por
    // ≥ occupancyToleranceMs dispara UMA vez (não repete a cada tick enquanto persiste — só
    // depois de voltar ao alvo e desviar de novo). Setor sem targetOccupancy nunca entra aqui.
    const occupancyAlerts: ObjetosResult["occupancyAlerts"] = [];
    for (const s of setores) {
      if (s.targetOccupancy == null) {
        this.occupancyState.delete(s.id);
        continue;
      }
      const count = matrix[s.label]?.pessoa ?? 0;
      if (count === s.targetOccupancy) {
        this.occupancyState.delete(s.id);
        continue;
      }
      const tolMs = s.occupancyToleranceMs ?? DEFAULT_OCCUPANCY_TOLERANCE_MS;
      const st = this.occupancyState.get(s.id);
      if (!st) {
        this.occupancyState.set(s.id, { since: now, alerted: false });
      } else if (!st.alerted && now - st.since >= tolMs) {
        st.alerted = true;
        occupancyAlerts.push({ setor: s.label, count, target: s.targetOccupancy });
      }
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
          if (!cargaSetor) cargaSetor = this.zoneOf(setores, p.bbox) ?? "";
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
        const z = this.zoneOf(setores, d.bbox);
        if (z == null) continue;
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
      occupancyAlerts,
    };
  }

  dispose(): void {
    /* worker compartilhado; nada a liberar por instância */
  }
}
