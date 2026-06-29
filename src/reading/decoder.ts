// Decodificador de código de barras p/ o modo Leitura.
// BarcodeDetector NATIVO (Chrome/Edge — assíncrono, não bloqueia) quando disponível;
// senão, ZXing num WEB WORKER (lazy) — a decodificação pesada roda FORA da main thread,
// mantendo o feed fluido. ZXing não entra no bundle principal (fica no chunk do worker).

import { APP_CONFIG } from "../config";

export type DecodeResult = { code: string; format: string };
export type DecoderKind = "nativo" | "zxing" | "indisponível" | "inicializando";

type NativeDetector = {
  detect: (src: CanvasImageSource) => Promise<Array<{ rawValue: string; format: string }>>;
};

let kind: DecoderKind = "inicializando";
let nativeDetector: NativeDetector | null = null;
let worker: Worker | null = null;
let reqId = 0;
const pending = new Map<number, (r: DecodeResult | null) => void>();
let initPromise: Promise<void> | null = null;

export function decoderKind(): DecoderKind {
  return kind;
}

async function init(): Promise<void> {
  // 1) BarcodeDetector nativo (assíncrono — sem bloqueio de main thread)
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const BD = (globalThis as any).BarcodeDetector;
    if (BD) {
      let formats: string[] = APP_CONFIG.reading.formats;
      try {
        const supported: string[] = await BD.getSupportedFormats?.();
        if (Array.isArray(supported) && supported.length)
          formats = formats.filter((f) => supported.includes(f));
      } catch {
        /* alguns navegadores não expõem getSupportedFormats */
      }
      nativeDetector = new BD(formats.length ? { formats } : undefined) as NativeDetector;
      kind = "nativo";
      return;
    }
  } catch {
    nativeDetector = null;
  }

  // 2) Fallback ZXing em WORKER (a lib fica no chunk do worker, fora do bundle de atividade).
  try {
    worker = new Worker(new URL("./zxingWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; code: string | null; format: string }>) => {
      const cb = pending.get(e.data.id);
      if (cb) {
        pending.delete(e.data.id);
        cb(e.data.code ? { code: e.data.code, format: e.data.format } : null);
      }
    };
    worker.onerror = () => {
      worker = null;
      kind = "indisponível";
    };
    kind = "zxing";
    return;
  } catch {
    worker = null;
  }

  kind = "indisponível";
}

export function ensureDecoder(): Promise<void> {
  if (!initPromise) initPromise = init();
  return initPromise;
}

// Decodifica a partir de um canvas (idealmente já recortado no ROI). Retorna o 1º código ou null.
export async function decodeFromCanvas(canvas: HTMLCanvasElement): Promise<DecodeResult | null> {
  if (kind === "inicializando") await ensureDecoder();

  if (nativeDetector) {
    try {
      const found = await nativeDetector.detect(canvas);
      if (found && found.length) return { code: found[0].rawValue, format: found[0].format };
    } catch {
      /* frame ruim/ocupado — ignora */
    }
    return null;
  }

  if (worker) {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const { width: w, height: h } = canvas;
    if (!w || !h) return null;
    const img = ctx.getImageData(0, 0, w, h);
    const id = ++reqId;
    return new Promise<DecodeResult | null>((resolve) => {
      pending.set(id, resolve);
      // transfere o buffer (zero-cópia) → o worker computa luminância e decodifica
      worker!.postMessage({ id, rgba: img.data.buffer, w, h }, [img.data.buffer]);
    });
  }

  return null;
}
