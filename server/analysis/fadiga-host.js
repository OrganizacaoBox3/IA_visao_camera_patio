// ─────────────────────────────────────────────────────────────────────────────
// fadiga-host.js — orquestrador do pipeline de FADIGA no hub (F1a da spec
// docs/analises/spec-fadiga-no-hub.md). Requisito do dono (2026-07-21): "o
// navegador não deve precisar estar aberto pra análise funcionar".
//
// PARALELO ao engine do D-FINE de propósito (zero mudança lá): o engine segue
// EXCLUINDO câmeras modo "fadiga" do pipeline de pessoa (worker-host.js:125);
// este host cuida SÓ delas — frames via o MESMO tee do io (index.js), worker
// DEDICADO (worker-fadiga.js: YuNet + FaceMesh), risco por câmera
// (fadiga-risk.js, port 1:1 do cliente), ingest direto no pgstore (fad_buckets/
// fad_events — as MESMAS tabelas que o cliente alimenta via POST /api/ingest;
// o turno é carimbado no choke point do ingest, não aqui) e evento socket
// ADITIVO "analysis-fatigue" (volatile, espelho p/ overlay — F1b consome).
//
// LIGA/DESLIGA: ANALYSIS_FADIGA=1 (default OFF na F1a — validação antes de
// virar default). Modelos ausentes → host não liga e o hub segue normal.
// TRACKING: o bbox do rosto do frame anterior vai como hint (`box`) — o crop
// SEGUE o rosto; mesh reprovado (presence baixo) → próximo frame re-detecta
// com YuNet no frame inteiro. LGPD: frames efêmeros; nada de imagem/landmark
// persiste — só agregados (como o cliente já gravava).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");
const { ensureFadigaModels } = require("./model-fadiga");
const { FadigaRisk, calcEar, calcMar, LEFT_EYE, RIGHT_EYE, MOUTH_W, MOUTH_O } = require("./fadiga-risk");

const ENABLED = process.env.ANALYSIS_FADIGA === "1"; // F1a: opt-in explícito
const TICK_MS = 200; // 5fps por câmera de fadiga (spike: mesh 7,4ms → folga enorme)
const RESPAWN_DELAY_MS = 2000;
const WORKER = path.join(__dirname, "worker-fadiga.js");
// Subconjunto do overlay (máscara): os MESMOS pontos que o cliente desenha (olhos + boca).
const MASK_IDX = [...LEFT_EYE, ...RIGHT_EYE, ...MOUTH_W, ...MOUTH_O];

function createFadigaHost({ io, ingest, isFadigaCamera, cameraLabelOf, log = console.log }) {
  const states = new Map(); // cameraId → { latest:{buf,ts}|null, inflight, box, risk, label }
  let worker = null;
  let workerReady = false;
  let stopping = false;
  let reqId = 0;
  let active = false; // flag + modelos ok

  function stateOf(id) {
    let st = states.get(id);
    if (!st) {
      st = { latest: null, inflight: false, box: null, risk: new FadigaRisk(), label: cameraLabelOf(id) };
      states.set(id, st);
    }
    return st;
  }

  function spawnWorker() {
    if (stopping) return;
    worker = fork(WORKER, [], { serialization: "advanced" });
    workerReady = false;
    worker.on("message", onWorkerMessage);
    worker.on("exit", (code) => {
      workerReady = false;
      worker = null;
      for (const st of states.values()) st.inflight = false; // jobs em voo morreram junto
      if (!stopping) {
        log(`[fadiga-hub] worker saiu (code ${code}) — respawn em ${RESPAWN_DELAY_MS}ms`);
        setTimeout(spawnWorker, RESPAWN_DELAY_MS).unref();
      }
    });
  }

  function onWorkerMessage(msg) {
    if (!msg) return;
    if (msg.type === "ready") {
      workerReady = true;
      log(`[fadiga-hub] worker pronto (${(msg.models || []).join(" + ")})`);
      return;
    }
    if (msg.type === "fatal") {
      log(`[fadiga-hub] worker FATAL: ${msg.error}`);
      return;
    }
    const st = states.get(msg.cameraId);
    if (!st) return;
    if (msg.dropped) return; // último-vence do worker: o job substituto ainda está em voo
    st.inflight = false;
    if (msg.error) {
      log(`[fadiga-hub] inferência falhou (${msg.cameraId}): ${msg.error}`);
      return;
    }
    handleResult(msg.cameraId, st, msg);
  }

  function handleResult(cameraId, st, msg) {
    const face = msg.face || { ok: false };
    const now = Date.now();
    let ear = null,
      mar = null;
    if (face.ok && face.pts) {
      st.box = face.box; // tracking: o crop do próximo frame segue o rosto
      // Float32Array [x0,y0,…] → array esparso {x,y} nos índices que calcEar/calcMar usam
      const lm = [];
      for (const i of MASK_IDX) lm[i] = { x: face.pts[i * 2], y: face.pts[i * 2 + 1] };
      ear = calcEar(lm);
      mar = calcMar(lm);
    } else {
      st.box = null; // perdeu o rosto → próximo frame re-detecta (YuNet full-frame)
    }

    st.label = cameraLabelOf(cameraId); // re-resolve: a câmera pode ter registrado label após o 1º frame
    const { events } = st.risk.update({ ear, mar, phone: false, now, wallTs: now });
    for (const ev of events) ingest("fad", "event", { posto: st.label, type: ev.type, ts: ev.ts });
    const sample = st.risk.sampleTick(now);
    if (sample) ingest("fad", "samples", { posto: st.label, ...sample });

    // Espelho p/ overlay (ADITIVO; volatile — perder um frame não importa). eyes/mouth em
    // coordenadas 0..1 do frame; NUNCA persiste (biométrico só em trânsito, como o vídeo).
    const snap = st.risk.snapshot();
    const fatigue = {
      ok: !!face.ok,
      score: face.score ?? 0,
      box: face.box ?? null,
      risk: snap.risk,
      ear: snap.ear,
      mar: snap.mar,
      counters: snap.counters,
      mask: face.ok && face.pts ? MASK_IDX.map((i) => [face.pts[i * 2], face.pts[i * 2 + 1]]) : null,
    };
    io.volatile.emit("analysis-fatigue", { cameraId, ts: msg.ts, latencyMs: now - msg.ts, fatigue });
  }

  function tick() {
    if (!active || !workerReady || !worker) return;
    for (const [id, st] of states) {
      if (!st.latest || st.inflight) continue;
      const frame = st.latest;
      st.latest = null;
      st.inflight = true;
      try {
        worker.send({
          type: "detect",
          id: ++reqId,
          cameraId: id,
          jpeg: Buffer.isBuffer(frame.buf) ? frame.buf : Buffer.from(frame.buf),
          ts: frame.ts ?? Date.now(),
          box: st.box,
        });
      } catch {
        st.inflight = false; // worker caiu entre o check e o send — respawn cuida
      }
    }
  }

  return {
    /** Sobe o host (idempotente). false = desligado (flag OFF ou modelo indisponível). */
    async init() {
      if (!ENABLED) return false;
      if (!(await ensureFadigaModels(true))) return false;
      active = true;
      spawnWorker();
      setInterval(tick, TICK_MS).unref();
      log(`[fadiga-hub] LIGADO — câmeras modo fadiga analisadas 24/7 no hub (@${1000 / TICK_MS}fps, worker dedicado)`);
      return true;
    },

    /** Tee de frames (index.js): guarda só o MAIS NOVO por câmera de fadiga.
     *  OBSERVADOR NUNCA DERRUBA O RELÉ: qualquer erro aqui é engolido com log 1× —
     *  o hub caiu em produção local (2026-07-22) por um throw neste caminho. */
    onFrame(id, buf, ts) {
      try {
        if (!active || !isFadigaCamera(id)) return;
        stateOf(id).latest = { buf, ts: ts ?? Date.now() };
      } catch (e) {
        if (!this._onFrameErrLogged) {
          this._onFrameErrLogged = true;
          log(`[fadiga-hub] onFrame falhou (1ª ocorrência): ${e && e.message}`);
        }
      }
    },

    /** camcfg mudou: câmera que DEIXOU de ser fadiga sai do mapa (risco/box zerados). */
    onCamcfgUpdated(id) {
      try {
        if (!active) return;
        if (id && !isFadigaCamera(id)) states.delete(id);
      } catch {
        /* observador não derruba o relé */
      }
    },

    status() {
      return { enabled: ENABLED, active, workerReady, cameras: [...states.keys()] };
    },

    stop() {
      stopping = true;
      active = false;
      if (worker) worker.kill();
    },
  };
}

module.exports = { createFadigaHost, MASK_IDX };
