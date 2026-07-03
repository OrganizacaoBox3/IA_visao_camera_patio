// Cliente de detecção de objetos (coco-ssd). Orquestra o WORKER (detectWorker.ts) e o TILING:
//   - recorta cada bloco do frame via createImageBitmap (crop+downscale FORA da main no Chrome) e
//     TRANSFERE o ImageBitmap ao worker — zero drawImage+getImageData (readback GPU→CPU) na main
//     (plano-performance-bit 3.1);
//   - FALLBACK de compatibilidade: browser sem createImageBitmap(crop+resize) → rasterize atual
//     (canvas 2D + getImageData, pixels RGBA transferíveis) — feature-detect 1×, não por chamada;
//   - remapeia as caixas do bloco → frame inteiro e funde duplicatas das bordas com NMS;
//   - FALLBACK: se o worker não inicia (sem OffscreenCanvas/WebGL no worker), detecta na main thread
//     (sem tiling, p/ não travar) via o detector compartilhado do vision/model — que desde a F3
//     (ADR-009) carrega tfjs/coco-ssd por import() DINÂMICO: o custo só é pago se este fallback
//     (ou o andaime coco do objects/detector) rodar de fato; o bundle principal fica sem tfjs.
import { APP_CONFIG } from "../config";
import { loadDetector, type Detection } from "./model";
import { requestInference, type InferencePriority } from "./scheduler";
import { suppressDuplicates, type NormDet } from "./nms";

const C = APP_CONFIG.detection;

type WorkerDet = { cls: string; score: number; bbox: [number, number, number, number] }; // bbox 0..1 no bloco

// ── worker (singleton) ───────────────────────────────────────────────────────
let worker: Worker | null = null;
let workerReady = false;
let workerFailed = false;
let reqId = 0;
const pending = new Map<number, (d: WorkerDet[]) => void>();

// Backend do tfjs DENTRO do worker (plano-performance-bit 1.9). `null` = worker ainda não pronto
// ou caminho de fallback main-thread (workerFailed). Exposto p/ telemetria futura.
let detectBackend: string | null = null;

export function getDetectBackend(): string | null {
  return detectBackend;
}

// Aquece o detector de main thread SOMENTE quando o worker falha (P5: evita carregar
// dois modelos coco — worker mobilenet_v2 + main lite_mobilenet_v2 — no caminho feliz).
// F3: é aqui que o chunk async tfjs+coco-ssd é baixado (loadDetector lazy) — nunca antes.
function warmFallback(): void {
  void loadDetector().catch(() => {});
}

export function ensureDetectClient(): void {
  if (worker || workerFailed) return;
  probeBitmapPath();
  try {
    worker = new Worker(new URL("./detectWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (
      e: MessageEvent<{ type: string; id?: number; dets?: WorkerDet[]; backend?: string }>,
    ) => {
      const m = e.data;
      if (m.type === "ready") {
        workerReady = true;
        detectBackend = m.backend ?? null;
        // Fallback silencioso do tfjs p/ CPU no worker (sem WebGL) é o modo catastrófico:
        // mesma API, ~10× mais lento. Alerta 1× p/ ficar visível no console.
        if (detectBackend === "cpu")
          console.warn(
            "[detect] tfjs no worker caiu para backend CPU — detecção em CPU é uma ordem de " +
              "magnitude mais lenta; verifique o suporte a WebGL/OffscreenCanvas no worker.",
          );
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

// (3.1) Variante sem readback: TRANSFERE o ImageBitmap ao worker (ownership passa ao worker, que
// fecha após o detect). Se o postMessage falhar (worker morreu no meio), fecha aqui e resolve vazio
// — tile sem resultado, sem crashar a rodada e sem vazar o bitmap.
function detectTileBitmap(
  bitmap: ImageBitmap,
  maxBoxes: number,
  minScore: number,
): Promise<WorkerDet[]> {
  const id = ++reqId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    try {
      worker!.postMessage({ type: "detect-bitmap", id, bitmap, maxBoxes, minScore }, [bitmap]);
    } catch {
      pending.delete(id);
      try {
        bitmap.close();
      } catch {
        /* já detached/fechado */
      }
      resolve([]);
    }
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

// ── Supressão de duplicatas por classe (NMS por IoU + dedupe por CONTENÇÃO) ──
// Lógica pura em ./nms.ts (testável sem tfjs). Além do NMS clássico (IoU ≥ nmsIoU),
// suprime a caixa majoritariamente CONTIDA em outra da mesma classe (interseção /
// área_menor ≥ CONTAINMENT_THR, mantendo a de maior score): é a "pessoa duplicada"
// do tiling — caixa PARCIAL num tile vizinho tem IoU BAIXO com a caixa inteira
// (união grande) e sobrevivia ao NMS. Vale p/ TODOS os consumidores de detectFrame.
// 0.7 é CONSERVADOR de propósito: duas pessoas realmente próximas lado a lado não
// atingem 70% de contenção mútua (só oclusão forte atinge — e aí o detector já
// tende a emitir uma caixa só). Trade-off declarado em nms.ts.
const CONTAINMENT_THR = 0.7;

// ── (2.4b) TILE ROTATION na GRADE (perfil longo alcance) ─────────────────────
// Estado por CALLER, keyed por `opts.schedule.key` (ex.: `${cameraId}:atividade`) — vive AQUI
// (module-level) porque o caller já passa uma key estável p/ o scheduler; nada muda na API.
// Na GRADE (`tiled === false`) com grid multi-tile, cada chamada processa só K dos N tiles
// (round-robin persistente) e FUNDE as detecções novas com o cache dos tiles não processados,
// aplicando o NMS no conjunto fundido. Entradas do cache expiram após ~2 varreduras completas sem
// refresh (em regime cada tile é re-processado a cada varredura; o TTL protege contra rotação
// interrompida — ex.: câmera que alternou p/ full e voltou).
// TRADE-OFF DECLARADO: na grade, a bbox de um tile só atualiza quando a rotação volta nele
// (até N/K = 4 chamadas ≈ 4 × TILE_OBJECT_INTERVAL_MS); motion/alarme não dependem disso.
// Na câmera ABERTA (`tiled === true`) a grade é processada COMPLETA por chamada (recall preservado).
const GRID_TILES_PER_CALL = 4; // K tiles processados por chamada na grade (de N=16 no perfil LR)
const GRID_CACHE_TTL_SWEEPS = 2; // expira entrada não refrescada após ~2 varreduras completas
type TileCacheEntry = { dets: NormDet[]; round: number };
type RotationState = { sig: string; pos: number; round: number; cache: (TileCacheEntry | null)[] };
const rotationByKey = new Map<string, RotationState>();

// Obtém (ou cria) o estado de rotação do caller; reseta se a geometria do grid mudou.
// LRU simples com teto — evita acumular estado de câmeras que saíram da grade.
function rotationFor(key: string, tileCount: number, sig: string): RotationState {
  let st = rotationByKey.get(key) ?? null;
  if (!st || st.sig !== sig) {
    st = { sig, pos: 0, round: 0, cache: new Array<TileCacheEntry | null>(tileCount).fill(null) };
  }
  rotationByKey.delete(key); // touch (mantém ordem de uso p/ o teto abaixo)
  rotationByKey.set(key, st);
  if (rotationByKey.size > 64) {
    const oldest = rotationByKey.keys().next().value;
    if (oldest !== undefined) rotationByKey.delete(oldest);
  }
  return st;
}

// ── (3.1) caminho preferido: createImageBitmap com crop+resize, sem readback na main ─────────
// Feature-detect 1× (não por chamada): alguns browsers antigos não suportam as opções de resize no
// crop (ou nem têm createImageBitmap) — nesses, `bitmapPath` fica `false` e TODAS as chamadas usam o
// rasterize atual. Enquanto o probe (assíncrono, ~1 tick) não resolve, as primeiras chamadas também
// caem no rasterize — seguro e raríssimo (o probe dispara junto com o init do worker).
let bitmapPath: boolean | null = null; // null = probe ainda não resolveu
let bitmapProbe: Promise<void> | null = null;
function probeBitmapPath(): void {
  if (bitmapProbe) return;
  bitmapProbe = (async () => {
    try {
      if (typeof createImageBitmap !== "function") {
        bitmapPath = false;
        return;
      }
      const bmp = await createImageBitmap(new ImageData(4, 4), 0, 0, 4, 4, {
        resizeWidth: 2,
        resizeHeight: 2,
        resizeQuality: "low",
      });
      bitmapPath = bmp.width === 2 && bmp.height === 2; // browser velho ignora resize → cai no fallback
      bmp.close();
    } catch {
      bitmapPath = false;
    }
  })();
}

// Recorta+reduz UM tile via createImageBitmap (crop e downscale fora da main no Chrome; nada de
// drawImage/getImageData). `el` pode ser ImageBitmap (dashboard/fadiga), HTMLVideoElement ou Canvas
// (demais callers) — todos são ImageBitmapSource. Fonte indisponível no meio (ex.: ImageBitmap do
// feed fechado/reciclado entre a chamada e o snapshot) → null = tile sem resultado, rodada segue.
async function grabTile(
  el: CanvasImageSource,
  nativeW: number,
  nativeH: number,
  t: Tile,
  tileWidth: number,
): Promise<ImageBitmap | null> {
  const sx = Math.max(0, Math.round(t.x0 * nativeW));
  const sy = Math.max(0, Math.round(t.y0 * nativeH));
  const sw = Math.max(1, Math.min(Math.round(nativeW) - sx, Math.round((t.x1 - t.x0) * nativeW)));
  const sh = Math.max(1, Math.min(Math.round(nativeH) - sy, Math.round((t.y1 - t.y0) * nativeH)));
  // (2.3) UPSCALE CONTROLADO: quando a fonte do tile é MENOR que o alvo (ex.: fonte 720 na grade
  // 4×4 do LR → ~223px << 640), sobe até `tileWidth` AQUI — a reamostragem do createImageBitmap
  // ("high" ≈ bicúbica) é melhor que o resize bilinear interno do grafo do modelo, então o pedestre
  // pequeno chega mais nítido ao 300×300 do SSD. Cap de segurança 2×: acima disso o upscale não cria
  // informação (só borra) e paga área à toa. CUSTO DECLARADO: a área do tile transferido ao worker
  // cresce até 4× (2× por eixo) no pior caso; como o coco reamostra p/ 300×300 de qualquer forma,
  // o ganho é a QUALIDADE da reamostragem, não o tamanho final visto pelo modelo.
  const dw = Math.max(1, Math.min(tileWidth, sw * 2));
  const dh = Math.max(1, Math.round((dw * sh) / sw));
  try {
    return await createImageBitmap(el, sx, sy, sw, sh, {
      resizeWidth: dw,
      resizeHeight: dh,
      // "high" só no UPSCALE (tile pequeno → barato); downscale/1:1 continua "low" (mais rápido).
      resizeQuality: dw > sw ? "high" : "low",
    });
  } catch {
    return null;
  }
}

// Payload de um tile já "fotografado": bitmap (caminho novo, transferível) ou RGBA (fallback).
type TilePayload =
  | { kind: "bmp"; bitmap: ImageBitmap }
  | { kind: "rgba"; rgba: ArrayBuffer; w: number; h: number };

// ── canvas de rasterização (FALLBACK de compatibilidade; draw→getImageData é síncrono) ──
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
  // (2.3) UPSCALE CONTROLADO (mesma regra do grabTile): fonte menor que o alvo → sobe até
  // `tileWidth`, com cap de 2× a fonte (além disso só borra e custa área — até 4× no worker).
  const dw = Math.max(1, Math.min(tileWidth, Math.round(sw) * 2)),
    dh = Math.max(1, Math.round((dw * sh) / sw));
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== dw || scratch.height !== dh) {
    scratch.width = dw;
    scratch.height = dh;
  }
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // "high" (≈ bicúbico) só no upscale; downscale mantém "low" (mais barato, qualidade suficiente).
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = dw > sw ? "high" : "low";
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
  // (2.4a) Integração com o SCHEDULER global: quando presente, CADA tile vira UMA tarefa própria
  // (`${key}:t<i>`, awaited em sequência) — entre um tile e o próximo, tarefas de prioridade maior
  // (câmera aberta, "high") intercalam em vez de esperar o lote inteiro. O CALLER que passa
  // `schedule` NÃO deve embrulhar detectFrame em requestInference (deadlock com maxConcurrent=1) e
  // deve manter seu próprio gate de voo (1 detectFrame em voo por key). Ausente → comportamento
  // legado: Promise.all direto no worker, sem scheduler (ex.: fadiga.ts). ADITIVO.
  schedule?: { key: string; priority: InferencePriority };
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
  const schedule = opts?.schedule;

  // Fallback main thread: sem tiling (evita bloquear), só limiar/maxBoxes afinados.
  // Com `schedule`, serializa via scheduler (o caller deixou de embrulhar em requestInference).
  if (!workerReady || !worker) {
    if (!workerFailed) return []; // ainda carregando o worker; não cai pro main thread à toa
    const runMain = async (): Promise<Detection[]> => {
      try {
        const model = await loadDetector();
        return await model.detect(el as HTMLCanvasElement, maxBoxes, minScore);
      } catch {
        return [];
      }
    };
    if (!schedule) return runMain();
    const res = await requestInference(
      { key: schedule.key, run: runMain },
      { priority: schedule.priority },
    );
    return res ?? [];
  }

  const tiles = tileGrid(tiled, opts?.tiles);

  // (2.4b) TILE ROTATION: só na GRADE (`tiled === false`) com grid multi-tile e caller identificado
  // (schedule.key). Na câmera aberta (`tiled === true`), grade completa como sempre.
  let rot: RotationState | null = null;
  let indices = tiles.map((_, i) => i);
  if (schedule && !tiled && tiles.length > 1) {
    const st = rotationFor(schedule.key, tiles.length, `${tiles.length}:${tileWidth}`);
    rot = st;
    st.round++;
    const k = Math.min(GRID_TILES_PER_CALL, tiles.length);
    indices = Array.from({ length: k }, (_, i) => (st.pos + i) % tiles.length);
    st.pos = (st.pos + k) % tiles.length;
  }

  // Snapshot AGORA (só os tiles desta chamada): `el` é a imagem viva do feed — o recorte é tirado
  // no momento da chamada, mesmo que o worker processe o tile mais tarde. (3.1) Caminho preferido:
  // createImageBitmap dispara SÍNCRONO p/ todos os tiles no mesmo tick (o snapshot da fonte é do
  // instante da chamada; só a conclusão é assíncrona) — semântica igual à do rasterize.
  const grabOne = async (i: number): Promise<{ i: number; t: Tile; p: TilePayload | null }> => {
    if (bitmapPath === true) {
      const bitmap = await grabTile(el, nativeW, nativeH, tiles[i], tileWidth);
      return { i, t: tiles[i], p: bitmap ? { kind: "bmp", bitmap } : null };
    }
    const r = rasterize(el, nativeW, nativeH, tiles[i], tileWidth);
    return { i, t: tiles[i], p: r ? { kind: "rgba", ...r } : null };
  };
  const raster = await Promise.all(indices.map(grabOne));

  const sendTile = (p: TilePayload): Promise<WorkerDet[]> =>
    p.kind === "bmp"
      ? detectTileBitmap(p.bitmap, maxBoxes, minScore)
      : detectTile(p.rgba, p.w, p.h, maxBoxes, minScore);

  // (2.4a) Execução: com `schedule`, 1 tile = 1 tarefa do scheduler, awaited em SEQUÊNCIA —
  // entre um tile e o próximo o scheduler serve tarefas "high" (a câmera aberta não espera mais o
  // lote inteiro de uma câmera da grade). `undefined` = tile coalescido por um pedido mais novo da
  // MESMA key de tile (só ocorre com instância full+grade da mesma câmera) → tratado como "sem
  // resultado novo" (mantém o cache da rodada anterior). Sem `schedule`: caminho legado.
  const results: (WorkerDet[] | undefined)[] = [];
  if (schedule) {
    for (const { i, p } of raster) {
      if (!p) {
        results.push([]);
        continue;
      }
      const res = await requestInference(
        { key: `${schedule.key}:t${i}`, run: () => sendTile(p) },
        { priority: schedule.priority },
      );
      // Gestão do bitmap no caminho agendado: se a tarefa RODOU, o handle local já foi transferido
      // (detached) e close() é no-op; se foi COALESCIDA (`undefined`, tarefa nunca rodou), o bitmap
      // nunca saiu da main — fechar aqui evita vazar o backing store a cada rodada coalescida.
      if (p.kind === "bmp") {
        try {
          p.bitmap.close();
        } catch {
          /* já detached */
        }
      }
      results.push(res);
    }
  } else {
    results.push(
      ...(await Promise.all(
        raster.map(({ p }) => (p ? sendTile(p) : Promise.resolve([] as WorkerDet[]))),
      )),
    );
  }

  // remapeia cada caixa do bloco → fração do frame inteiro (+ atualiza o cache da rotação)
  const all: NormDet[] = [];
  const freshIdx = new Set<number>();
  results.forEach((dets, idx) => {
    if (!dets) return; // tile coalescido — a entrada anterior do cache continua valendo
    const t = raster[idx].t,
      tw = t.x1 - t.x0,
      th = t.y1 - t.y0;
    const norm = dets.map(
      (d): NormDet => ({
        cls: d.cls,
        score: d.score,
        bbox: [t.x0 + d.bbox[0] * tw, t.y0 + d.bbox[1] * th, d.bbox[2] * tw, d.bbox[3] * th],
      }),
    );
    freshIdx.add(raster[idx].i);
    if (rot) rot.cache[raster[idx].i] = { dets: norm, round: rot.round };
    all.push(...norm);
  });

  // (2.4b) funde o cache dos tiles NÃO processados nesta chamada; expira entradas velhas.
  if (rot) {
    const st = rot;
    const ttl = Math.ceil(tiles.length / GRID_TILES_PER_CALL) * GRID_CACHE_TTL_SWEEPS;
    st.cache.forEach((entry, i) => {
      if (!entry) return;
      if (st.round - entry.round > ttl) {
        st.cache[i] = null;
        return;
      }
      if (!freshIdx.has(i)) all.push(...entry.dets);
    });
  }

  // Supressão de duplicatas:
  //   • >1 bloco: NMS por IoU (funde as bordas dos tiles) + CONTENÇÃO — inclui o caso
  //     longo-alcance-na-grade (`tiled` false + `opts.tiles` multi-bloco) e o conjunto
  //     FUNDIDO da rotação (frescos + cache).
  //   • single-shot: SÓ a contenção (IoU=∞ desliga o NMS — o coco já fez o dele; não
  //     mudar o recall do caminho single). A dupla por contenção (caixa parcial + caixa
  //     inteira da MESMA pessoa) acontece também no single-shot/upscale.
  const merged =
    tiles.length > 1
      ? suppressDuplicates(all, C.nmsIoU, CONTAINMENT_THR)
      : suppressDuplicates(all, Number.POSITIVE_INFINITY, CONTAINMENT_THR);
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
