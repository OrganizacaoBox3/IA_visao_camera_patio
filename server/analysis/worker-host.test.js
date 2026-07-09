// Testes da lógica PURA do POOL de workers (roteamento por menor-carga/round-robin,
// coalescência/≤1-em-voo por câmera, e o dimensionamento automático do N). Determinísticos —
// não sobem processos (o fork/IPC é efeito colateral do createWorkerPool, coberto pelo smoke).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickWorker, resolveWorkerCount, dispatchReady, staggerPhaseMs } = require("./worker-host");
const { createInflightSlots } = require("./inflight");

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

  it("nenhum worker pronto → -1 (o caller trata: st.slots.abort)", () => {
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

describe("dispatchReady — coalescência/≤1-em-voo + cadência por SLOT ABSOLUTO (fase áurea)", () => {
  const base = () => ({
    fadiga: false,
    slots: createInflightSlots(), // vazio → canBegin true
    maxInflight: 1,
    latest: { buf: {} },
    lastSentAt: 0,
    staggerIndex: 0,
    roundMs: 1000,
  });
  const now = 100_000;

  it("pronta: não-fadiga, livre, frame novo e slot novo do grid próprio → despacha", () => {
    expect(dispatchReady(base(), now, 1000)).toBe(true); // slot 100 > slot 0
  });

  it("slot cheio (job em voo, serial max=1) → NÃO despacha (coalescência)", () => {
    const slots = createInflightSlots();
    slots.begin(1);
    expect(dispatchReady({ ...base(), slots, maxInflight: 1 }, now, 1000)).toBe(false);
  });

  it("FOCADA (maxInflight>1): com 1 em voo AINDA despacha (paralelismo do foco)", () => {
    const slots = createInflightSlots();
    slots.begin(1);
    expect(dispatchReady({ ...base(), slots, maxInflight: 3 }, now, 1000)).toBe(true);
  });

  it("sem frame novo (latest null) → NÃO despacha (último-vence: nada a mandar)", () => {
    expect(dispatchReady({ ...base(), latest: null }, now, 1000)).toBe(false);
  });

  it("câmera fadiga (roda no cliente) → NUNCA despacha no hub", () => {
    expect(dispatchReady({ ...base(), fadiga: true }, now, 1000)).toBe(false);
  });

  it("MESMO slot → NÃO despacha; slot novo → despacha (a régua é o grid, não o tempo relativo)", () => {
    const st = { ...base(), lastSentAt: 100_100 };
    expect(dispatchReady(st, 100_900, 1000)).toBe(false); // ambos dentro do slot [100_000, 101_000)
    expect(dispatchReady(st, 101_000, 1000)).toBe(true); // slot novo começou
  });

  it("dispatch atrasado NÃO desloca o grid (auto-corretivo — mata o estado absorvente)", () => {
    // Despachou TARDE dentro do slot (tick com jitter): o próximo slot continua em
    // 101_000, não em lastSentAt+roundMs=101_900 (a regra relativa re-alinhava aqui).
    const st = { ...base(), lastSentAt: 100_900 };
    expect(dispatchReady(st, 101_050, 1000)).toBe(true);
  });

  it("fase áurea desloca o grid da câmera (staggerIndex 1 → fase 618ms)", () => {
    const st = { ...base(), staggerIndex: 1, lastSentAt: 100_700 }; // slot próprio [100_618, 101_618)
    expect(dispatchReady(st, 101_500, 1000)).toBe(false); // ainda no mesmo slot DELA
    expect(dispatchReady(st, 101_650, 1000)).toBe(true); // 101_618 passou → slot novo
  });

  it("usa st.roundMs (câmera com linha @2fps) e cai no default quando ausente", () => {
    const linha = { ...base(), roundMs: 500, lastSentAt: 100_100 };
    expect(dispatchReady(linha, 100_600, 1000)).toBe(true); // grid de 500: slot 201 > 200
    const semRound = { ...base(), roundMs: 0, lastSentAt: 100_100 }; // default 1000: mesmo slot
    expect(dispatchReady(semRound, 100_600, 1000)).toBe(false);
  });

  it("estado sem staggerIndex (legado) → fase 0, grid em múltiplos de roundMs", () => {
    const st = { ...base(), staggerIndex: undefined, lastSentAt: 100_100 };
    expect(dispatchReady(st, 100_900, 1000)).toBe(false);
    expect(dispatchReady(st, 101_000, 1000)).toBe(true);
  });
});

describe("staggerPhaseMs — fase áurea por índice (espalhamento livre de colisão)", () => {
  // Menor distância CIRCULAR entre fases vizinhas dentro do round (inclui o wrap).
  function minCircularGap(phases, roundMs) {
    const s = [...phases].sort((a, b) => a - b);
    let min = Infinity;
    for (let i = 0; i < s.length; i++) {
      const gap = i === s.length - 1 ? s[0] + roundMs - s[i] : s[i + 1] - s[i];
      min = Math.min(min, gap);
    }
    return min;
  }

  it("é determinística e fica em [0, roundMs)", () => {
    for (let i = 0; i < 40; i++) {
      const ph = staggerPhaseMs(i, 1000);
      expect(ph).toBe(staggerPhaseMs(i, 1000));
      expect(ph).toBeGreaterThanOrEqual(0);
      expect(ph).toBeLessThan(1000);
    }
  });

  it("3 câmeras @1000ms (regime da bancada): fases 0/618/236 — mín distância 236ms, na ordem do pulso de inferência (~240ms tier N)", () => {
    const phases = [0, 1, 2].map((i) => staggerPhaseMs(i, 1000));
    expect(phases).toEqual([0, 618, 236]);
    expect(minCircularGap(phases, 1000)).toBe(236); // frente2: fila p95 259→2ms com esse espalhamento
  });

  it("até 13 câmeras @1000ms: todas distintas, vizinhas ≥56ms (> tick de 50ms — nunca 2 no mesmo tick)", () => {
    const phases = Array.from({ length: 13 }, (_, i) => staggerPhaseMs(i, 1000));
    expect(new Set(phases).size).toBe(13); // zero colisão (hash % roundMs colidiu a 36ms com 2 câmeras)
    expect(minCircularGap(phases, 1000)).toBeGreaterThanOrEqual(56);
  });

  it("roundMs novo re-deriva a fase na MESMA fração áurea (foco/linha muda a cadência)", () => {
    for (const i of [0, 1, 2, 3, 4]) {
      // fração do round preservada entre grids (±arredondamento de 1ms)
      expect(Math.abs(staggerPhaseMs(i, 500) / 500 - staggerPhaseMs(i, 1000) / 1000)).toBeLessThan(0.005);
    }
    // espalhamento se mantém no grid novo: 3 câmeras que caem p/ 500ms (linha @2fps)
    const phases = [0, 1, 2].map((i) => staggerPhaseMs(i, 500));
    expect(phases).toEqual([0, 309, 118]);
    expect(minCircularGap(phases, 500)).toBe(118);
  });

  it("entradas degeneradas não explodem: índice ausente/negativo → fase 0; roundMs inválido → [0,1)", () => {
    expect(staggerPhaseMs(undefined, 1000)).toBe(0);
    expect(staggerPhaseMs(-3, 1000)).toBe(0);
    expect(staggerPhaseMs(2, 0)).toBe(0);
    expect(staggerPhaseMs(2, undefined)).toBe(0);
  });
});

describe("dispatchReady — slot absoluto NÃO re-alinha sob jitter (a matemática do protótipo da frente 2)", () => {
  // Simulação determinística do tick de produção: relógio de 50ms com atraso
  // ocasional (event loop ocupado por decode do gate/IPC/GC — frente2 §1), câmeras
  // SEMPRE com frame novo (último-vence) e lastSentAt=now na avaliação (como
  // gateAndDispatch). `eligible` é a regra sob teste.
  function lcg(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  }
  function simulate({ eligible, cams, minutes = 10, tickMs = 50, seed = 7, delayEvery = 0.05, delayMin = 20, delayMax = 140 }) {
    const rnd = lcg(seed);
    const dispatches = cams.map(() => []);
    const end = minutes * 60_000;
    let now = 0;
    while (now < end) {
      now += tickMs + (rnd() < delayEvery ? delayMin + rnd() * (delayMax - delayMin) : 0);
      for (let i = 0; i < cams.length; i++) {
        if (eligible(cams[i], now)) {
          cams[i].lastSentAt = now;
          dispatches[i].push(now);
        }
      }
    }
    return dispatches;
  }
  // Rodadas "conjuntas": ≥2 câmeras despachando no MESMO tick (o alinhamento do serrote).
  function jointRounds(dispatches, sinceMs = 0) {
    const seen = new Map();
    for (const times of dispatches)
      for (const t of times) if (t >= sinceMs) seen.set(t, (seen.get(t) || 0) + 1);
    let joint = 0;
    for (const n of seen.values()) if (n >= 2) joint += 1;
    return joint;
  }
  const mkCam = (i, roundMs = 1000) => ({
    fadiga: false,
    slots: createInflightSlots(),
    maxInflight: 1,
    latest: { buf: {} },
    lastSentAt: 0,
    staggerIndex: i,
    roundMs,
  });
  const MAX_TICK_GAP = 50 + 140; // pior avaliação possível: tick + atraso máximo simulado

  it("10min de jitter: fase preservada (offset ≤ tick+atraso), ZERO rodadas conjuntas, frequência exata", () => {
    const cams = [0, 1, 2].map((i) => mkCam(i));
    const ds = simulate({ eligible: (st, now) => dispatchReady(st, now, 1000), cams });
    ds.forEach((times, i) => {
      const ph = staggerPhaseMs(i, 1000);
      for (const t of times) {
        // o despacho cai no COMEÇO do slot próprio: um tick atrasado adia ESTE
        // despacho, mas o grid (a fase) não anda — auto-corretivo
        const off = (((t - ph) % 1000) + 1000) % 1000;
        expect(off).toBeLessThan(MAX_TICK_GAP + 5);
      }
      // o fix muda a FASE, não a frequência: 1 despacho por slot de 1000ms
      expect(Math.abs(times.length - 600)).toBeLessThanOrEqual(2);
    });
    expect(jointRounds(ds)).toBe(0); // nunca 2 câmeras no mesmo tick — sem rajada, sem fila
  });

  it("a regra RELATIVA antiga COLAPSA sob o MESMO jitter (estado absorvente — prova de sensibilidade do sensor)", () => {
    // Nascem perfeitamente espalhadas (0/333/666ms) e mesmo assim re-alinham: uma
    // vez 2 câmeras no mesmo tick, lastSentAt idêntico as prende juntas p/ sempre.
    const cams = [0, 1, 2].map((i) => ({ ...mkCam(i), lastSentAt: -1000 + i * 333 }));
    const relative = (st, now) => now - st.lastSentAt >= st.roundMs;
    const ds = simulate({ eligible: relative, cams });
    // último minuto: rodadas conjuntas abundantes (colapsado) — o slot absoluto dá 0
    expect(jointRounds(ds, 9 * 60_000)).toBeGreaterThan(20);
  });

  it("mudança de roundMs (foco/linha) re-deriva a fase no ato — grid novo, sem colidir com a vizinha", () => {
    const st1 = mkCam(1); // fase 618 @1000 → 309 @500
    const st2 = mkCam(2); // fase 236 @1000 → 118 @500
    const after = { a: [], b: [] };
    let now = 0;
    for (let k = 0; k < 400; k++) {
      now += 50; // sem jitter: isola o efeito da troca de cadência
      if (now === 10_000) {
        st1.roundMs = 500; // câmera ganhou linha/foco: cadência sobe p/ 2fps
        st2.roundMs = 500;
      }
      for (const [st, out] of [[st1, after.a], [st2, after.b]]) {
        if (dispatchReady(st, now, 1000)) {
          st.lastSentAt = now;
          if (now > 10_000) out.push(now);
        }
      }
    }
    // despachos caem no grid NOVO com a fase RE-DERIVADA (500k+309 e 500k+118)
    for (const t of after.a) expect((((t - 309) % 500) + 500) % 500).toBeLessThan(55);
    for (const t of after.b) expect((((t - 118) % 500) + 500) % 500).toBeLessThan(55);
    // cadência dobrou de fato (~2 despachos/s no trecho a 500ms)
    expect(after.a.length).toBeGreaterThanOrEqual(18);
    expect(after.b.length).toBeGreaterThanOrEqual(18);
    // e as duas seguem sem rodada conjunta (fases 309/118: distância 191ms > tick)
    const setA = new Set(after.a);
    for (const t of after.b) expect(setA.has(t)).toBe(false);
  });
});
