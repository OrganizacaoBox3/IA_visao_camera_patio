// Carregamento dos modelos do modo Fadiga (MediaPipe Tasks Vision).
// FilesetResolver (wasm) é compartilhado; FaceLandmarker/HandLandmarker são criados POR instância
// (runningMode VIDEO mantém estado de timestamp interno — não dá p/ compartilhar entre câmeras).
import { FaceLandmarker, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";
import { APP_CONFIG } from "../config";

let filesetPromise: Promise<Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>> | null =
  null;
function fileset() {
  if (!filesetPromise)
    filesetPromise = FilesetResolver.forVisionTasks(APP_CONFIG.fadiga.mediapipeWasmUrl);
  return filesetPromise;
}

// Preferimos delegate GPU (WebGL): a inferência CPU/WASM é síncrona na main thread e causa
// jank a cada 66/90ms. Se a criação com GPU falhar (sem WebGL2, driver ruim, blacklist),
// caímos automaticamente para CPU — fadiga NUNCA pode quebrar por falta de GPU.
let gpuFallbackLogged = false;
async function createWithGpuFallback<T>(
  name: string,
  create: (delegate: "GPU" | "CPU") => Promise<T>,
): Promise<T> {
  try {
    return await create("GPU");
  } catch (err) {
    if (!gpuFallbackLogged) {
      gpuFallbackLogged = true;
      console.warn(
        `[fadiga] MediaPipe ${name}: delegate GPU indisponível; usando CPU (WASM).`,
        err,
      );
    }
    return create("CPU");
  }
}

export async function createFaceLandmarker(): Promise<FaceLandmarker> {
  const vision = await fileset();
  return createWithGpuFallback("FaceLandmarker", (delegate) =>
    FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: APP_CONFIG.fadiga.faceModelAssetUrl, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }),
  );
}

export async function createHandLandmarker(): Promise<HandLandmarker> {
  const vision = await fileset();
  return createWithGpuFallback("HandLandmarker", (delegate) =>
    HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: APP_CONFIG.fadiga.handModelAssetUrl, delegate },
      runningMode: "VIDEO",
      numHands: 2,
    }),
  );
}
