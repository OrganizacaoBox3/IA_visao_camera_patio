// Detector de objetos do modo "Objetos / Contagem".
// Primário: ZERO-SHOT OWL-ViT em WORKER (transformers.js) — detecta caixa/empilhadeira/palete
//   por prompts de texto, sem treinar. Pesado → roda fora da main thread, cadência baixa.
// Enquanto o OWL-ViT carrega (download do modelo na 1ª vez), usa coco-ssd como ANDAIME
//   (só "pessoa" das nossas classes) para o painel não ficar vazio.

import { APP_CONFIG } from "../config";
import { loadDetector } from "../vision/model";
import { OBJECT_CATALOG, keyForCoco } from "./catalog";

export type ObjDetection = { key: string; score: number; bbox: [number, number, number, number] }; // bbox 0..1
export type ObjBackend = "carregando" | "coco" | "owlvit" | "indisponível";

let backend: ObjBackend = "carregando";
export function objectBackend(): ObjBackend {
  return backend;
}

// ── coco-ssd (andaime) ──
let cocoReady = false;

// ── OWL-ViT (worker) ──
let worker: Worker | null = null;
let owlvitReady = false;
// LATCH de falha (mesmo padrão de vision/detect.ts): erro no worker marca falha PERMANENTE —
// sem o latch, cada ensureObjectDetector() recriava o worker e o download/init do modelo
// recomeçava em loop. Falhou uma vez → fica no coco (ou "indisponível" se o coco também falhar).
let workerFailed = false;
let reqId = 0;
type WorkerDet = {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
};
const pending = new Map<number, (d: WorkerDet[]) => void>();
let rasterCanvas: HTMLCanvasElement | null = null;

function initWorker() {
  try {
    worker = new Worker(new URL("./owlvitWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ type: string; id?: number; dets?: WorkerDet[] }>) => {
      const m = e.data;
      if (m.type === "ready") {
        owlvitReady = true;
        backend = "owlvit";
        return;
      }
      if (m.type === "error") {
        worker = null;
        workerFailed = true; // permanente: não recria em loop; coco segue como fallback
        if (!owlvitReady && !cocoReady) backend = "indisponível";
        return;
      }
      if (m.type === "result" && typeof m.id === "number") {
        const cb = pending.get(m.id);
        if (cb) {
          pending.delete(m.id);
          cb(m.dets ?? []);
        }
      }
    };
    worker.onerror = () => {
      worker = null;
      workerFailed = true;
      if (!owlvitReady && !cocoReady) backend = "indisponível";
    };
    worker.postMessage({ type: "init", model: APP_CONFIG.objects.model });
  } catch {
    worker = null;
    workerFailed = true;
  }
}

export async function ensureObjectDetector(): Promise<void> {
  if (!worker && !owlvitReady && !workerFailed) initWorker(); // dispara o carregamento do OWL-ViT (1×)
  try {
    await loadDetector();
    cocoReady = true;
    if (backend === "carregando") backend = "coco";
  } catch {
    if (!owlvitReady) backend = "indisponível";
  }
}

// candidate labels p/ o OWL-ViT a partir das classes selecionadas + mapa label→chave
function labelsFor(classes: string[]): { labels: string[]; toKey: Map<string, string> } {
  const labels: string[] = [];
  const toKey = new Map<string, string>();
  for (const c of OBJECT_CATALOG) {
    if (!classes.includes(c.key)) continue;
    for (const p of c.prompts) {
      if (!toKey.has(p)) {
        labels.push(p);
        toKey.set(p, c.key);
      }
    }
  }
  return { labels, toKey };
}

export async function detectObjects(
  el: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement | ImageBitmap,
  w: number,
  h: number,
  classes: string[],
  minScore: number,
): Promise<ObjDetection[]> {
  if (backend === "carregando") await ensureObjectDetector();

  // OWL-ViT (preferido): rasteriza o frame e manda os pixels p/ o worker
  if (owlvitReady && worker) {
    const { labels, toKey } = labelsFor(classes);
    if (!labels.length) return [];
    const pw = Math.min(w, APP_CONFIG.objects.procWidth);
    const ph = Math.max(1, Math.round((pw * h) / w));
    if (!rasterCanvas) rasterCanvas = document.createElement("canvas");
    if (rasterCanvas.width !== pw || rasterCanvas.height !== ph) {
      rasterCanvas.width = pw;
      rasterCanvas.height = ph;
    }
    const ctx = rasterCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return [];
    ctx.drawImage(el, 0, 0, pw, ph);
    const img = ctx.getImageData(0, 0, pw, ph);
    const id = ++reqId;
    const dets = await new Promise<WorkerDet[]>((resolve) => {
      pending.set(id, resolve);
      worker!.postMessage(
        {
          type: "detect",
          id,
          rgba: img.data.buffer,
          w: pw,
          h: ph,
          labels,
          threshold: APP_CONFIG.objects.threshold,
        },
        [img.data.buffer],
      );
    });
    const out: ObjDetection[] = [];
    for (const d of dets) {
      const key = toKey.get(d.label);
      if (!key) continue;
      const x = d.box.xmin / pw,
        y = d.box.ymin / ph;
      out.push({
        key,
        score: d.score,
        bbox: [x, y, (d.box.xmax - d.box.xmin) / pw, (d.box.ymax - d.box.ymin) / ph],
      });
    }
    return out;
  }

  // Andaime coco-ssd enquanto o OWL-ViT não está pronto (só classes COCO que temos)
  if (cocoReady) {
    const model = await loadDetector();
    const res = await model.detect(el as HTMLCanvasElement); // tfjs aceita ImageBitmap em runtime
    const out: ObjDetection[] = [];
    for (const d of res) {
      if (d.score < minScore) continue;
      const k = keyForCoco(d.class);
      if (!k || !classes.includes(k)) continue;
      out.push({
        key: k,
        score: d.score,
        bbox: [d.bbox[0] / w, d.bbox[1] / h, d.bbox[2] / w, d.bbox[3] / h],
      });
    }
    return out;
  }

  return [];
}
