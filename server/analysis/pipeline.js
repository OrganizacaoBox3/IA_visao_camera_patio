// ─────────────────────────────────────────────────────────────────────────────
// pipeline.js — PIPELINE POR RODADA do motor: dets do worker → exclusão →
// auto-máscara → tracking → contagem de linha → zonas de atividade → ingest →
// emit. É a LÓGICA DE DOMÍNIO por detecção (o engine só orquestra: cadência,
// worker, timers, sockets). Determinístico dado (st, dets, now) — testável com
// dets sintéticos, sem worker/IPC (pipeline.test.js).
//
// CONTRATO com o relatório (INTOCÁVEL — mesmos shapes de src/report/store.ts):
//   ingest("flow","cross", { cameraId, cameraLabel, tripwireId, dir, ts, shift })
//   ingest("ativ","samples", { cameraId, samples:[{ zoneId, label, atividade,
//     idleMs:0, frames, activeFrames, people }] })
//   people = PICO de pessoas na janela (→ people_peak); activeFrames = rodadas
//   com ≥1 pessoa (→ activePct); idleMs fica 0 (ociosidade por MOTION é do front).
//
// CONTRATO com o front (socket `analysis-tracks`, ADITIVO): o payload é montado
// AQUI (projeção explícita — campos internos do tracker NÃO vazam: firstSeen,
// velocidade crua…); o engine só transporta (deps.emitTracks). ECONOMIA: sem
// espectador (deps.hasViewers()=false) o payload nem é montado.
//
// DEPS injetadas (createPipeline): highScore (nascimento de track — precision.js),
// ingest (pgstore), hasViewers/emitTracks (socket — o engine é o dono do io),
// cameraLabelOf (label p/ o evento de flow).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { attributeZone, inExclusionZone } = require("./zones");
const { roundObserver } = require("./automask");
const sessionRecorder = require("../bt/session-recorder"); // gravador OPT-IN (FUSION_RECORD) da sessão de fusão — no-op quando off

// Turno da fábrica. DUPLICAÇÃO DECLARADA de src/report/calc/common.ts:8 (front):
// mudou o turno lá, mude AQUI — senão a contagem "flow" diverge do relatório.
const shiftOf = (hour) => (hour >= 6 && hour < 14 ? "Manhã" : hour >= 14 && hour < 22 ? "Tarde" : "Noite");

/**
 * @param {object} deps
 * @param {number} deps.highScore            nascimento/1ª passada do tracker (PRECISION.detector.highScore)
 * @param {(kind, sub, payload) => Promise} deps.ingest       persistência de indicadores (pgstore.ingest)
 * @param {() => boolean} deps.hasViewers    há dashboard ouvindo? (false → não monta o payload)
 * @param {(payload) => void} deps.emitTracks  transporte do `analysis-tracks` (engine/io)
 * @param {(cameraId) => string} deps.cameraLabelOf  label da câmera p/ o evento de flow
 */
function createPipeline({ highScore, ingest, hasViewers, emitTracks, cameraLabelOf }) {
  /**
   * Uma rodada de UMA câmera: consome as dets cruas do worker e MUTA st
   * (tracker/counter/janela/logs). Emite overlay ao final (inclusive com 0
   * tracks — o dashboard precisa da rodada vazia p/ apagar caixas).
   */
  function processRound(st, dets, now, latencyMs = 0) {
    // Zona de EXCLUSÃO (calibração — acuracia-modelos.md Medida A): pessoa cujo PÉ
    // (bottom-center) cai em zona modo "exclusao" é DESCARTADA AQUI — antes de
    // tracking/contagem/ingest/emit. FP de objeto fixo é espacialmente preso; a
    // pessoa real se move — mascarar o hotspot mata o FP sem custar recall.
    const persons = [];
    let excluded = 0;
    let autoHidden = 0;
    // Auto-máscara: 1 observer por rodada (contrato automask.js). APRENDE de todas
    // as dets, inclusive as que suprime — objeto ainda presente segue confirmado;
    // quando some, deixa de ser reaprendido e a supressão cai (adaptativo).
    const obs = st.autoMask ? roundObserver(st.autoMask) : null;
    for (const d of dets) {
      if (!d || d.class !== "person" || !Array.isArray(d.bbox)) continue;
      if (st.zonesExcl.length && inExclusionZone(d.bbox, st.zonesExcl)) {
        excluded += 1;
        continue;
      }
      if (obs) {
        const fx = d.bbox[0] + d.bbox[2] / 2; // PÉ da detecção (mesma âncora da exclusão)
        const fy = d.bbox[1] + d.bbox[3];
        if (obs.observe(fx, fy, d.bbox[2], d.bbox[3])) {
          autoHidden += 1; // célula aprendida como objeto fixo → suprime (como exclusão manual)
          continue;
        }
      }
      persons.push({ score: d.score, bbox: d.bbox });
    }
    if (obs) obs.close(now, st.id);

    // Logs rolantes (60s) que alimentam fps real/dets1m/excluded1m no status.
    st.rounds.push(now);
    st.detsLog.push({ t: now, n: persons.length, x: excluded, a: autoHidden });
    const cutoff = now - 60_000;
    while (st.rounds.length && st.rounds[0] < cutoff) st.rounds.shift();
    while (st.detsLog.length && st.detsLog[0].t < cutoff) st.detsLog.shift();

    // POLÍTICA LOST (bytetrack.js): update() devolve só os tracks EMITÍVEIS —
    // track sem match há >1 rodada fica INTERNO (sem rastro no overlay, sem
    // ocupação, sem contagem) até re-associar (mesmo id) ou morrer pelo TTL.
    const tracks = st.tracker.update(persons, now, highScore);
    // Métrica de RE-ASSOCIAÇÃO (2º estágio): delta do acumulado → detsLog.r →
    // tracker.reassoc1m no status (sensor do salto recuperado SEM id novo).
    if (typeof st.tracker.stats === "function") {
      const tot = st.tracker.stats().reassociations;
      st.detsLog[st.detsLog.length - 1].r = tot - (st.reassocSeen || 0);
      st.reassocSeen = tot;
    }

    // Tripwires → eventos de cruzamento → ingest "flow"/"cross". DECISÃO: LOST não
    // alimenta o counter (posição congelada não gera cruzamento e não refresca o
    // last-pos) — a travessia sobrevive pela RE-ASSOCIAÇÃO (mesmo id) + last-pos
    // que o counter guarda por TTL próprio (mesmo TTL do tracker — engine.js).
    const crossings = st.counter.update(
      tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, foot: t.foot })),
      now,
    );
    if (crossings.length) {
      const cameraLabel = cameraLabelOf(st.id);
      const ts = Date.now();
      for (const ev of crossings) {
        ingest("flow", "cross", {
          cameraId: st.id,
          cameraLabel,
          tripwireId: ev.tripwireId,
          dir: ev.dir,
          ts,
          shift: shiftOf(new Date(ts).getHours()),
        }).catch((e) => console.error("[analysis] ingest flow falhou:", e.message));
      }
    }

    // Zonas de atividade → people/occupied por zona. A atribuição por track roda
    // UMA vez e alimenta os dois consumidores — a janela do ingest e o payload de
    // overlay — zero trabalho extra.
    const zoneByTrack = new Map(); // track.id → label | null
    const perLabel = new Map(); // label → pessoas nesta rodada
    if (st.zonesAtiv.length) {
      for (const t of tracks) {
        const label = attributeZone(t.bbox, st.zonesAtiv);
        zoneByTrack.set(t.id, label);
        if (label) perLabel.set(label, (perLabel.get(label) || 0) + 1);
      }
      st.window.frames += 1;
      for (const z of st.zonesAtiv) {
        const n = perLabel.get(z.label) || 0;
        let acc = st.window.zones.get(z.id);
        if (!acc)
          st.window.zones.set(z.id, (acc = { label: z.label, atividade: z.atividade || "", active: 0, peak: 0 }));
        if (n > 0) acc.active += 1;
        if (n > acc.peak) acc.peak = n;
      }
    }

    // Gravação OPT-IN da sessão de fusão (FUSION_RECORD): tracks CRUS desta rodada, ANTES do gate de
    // espectador (o teste de campo grava mesmo sem dashboard aberto). Fail-safe: jamais lança.
    sessionRecorder.recordTracks(st.id, now, tracks);

    // Overlay servido: roda TODA rodada com espectador (inclusive 0 tracks — o
    // dashboard precisa da rodada vazia p/ apagar caixas), mesmo sem zona/linha.
    if (hasViewers()) {
      emitTracks({
        cameraId: st.id,
        ts: now,
        // Latência captura→emissão (ms): quanto o frame ENVELHECEU no pipeline (fila+decode+inferência)
        // antes de virar caixa. Medida no worker-host (Date.now − ts de captura) e passada por parâmetro.
        // O cliente ancora o keyframe em `recvT - latencyMs` e extrapola pro AGORA real → a caixa senta
        // na pessoa em vez de nascer ~meio segundo atrás (07-diagnostico-overlay-lag).
        latencyMs: Math.max(0, latencyMs),
        tracks: tracks.map((t) => ({
          id: t.id,
          bbox: [t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]], // normalizado 0..1
          cx: t.cx,
          cy: t.cy,
          // VELOCIDADE p/ o cliente EXTRAPOLAR entre rodadas (fluidez sem inferir).
          // Unidade: fração NORMALIZADA do frame por SEGUNDO (mesma base do bbox);
          // o ByteTrack estima em unid/ms → ×1000. Cliente: x(t+Δs) ≈ x + vx·Δs.
          vx: t.vx * 1000,
          vy: t.vy * 1000,
          // score REAL (0..1) da det que sustenta o track nesta rodada — o front usa
          // no slider de confiança do modo hub (det baixa sustenta → reflete o piso).
          score: t.score,
          zone: zoneByTrack.get(t.id) ?? null,
        })),
        zones: st.zonesAtiv.map((z) => {
          const people = perLabel.get(z.label) || 0;
          return { id: z.id, label: z.label, people, occupied: people > 0 };
        }),
      });
    }
  }

  /** Flush das janelas "ativ" acumuladas (~ANALYSIS_AGG_MS) de todas as câmeras. */
  function flushWindows(states) {
    for (const st of states.values()) {
      if (!st.window.frames || !st.window.zones.size) continue;
      const samples = [];
      for (const [zoneId, acc] of st.window.zones) {
        samples.push({
          zoneId,
          label: acc.label,
          atividade: acc.atividade,
          idleMs: 0, // ociosidade por motion segue no front
          frames: st.window.frames,
          activeFrames: acc.active,
          people: acc.peak,
        });
      }
      st.window = { frames: 0, zones: new Map() };
      ingest("ativ", "samples", { cameraId: st.id, samples }).catch((e) =>
        console.error("[analysis] ingest ativ falhou:", e.message),
      );
    }
  }

  return { processRound, flushWindows };
}

module.exports = { createPipeline, shiftOf };
