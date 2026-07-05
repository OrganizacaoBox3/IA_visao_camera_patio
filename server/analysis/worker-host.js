// ─────────────────────────────────────────────────────────────────────────────
// worker-host.js — Ciclo de vida do worker de inferência (spawn/respawn + CPU).
//
// Extraído de engine.js (R5/retrofit): a "supervisão do processo filho" (fork, respawn
// com backoff, roteamento de mensagens, amostragem de CPU) é uma responsabilidade própria.
// Fábrica createWorkerHost(deps): o engine injeta o Map `states`, o getModelPath (o path
// pode mudar por fallback), o callback onDets (=processDets) e o predicado isStopping.
// Comportamento byte-a-byte do original — só a fronteira mudou.
//
// worker.js = D-FINE / onnxruntime-node em PROCESSO SEPARADO (spike §6). Buffers de JPEG
// viajam como binário (serialization:"advanced"), sem base64.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { fork } = require("node:child_process");
const path = require("node:path");

/**
 * @param {object} deps
 * @param {Map} deps.states                câmeraId → estado (para reset no exit e lookup na resposta)
 * @param {() => string} deps.getModelPath caminho ATUAL do modelo (pode ter mudado por fallback S→N)
 * @param {(st, dets, now) => void} deps.onDets  pipeline por rodada (=processDets do engine)
 * @param {() => boolean} deps.isStopping  true quando o engine está encerrando (não respawna)
 */
function createWorkerHost({ states, getModelPath, onDets, isStopping }) {
  let worker = null;
  let workerReady = false;
  let workerPid = 0;
  let respawns = 0;
  let backoffAttempt = 0;
  let respawnTimer = null;

  // CPU do worker (amostrada dos process.cpuUsage() que ele manda em cada resposta)
  let cpuSample = null; // { user, system, t }
  let cpuPct = 0;

  // ── Worker: spawn + respawn com backoff ──────────────────────────────────────
  function spawnWorker() {
    workerReady = false;
    worker = fork(path.join(__dirname, "worker.js"), [], {
      serialization: "advanced", // Buffers de JPEG viajam como binário, sem base64
      env: { ...process.env, ANALYSIS_MODEL_PATH: getModelPath() },
    });
    workerPid = worker.pid;
    worker.on("message", onWorkerMessage);
    worker.on("exit", (code, signal) => {
      workerReady = false;
      worker = null;
      // pedidos em voo morreram com o processo: libera os slots p/ a próxima rodada
      for (const st of states.values()) {
        st.busy = false;
        st.inflight = 0;
      }
      if (isStopping()) return;
      respawns += 1;
      const delay = Math.min(1000 * 2 ** backoffAttempt, 30_000);
      backoffAttempt += 1;
      console.warn(
        `[analysis] worker morreu (code=${code} signal=${signal}) — respawn em ${delay}ms (tentativa ${backoffAttempt})`,
      );
      respawnTimer = setTimeout(spawnWorker, delay);
      if (respawnTimer.unref) respawnTimer.unref();
    });
  }

  function onWorkerMessage(msg) {
    if (!msg) return;
    if (msg.type === "ready") {
      workerReady = true;
      backoffAttempt = 0; // subiu limpo — zera o backoff
      if (msg.cpu) cpuSample = { ...msg.cpu, t: Date.now() };
      console.log(`[analysis] worker pronto (pid=${workerPid}, modelo=${msg.model})`);
      return;
    }
    if (msg.type === "fatal") {
      console.error(`[analysis] worker FATAL: ${msg.error}`);
      return; // o handler de exit cuida do respawn
    }
    const st = states.get(msg.cameraId);
    if (msg.cpu) sampleCpu(msg.cpu);
    if (!st || st.inflight !== msg.id) return; // resposta órfã (respawn/prune) — ignora
    st.busy = false;
    st.inflight = 0;
    if (msg.dropped) return; // substituído na fila do worker (último-vence)
    if (msg.error) {
      st.errors += 1;
      if (st.errors <= 3 || st.errors % 50 === 0)
        console.warn(`[analysis:${st.id}] falha no frame: ${msg.error}`);
      return;
    }
    st.lastMs = msg.inferMs || 0;
    onDets(st, Array.isArray(msg.dets) ? msg.dets : [], Date.now());
  }

  function sampleCpu(cpu) {
    const t = Date.now();
    if (!cpuSample) {
      cpuSample = { user: cpu.user, system: cpu.system, t };
      return;
    }
    const dt = t - cpuSample.t;
    if (dt < 5000) return; // janela mínima p/ % estável
    const dcpuMs = (cpu.user + cpu.system - cpuSample.user - cpuSample.system) / 1000;
    cpuPct = Math.round((dcpuMs / dt) * 1000) / 10; // % de UM core
    cpuSample = { user: cpu.user, system: cpu.system, t };
  }

  /** Pronto p/ receber um `detect`? (workerReady E processo vivo — usado pelo tick.) */
  function ready() {
    return workerReady && !!worker;
  }

  /** Envia um pedido ao worker. Lança se o send do IPC falhar (o tick trata). */
  function send(msg) {
    worker.send(msg);
  }

  /** Métricas p/ status()/logMinute (aditivo — mesmo shape de antes). */
  function stats() {
    return { ready: workerReady, pid: workerPid, respawns, cpuPct };
  }

  /** Encerra a supervisão: cancela respawn pendente e mata o worker. */
  function stop() {
    if (respawnTimer) clearTimeout(respawnTimer);
    if (worker) {
      try {
        worker.kill();
      } catch {
        /* ignore */
      }
    }
  }

  return { spawnWorker, ready, send, stats, stop };
}

module.exports = { createWorkerHost };
