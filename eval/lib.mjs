// ─────────────────────────────────────────────────────────────────────────────
// eval/lib.mjs — núcleo COMPARTILHADO da bancada de acurácia.
//
// Fonte única do que era triplicado em run-eval/gate/compare-models: cliente do
// worker de produção (fork IPC), matching det×GT, P/R/F1 e buckets de tamanho.
// Um fix de matching aqui vale para o gate E para o full-set — sem drift entre
// sensores (era o risco nº 1 da triplicação).
//
// CONTRATOS que este módulo depende (não mudar sem passar por aqui):
//   • IPC do worker (server/analysis/worker.js): {type:"detect",id,cameraId,jpeg,tiles?}
//     → {id, dets:[{class,score,bbox:[x,y,w,h] normalizado}], decodeMs, inferMs, cpu}.
//   • Catálogo de modelo: server/analysis/model.js (MODELS) — IMPORTADO, nunca copiado.
//     resolveModelPath() replica a resolução de PRODUÇÃO: ANALYSIS_MODEL_PATH fixa um
//     .onnx explícito; senão ANALYSIS_MODEL = n|s|m (default "s", igual ao engine).
// ─────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.dirname(EVAL_DIR);
export const WORKER = path.join(ROOT, "server", "analysis", "worker.js");
export const MODELS_DIR = path.join(ROOT, "server", "models");

/** Catálogo canônico N/S/M (file/sha/label) — a MESMA fonte do motor. */
export const { MODELS } = require(path.join(ROOT, "server", "analysis", "model.js"));

/**
 * Caminho do .onnx a medir, com a MESMA precedência da produção (model.js):
 * ANALYSIS_MODEL_PATH (override explícito) > ANALYSIS_MODEL n|s|m > default "s".
 */
export function resolveModelPath(env = process.env) {
  if (env.ANALYSIS_MODEL_PATH) return env.ANALYSIS_MODEL_PATH;
  const spec = MODELS[(env.ANALYSIS_MODEL || "s").toLowerCase()] || MODELS.s;
  return path.join(MODELS_DIR, spec.file);
}

/**
 * Fork do worker REAL de produção via IPC (mesmo contrato do engine.js).
 * Nada do pipeline é reimplementado: se o worker mudar, a régua mede a mudança.
 * @param {string} modelPath .onnx a carregar (ANALYSIS_MODEL_PATH do worker)
 * @param {{ scoreMin?: string|number, fatalExitCode?: number }} [opts]
 *   scoreMin: piso de score do worker (default "0.25" — uma passada serve todas
 *   as curvas: filtrar por threshold DEPOIS do NMS ≡ rodar com SCORE_MIN=thr).
 * @returns {{ ready: Promise<object>, detect(id,jpeg,tiles?): Promise<object>, kill(): void }}
 */
export function startWorker(modelPath, { scoreMin = "0.25", fatalExitCode = 1 } = {}) {
  const w = fork(WORKER, [], {
    serialization: "advanced",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { ...process.env, ANALYSIS_SCORE_MIN: String(scoreMin), ANALYSIS_MODEL_PATH: modelPath },
  });
  const pending = new Map();
  let onReady;
  const ready = new Promise((res, rej) => {
    onReady = res;
    w.on("exit", (code) => rej(new Error(`worker saiu com código ${code} antes do ready`)));
  });
  w.on("message", (m) => {
    if (!m) return;
    if (m.type === "ready") onReady(m);
    else if (m.type === "fatal") {
      console.error("[eval] worker fatal:", m.error);
      process.exit(fatalExitCode);
    } else if (m.id != null && pending.has(m.id)) {
      const res = pending.get(m.id);
      pending.delete(m.id);
      res(m);
    }
  });
  const detect = (id, jpeg, tiles) =>
    new Promise((res) => {
      pending.set(id, res);
      // cameraId único por pedido → a fila último-vence do worker nunca descarta nada aqui
      w.send({ type: "detect", id, cameraId: id, jpeg, ...(tiles ? { tiles } : {}) });
    });
  return { ready, detect, kill: () => w.kill() };
}

/** IoU mínimo para casar det×GT (padrão COCO da bancada inteira). */
export const IOU_MATCH = 0.5;

/** IoU de duas bboxes [x,y,w,h] (mesma unidade). 0 sem interseção. */
export function iou(a, b) {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

/**
 * Matching guloso por score (1-1, IoU≥iouThr) — dets e GT em PIXELS.
 * @param {Array<{box:number[], score:number}>} dets
 * @param {number[][]} gts bboxes GT [x,y,w,h]
 * @returns {{det:number[], gt:boolean[]}} det[i] = índice do GT casado ou -1
 */
export function matchGreedy(dets, gts, iouThr = IOU_MATCH) {
  const detMatch = new Array(dets.length).fill(-1);
  const gtTaken = new Array(gts.length).fill(false);
  const order = dets.map((_, i) => i).sort((a, b) => dets[b].score - dets[a].score);
  for (const i of order) {
    let best = -1;
    let bestIou = iouThr;
    for (let g = 0; g < gts.length; g++) {
      if (gtTaken[g]) continue;
      const v = iou(dets[i].box, gts[g]);
      if (v >= bestIou) {
        bestIou = v;
        best = g;
      }
    }
    if (best >= 0) {
      detMatch[i] = best;
      gtTaken[best] = true;
    }
  }
  return { det: detMatch, gt: gtTaken };
}

/** Precisão/recall/F1 de um acumulador {tp,fp,fn} (P=1 sem dets; R=0 sem GT). */
export function prf(a) {
  const p = a.tp + a.fp ? a.tp / (a.tp + a.fp) : 1;
  const r = a.tp + a.fn ? a.tp / (a.tp + a.fn) : 0;
  return { ...a, p, r, f1: p + r ? (2 * p * r) / (p + r) : 0 };
}

// Buckets de tamanho COCO por ÁREA de bbox: <32² pequena · 32²–96² média · >96² grande.
export const SMALL_MAX = 32 * 32;
export const MEDIUM_MAX = 96 * 96;
export const sizeBucket = (area) => (area < SMALL_MAX ? "S" : area < MEDIUM_MAX ? "M" : "L");
