// ─────────────────────────────────────────────────────────────────────────────
// telemetry.js — Montagem do payload de GET /api/analysis/status (CONTRATO
// ADITIVO — campos novos sim, quebrar existentes nunca). PURO dado o snapshot
// injetado: o engine junta o wiring vivo (states/config/stats) e este módulo
// agrega por câmera e dá forma — testável sem subir o motor (telemetry.test.js).
//
// Efeito colateral DELIBERADO: poda o skipLog (janela rolante 60s) de cada
// câmera ao medir — a mesma poda que o pipeline faz; medir aqui mantém o log
// enxuto em câmeras paradas (sem rodada não haveria poda).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const automask = require("./automask");

/**
 * @param {object} snap  snapshot vivo do engine:
 *   { now, states:Map, focusedCams:Set, targetFpsOf(st), enabled, modelFile,
 *     fps:{normal,line,focus}, motionGate:{enabled,ratio,probeMs,probeFocusMs,thumb},
 *     autoscale:{mode,tier,pin,choked,idle,lastSwitchAt}, worker, go2rtcPull }
 * @returns {object} payload do /api/analysis/status (shape estável)
 */
function buildStatus(snap) {
  const { now, states, focusedCams, targetFpsOf } = snap;
  const perCamera = {};
  let skipped1mAll = 0; // prova do ganho do gate — inferências puladas (60s, todas as câmeras)
  let skippedAll = 0; // idem, acumulado desde o boot
  for (const [id, st] of states) {
    let dets1m = 0;
    let excluded1m = 0;
    let automasked1m = 0;
    let reassoc1m = 0;
    for (const d of st.detsLog) {
      dets1m += d.n;
      excluded1m += d.x || 0;
      automasked1m += d.a || 0;
      reassoc1m += d.r || 0;
    }
    const cutoff = now - 60_000;
    while (st.skipLog.length && st.skipLog[0] < cutoff) st.skipLog.shift();
    skipped1mAll += st.skipLog.length;
    skippedAll += st.skipped;
    perCamera[id] = {
      fps: Math.round((st.rounds.length / 60) * 100) / 100,
      targetFps: targetFpsOf(st), // cadência efetiva (foco > linha > normal); 0 se fadiga
      focused: focusedCams.has(id), // aberta em tela cheia por ≥1 dashboard
      queue: st.slots.count() + (st.latest ? 1 : 0), // inferências em voo (foco pode ter >1) + frame pendente
      skipped1m: st.skipLog.length, // rodadas puladas pelo gate nos últimos 60s
      skippedTotal: st.skipped, // total pulado desde o boot
      motion: Math.round(st.motionRatio * 10000) / 10000, // último ratio de movimento (0..1)
      lastMs: st.lastMs,
      dets1m,
      excluded1m, // dets de pessoa suprimidas por zona de exclusão em 60s
      longRange: st.longRange, // true = rodada com tiling no worker
      fadiga: st.fadiga, // true = câmera modo=fadiga (NÃO analisada no hub)
      source: st.source, // origem do último frame ("relay" | "go2rtc")
    };
    // Auto-máscara: transparência — o operador vê onde a máscara agiu (rects
    // normalizados prontos p/ virar zona de exclusão manual). Formato: automask.statusOf.
    if (st.autoMask) {
      perCamera[id].automasked1m = automasked1m; // dets suprimidas pela auto-máscara em 60s
      perCamera[id].autoMask = automask.statusOf(st.autoMask);
    }
    // Tracker anti-rastro (precision.js 20-22): sensores da política de emissão.
    // Condicional (aditivo): só quando o estado carrega um tracker com stats().
    if (st.tracker && typeof st.tracker.stats === "function") {
      const tk = st.tracker.stats();
      perCamera[id].tracker = {
        reassoc1m, // saltos recuperados SEM id novo nos últimos 60s (2º estágio)
        reassocTotal: tk.reassociations, // idem, desde o boot
        lost: tk.lost, // tracks vivos INTERNOS mas ocultos do payload agora
      };
    }
  }
  return {
    enabled: snap.enabled,
    model: snap.modelFile,
    targetFps: snap.fps.normal,
    lineFps: snap.fps.line, // cadência das câmeras com linha/tripwire
    focusFps: snap.fps.focus, // cadência da câmera em foco (tela cheia)
    focused: [...focusedCams], // ids das câmeras focadas (união entre dashboards)
    autoMask: { mode: automask.AUTOMASK_MODE }, // modo global ("off"|"suggest"|"hide")
    // Gate de movimento — config + PROVA DO GANHO (inferências puladas).
    motionGate: {
      enabled: snap.motionGate.enabled,
      ratio: snap.motionGate.ratio, // limiar de movimento p/ rodar
      probeMs: snap.motionGate.probeMs, // piso: cena estática ainda roda a cada tanto (nunca-cego)
      probeFocusMs: snap.motionGate.probeFocusMs, // idem, câmera focada
      thumb: snap.motionGate.thumb, // resolução do thumbnail de luma
      skipped1m: skipped1mAll,
      skippedTotal: skippedAll,
    },
    // Auto-dimensionamento do modelo — tier ativo, modo e histerese (diagnóstico).
    autoscale: snap.autoscale,
    worker: snap.worker,
    go2rtcPull: snap.go2rtcPull,
    perCamera,
  };
}

module.exports = { buildStatus };
