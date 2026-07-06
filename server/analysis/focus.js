// ─────────────────────────────────────────────────────────────────────────────
// focus.js — Registro de FOCO do operador (contrato socket `analysis-focus`,
// ADITIVO): qual câmera cada dashboard tem aberta em tela cheia. A câmera FOCADA
// = UNIÃO entre todos os sockets (vários dashboards podem olhar câmeras
// diferentes); a contribuição de um socket some quando ele libera/desconecta.
// PURO/determinístico (focus.test.js) — o efeito (reajustar a cadência da câmera
// que entrou/saiu do foco) fica no engine, guiado pelo Set `changed` devolvido.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// Cadência efetiva de UMA câmera por PRECEDÊNCIA: FOCO > LINHA > normal. Focada
// (aberta em tela cheia por ≥1 dashboard) amostra a rounds.focus mesmo com linha.
// Parametrizada nos round-ms (não lê env) → determinística e testável.
function pickRoundMs({ focused, hasLine }, rounds) {
  if (focused) return rounds.focus;
  if (hasLine) return rounds.line;
  return rounds.normal;
}

// União dos ids focados entre TODOS os sockets; entradas null/"" (sem foco) são
// ignoradas. Devolve Set de cameraIds (string). PURO.
function focusUnion(registry) {
  const set = new Set();
  for (const id of registry.values()) if (id != null && id !== "") set.add(String(id));
  return set;
}

/**
 * Registro socketId→cameraId com a união materializada.
 * set()/clear() devolvem o Set de cameraIds cuja PERTINÊNCIA ao foco mudou —
 * o caller reaplica a cadência só nessas (as demais não mudam).
 */
function createFocusRegistry() {
  const bySocket = new Map(); // socketId → cameraId
  const union = new Set(); // união atual dos ids focados

  function recompute() {
    const next = focusUnion(bySocket);
    const changed = new Set();
    for (const id of next) if (!union.has(id)) changed.add(id);
    for (const id of union) if (!next.has(id)) changed.add(id);
    union.clear();
    for (const id of next) union.add(id);
    return changed;
  }

  return {
    /** Registra o foco DESTE socket (cameraId null/"" = liberou). → ids que mudaram. */
    set(socketId, cameraId) {
      if (!socketId) return new Set();
      const key = String(socketId);
      if (cameraId == null || cameraId === "") bySocket.delete(key);
      else bySocket.set(key, String(cameraId));
      return recompute();
    },
    /** Socket desconectou: remove a contribuição dele (nunca deixa foco órfão). → ids que mudaram. */
    clear(socketId) {
      if (socketId && bySocket.delete(String(socketId))) return recompute();
      return new Set();
    },
    /** A câmera está focada por ≥1 dashboard? */
    has: (id) => union.has(id),
    /** Snapshot dos ids focados (p/ status/telemetria). */
    ids: () => [...union],
    /** Zera o registro (stop do engine). */
    reset() {
      bySocket.clear();
      union.clear();
    },
  };
}

module.exports = { pickRoundMs, focusUnion, createFocusRegistry };
