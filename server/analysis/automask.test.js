// Testes da auto-máscara aprendida (Welford). Provamos o gate: presença altíssima +
// jitter baixíssimo + janela longa → SUGERE/SUPRIME; qualquer um violado → NÃO decide.
// A mecânica por-rodada passa pelo CONTRATO encapsulado (roundObserver/close) — o
// caller não toca rounds/cells/present (internals Welford são deste módulo).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createAutoMask,
  amCell,
  roundObserver,
  evaluateWindow,
  statusOf,
  AM_COLS,
  AM_ROWS,
  AM_PRESENT,
  AM_JITTER,
  AM_MIN_ROUNDS,
  AUTOMASK_MODE,
  AUTOMASK_ON,
} = require("./automask");

// Simula N RODADAS de observação via o contrato público (1 observer por rodada).
// `presentRounds` controla em quantas a célula esteve presente (default: todas).
// close() usa um relógio ancorado em windowStart → nunca vence a janela aqui
// (a avaliação é chamada explicitamente nos testes).
function observeRounds(am, vals, rounds, { presentRounds = rounds, valsAt } = {}) {
  const t0 = am.windowStart;
  for (let i = 0; i < rounds; i++) {
    const obs = roundObserver(am);
    const v = valsAt ? valsAt(i) : vals;
    if (i < presentRounds) obs.observe(v[0], v[1], v[2], v[3]);
    obs.close(t0 + i, "camT");
  }
}

describe("amCell — ponto normalizado → índice de célula do grid", () => {
  it("mapeia canto superior-esquerdo p/ 0 e clampa negativos", () => {
    expect(amCell(0, 0)).toBe(0);
    expect(amCell(-1, -1)).toBe(0); // clamp inferior
  });
  it("mapeia canto inferior-direito p/ a última célula e clampa >1", () => {
    const last = (AM_ROWS - 1) * AM_COLS + (AM_COLS - 1);
    expect(amCell(0.999, 0.999)).toBe(last);
    expect(amCell(1.5, 1.5)).toBe(last); // clamp superior
  });
  it("linha·coluna: célula = row*COLS + col", () => {
    // centro (0.5,0.5) → col=floor(0.5*24)=12, row=floor(0.5*18)=9
    expect(amCell(0.5, 0.5)).toBe(9 * AM_COLS + 12);
  });
});

describe("roundObserver — acumulação de Welford + presença 1×/rodada", () => {
  it("média corre p/ o valor observado; variância zero p/ valores idênticos", () => {
    const am = createAutoMask();
    const cell = amCell(0.3, 0.7);
    const obs = roundObserver(am);
    for (let i = 0; i < 10; i++) obs.observe(0.3, 0.7, 0.1, 0.2); // 10 dets na MESMA rodada
    obs.close(am.windowStart, "camT");
    const c = am.cells.get(cell);
    expect(c.n).toBe(10);
    expect(c.mean).toEqual([0.3, 0.7, 0.1, 0.2]);
    expect(c.m2).toEqual([0, 0, 0, 0]); // sem variância → objeto perfeitamente estático
    expect(c.present).toBe(1); // presença é POR RODADA, não por detecção
    expect(am.rounds).toBe(1);
  });
  it("m2/n reproduz a variância populacional de um conjunto conhecido", () => {
    const am = createAutoMask();
    const cell = amCell(0.3, 0.7);
    // fx ∈ {0.30, 0.32}: média 0.31, variância populacional = 0.0001 (std=0.01)
    const obs = roundObserver(am);
    for (const fx of [0.3, 0.32, 0.3, 0.32]) obs.observe(fx, 0.7, 0.1, 0.2);
    const c = am.cells.get(cell);
    expect(c.mean[0]).toBeCloseTo(0.31, 9);
    expect(Math.sqrt(c.m2[0] / c.n)).toBeCloseTo(0.01, 9);
  });
  it("observe responde SUPRIMIR (modo hide) só p/ célula já aprendida como fixa", () => {
    const am = createAutoMask();
    expect(roundObserver(am).observe(0.5, 0.5, 0.1, 0.2)).toBe(false); // nada aprendido ainda
    am.suppressed.add(amCell(0.5, 0.5)); // célula marcada (como após uma janela)
    expect(roundObserver(am).observe(0.5, 0.5, 0.1, 0.2)).toBe(true); // hide → suprime
    expect(roundObserver(am).observe(0.9, 0.9, 0.1, 0.2)).toBe(false); // outra célula segue
  });
});

describe("evaluateWindow — gate objeto-fixo (presença + jitter + janela)", () => {
  let am;
  let logSpy;
  beforeEach(() => {
    am = createAutoMask();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it("presença ~100% + jitter ~0 + rodadas suficientes → SUGERE a célula", () => {
    const cell = amCell(0.5, 0.5);
    observeRounds(am, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS + 10); // estático, presente sempre
    evaluateWindow(am, Date.now(), "camT");
    expect(am.suppressed.has(cell)).toBe(true);
    expect(am.suggestions).toHaveLength(1);
    expect(am.suggestions[0].cell).toBe(cell);
    expect(am.suggestions[0].presentPct).toBe(1);
    expect(am.suggestions[0].jitter).toBe(0);
  });

  it("jitter ALTO (bbox oscila > AM_JITTER) → NÃO decide (provável pessoa real)", () => {
    // fx/fy fixos (mesma célula) mas LARGURA alterna 0.1/0.2 → std=0.05 > AM_JITTER(0.02).
    observeRounds(am, null, AM_MIN_ROUNDS + 10, {
      valsAt: (i) => [0.5, 0.5, i % 2 ? 0.2 : 0.1, 0.2],
    });
    // pré-condição do cenário: o jitter realmente excede o gate
    const c = am.cells.get(amCell(0.5, 0.5));
    expect(Math.sqrt(c.m2[0] / c.n)).toBe(0); // fx estável
    expect(Math.sqrt(c.m2[2] / c.n)).toBeGreaterThan(AM_JITTER); // largura tremula
    evaluateWindow(am, Date.now(), "camT");
    expect(am.suppressed.size).toBe(0);
    expect(am.suggestions).toHaveLength(0);
  });

  it("presença BAIXA (< AM_PRESENT) mesmo com jitter ~0 → NÃO decide", () => {
    // 130 presenças / 200 rodadas = 0.65 < AM_PRESENT(0.97); n=130 ≥ AM_MIN_ROUNDS.
    observeRounds(am, [0.5, 0.5, 0.1, 0.2], 200, { presentRounds: 130 });
    const c = am.cells.get(amCell(0.5, 0.5));
    expect(c.n).toBe(130);
    expect(c.present / am.rounds).toBeLessThan(AM_PRESENT);
    evaluateWindow(am, Date.now(), "camT");
    expect(am.suppressed.size).toBe(0);
    expect(am.suggestions).toHaveLength(0);
  });

  it("amostra INSUFICIENTE (n < AM_MIN_ROUNDS) → NÃO decide mesmo presente 100%", () => {
    observeRounds(am, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS - 1); // estático mas pouca janela
    evaluateWindow(am, Date.now(), "camT");
    expect(am.suppressed.size).toBe(0);
    expect(am.suggestions).toHaveLength(0);
  });

  it("reinicia a janela: zera cells/rounds e reposiciona windowStart", () => {
    observeRounds(am, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS + 10);
    const now = Date.now();
    evaluateWindow(am, now, "camT");
    expect(am.cells.size).toBe(0);
    expect(am.rounds).toBe(0);
    expect(am.windowStart).toBe(now);
  });

  it("adaptativo: objeto que SOME deixa de ser reaprendido → supressão cai na 2ª janela", () => {
    // Janela 1: objeto fixo presente → suprimido.
    observeRounds(am, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS + 10);
    evaluateWindow(am, Date.now(), "camT");
    expect(am.suppressed.size).toBe(1);
    // Janela 2: nada observado (objeto sumiu) → next vazio → supressão cai.
    evaluateWindow(am, Date.now(), "camT");
    expect(am.suppressed.size).toBe(0);
    expect(am.suggestions).toHaveLength(0);
  });

  it("close() do observer dispara a avaliação quando a janela VENCE (fio que o engine puxava)", () => {
    const cell = amCell(0.5, 0.5);
    observeRounds(am, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS + 10);
    // rodada final com now além da janela → close avalia sozinho (sem evaluateWindow explícito)
    const obs = roundObserver(am);
    obs.observe(0.5, 0.5, 0.1, 0.2);
    obs.close(am.windowStart + 600_000, "camT");
    expect(am.suppressed.has(cell)).toBe(true);
    expect(am.rounds).toBe(0); // janela reiniciada
  });
});

describe("statusOf — apresentação p/ o status() (célula → rect normalizado)", () => {
  it("converte sugestões em rects prontos p/ desenhar/pintar zona manual", () => {
    const am = createAutoMask();
    const cell = 9 * AM_COLS + 12; // (col 12, row 9)
    am.suggestions = [{ cell, presentPct: 0.987, jitter: 0.0123 }];
    am.suppressed = new Set([cell]);
    const s = statusOf(am);
    expect(s.mode).toBe(AUTOMASK_MODE);
    expect(s.suppressed).toBe(AUTOMASK_MODE === "hide" ? 1 : 0);
    expect(s.suggestions).toEqual([
      {
        x: 12 / AM_COLS,
        y: 9 / AM_ROWS,
        w: 1 / AM_COLS,
        h: 1 / AM_ROWS,
        presentPct: 0.99, // arredondado a 2 casas
        jitter: 0.012, // arredondado a 3 casas
      },
    ]);
  });
});

describe("configuração default", () => {
  it("modo default é 'hide' (decisão de produto: auto-esconde o fantasma fixo; zero interação) e ON", () => {
    expect(AUTOMASK_MODE).toBe("hide");
    expect(AUTOMASK_ON).toBe(true);
  });
  it("grid/janela fixados nos defaults calibrados (constantes, não env)", () => {
    expect(AM_COLS).toBe(24);
    expect(AM_ROWS).toBe(18);
    expect(AM_PRESENT).toBe(0.97);
    expect(AM_MIN_ROUNDS).toBe(120);
    expect(AM_JITTER).toBe(0.02); // env ANALYSIS_AUTOMASK_JITTER preservado (default 0.02)
  });
});
