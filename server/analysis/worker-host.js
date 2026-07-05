// ─────────────────────────────────────────────────────────────────────────────
// worker-host.js — POOL de workers de inferência (spawn/respawn POR-WORKER + CPU
// + roteamento por menor-carga). Destrava o throughput do hub: o binding do
// onnxruntime-node SERIALIZA inferências DENTRO de um processo (spike §6), então
// 1 worker satura ~1-2 cores e deixa o resto da máquina ocioso. N processos
// escalam quase linear (spike §7: 4 processos ≈ 9,9 fps vs 1 ≈ 2 fps).
//
// STATELESS POR FRAME: o worker (worker.js) só faz inferência — decode→session.run→
// postprocess, sem estado por câmera (o TRACKING/ByteTrack/counting/zones vive no
// ENGINE, por câmera). Logo QUALQUER worker processa QUALQUER frame → roteamento por
// MENOR-CARGA (fila mais curta), sem assignment sticky. O engine já garante ≤1 job
// em voo por câmera (st.busy), então nunca há 2 frames da mesma câmera concorrendo
// nem risco de reordenação; a resposta carrega cameraId+id e o engine reassembla.
//
// CUSTO: cada worker carrega SUA cópia do .onnx em RAM (~190-240 MB RSS/worker,
// spike §7). N cópias do modelo é o preço do paralelismo real no Node — aceitável
// p/ os tiers S/N num hub de escritório (8C/16T comporta o pool + relé/ffmpeg).
//
// NUNCA-CEGO POR-WORKER: respawn é INDIVIDUAL (um cai → só ele volta, com backoff);
// enquanto ≥1 worker vive, o motor segue analisando. No exit de um worker, SÓ as
// câmeras cujo job em voo estava NELE são liberadas (as dos outros seguem).
//
// worker.js = D-FINE / onnxruntime-node em PROCESSO SEPARADO (spike §6). Buffers de
// JPEG viajam como binário (serialization:"advanced"), sem base64. O worker.js NÃO
// muda — só passa a ter N instâncias.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { fork } = require("node:child_process");
const path = require("node:path");

// ── Lógica PURA (testável, determinística) ───────────────────────────────────

/**
 * Número de workers do pool. `pin` (env ANALYSIS_WORKERS) FIXA o N; ausente/invalido =
 * AUTO: min(floor(cores/2), câmeras), piso 1.
 *
 * CAVEAT (documentado): no boot as câmeras ainda NÃO registraram (elas conectam via
 * socket DEPOIS do listen), então `cameras` costuma ser 0 nesse instante. Clampar a
 * 0/1 crioparia o pool — por isso o clamp por câmeras SÓ vale quando há contagem (>0);
 * com 0 (desconhecido no boot) dimensiona por cores. O clamp evita superprovisionar
 * workers acima do nº de câmeras quando esse número é conhecido.
 *
 * @param {{cores?:number, cameras?:number, pin?:string|number}} p
 * @returns {number} N ≥ 1
 */
function resolveWorkerCount({ cores, cameras, pin } = {}) {
  const p = Number(pin);
  if (Number.isInteger(p) && p >= 1) return p; // ANALYSIS_WORKERS = pin explícito de ops
  const byCore = Math.max(1, Math.floor((Number(cores) || 1) / 2));
  const cam = Number(cameras) || 0;
  const n = cam > 0 ? Math.min(byCore, cam) : byCore;
  return Math.max(1, n);
}

/**
 * ROTEAMENTO PURO — escolhe o worker PRONTO de MENOR carga (fila mais curta),
 * com round-robin no EMPATE (varre a partir de `rr`). Devolve o índice escolhido,
 * ou -1 se nenhum worker está pronto.
 *
 * @param {Array<{ready:boolean, load:number}>} workers
 * @param {number} rr  ponteiro round-robin (o caller avança p/ (idx+1)%N após usar)
 * @returns {number} índice do worker escolhido, ou -1
 */
function pickWorker(workers, rr = 0) {
  const n = workers.length;
  if (!n) return -1;
  const start = ((rr % n) + n) % n; // normaliza rr (defensivo)
  let best = -1;
  let bestLoad = Infinity;
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n; // varre a partir de rr → empates saem em round-robin
    const w = workers[i];
    if (!w || !w.ready) continue;
    if (w.load < bestLoad) {
      bestLoad = w.load;
      best = i;
    }
  }
  return best;
}

/**
 * COALESCÊNCIA/≤1-EM-VOO POR CÂMERA (guarda de despacho, PURA). A câmera despacha
 * neste tick só se: não é fadiga (roda no cliente), não tem job em voo (busy), tem
 * frame novo (latest, último-vence) e respeitou a cadência (roundMs). Isso preserva
 * "só o frame MAIS NOVO de cada câmera importa" e "≤1 job em voo por câmera".
 *
 * @param {object} st              estado por câmera do engine
 * @param {number} now            Date.now()
 * @param {number} defaultRoundMs cadência base (quando st.roundMs não está setado)
 */
function dispatchReady(st, now, defaultRoundMs) {
  if (!st || st.fadiga) return false;
  if (st.busy || !st.latest) return false;
  if (now - st.lastSentAt < (st.roundMs || defaultRoundMs)) return false;
  return true;
}

// ── Pool (efeitos colaterais: fork/kill/IPC) ─────────────────────────────────

/**
 * @param {object} deps
 * @param {Map} deps.states                câmeraId → estado (reset no exit + lookup na resposta)
 * @param {() => string} deps.getModelPath caminho ATUAL do modelo (pode mudar por fallback/tier)
 * @param {(st, dets, now) => void} deps.onDets  pipeline por rodada (=processDets do engine)
 * @param {() => boolean} deps.isStopping  true quando o engine encerra (não respawna)
 * @param {() => number} deps.getSize      nº de workers a subir (resolvido no spawn — env/cores/câmeras)
 */
function createWorkerPool({ states, getModelPath, onDets, isStopping, getSize }) {
  const workers = []; // registros por worker, índice estável (0..N-1)
  let rr = 0; // ponteiro round-robin do roteamento

  function makeWorker(id) {
    return {
      id,
      proc: null,
      ready: false,
      pid: 0,
      respawns: 0,
      backoffAttempt: 0,
      respawnTimer: null,
      reloading: false, // troca de modelo em curso → respawn imediato (não paga backoff)
      cpuSample: null, // { user, system, t }
      cpuPct: 0,
      inflight: new Map(), // jobId → cameraId (jobs em voo NESTE worker — carga + never-blind)
    };
  }

  function spawnOne(w) {
    w.ready = false;
    w.proc = fork(path.join(__dirname, "worker.js"), [], {
      serialization: "advanced", // Buffers de JPEG viajam como binário, sem base64
      env: { ...process.env, ANALYSIS_MODEL_PATH: getModelPath() },
    });
    w.pid = w.proc.pid;
    w.proc.on("message", (msg) => onWorkerMessage(w, msg));
    w.proc.on("exit", (code, signal) => onWorkerExit(w, code, signal));
  }

  function onWorkerExit(w, code, signal) {
    w.ready = false;
    w.proc = null;
    // NUNCA-CEGO POR-WORKER: libera SÓ as câmeras cujo job em voo estava NESTE worker
    // (as dos outros workers seguem). Sem isso a câmera ficaria busy p/ sempre.
    for (const [jobId, cameraId] of w.inflight) {
      const st = states.get(cameraId);
      if (st && st.inflight === jobId) {
        st.busy = false;
        st.inflight = 0;
      }
    }
    w.inflight.clear();
    if (isStopping()) return;
    // Troca de modelo (autoscale): respawn IMEDIATO com o novo getModelPath() — não é
    // crash, não paga backoff nem conta como respawn de falha. Gap de ~1 rodada, logado.
    if (w.reloading) {
      w.reloading = false;
      console.log(`[analysis] worker#${w.id} recarregando (troca de modelo) — respawn imediato`);
      spawnOne(w);
      return;
    }
    w.respawns += 1;
    const delay = Math.min(1000 * 2 ** w.backoffAttempt, 30_000);
    w.backoffAttempt += 1;
    console.warn(
      `[analysis] worker#${w.id} morreu (code=${code} signal=${signal}) — respawn em ${delay}ms (tentativa ${w.backoffAttempt})`,
    );
    w.respawnTimer = setTimeout(() => spawnOne(w), delay);
    if (w.respawnTimer.unref) w.respawnTimer.unref();
  }

  function onWorkerMessage(w, msg) {
    if (!msg) return;
    if (msg.type === "ready") {
      w.ready = true;
      w.backoffAttempt = 0; // subiu limpo — zera o backoff
      if (msg.cpu) w.cpuSample = { ...msg.cpu, t: Date.now() };
      console.log(`[analysis] worker#${w.id} pronto (pid=${w.pid}, modelo=${msg.model})`);
      return;
    }
    if (msg.type === "fatal") {
      console.error(`[analysis] worker#${w.id} FATAL: ${msg.error}`);
      return; // o handler de exit cuida do respawn
    }
    if (msg.cpu) sampleCpu(w, msg.cpu);
    w.inflight.delete(msg.id); // job respondeu → sai da carga deste worker
    const st = states.get(msg.cameraId);
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

  // CPU por worker (amostrada dos process.cpuUsage() de cada resposta). O agregado
  // (soma dos N) sai em stats().cpuPct = total de cores usados pelo pool.
  function sampleCpu(w, cpu) {
    const t = Date.now();
    if (!w.cpuSample) {
      w.cpuSample = { user: cpu.user, system: cpu.system, t };
      return;
    }
    const dt = t - w.cpuSample.t;
    if (dt < 5000) return; // janela mínima p/ % estável
    const dcpuMs = (cpu.user + cpu.system - w.cpuSample.user - w.cpuSample.system) / 1000;
    w.cpuPct = Math.round((dcpuMs / dt) * 1000) / 10; // % de UM core
    w.cpuSample = { user: cpu.user, system: cpu.system, t };
  }

  /** Sobe o pool (N = getSize() resolvido agora — env/cores/câmeras). */
  function spawnWorker() {
    const size = Math.max(1, getSize ? getSize() : 1);
    for (let i = 0; i < size; i++) {
      const w = makeWorker(i);
      workers.push(w);
      spawnOne(w);
    }
    console.log(`[analysis] pool de ${size} worker(s) de inferência iniciando`);
  }

  /** Pronto p/ despachar? (≥1 worker pronto E vivo — usado pelo tick.) */
  function ready() {
    return workers.some((w) => w.ready && !!w.proc);
  }

  /**
   * Roteia um pedido ao worker PRONTO de MENOR carga (round-robin no empate) e
   * registra o job em voo (carga). Lança se NENHUM worker está pronto ou se o send
   * do IPC falhar (o tick trata: reseta st.busy). NÃO registra inflight em falha.
   */
  function send(msg) {
    const snap = workers.map((w) => ({ ready: w.ready && !!w.proc, load: w.inflight.size }));
    const i = pickWorker(snap, rr);
    if (i < 0) throw new Error("nenhum worker pronto");
    rr = (i + 1) % workers.length;
    workers[i].proc.send(msg); // pode lançar (canal fechado) → propaga sem marcar inflight
    workers[i].inflight.set(msg.id, msg.cameraId);
  }

  /**
   * Recarrega o modelo em TODOS os workers (troca de tier do autoscale). Cada um: se
   * vivo, marca reloading + mata (o exit respawna imediato lendo o getModelPath() ATUAL);
   * se já caído (backoff), cancela o timer e sobe agora. Idempotente por worker.
   */
  function reload() {
    for (const w of workers) {
      if (!w.proc) {
        if (w.respawnTimer) clearTimeout(w.respawnTimer);
        w.respawnTimer = null;
        spawnOne(w);
        continue;
      }
      if (w.reloading) continue;
      w.reloading = true;
      try {
        w.proc.kill();
      } catch {
        /* ignore — o exit handler cuida do respawn */
      }
    }
  }

  /** Métricas agregadas + por worker (aditivo). cpuPct = SOMA (total de cores usados). */
  function stats() {
    const per = workers.map((w) => ({
      id: w.id,
      ready: w.ready && !!w.proc,
      pid: w.pid,
      cpuPct: w.cpuPct,
      respawns: w.respawns,
      load: w.inflight.size,
    }));
    const readyCount = per.reduce((a, w) => a + (w.ready ? 1 : 0), 0);
    return {
      ready: readyCount > 0, // ≥1 worker pronto (truthiness p/ logMinute/status)
      size: workers.length,
      readyCount,
      cpuPct: per.reduce((a, w) => a + w.cpuPct, 0), // agregado: total de cores usados pelo pool
      respawns: per.reduce((a, w) => a + w.respawns, 0),
      pids: per.map((w) => w.pid),
      workers: per,
    };
  }

  /** Encerra a supervisão: cancela respawns pendentes e mata todos os workers. */
  function stop() {
    for (const w of workers) {
      if (w.respawnTimer) clearTimeout(w.respawnTimer);
      if (w.proc) {
        try {
          w.proc.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }

  return { spawnWorker, ready, send, stats, reload, stop };
}

module.exports = { createWorkerPool, pickWorker, resolveWorkerCount, dispatchReady };
