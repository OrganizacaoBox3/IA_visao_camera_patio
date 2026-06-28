// Carregamento dos modelos do modo Fadiga (MediaPipe Tasks Vision).
// FilesetResolver (wasm) é compartilhado; FaceLandmarker/HandLandmarker são criados POR instância
// (runningMode VIDEO mantém estado de timestamp interno — não dá p/ compartilhar entre câmeras).
import { FaceLandmarker, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { APP_CONFIG } from "../config";

let filesetPromise: Promise<Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>> | null = null;
function fileset() {
  if (!filesetPromise) filesetPromise = FilesetResolver.forVisionTasks(APP_CONFIG.fadiga.mediapipeWasmUrl);
  return filesetPromise;
}

export async function createFaceLandmarker(): Promise<FaceLandmarker> {
  const vision = await fileset();
  return FaceLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: APP_CONFIG.fadiga.faceModelAssetUrl },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: false,
    outputFacialTransformationMatrixes: false,
  });
}

export async function createHandLandmarker(): Promise<HandLandmarker> {
  const vision = await fileset();
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: APP_CONFIG.fadiga.handModelAssetUrl },
    runningMode: "VIDEO",
    numHands: 2,
  });
}
