// Testes da lógica PURA do POOL de workers (roteamento por menor-carga/round-robin,
// coalescência/≤1-em-voo por câmera, e o dimensionamento automático do N). Determinísticos —
// não sobem processos (o fork/IPC é efeito colateral do createWorkerPool, coberto pelo smoke).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickWorker, resolveWorkerCount, dispatchReady } = require("./worker-host");

describe("pickWorker — roteamento por MENOR carga + round-robin no empate", () => {
  const ready = (load) => ({ ready: true, load });

  it("escolhe o worker PRONTO de menor carga", () => {
    const ws = [ready(2), ready(0), ready(1)];
    expect(pickWorker(ws, 0)).toBe(1);
  });

  it("ignora workers não-prontos (nunca roteia p/ um morto)", () => {
    const ws = [{ ready: false, load: 0 }, { ready: true, load: 5 }];
    expect(pickWorker(ws, 0)).toBe(1);
  });

  it("nenhum worker pronto → -1 (o caller trata: reseta st.busy)", () => {
    expect(pickWorker([{ ready: false, load: 0 }, { ready: false, load: 0 }], 0)).toBe(-1);
    expect(pickWorker([], 0)).toBe(-1);
  });

  it("empate (todos idle) → round-robin a partir de rr", () => {
    const ws = [ready(0), ready(0), ready(0)];
    expect(pickWorker(ws, 0)).toBe(0);
    expect(pickWorker(ws, 1)).toBe(1);
    expect(pickWorker(ws, 2)).toBe(2);
    expect(pickWorker(ws, 3)).toBe(0); // rr normaliza (3 % 3 = 0)
  });

  it("sequência de despachos idle espalha em round-robin (o caller avança rr=(idx+1)%N)", () => {
    // Simula um tick com 4 câmeras e 3 workers idle: a carga sobe a cada atribuição,
    // então o próximo despacho vê o worker anterior mais carregado → espalha.
    const ws = [ready(0), ready(0), ready(0)];
    const picks = [];
    let rr = 0;
    for (let i = 0; i < 4; i++) {
      const idx = pickWorker(ws, rr);
      picks.push(idx);
      ws[idx].load += 1; // registra o job em voo (como o pool.send)
      rr = (idx + 1) % ws.length;
    }
    expect(picks).toEqual([0, 1, 2, 0]); // 3 espalhados, o 4º volta ao menos carregado
    expect(ws.map((w) => w.load)).toEqual([2, 1, 1]);
  });

  it("menor-carga vence o round-robin quando há desnível", () => {
    // rr apontaria p/ 0, mas 2 está mais vazio → vai p/ 2 (carga manda; rr só desempata).
    const ws = [ready(3), ready(3), ready(1)];
    expect(pickWorker(ws, 0)).toBe(2);
  });
});

describe("resolveWorkerCount — N automático (env pin / cores / câmeras)", () => {
  it("ANALYSIS_WORKERS fixa o N (pin de ops)", () => {
    expect(resolveWorkerCount({ cores: 8, cameras: 12, pin: "3" })).toBe(3);
    expect(resolveWorkerCount({ cores: 4, cameras: 1, pin: 6 })).toBe(6); // pin acima de cores/câmeras é respeitado
  });

  it("pin inválido (0/negativo/NaN/vazio) cai no AUTO", () => {
    expect(resolveWorkerCount({ cores: 8, cameras: 8, pin: "0" })).toBe(4);
    expect(resolveWorkerCount({ cores: 8, cameras: 8, pin: "abc" })).toBe(4);
    expect(resolveWorkerCount({ cores: 8, cameras: 8, pin: "" })).toBe(4);
    expect(resolveWorkerCount({ cores: 8, cameras: 8, pin: "2.5" })).toBe(4);
  });

  it("AUTO = min(floor(cores/2), câmeras)", () => {
    expect(resolveWorkerCount({ cores: 16, cameras: 5 })).toBe(5); // câmeras < floor(cores/2)=8
    expect(resolveWorkerCount({ cores: 8, cameras: 20 })).toBe(4); // floor(8/2)=4 < 20 câmeras
    expect(resolveWorkerCount({ cores: 6, cameras: 3 })).toBe(3);
  });

  it("piso 1 (máquina de 1-2 cores)", () => {
    expect(resolveWorkerCount({ cores: 1, cameras: 10 })).toBe(1);
    expect(resolveWorkerCount({ cores: 2, cameras: 10 })).toBe(1);
  });

  it("boot com câmeras=0 (registram após o listen) → dimensiona por cores, NÃO clampa a 1", () => {
    // Caveat documentado: no boot cameras=0; clampar a 1 crioparia o pool. Usa floor(cores/2).
    expect(resolveWorkerCount({ cores: 8, cameras: 0 })).toBe(4);
    expect(resolveWorkerCount({ cores: 16 })).toBe(8);
  });
});

describe("dispatchReady — coalescência / ≤1 job em voo por câmera", () => {
  const base = () => ({ fadiga: false, busy: false, latest: { buf: {} }, lastSentAt: 0, roundMs: 1000 });
  const now = 100_000;

  it("pronta: não-fadiga, livre, com frame novo e cadência cumprida → despacha", () => {
    expect(dispatchReady(base(), now, 1000)).toBe(true);
  });

  it("busy (job em voo) → NÃO despacha (garante ≤1 por câmera)", () => {
    expect(dispatchReady({ ...base(), busy: true }, now, 1000)).toBe(false);
  });

  it("sem frame novo (latest null) → NÃO despacha (último-vence: nada a mandar)", () => {
    expect(dispatchReady({ ...base(), latest: null }, now, 1000)).toBe(false);
  });

  it("dentro da cadência (roundMs não cumprido) → NÃO despacha", () => {
    const st = { ...base(), lastSentAt: now - 500, roundMs: 1000 }; // só 500ms desde o último
    expect(dispatchReady(st, now, 1000)).toBe(false);
  });

  it("câmera fadiga (roda no cliente) → NUNCA despacha no hub", () => {
    expect(dispatchReady({ ...base(), fadiga: true }, now, 1000)).toBe(false);
  });

  it("usa st.roundMs (câmera com linha @2fps) e cai no default quando ausente", () => {
    const linha = { ...base(), roundMs: 500, lastSentAt: now - 600 }; // 600ms ≥ 500 → ok
    expect(dispatchReady(linha, now, 1000)).toBe(true);
    const semRound = { ...base(), roundMs: 0, lastSentAt: now - 600 }; // cai no default 1000: 600<1000
    expect(dispatchReady(semRound, now, 1000)).toBe(false);
  });
});
