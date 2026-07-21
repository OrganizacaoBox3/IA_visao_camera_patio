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

// Retry com backoff: a carga (fetch do .task + instanciação WASM) pode falhar transitoriamente
// (rede do CD, cold start do asset). 3 tentativas bastam; erro persistente é LOGADO com a causa
// real ANTES de subir — o chamador (processors/fadiga.ts) só rebaixa o estado da UI, e sem este
// log o diagnóstico em campo era impossível (o erro morria num catch silencioso).
const RETRY_DELAYS_MS = [500, 1000, 2000];
async function createWithRetry<T>(
  name: string,
  create: (delegate: "GPU" | "CPU") => Promise<T>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await createWithGpuFallback(name, create);
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_DELAYS_MS.length) {
        console.warn(
          `[fadiga] ${name}: carga falhou (tentativa ${attempt + 1}) — retry em ${RETRY_DELAYS_MS[attempt]}ms`,
          err,
        );
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      }
    }
  }
  console.error(`[fadiga] ${name}: modelo NÃO carregou após ${RETRY_DELAYS_MS.length + 1} tentativas`, lastErr);
  throw lastErr;
}

export async function createFaceLandmarker(): Promise<FaceLandmarker> {
  const vision = await fileset();
  return createWithRetry("FaceLandmarker", (delegate) =>
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
  return createWithRetry("HandLandmarker", (delegate) =>
    HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: APP_CONFIG.fadiga.handModelAssetUrl, delegate },
      runningMode: "VIDEO",
      // (P0 fluidez) 2→1: o caso de uso é o operador com o celular — UMA mão basta p/ o gesto e
      // p/ o boost adaptativo do celular (fadiga.ts usa a mão mais forte / qualquer interseção).
      // Metade do custo do HandLandmarker por inferência (66–90ms de cadência na câmera aberta).
      // TRADE-OFF DECLARADO: gesto simultâneo com as DUAS mãos deixa de ver a segunda (o pipeline
      // já usava só o sinal mais forte; `handCount` no HUD passa a exibir no máx. 1).
      numHands: 1,
    }),
  );
}
