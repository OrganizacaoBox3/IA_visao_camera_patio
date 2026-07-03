// F3 (ADR-009) — coco-ssd LAZY: tfjs + coco-ssd saem do BUNDLE PRINCIPAL e viram chunk async,
// carregado SÓ na primeira chamada de loadDetector() (fallback main-thread do detect.ts quando o
// worker falha; andaime "coco" do objects/detector enquanto o OWL-ViT carrega). O worker de
// detecção (detectWorker.ts) tem o próprio bundle e não passa por aqui. Tipos via `import type`
// (apagados na compilação — zero bytes no bundle). Contrato público INTACTO: loadDetector/
// Detector/Detection idênticos — só MUDA QUANDO o código carrega, não o comportamento.
import type * as cocoSsd from "@tensorflow-models/coco-ssd";

// Carregamento ÚNICO do modelo coco-ssd, compartilhado por todas as câmeras do dashboard.
let modelPromise: Promise<cocoSsd.ObjectDetection> | null = null;

export function loadDetector(): Promise<cocoSsd.ObjectDetection> {
  if (!modelPromise)
    modelPromise = (async () => {
      // tfjs primeiro (side effect: registra kernels/backends), depois o modelo — mesma ordem
      // dos imports estáticos antigos. Falha de rede fica cacheada na promise rejeitada, como
      // antes (cocoSsd.load também cacheava a rejeição).
      await import("@tensorflow/tfjs");
      const coco = await import("@tensorflow-models/coco-ssd");
      return coco.load({ base: "lite_mobilenet_v2" });
    })();
  return modelPromise;
}

export type Detector = cocoSsd.ObjectDetection;
export type Detection = cocoSsd.DetectedObject;
