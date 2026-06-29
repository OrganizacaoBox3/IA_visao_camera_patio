/// <reference lib="webworker" />
// Worker de detecção de objetos (coco-ssd via tfjs) — roda FORA da main thread.
// A inferência do coco-ssd é o gargalo que travava a UI quando rodava na main thread,
// ainda mais com N câmeras disputando a mesma GPU/thread. Aqui ela roda no worker
// (backend WebGL via OffscreenCanvas) e é naturalmente SERIALIZADA entre câmeras.
//
// Protocolo: recebe pixels RGBA (ImageData transferível) de UM bloco (tile) + params;
// devolve [{cls, score, bbox}] com bbox NORMALIZADO (0..1) ao próprio bloco. O cliente
// na main thread faz o tiling (recorte), remapeia p/ o frame inteiro e funde com NMS.
import "@tensorflow/tfjs";
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

self.onmessage = async (e: MessageEvent<InitMsg | DetMsg>) => {
  const m = e.data;

  if (m.type === "init") {
    try {
      await ensure(m.base);
      post({ type: "ready" });
    } catch (err) {
      post({ type: "error", error: String(err) });
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
