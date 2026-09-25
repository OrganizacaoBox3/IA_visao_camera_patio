// ─────────────────────────────────────────────────────────────────────────────
// automask.js — Auto-máscara de exclusão APRENDIDA. PURO/determinístico (testado).
//
// O QUE GARANTE: célula do grid onde há detecção de pessoa PRESENTE ~100% do tempo
// E com bbox quase ESTÁTICO por uma janela ≥10min = objeto fixo lido como pessoa no
// piso de score (47-86% dos FP são poucos objetos fixos — acuracia-modelos.md §2).
// SEGURANÇA do auto-esconder: gate CONSERVADOR (presença altíssima + jitter
// baixíssimo + janela longa) — pessoa real num posto AINDA varia (pé/tronco oscilam,
// sai de quadro); objeto fixo não. A máscara é ADAPTATIVA (reavaliada a cada janela):
// célula que volta a ter movimento perde a supressão sozinha — não fica cego a quem
// anda. Tudo é logado e contado (automasked1m em status()) — nada some em silêncio.
//
// CONTRATO (o caller NÃO toca os internals Welford — rounds/cells/present):
//   createAutoMask(overrides?) → estado por câmera (opaco). `overrides` = decisões
//     PERSISTIDAS do operador (automask-store.js), no formato `{ [cell]: {decision} }` —
//     carregadas no boot/criação do estado, não recarregadas sozinhas depois (ver
//     applyOverride p/ o caminho ao vivo).
//   roundObserver(am) → { observe(fx,fy,w,h) → bool (true = SUPRIMIR esta det),
//                         close(now, camId) } — 1 observer por RODADA; observe
//     APRENDE de TODAS as dets (mesmo as suprimidas: objeto ainda presente segue
//     confirmado; quando some, deixa de ser reaprendido e a supressão cai);
//     close fecha a rodada e reavalia a janela quando vence.
//   statusOf(am) → { mode, suppressed, suggestions:[{cell,x,y,w,h,…,decision?}] }
//     (rects normalizados, prontos p/ o operador pintar uma zona manual ali OU
//     confirmar/corrigir a sugestão — `decision` ecoa o override já gravado).
//   applyOverride(am, cell, decision) / clearOverride(am, cell) → aplica AO VIVO a
//     decisão do operador (chamado pela rota; automask-store.js já persistiu antes).
//     CORREÇÃO EM DOIS SENTIDOS (2026-09-24) — evita manequim/foto/TV/boneco lido como
//     pessoa SEM cegar quem fica parado de verdade (guarda de posto):
//       "falsoPositivo" → suprime JÁ, sem esperar AM_CONFIRM_WINDOWS (o operador viu
//                          que é objeto fixo; a estatística só confirmaria o óbvio).
//       "correto"       → NUNCA suprime esta célula, mesmo que a estatística volte a
//                          qualificar — o operador tem a palavra final sobre a própria imagem.
//
// ANALYSIS_AUTOMASK — default "hide" (decisão de produto: o fantasma de objeto fixo
// some sozinho, zero interação): "suggest" aprende+expõe sem suprimir (observar-e-
// validar); "off" desliga (custo zero). Grid/janela/presença são CONSTANTES (knob
// que ninguém mede é ruído de config); só AM_JITTER segue env — é o único threshold
// que muda com resolução/tremor da câmera e vale calibrar em campo.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const AUTOMASK_RAW = String(process.env.ANALYSIS_AUTOMASK || "hide").toLowerCase();
const AUTOMASK_MODE = /^(1|on|hide|true)$/.test(AUTOMASK_RAW)
  ? "hide"
  : /^(suggest|sug|learn)$/.test(AUTOMASK_RAW)
    ? "suggest"
    : "off";
const AUTOMASK_ON = AUTOMASK_MODE !== "off";
const AM_COLS = 24; // colunas do grid de aprendizado
const AM_ROWS = 18; // linhas do grid de aprendizado
const AM_WIN_MS = 600_000; // janela de aprendizado (≥10min)
const AM_PRESENT = 0.97; // fração da janela com presença p/ ser "objeto fixo"
// Amostra mínima na janela/célula antes de decidir.
//
// ERA 120 — e isso MATAVA o mecanismo nesta operação (medido 2026-09-04): a contagem de
// rodadas é de INFERÊNCIA (pipeline.processRound), e com 26 câmeras dividindo os workers a
// cadência real por câmera fica em 0,05-0,32 fps → 30 a 192 rodadas numa janela de 10min.
// Abaixo de 120 o `evaluateWindow` NUNCA rodava: nada era aprendido, nada suprimido
// (`autoMask: {suppressed: 0, suggestions: []}` no /api/analysis/status de produção) — e,
// pior, `windowStart` só avançava DENTRO do evaluateWindow, então a janela também nunca
// virava. Resultado: o fantasma de objeto fixo (o FP que o operador vê como "pessoa" onde
// não tem ninguém) ficava para sempre, apesar de existir um mecanismo pronto pra matá-lo.
//
// 20 é alcançável em toda cadência observada (0,05 fps → 30 rodadas/janela). A confiança
// estatística que se perde no tamanho da amostra é RECUPERADA exigindo confirmação em DUAS
// janelas consecutivas (AM_CONFIRM_WINDOWS): mobília qualifica em toda janela; pessoa parada
// num posto quase nunca fica imóvel no MESMO pixel por duas janelas seguidas. Ver o teste
// "pessoa parada 1 janela e depois sai NÃO é suprimida".
const AM_MIN_ROUNDS = 20;
// Janelas CONSECUTIVAS em que a célula precisa qualificar antes de ser suprimida. É o que
// paga a conta da amostra menor (ver acima) — e mantém a adaptatividade: parar de qualificar
// em uma janela derruba a candidatura.
const AM_CONFIRM_WINDOWS = 2;
// std norm máx p/ "fixo" (env ANALYSIS_AUTOMASK_JITTER — ver racional no cabeçalho).
const AM_JITTER = Math.max(0.001, Number(process.env.ANALYSIS_AUTOMASK_JITTER) || 0.02);

/** `raw` (de automask-store.decisionsFor) → Map cell(number) → "correto"|"falsoPositivo".
 *  Entrada corrompida/fora do enum é DESCARTADA (nunca vira override que ninguém explica). */
function normalizeOverrides(raw) {
  const m = new Map();
  for (const [k, v] of Object.entries(raw || {})) {
    const cell = Number(k);
    const decision = v && v.decision;
    if (Number.isInteger(cell) && cell >= 0 && (decision === "correto" || decision === "falsoPositivo"))
      m.set(cell, decision);
  }
  return m;
}

function createAutoMask(overrides) {
  // cells: cellIndex → { present, n, mean:[fx,fy,w,h], m2:[...] } (Welford p/ variância).
  // candidatas: cellIndex → nº de janelas CONSECUTIVAS em que a célula qualificou como fixa
  // (a supressão só entra em AM_CONFIRM_WINDOWS — ver o racional em AM_MIN_ROUNDS).
  return {
    rounds: 0,
    windowStart: Date.now(),
    cells: new Map(),
    candidatas: new Map(),
    suppressed: new Set(),
    suggestions: [],
    overrides: normalizeOverrides(overrides), // decisões do operador — ver applyOverride
  };
}

/** Aplica AO VIVO a decisão do operador (a rota já persistiu via automask-store antes). */
function applyOverride(am, cell, decision) {
  am.overrides.set(cell, decision);
  if (decision === "correto") am.suppressed.delete(cell);
  else if (decision === "falsoPositivo" && AUTOMASK_MODE === "hide") am.suppressed.add(cell);
}

/** Desfaz a decisão — a célula volta a depender só da estatística. */
function clearOverride(am, cell) {
  am.overrides.delete(cell);
}

/** célula do grid AM p/ um ponto NORMALIZADO (o PÉ da detecção — igual à zona de exclusão). */
function amCell(fx, fy) {
  const c = Math.min(AM_COLS - 1, Math.max(0, Math.floor(fx * AM_COLS)));
  const r = Math.min(AM_ROWS - 1, Math.max(0, Math.floor(fy * AM_ROWS)));
  return r * AM_COLS + c;
}

// Acumulação de Welford (média/variância on-line) do pé + tamanho do bbox na célula.
function accumulate(am, cell, vals) {
  let c = am.cells.get(cell);
  if (!c) am.cells.set(cell, (c = { present: 0, n: 0, mean: [0, 0, 0, 0], m2: [0, 0, 0, 0] }));
  c.n += 1;
  for (let k = 0; k < 4; k++) {
    const delta = vals[k] - c.mean[k];
    c.mean[k] += delta / c.n;
    c.m2[k] += delta * (vals[k] - c.mean[k]);
  }
}

/**
 * Observador de UMA rodada de detecção — encapsula a mecânica por-rodada que antes
 * vazava p/ o engine (presença é 1×/rodada/célula, não 1×/detecção).
 * @param {ReturnType<createAutoMask>} am
 * @returns {{ observe(fx,fy,w,h):boolean, close(now:number, camId:string):void }}
 */
function roundObserver(am) {
  const roundCells = new Set(); // células com ≥1 pé NESTA rodada
  return {
    /** Aprende a detecção e responde se ela deve ser SUPRIMIDA (só no modo "hide"). */
    observe(fx, fy, w, h) {
      const cell = amCell(fx, fy);
      roundCells.add(cell);
      accumulate(am, cell, [fx, fy, w, h]);
      // Decisão do OPERADOR tem a palavra final — vem antes da estatística nos dois sentidos.
      const ov = am.overrides.get(cell);
      if (ov === "correto") return false;
      if (ov === "falsoPositivo") return AUTOMASK_MODE === "hide";
      return AUTOMASK_MODE === "hide" && am.suppressed.has(cell);
    },
    /** Fecha a rodada (presenças) e reavalia a janela quando ela vence. */
    close(now, camId) {
      am.rounds += 1;
      for (const cell of roundCells) am.cells.get(cell).present += 1;
      // A janela vira por TEMPO (nunca congela — era o 2º efeito do bug do AM_MIN_ROUNDS:
      // sem avaliar, `windowStart` não avançava e a janela crescia indefinidamente, fazendo
      // `present/rounds` deixar de significar "os últimos 10min"). Amostra insuficiente é
      // decidida DENTRO do evaluateWindow (por célula), que também reinicia a janela.
      if (now - am.windowStart >= AM_WIN_MS) evaluateWindow(am, now, camId);
    },
  };
}

/** Fim da janela: reavalia quais células são objeto fixo, loga transições, reinicia a janela. */
function evaluateWindow(am, now, camId) {
  const prev = am.suppressed;
  const next = new Set();
  const suggestions = [];
  const candidatasAntes = am.candidatas || new Map();
  const candidatas = new Map(); // qualificou NESTA janela → nº de janelas consecutivas
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
    // Qualificou nesta janela. Só SUPRIME depois de AM_CONFIRM_WINDOWS janelas consecutivas —
    // é o que compensa a amostra menor (ver AM_MIN_ROUNDS) e o que separa mobília de pessoa
    // que ficou parada uma janela. A SUGESTÃO sai já na 1ª (observabilidade sem ação).
    const janelas = (candidatasAntes.get(cell) || 0) + 1;
    candidatas.set(cell, janelas);
    suggestions.push({ cell, presentPct, jitter, janelas });
    if (janelas >= AM_CONFIRM_WINDOWS) next.add(cell);
  }
  am.candidatas = candidatas; // quem não qualificou nesta janela perde a sequência (adaptativo)
  // Decisão do OPERADOR OVERRULA a estatística desta janela — nos dois sentidos. Sem isto, um
  // "falsoPositivo" confirmado podia CAIR na próxima janela se a amostra ficasse rasa demais
  // (o objeto saiu de quadro um pouco), e um "correto" podia voltar a ser suprimido se o guarda
  // ficasse parado tempo/jitter suficiente para requalificar sozinho.
  for (const [cell, decision] of am.overrides) {
    if (decision === "correto") next.delete(cell);
    else if (decision === "falsoPositivo" && AUTOMASK_MODE === "hide") next.add(cell);
  }
  for (const cell of next) {
    if (prev.has(cell)) continue; // já conhecida — só loga a novidade
    const col = cell % AM_COLS;
    const row = Math.floor(cell / AM_COLS);
    const c = am.cells.get(cell);
    console.log(
      `[analysis:${camId}] auto-máscara ${AUTOMASK_MODE === "hide" ? "SUPRIMINDO" : "SUGESTÃO"} ` +
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

/**
 * Apresentação p/ o status() — cada célula como rect NORMALIZADO (transparência:
 * o operador vê onde a máscara agiu e pode pintar uma zona manual ali, OU confirmar/corrigir
 * a sugestão — `cell` é o id estável que a rota de decisão espera de volta; `decision` ecoa
 * o override já gravado, se houver, para a tela não perguntar de novo o que já foi respondido).
 * `suppressed` conta células ENFORCED — só no modo "hide" ("suggest" não suprime nada).
 */
function statusOf(am) {
  return {
    mode: AUTOMASK_MODE,
    suppressed: AUTOMASK_MODE === "hide" ? am.suppressed.size : 0,
    suggestions: (am.suggestions || []).map((s) => {
      const col = s.cell % AM_COLS;
      const row = Math.floor(s.cell / AM_COLS);
      return {
        cell: s.cell,
        x: col / AM_COLS,
        y: row / AM_ROWS,
        w: 1 / AM_COLS,
        h: 1 / AM_ROWS,
        presentPct: Math.round(s.presentPct * 100) / 100,
        jitter: Math.round(s.jitter * 1000) / 1000,
        decision: (am.overrides && am.overrides.get(s.cell)) || null,
      };
    }),
  };
}

module.exports = {
  createAutoMask,
  amCell,
  roundObserver,
  evaluateWindow,
  statusOf,
  applyOverride,
  clearOverride,
  normalizeOverrides,
  AM_COLS,
  AM_ROWS,
  AM_WIN_MS,
  AM_PRESENT,
  AM_MIN_ROUNDS,
  AM_CONFIRM_WINDOWS,
  AM_JITTER,
  AUTOMASK_MODE,
  AUTOMASK_ON,
};
