import "@tensorflow/tfjs";
import * as cocoSsd from "@tensorflow-models/coco-ssd";

// Carregamento ÚNICO do modelo coco-ssd, compartilhado por todas as câmeras do dashboard.
let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;

export function loadDetector(): Promise<cocoSsd.ObjectDetection> {
  if (!modelPromise) modelPromise = cocoSsd.load({ base: "lite_mobilenet_v2" });
  return modelPromise;
}

export type Detector = cocoSsd.ObjectDetection;
export type Detection = cocoSsd.DetectedObject;
