/// <reference lib="webworker" />
// Worker de detecção ZERO-SHOT (OWL-ViT via transformers.js) — roda FORA da main thread.
// Detecta objetos por TEXTO (candidate labels), então a "lista de objetos" é só configuração.
// Recebe pixels RGBA (transferable) + rótulos; devolve [{label, score, box}].
import { pipeline, RawImage, env } from "@xenova/transformers";

// Usa modelos remotos (HuggingFace CDN) — cacheados pelo navegador após o 1º download.
env.allowLocalModels = false;

type InitMsg = { type: "init"; model: string };
type DetMsg = { type: "detect"; id: number; rgba: ArrayBuffer; w: number; h: number; labels: string[]; threshold: number };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let detector: any = null;

self.onmessage = async (e: MessageEvent<InitMsg | DetMsg>) => {
  const m = e.data;

  if (m.type === "init") {
    try {
      detector = await pipeline("zero-shot-object-detection", m.model);
      (self as unknown as Worker).postMessage({ type: "ready" });
    } catch (err) {
      (self as unknown as Worker).postMessage({ type: "error", error: String(err) });
    }
    return;
  }

  if (m.type === "detect") {
    if (!detector) { (self as unknown as Worker).postMessage({ type: "result", id: m.id, dets: [] }); return; }
    try {
      const raw = new RawImage(new Uint8ClampedArray(m.rgba), m.w, m.h, 4).rgb();
      const out = await detector(raw, m.labels, { threshold: m.threshold, topk: 50 });
      // out: [{ score, label, box:{xmin,ymin,xmax,ymax} }]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dets = (out as any[]).map((o) => ({ label: o.label, score: o.score, box: o.box }));
      (self as unknown as Worker).postMessage({ type: "result", id: m.id, dets });
    } catch {
      (self as unknown as Worker).postMessage({ type: "result", id: m.id, dets: [] });
    }
  }
};
