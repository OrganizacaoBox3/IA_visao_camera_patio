// ─────────────────────────────────────────────────────────────────────────────
// motion.js — GATE DE MOVIMENTO do motor de análise (PURO/determinístico, testável).
//
// PORQUÊ (medição-âncora): a inferência (session.run) é 89-97% do custo de um frame
// (~130-650ms); decode/postproc <5%. O maior ganho não é otimizar a inferência: é
// NÃO INFERIR quando a cena está estática — num CD à noite a maioria das câmeras vê
// chão parado. O engine decodifica um THUMBNAIL de luma (64×48, sub-ms) antes de
// despachar; este módulo compara com o anterior (diff de luminância — a MESMA
// matemática de src/processors/atividade.ts) e o engine pula o dispatch quando o
// ratio fica abaixo do limiar. A economia é o session.run inteiro.
//
// NUNCA-CEGO (invariante — é vigilância, o gate jamais cega a câmera):
//   • BASELINE: o 1º frame (sem anterior) SEMPRE roda.
//   • PISO DE PROBE: cena 100% estática ainda roda a cada probeMs (focada: probeFocusMs).
//   • FAIL-OPEN: erro de decode do thumbnail → o engine despacha assim mesmo.
//   • O TTL do tracker cobre o probe (precision.trackTtlMs) — pessoa parada não
//     some entre dois probes.
//
// MÁSCARA DE HOTSPOT: as zonas de EXCLUSÃO (as mesmas que filtram FP de detecção)
// viram mapa de ignore do thumbnail — relógio/galho/timestamp queimado não disparam
// o gate. Zero config nova: quem pintou exclusão herda a máscara de graça.
//
// KNOBS de qualidade (ratio/probes/pixelDelta): precision.js (painel — env
// interpretado lá). Daqui só o LIGA/DESLIGA (ANALYSIS_MOTION_GATE, default ON —
// escape hatch de custo) e as dims do thumbnail (fixas: o gate é grosso de propósito).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { PRECISION } = require("./precision");

const GATE_ON = !/^(0|off|false|no)$/i.test(String(process.env.ANALYSIS_MOTION_GATE ?? "on"));
const THUMB_W = 64; // dims do thumbnail de luma — fixas (coarse de propósito)
const THUMB_H = 48;
const PIXEL_DELTA = PRECISION.gate.pixelDelta;
const MOTION_RATIO = PRECISION.gate.motionRatio;
const PROBE_MS = PRECISION.gate.probeMs;
const PROBE_FOCUS_MS = PRECISION.gate.probeFocusMs;

/**
 * Diff de luminância entre dois thumbnails (single-channel, 0..255), ignorando os pixels
 * mascarados. PURO. Mesma conta do processador de atividade — não reinventa.
 * @param {ArrayLike<number>} cur    thumbnail atual (length = w*h)
 * @param {ArrayLike<number>} prev   thumbnail anterior (mesmo length)
 * @param {Uint8Array|null} ignore   mapa de ignore (1 = pixel de hotspot, não conta); null = sem máscara
 * @param {number} [pixelDelta]      limiar de mudança de luma (default PIXEL_DELTA)
 * @returns {{ changed:number, total:number, ratio:number }}
 */
function motionRatio(cur, prev, ignore = null, pixelDelta = PIXEL_DELTA) {
  if (!cur || !prev || cur.length !== prev.length) return { changed: 0, total: 0, ratio: 0 };
  let changed = 0;
  let total = 0;
  const n = cur.length;
  for (let i = 0; i < n; i++) {
    if (ignore && ignore[i]) continue; // hotspot mascarado (exclusão) — não conta no movimento
    total += 1;
    if (Math.abs(cur[i] - prev[i]) > pixelDelta) changed += 1;
  }
  return { changed, total, ratio: total > 0 ? changed / total : 0 };
}

/**
 * Rasteriza retângulos NORMALIZADOS (0..1) num mapa de ignore w×h (1 = ignora o pixel).
 * Retângulo conservador (o bbox inteiro da zona): num gate coarse 64×48, ignorar um pouco
 * a mais é seguro — não queremos QUALQUER movimento vindo do relógio/timestamp.
 * @param {number} w
 * @param {number} h
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @returns {Uint8Array|null} null quando nenhum pixel foi marcado (caminho rápido no caller)
 */
function buildIgnoreMask(w, h, rects) {
  if (!rects || !rects.length) return null;
  const m = new Uint8Array(w * h);
  let any = false;
  for (const r of rects) {
    if (!r) continue;
    const x0 = Math.max(0, Math.floor(r.x * w));
    const x1 = Math.min(w, Math.ceil((r.x + r.w) * w));
    const y0 = Math.max(0, Math.floor(r.y * h));
    const y1 = Math.min(h, Math.ceil((r.y + r.h) * h));
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        m[y * w + x] = 1;
        any = true;
      }
  }
  return any ? m : null;
}

/**
 * DECISÃO DO GATE (PURA). Dado o ratio de movimento, o tempo desde a última inferência REAL
 * e o piso de probe, decide se despacha ao worker. Ordem: baseline → movimento → probe → pula.
 *   • hasPrev=false  → infer (baseline: 1º frame estabelece referência, nunca-cego)
 *   • ratio ≥ limiar → infer (há movimento)
 *   • sinceMs ≥ probe→ infer (piso de probe: cena estática há muito tempo, checa mesmo assim)
 *   • senão          → PULA (economiza a inferência)
 * @param {{ ratio:number, sinceMs:number, threshold?:number, probeMs?:number, hasPrev?:boolean }} p
 * @returns {{ infer:boolean, reason:"baseline"|"motion"|"probe"|"skip" }}
 */
function gateDecision({ ratio, sinceMs, threshold, probeMs, hasPrev = true }) {
  const thr = threshold ?? MOTION_RATIO;
  const probe = probeMs ?? PROBE_MS;
  if (!hasPrev) return { infer: true, reason: "baseline" };
  if (ratio >= thr) return { infer: true, reason: "motion" };
  if (sinceMs >= probe) return { infer: true, reason: "probe" };
  return { infer: false, reason: "skip" };
}

module.exports = {
  motionRatio,
  buildIgnoreMask,
  gateDecision,
  // Config (lida pelo engine p/ montar o thumbnail e pela telemetria):
  GATE_ON,
  THUMB_W,
  THUMB_H,
  PIXEL_DELTA,
  MOTION_RATIO,
  PROBE_MS,
  PROBE_FOCUS_MS,
};
