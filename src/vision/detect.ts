// Cliente de detecção de objetos (coco-ssd). Orquestra o WORKER (detectWorker.ts) e o TILING:
//   - rasteriza cada bloco do frame na main thread (barato), manda os pixels ao worker (transferível);
//   - remapeia as caixas do bloco → frame inteiro e funde duplicatas das bordas com NMS;
//   - FALLBACK: se o worker não inicia (sem OffscreenCanvas/WebGL no worker), detecta na main thread
//     (sem tiling, p/ não travar) via o detector compartilhado do vision/model.
import { APP_CONFIG } from "../config";
import { loadDetector, type Detection } from "./model";

const C = APP_CONFIG.detection;

type WorkerDet = { cls: string; score: number; bbox: [number, number, number, number] }; // bbox 0..1 no bloco

// ── worker (singleton) ───────────────────────────────────────────────────────
let worker: Worker | null = null;
let workerReady = false;
let workerFailed = false;
let reqId = 0;
const pending = new Map<number, (d: WorkerDet[]) => void>();

// Aquece o detector de main thread SOMENTE quando o worker falha (P5: evita carregar
// dois modelos coco — worker mobilenet_v2 + main lite_mobilenet_v2 — no caminho feliz).
function warmFallback(): void {
  void loadDetector().catch(() => {});
}

export function ensureDetectClient(): void {
  if (worker || workerFailed) return;
  try {
    worker = new Worker(new URL("./detectWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ type: string; id?: number; dets?: WorkerDet[] }>) => {
      const m = e.data;
      if (m.type === "ready") {
        workerReady = true;
        return;
      }
      if (m.type === "error") {
        worker = null;
        workerFailed = true;
        warmFallback();
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
      warmFallback();
    };
    worker.postMessage({ type: "init", base: C.base });
  } catch {
    worker = null;
    workerFailed = true;
    warmFallback();
  }
}

export function detectReady(): boolean {
  return workerReady || workerFailed;
}

function detectTile(
  rgba: ArrayBuffer,
  w: number,
  h: number,
  maxBoxes: number,
  minScore: number,
): Promise<WorkerDet[]> {
  const id = ++reqId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker!.postMessage({ type: "detect", id, rgba, w, h, maxBoxes, minScore }, [rgba]);
  });
}

// ── geometria do tiling (frações 0..1 do frame) ───────────────────────────────
type TileSpec = { cols: number; rows: number; overlap: number };
type Tile = { x0: number; y0: number; x1: number; y1: number };
// Semântica do grid (perfil LONGO ALCANCE):
//   • `optTiles` (opts.tiles) TEM PRECEDÊNCIA e aplica o grid MESMO com `tiled === false` — é o que
//     permite ligar tiling nas câmeras da GRADE de longo alcance (hoje só a câmera aberta faz tiling).
//   • Sem `optTiles`: comportamento atual — grade `C.tiles` só quando `tiled`; single-shot caso contrário.
function tileGrid(tiled: boolean, optTiles?: TileSpec): Tile[] {
  const grid: TileSpec = optTiles ?? (tiled ? C.tiles : { cols: 1, rows: 1, overlap: C.tiles.overlap });
  const cols = grid.cols,
    rows = grid.rows,
    o = grid.overlap;
  if (cols <= 1 && rows <= 1) return [{ x0: 0, y0: 0, x1: 1, y1: 1 }];
  const tw = 1 / cols,
    th = 1 / rows,
    out: Tile[] = [];
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      out.push({
        x0: clamp(i * tw - o * tw),
        y0: clamp(j * th - o * th),
        x1: clamp((i + 1) * tw + o * tw),
        y1: clamp((j + 1) * th + o * th),
      });
    }
  return out;
}

// ── NMS por classe (entrada/saída normalizadas ao frame) ──────────────────────
type NormDet = { cls: string; score: number; bbox: [number, number, number, number] };
function iou(a: [number, number, number, number], b: [number, number, number, number]): number {
  const ax2 = a[0] + a[2],
    ay2 = a[1] + a[3],
    bx2 = b[0] + b[2],
    by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  if (inter <= 0) return 0;
  const ua = a[2] * a[3] + b[2] * b[3] - inter;
  return ua > 0 ? inter / ua : 0;
}
function nms(dets: NormDet[], thr: number): NormDet[] {
  const byClass = new Map<string, NormDet[]>();
  for (const d of dets) {
    const arr = byClass.get(d.cls) ?? [];
    arr.push(d);
    byClass.set(d.cls, arr);
  }
  const kept: NormDet[] = [];
  for (const arr of byClass.values()) {
    arr.sort((a, b) => b.score - a.score);
    const sel: NormDet[] = [];
    for (const d of arr) {
      if (sel.every((s) => iou(s.bbox, d.bbox) < thr)) sel.push(d);
    }
    kept.push(...sel);
  }
  return kept;
}

// ── canvas de rasterização (reuso; draw→getImageData é síncrono, seguro entre câmeras) ──
let scratch: HTMLCanvasElement | null = null;
function rasterize(
  el: CanvasImageSource,
  nativeW: number,
  nativeH: number,
  t: Tile,
  tileWidth: number,
): { rgba: ArrayBuffer; w: number; h: number } | null {
  const sx = t.x0 * nativeW,
    sy = t.y0 * nativeH,
    sw = Math.max(1, (t.x1 - t.x0) * nativeW),
    sh = Math.max(1, (t.y1 - t.y0) * nativeH);
  const dw = Math.min(tileWidth, Math.round(sw)),
    dh = Math.max(1, Math.round((dw * sh) / sw));
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== dw || scratch.height !== dh) {
    scratch.width = dw;
    scratch.height = dh;
  }
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(el, sx, sy, sw, sh, 0, 0, dw, dh);
  const img = ctx.getImageData(0, 0, dw, dh);
  return { rgba: img.data.buffer, w: dw, h: dh };
}

// Opções OPT-IN por chamada (perfil LONGO ALCANCE — ver `config.detection.longRange`).
// Ausente → tudo idêntico ao comportamento atual (retrocompatível). Frentes B/C montam este `opts`
// a partir de `APP_CONFIG.detection.longRange` quando a câmera está no perfil panorâmica.
export type DetectFrameOpts = {
  tiles?: TileSpec; // grade a aplicar; tem precedência sobre `tiled` (liga tiling na grade tb)
  tileWidth?: number; // px por bloco enviado ao modelo (default C.detectTileWidth)
  minScore?: number; // limiar BRUTO do coco (default C.minScore)
  maxBoxes?: number; // teto de detecções por inferência (default C.maxBoxes)
};

// Detecta objetos no frame. `tiled` liga o grid (câmera aberta); tiles do mosaico usam single-shot.
// `opts` (opt-in, perfil longo alcance): `opts.tiles` aplica o grid MESMO com `tiled === false`
// (tiling nas câmeras da grade), e sobrescreve tileWidth/minScore/maxBoxes. Sem `opts`, idêntico a hoje.
// Retorna Detection[] com bbox em PIXELS do frame nativo (compatível com o pipeline existente).
export async function detectFrame(
  el: CanvasImageSource,
  nativeW: number,
  nativeH: number,
  tiled: boolean,
  opts?: DetectFrameOpts,
): Promise<Detection[]> {
  const tileWidth = opts?.tileWidth ?? C.detectTileWidth;
  const minScore = opts?.minScore ?? C.minScore;
  const maxBoxes = opts?.maxBoxes ?? C.maxBoxes;

  // Fallback main thread: sem tiling (evita bloquear), só limiar/maxBoxes afinados.
  if (!workerReady || !worker) {
    if (!workerFailed) return []; // ainda carregando o worker; não cai pro main thread à toa
    try {
      const model = await loadDetector();
      return await model.detect(el as HTMLCanvasElement, maxBoxes, minScore);
    } catch {
      return [];
    }
  }

  const tiles = tileGrid(tiled, opts?.tiles);
  const raster = tiles.map((t) => ({ t, r: rasterize(el, nativeW, nativeH, t, tileWidth) }));
  const results = await Promise.all(
    raster.map(({ r }) =>
      r ? detectTile(r.rgba, r.w, r.h, maxBoxes, minScore) : Promise.resolve([] as WorkerDet[]),
    ),
  );

  // remapeia cada caixa do bloco → fração do frame inteiro
  const all: NormDet[] = [];
  results.forEach((dets, idx) => {
    const t = raster[idx].t,
      tw = t.x1 - t.x0,
      th = t.y1 - t.y0;
    for (const d of dets)
      all.push({
        cls: d.cls,
        score: d.score,
        bbox: [t.x0 + d.bbox[0] * tw, t.y0 + d.bbox[1] * th, d.bbox[2] * tw, d.bbox[3] * th],
      });
  });

  // NMS sempre que houver >1 bloco (funde duplicatas nas bordas) — inclui o caso longo-alcance-na-grade,
  // em que `tiled` pode ser false mas `opts.tiles` gerou vários blocos.
  const merged = tiles.length > 1 ? nms(all, C.nmsIoU) : all;
  return merged.map((d) => ({
    class: d.cls,
    score: d.score,
    bbox: [d.bbox[0] * nativeW, d.bbox[1] * nativeH, d.bbox[2] * nativeW, d.bbox[3] * nativeH] as [
      number,
      number,
      number,
      number,
    ],
  }));
}
