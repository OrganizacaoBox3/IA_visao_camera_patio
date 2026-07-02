/// <reference lib="webworker" />
// Worker de detecção de objetos (coco-ssd via tfjs) — roda FORA da main thread.
// A inferência do coco-ssd é o gargalo que travava a UI quando rodava na main thread,
// ainda mais com N câmeras disputando a mesma GPU/thread. Aqui ela roda no worker
// (backend WebGL via OffscreenCanvas) e é naturalmente SERIALIZADA entre câmeras.
//
// Protocolo: recebe UM bloco (tile) + params em duas formas ADITIVAS —
//   • "detect-bitmap" (preferido, plano-performance-bit 3.1): ImageBitmap TRANSFERIDO (crop+resize
//     feitos fora da main via createImageBitmap; zero readback GPU→CPU na main). Ownership do
//     bitmap é DESTE worker: fecha (close()) após o detect, inclusive em erro.
//   • "detect" (fallback de compatibilidade): pixels RGBA (ArrayBuffer transferível).
// Ambos devolvem [{cls, score, bbox}] com bbox NORMALIZADO (0..1) ao próprio bloco. O cliente
// na main thread faz o tiling (recorte), remapeia p/ o frame inteiro e funde com NMS.
import * as tf from "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

type Base = "mobilenet_v1" | "mobilenet_v2" | "lite_mobilenet_v2";
type InitMsg = { type: "init"; base: Base };
type DetMsg = {
  type: "detect";
  id: number;
  rgba: ArrayBuffer;
  w: number;
  h: number;
  maxBoxes: number;
  minScore: number;
};
type DetBitmapMsg = {
  type: "detect-bitmap";
  id: number;
  bitmap: ImageBitmap; // transferido da main — ownership é do worker (fechar após o uso)
  maxBoxes: number;
  minScore: number;
};

let model: cocoSsd.ObjectDetection | null = null;
let loadP: Promise<void> | null = null;

function ensure(base: Base): Promise<void> {
  if (!loadP)
    loadP = cocoSsd.load({ base }).then((m) => {
      model = m;
    });
  return loadP;
}

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

self.onmessage = async (e: MessageEvent<InitMsg | DetMsg | DetBitmapMsg>) => {
  const m = e.data;

  if (m.type === "init") {
    try {
      await ensure(m.base);
      // Telemetria de backend (plano-performance-bit 1.9): o tfjs cai SILENCIOSAMENTE p/ CPU
      // quando WebGL não está disponível no worker — ordem de magnitude mais lento. Informa o
      // backend real no `ready` p/ o cliente alertar/expor (fallback invisível vira visível).
      await tf.ready();
      post({ type: "ready", backend: tf.getBackend() });
    } catch (err) {
      post({ type: "error", error: String(err) });
    }
    return;
  }

  if (m.type === "detect-bitmap") {
    const bmp = m.bitmap;
    try {
      if (!model) {
        post({ type: "result", id: m.id, dets: [] });
        return; // finally fecha o bitmap
      }
      const w = bmp.width,
        h = bmp.height;
      // O type de coco-ssd.detect() não lista ImageBitmap, mas em runtime ele delega a
      // tf.browser.fromPixels, que ACEITA ImageBitmap — cast consciente (zero cópia RGBA aqui).
      const res = await model.detect(bmp as unknown as ImageData, m.maxBoxes, m.minScore);
      const dets = res.map((d) => ({
        cls: d.class,
        score: d.score,
        bbox: [d.bbox[0] / w, d.bbox[1] / h, d.bbox[2] / w, d.bbox[3] / h] as [
          number,
          number,
          number,
          number,
        ],
      }));
      post({ type: "result", id: m.id, dets });
    } catch {
      // Bitmap inválido/fechado no meio ou erro do modelo → tile sem resultado (não crasha a rodada).
      post({ type: "result", id: m.id, dets: [] });
    } finally {
      // Transferido = ownership do worker: fechar SEMPRE (sucesso, erro E model ausente), senão o
      // backing store (potencialmente GPU) vaza a cada tile.
      try {
        bmp.close();
      } catch {
        /* já fechado */
      }
    }
    return;
  }

  if (m.type === "detect") {
    if (!model) {
      post({ type: "result", id: m.id, dets: [] });
      return;
    }
    try {
      const imgData = new ImageData(new Uint8ClampedArray(m.rgba), m.w, m.h);
      const res = await model.detect(imgData, m.maxBoxes, m.minScore);
      const dets = res.map((d) => ({
        cls: d.class,
        score: d.score,
        bbox: [d.bbox[0] / m.w, d.bbox[1] / m.h, d.bbox[2] / m.w, d.bbox[3] / m.h] as [
          number,
          number,
          number,
          number,
        ],
      }));
      post({ type: "result", id: m.id, dets });
    } catch {
      post({ type: "result", id: m.id, dets: [] });
    }
  }
};
