// Testes da auto-máscara aprendida (Welford) — o "coração" da calibração da Fase 4 que
// vivia sem teste em engine.js (auditoria-qualidade-codigo.md: god-module SEM teste).
// Extraída p/ automask.js (PURO/determinístico); aqui provamos o gate: presença altíssima +
// jitter baixíssimo + janela longa → SUGERE/SUPRIME; qualquer um violado → NÃO decide.
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createAutoMask,
  amCell,
  amObserve,
  evaluateAutoMask,
  AM_COLS,
  AM_ROWS,
  AM_PRESENT,
  AM_JITTER,
  AM_MIN_ROUNDS,
  AUTOMASK_MODE,
  AUTOMASK_ON,
} = require("./automask");

// Simula N rodadas de OBSERVAÇÃO de uma célula (mesma mecânica de engine.processDets):
// observa vals, incrementa am.rounds e marca presença 1×/rodada/célula. `presentRounds`
// controla em quantas dessas rodadas a célula esteve presente (default: todas).
function observe(am, vals, rounds, { presentRounds = rounds, valsAt } = {}) {
  for (let i = 0; i < rounds; i++) {
    const present = i < presentRounds;
    const roundCells = new Set();
    const v = valsAt ? valsAt(i) : vals;
    if (present) {
      const cell = amCell(v[0], v[1]);
      amObserve(am, cell, v, roundCells);
    }
    am.rounds += 1;
    for (const cell of roundCells) am.cells.get(cell).present += 1;
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

describe("amObserve — acumulação de Welford (média/variância on-line)", () => {
  it("média corre p/ o valor observado; variância zero p/ valores idênticos", () => {
    const am = createAutoMask();
    const roundCells = new Set();
    const cell = amCell(0.3, 0.7);
    for (let i = 0; i < 10; i++) amObserve(am, cell, [0.3, 0.7, 0.1, 0.2], roundCells);
    const c = am.cells.get(cell);
    expect(c.n).toBe(10);
    expect(c.mean).toEqual([0.3, 0.7, 0.1, 0.2]);
    expect(c.m2).toEqual([0, 0, 0, 0]); // sem variância → objeto perfeitamente estático
    expect(roundCells.has(cell)).toBe(true);
  });
  it("m2/n reproduz a variância populacional de um conjunto conhecido", () => {
    const am = createAutoMask();
    const cell = amCell(0.3, 0.7);
    // fx ∈ {0.30, 0.32}: média 0.31, variância populacional = 0.0001 (std=0.01)
    const seq = [0.3, 0.32, 0.3, 0.32];
    for (const fx of seq) amObserve(am, cell, [fx, 0.7, 0.1, 0.2], new Set());
    const c = am.cells.get(cell);
    expect(c.mean[0]).toBeCloseTo(0.31, 9);
    expect(Math.sqrt(c.m2[0] / c.n)).toBeCloseTo(0.01, 9);
  });
});

describe("evaluateAutoMask — gate objeto-fixo (presença + jitter + janela)", () => {
  let st;
  let logSpy;
  beforeEach(() => {
    st = { id: "camT", autoMask: createAutoMask() };
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());

  it("presença ~100% + jitter ~0 + rodadas suficientes → SUGERE a célula", () => {
    const cell = amCell(0.5, 0.5);
    observe(st.autoMask, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS + 10); // estático, presente sempre
    evaluateAutoMask(st, Date.now());
    expect(st.autoMask.suppressed.has(cell)).toBe(true);
    expect(st.autoMask.suggestions).toHaveLength(1);
    expect(st.autoMask.suggestions[0].cell).toBe(cell);
    expect(st.autoMask.suggestions[0].presentPct).toBe(1);
    expect(st.autoMask.suggestions[0].jitter).toBe(0);
  });

  it("jitter ALTO (bbox oscila > AM_JITTER) → NÃO decide (provável pessoa real)", () => {
    // fx/fy fixos (mesma célula) mas LARGURA alterna 0.1/0.2 → std=0.05 > AM_JITTER(0.02).
    observe(st.autoMask, null, AM_MIN_ROUNDS + 10, {
      valsAt: (i) => [0.5, 0.5, i % 2 ? 0.2 : 0.1, 0.2],
    });
    // pré-condição do cenário: o jitter realmente excede o gate
    const cell = amCell(0.5, 0.5);
    const c = st.autoMask.cells.get(cell);
    expect(Math.sqrt(c.m2[0] / c.n)).toBe(0); // fx estável
    expect(Math.sqrt(c.m2[2] / c.n)).toBeGreaterThan(AM_JITTER); // largura tremula
    evaluateAutoMask(st, Date.now());
    expect(st.autoMask.suppressed.size).toBe(0);
    expect(st.autoMask.suggestions).toHaveLength(0);
  });

  it("presença BAIXA (< AM_PRESENT) mesmo com jitter ~0 → NÃO decide", () => {
    // 130 presenças / 200 rodadas = 0.65 < AM_PRESENT(0.97); n=130 ≥ AM_MIN_ROUNDS.
    observe(st.autoMask, [0.5, 0.5, 0.1, 0.2], 200, { presentRounds: 130 });
    const c = st.autoMask.cells.get(amCell(0.5, 0.5));
    expect(c.n).toBe(130);
    expect(c.present / st.autoMask.rounds).toBeLessThan(AM_PRESENT);
    evaluateAutoMask(st, Date.now());
    expect(st.autoMask.suppressed.size).toBe(0);
    expect(st.autoMask.suggestions).toHaveLength(0);
  });

  it("amostra INSUFICIENTE (n < AM_MIN_ROUNDS) → NÃO decide mesmo presente 100%", () => {
    observe(st.autoMask, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS - 1); // estático mas pouca janela
    evaluateAutoMask(st, Date.now());
    expect(st.autoMask.suppressed.size).toBe(0);
    expect(st.autoMask.suggestions).toHaveLength(0);
  });

  it("reinicia a janela: zera cells/rounds e reposiciona windowStart", () => {
    observe(st.autoMask, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS + 10);
    const now = Date.now();
    evaluateAutoMask(st, now);
    expect(st.autoMask.cells.size).toBe(0);
    expect(st.autoMask.rounds).toBe(0);
    expect(st.autoMask.windowStart).toBe(now);
  });

  it("adaptativo: objeto que SOME deixa de ser reaprendido → supressão cai na 2ª janela", () => {
    // Janela 1: objeto fixo presente → suprimido.
    observe(st.autoMask, [0.5, 0.5, 0.1, 0.2], AM_MIN_ROUNDS + 10);
    evaluateAutoMask(st, Date.now());
    expect(st.autoMask.suppressed.size).toBe(1);
    // Janela 2: nada observado (objeto sumiu) → next vazio → supressão cai.
    evaluateAutoMask(st, Date.now());
    expect(st.autoMask.suppressed.size).toBe(0);
    expect(st.autoMask.suggestions).toHaveLength(0);
  });
});

describe("configuração default (env sprawl reduzido — R5/A)", () => {
  it("modo default é 'hide' (decisão de produto: auto-esconde o fantasma fixo; zero interação) e ON", () => {
    expect(AUTOMASK_MODE).toBe("hide");
    expect(AUTOMASK_ON).toBe(true);
  });
  it("grid/janela fixados nos defaults históricos (constantes, não mais env)", () => {
    expect(AM_COLS).toBe(24);
    expect(AM_ROWS).toBe(18);
    expect(AM_PRESENT).toBe(0.97);
    expect(AM_MIN_ROUNDS).toBe(120);
    expect(AM_JITTER).toBe(0.02); // env ANALYSIS_AUTOMASK_JITTER preservado (default 0.02)
  });
});
