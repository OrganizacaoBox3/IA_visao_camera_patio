// ─────────────────────────────────────────────────────────────────────────────
// worker-host.pool.test.js — REGRESSÃO de robustez do POOL (parte stateful).
//
// O worker-host.test.js cobre a lógica PURA. Aqui exercitamos o createWorkerPool com
// o fork INJETADO (fakes de ChildProcess — sem subir processo real): o alvo é o caminho
// de FALHA do IPC, que num incidente real derrubou o HUB INTEIRO. Bug: um worker morreu
// sob sobrecarga e o `proc.send()` no canal fechado emitiu um evento 'error' NÃO-TRATADO
// (ERR_IPC_CHANNEL_CLOSED) → exceção não capturada → hub morto. Invariante violada: um
// worker cair JAMAIS pode matar o hub (never-blind por-worker). Fix em 3 pontas: handler
// 'error' no proc, guarda `connected` no roteamento, e callback+reversão no send.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";

const require = createRequire(import.meta.url);
const { createWorkerPool } = require("./worker-host");

// Fake de ChildProcess: EventEmitter com send/kill/connected (o que o spawnOne usa).
function makeFake(i) {
  const p = new EventEmitter();
  p.connected = true;
  p.pid = 9000 + i;
  p.send = vi.fn(); // default: entrega ok (não invoca callback de erro)
  p.kill = vi.fn(() => {
    p.connected = false;
  });
  return p;
}

// Sobe um pool de N workers com fork injetado; devolve os fakes criados + helpers.
function montarPool(n, states = new Map()) {
  const workers = [];
  const pool = createWorkerPool({
    states,
    getModelPath: () => "/fake/model.onnx",
    onDets: vi.fn(),
    isStopping: () => false,
    getSize: () => n,
    fork: () => {
      const f = makeFake(workers.length);
      workers.push(f);
      return f;
    },
  });
  pool.spawnWorker();
  const marcarPronto = (w) => w.emit("message", { type: "ready", model: "fake" });
  return { pool, workers, states, marcarPronto };
}

beforeEach(() => {
  // silencia os logs do pool (spawn + warn de erro de IPC) p/ não poluir a saída
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createWorkerPool — roteamento com worker vivo", () => {
  it("entrega o job ao worker PRONTO e com canal aberto", () => {
    const { pool, workers, marcarPronto } = montarPool(1);
    marcarPronto(workers[0]);
    pool.send({ id: 1, cameraId: "camA" });
    expect(workers[0].send).toHaveBeenCalledTimes(1);
    expect(workers[0].send.mock.calls[0][0]).toMatchObject({ id: 1, cameraId: "camA" });
  });

  it("NÃO escolhe o worker com canal FECHADO (connected=false) — roteia p/ o vivo", () => {
    const { pool, workers, marcarPronto } = montarPool(2);
    workers.forEach(marcarPronto);
    workers[0].connected = false; // canal do #0 fechou (fecha ANTES do evento 'exit')
    pool.send({ id: 2, cameraId: "camA" });
    expect(workers[0].send).not.toHaveBeenCalled();
    expect(workers[1].send).toHaveBeenCalledTimes(1);
  });
});

describe("createWorkerPool — REGRESSÃO: um worker cair não derruba o hub", () => {
  it("evento 'error' no proc NÃO lança exceção (handler existe) e tira o worker de prontidão", () => {
    const { pool, workers, marcarPronto } = montarPool(1);
    marcarPronto(workers[0]);
    // Sem o handler 'error' do fix, emit('error') num EventEmitter LANÇA síncrono (e no
    // processo real seria exceção não-tratada → hub morto). Com o fix: tratado, sem throw.
    expect(() => workers[0].emit("error", new Error("EPIPE"))).not.toThrow();
    // saiu de prontidão → o próximo send não o escolhe (fica sem worker pronto)
    expect(() => pool.send({ id: 3, cameraId: "camA" })).toThrow(/nenhum worker pronto/);
  });

  it("erro ASSÍNCRONO do send (callback) reverte o job e libera a câmera — sem lançar", () => {
    const states = new Map([["camA", { inflight: 7, busy: true }]]);
    const { pool, workers, marcarPronto } = montarPool(1, states);
    marcarPronto(workers[0]);
    // canal aberto no snapshot, mas o send entrega o erro no CALLBACK (corrida com o exit)
    workers[0].send = vi.fn((_msg, cb) => cb(new Error("Channel closed")));
    expect(() => pool.send({ id: 7, cameraId: "camA" })).not.toThrow();
    // job revertido: câmera liberada p/ o tick re-despachar (never-blind)
    expect(states.get("camA")).toMatchObject({ inflight: 0, busy: false });
  });

  it("erro SÍNCRONO do send (canal já fechado na corrida) reverte e propaga p/ o chamador", () => {
    const states = new Map([["camA", { inflight: 8, busy: true }]]);
    const { pool, workers, marcarPronto } = montarPool(1, states);
    marcarPronto(workers[0]);
    workers[0].send = vi.fn(() => {
      throw new Error("ERR_IPC_CHANNEL_CLOSED");
    });
    // propaga (o dispatchToWorker do engine tem try/catch que zera st.busy)…
    expect(() => pool.send({ id: 8, cameraId: "camA" })).toThrow(/CHANNEL_CLOSED/);
    // …mas ANTES de propagar já reverteu o job (não fica câmera presa em busy)
    expect(states.get("camA")).toMatchObject({ inflight: 0, busy: false });
  });
});
