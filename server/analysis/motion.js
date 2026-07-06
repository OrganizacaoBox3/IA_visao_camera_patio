// ─────────────────────────────────────────────────────────────────────────────
// motion.js — GATE DE MOVIMENTO do motor de análise (PURO/determinístico, testável).
//
// PORQUÊ: a MEDIÇÃO que ancora a Onda-Motion — a inferência (session.run) é 89-97% do
// custo de um frame (~130-650ms); decode/postproc <5%. O maior ganho NÃO é otimizar a
// inferência: é NÃO INFERIR quando a cena está estática. Num CD à noite, a maioria das
// câmeras vê chão parado — rodar o D-FINE nelas 6×/s é queimar CPU à toa.
//
// COMO: o engine decodifica um THUMBNAIL barato de luma (sharp shrink-on-load, ~64×48
// greyscale raw — sub-ms) ANTES de despachar ao worker; este módulo compara com o
// thumbnail anterior (diff de luminância, a MESMA matemática de src/processors/atividade.ts:
// |luma−prev| > pixelDelta → pixel "mudou"; ratio = mudados/total) e o engine PULA o
// dispatch quando o ratio fica abaixo do limiar. A economia é o session.run inteiro.
//
// NUNCA-CEGO (é vigilância — o gate jamais cega a câmera):
//   • BASELINE: o 1º frame (sem anterior) SEMPRE roda — estabelece a luma de referência.
//   • PISO DE PROBE: mesmo em cena 100% estática, roda ao menos a cada PROBE_MS (default 6s;
//     câmera FOCADA a cada PROBE_FOCUS_MS, default 2s). Pega a pessoa que apareceu e CONGELOU.
//   • FAIL-OPEN: erro de decode do thumbnail → o engine despacha assim mesmo (decisão do caller).
//   • O TTL do ByteTrack é esticado no engine p/ cobrir o PROBE_MS → pessoa parada não some
//     entre dois probes.
//
// MÁSCARA DE HOTSPOT (reuso das zonas de EXCLUSÃO): relógio/galho/timestamp queimado geram
// movimento que NÃO é pessoa. O engine rasteriza as zonas modo "exclusao" (as MESMAS que já
// filtram FP de detecção) num mapa de ignore do thumbnail; os pixels marcados não contam no
// ratio. Zero config nova: quem já pintou exclusão para o objeto fixo, o gate herda de graça.
//
// ENV (norte "zero config" — defaults sensatos, poucos knobs):
//   ANALYSIS_MOTION_GATE           on|off  (default ON; "0"/"off"/"false"/"no" desliga — escape hatch)
//   ANALYSIS_MOTION_RATIO          fração do thumbnail que precisa mudar p/ "há movimento" (default 0.005)
//   ANALYSIS_MOTION_PROBE_MS       piso de probe em cena estática (default 6000)
//   ANALYSIS_MOTION_PROBE_FOCUS_MS piso de probe da câmera focada/tela cheia (default 2000)
// Thumbnail (64×48) e pixelDelta (22, = atividade.motionPixelDelta) são CONSTANTES (YAGNI:
// knob que ninguém calibra em campo é ruído de config).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

/** Número de env com clamp [min,max] e default. */
function numEnv(raw, def, min, max) {
  const v = Number(raw);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

// ── Configuração (lida 1× na carga do módulo) ────────────────────────────────
const GATE_ON = !/^(0|off|false|no)$/i.test(String(process.env.ANALYSIS_MOTION_GATE ?? "on"));
const THUMB_W = 64; // largura do thumbnail de luma (fixo — coarse de propósito: o gate é grosso)
const THUMB_H = 48; // altura do thumbnail de luma
const PIXEL_DELTA = 22; // |luma−prev| (0..255) p/ "pixel mudou" — MESMO de atividade.motionPixelDelta
const MOTION_RATIO = numEnv(process.env.ANALYSIS_MOTION_RATIO, 0.005, 0, 1);
const PROBE_MS = numEnv(process.env.ANALYSIS_MOTION_PROBE_MS, 6000, 500, 60_000);
const PROBE_FOCUS_MS = numEnv(process.env.ANALYSIS_MOTION_PROBE_FOCUS_MS, 2000, 250, 60_000);

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
 * Rasteriza retângulos NORMALIZADOS (0..1) num mapa de ignore w×h (1 = ignora o pixel). Usado
 * p/ reaproveitar as zonas de EXCLUSÃO como máscara de hotspot do gate. Retângulo conservador
 * (o bbox inteiro da zona) — num gate coarse 64×48, ignorar um pouco a mais é seguro (não
 * queremos QUALQUER movimento vindo do relógio/timestamp). null quando não há retângulo.
 * @param {number} w
 * @param {number} h
 * @param {Array<{x:number,y:number,w:number,h:number}>} rects
 * @returns {Uint8Array|null}
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
 * DECISÃO DO GATE (PURA). Dado o ratio de movimento, o tempo desde a última inferência REAL e o
 * piso de probe, decide se despacha ao worker. Ordem: baseline → movimento → probe → pula.
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
  // Config (lida pelo engine p/ montar o thumbnail e esticar o TTL do tracker):
  GATE_ON,
  THUMB_W,
  THUMB_H,
  PIXEL_DELTA,
  MOTION_RATIO,
  PROBE_MS,
  PROBE_FOCUS_MS,
};
