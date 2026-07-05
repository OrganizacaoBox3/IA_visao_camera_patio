// ─────────────────────────────────────────────────────────────────────────────
// automask.js — Auto-máscara de exclusão APRENDIDA (Fase 4). PURO/determinístico.
//
// Extraído de engine.js (R5/retrofit): a estatística de "célula do grid é objeto fixo
// lido como pessoa?" é lógica pura (Welford por célula) — merece módulo próprio E teste
// (fecha o gap do coração do produto: automask.test.js). O engine só orquestra (chama
// amObserve por detecção, evaluateAutoMask ao fim da janela) e desenha o status.
//
// ANALYSIS_AUTOMASK: ausente/"suggest"/"sug"/"learn" (DEFAULT — aprende + expõe a sugestão em
//    status() + loga, mas NÃO suprime nada — transparência sem risco: é a BASE SEGURA por só
//    OBSERVAR, sem LGPD nem esconder pessoa; caminho RECOMENDADO p/ validar contra a realidade);
//   "off"/"0"/"false" (feature OFF — nada aprende, nada suprime, custo zero — escape hatch);
//   "hide"/"1"/"on" (aprende + SUPRIME as células aprendidas + loga — como a zona de exclusão
//    manual, mas APRENDIDA). Aprende a célula do grid onde há detecção de pessoa PRESENTE
//   ~100% do tempo E com bbox quase ESTÁTICO por uma janela ≥10min = objeto fixo lido como
//   pessoa no piso de score (acuracia-modelos.md §2: 47-86% dos FP são poucos objetos fixos).
//   CONSERVADOR de propósito: pessoa real num posto AINDA varia (pé/tronco oscilam, ela sai
//   de quadro); objeto fixo não. Por isso o gate é presença altíssima + jitter baixíssimo +
//   janela longa. Auto-suprimir ("hide") é o modo ARRISCADO (pode esconder pessoa quase imóvel)
//   → permanece OPT-IN consciente. Só o observar-e-logar ("suggest") é o default.
//
// ENV SPRAWL (R5/A — env sprawl da auto-máscara): grid e janela (AM_COLS/AM_ROWS/AM_WIN_MS/
// AM_MIN_ROUNDS) e o gate de presença (AM_PRESENT) eram env sem caso de uso medido — agora
// são CONSTANTES (YAGNI: knob que ninguém mede é ruído de config). Restam DOIS env: o MODO
// (ANALYSIS_AUTOMASK — decisão de risco off/suggest/hide) e AM_JITTER (ANALYSIS_AUTOMASK_JITTER
// — o único threshold que muda com a resolução/tremor da câmera e vale calibrar em campo).
// Os defaults são os MESMOS de antes → comportamento default byte-a-byte inalterado.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const AUTOMASK_RAW = String(process.env.ANALYSIS_AUTOMASK || "suggest").toLowerCase();
const AUTOMASK_MODE = /^(1|on|hide|true)$/.test(AUTOMASK_RAW)
  ? "hide"
  : /^(suggest|sug|learn)$/.test(AUTOMASK_RAW)
    ? "suggest"
    : "off";
const AUTOMASK_ON = AUTOMASK_MODE !== "off";
// Grid/janela FIXOS (R5/A): antes ANALYSIS_AUTOMASK_COLS/ROWS/WIN_MS/PRESENT/MIN_ROUNDS.
const AM_COLS = 24; // colunas do grid de aprendizado
const AM_ROWS = 18; // linhas do grid de aprendizado
const AM_WIN_MS = 600_000; // janela de aprendizado (≥10min)
const AM_PRESENT = 0.97; // fração da janela com presença p/ ser "objeto fixo"
const AM_MIN_ROUNDS = 120; // rodadas mínimas na janela/célula antes de decidir
// AM_JITTER segue env (ANALYSIS_AUTOMASK_JITTER): std norm máx p/ "fixo" — o único knob que
// depende da câmera (resolução/tremor) e que vale calibrar contra a realidade em campo.
const AM_JITTER = Math.max(0.001, Number(process.env.ANALYSIS_AUTOMASK_JITTER) || 0.02);

// ── Auto-máscara: estado por câmera + observação/avaliação (Fase 4) ──────────
function createAutoMask() {
  // cells: cellIndex → { present, n, mean:[fx,fy,w,h], m2:[...] } (Welford p/ variância).
  return { rounds: 0, windowStart: Date.now(), cells: new Map(), suppressed: new Set(), suggestions: [] };
}
/** célula do grid AM p/ um ponto NORMALIZADO (o PÉ da detecção — igual à zona de exclusão). */
function amCell(fx, fy) {
  const c = Math.min(AM_COLS - 1, Math.max(0, Math.floor(fx * AM_COLS)));
  const r = Math.min(AM_ROWS - 1, Math.max(0, Math.floor(fy * AM_ROWS)));
  return r * AM_COLS + c;
}
/** acumula uma observação (pé + tamanho do bbox) na célula; marca presença desta rodada. */
function amObserve(am, cell, vals, roundCells) {
  roundCells.add(cell);
  let c = am.cells.get(cell);
  if (!c) am.cells.set(cell, (c = { present: 0, n: 0, mean: [0, 0, 0, 0], m2: [0, 0, 0, 0] }));
  c.n += 1;
  for (let k = 0; k < 4; k++) {
    const delta = vals[k] - c.mean[k];
    c.mean[k] += delta / c.n;
    c.m2[k] += delta * (vals[k] - c.mean[k]);
  }
}
/** Fim da janela: reavalia quais células são objeto fixo, loga transições, reinicia a janela. */
function evaluateAutoMask(st, now) {
  const am = st.autoMask;
  const prev = am.suppressed;
  const next = new Set();
  const suggestions = [];
  for (const [cell, c] of am.cells) {
    if (c.n < AM_MIN_ROUNDS) continue; // pouca amostra → não decide
    const presentPct = c.present / am.rounds;
    if (presentPct < AM_PRESENT) continue; // não está presente ~100% do tempo → não é objeto fixo
    const std0 = Math.sqrt(c.m2[0] / c.n);
    const std1 = Math.sqrt(c.m2[1] / c.n);
    const std2 = Math.sqrt(c.m2[2] / c.n);
    const std3 = Math.sqrt(c.m2[3] / c.n);
    const jitter = Math.max(std0, std1, std2, std3);
    if (jitter > AM_JITTER) continue; // ainda VARIA (pé/tamanho oscilam) → provável pessoa real
    next.add(cell);
    suggestions.push({ cell, presentPct, jitter });
  }
  for (const cell of next) {
    if (prev.has(cell)) continue; // já conhecida — só loga a novidade
    const col = cell % AM_COLS;
    const row = Math.floor(cell / AM_COLS);
    const c = am.cells.get(cell);
    console.log(
      `[analysis:${st.id}] auto-máscara ${AUTOMASK_MODE === "hide" ? "SUPRIMINDO" : "SUGESTÃO"} ` +
        `célula (${col},${row}) ~${Math.round(((col + 0.5) / AM_COLS) * 100)}%,${Math.round(((row + 0.5) / AM_ROWS) * 100)}% ` +
        `— presente ${Math.round((c.present / am.rounds) * 100)}% da janela (${Math.round(AM_WIN_MS / 60000)}min), objeto fixo provável`,
    );
  }
  am.suppressed = next;
  am.suggestions = suggestions;
  // reinicia a janela: re-aprende do zero → objeto que SOME deixa de ser reaprendido e a
  // supressão cai na próxima avaliação (adaptativo, com atraso de até uma janela).
  am.cells = new Map();
  am.rounds = 0;
  am.windowStart = now;
}

module.exports = {
  createAutoMask,
  amCell,
  amObserve,
  evaluateAutoMask,
  AM_COLS,
  AM_ROWS,
  AM_WIN_MS,
  AM_PRESENT,
  AM_MIN_ROUNDS,
  AM_JITTER,
  AUTOMASK_MODE,
  AUTOMASK_ON,
  AUTOMASK_RAW,
};
