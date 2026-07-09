// ─────────────────────────────────────────────────────────────────────────────
// inflight.js — controle de inferências EM VOO de UMA câmera. Responsabilidade única:
// quantas rodam em PARALELO (limite), validação de resposta ÓRFÃ (de respawn/prune) e
// GUARDA DE ORDEM DE CAPTURA (resposta de frame mais velho NÃO regride o tracker).
//
// Existe p/ a câmera FOCADA usar vários workers ao mesmo tempo (mais cadência = o marcador
// acompanha giro/entrada) SEM trocar de modelo (recall intacto). O motor (engine/worker-host)
// só chama esta API — nenhuma lógica de contador/ids/ordem espalhada por lá.
//
// Modelo: um Set dos jobIds em voo (o size É o contador E o validador de órfã) + o ts de
// captura do último frame JÁ aplicado (a guarda de ordem). Puro/sem I/O → testável isolado.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

function createInflightSlots() {
  const inFlight = new Set(); // jobIds despachados e ainda sem resposta
  let lastAppliedTs = 0; // ts de captura do último frame que ALIMENTOU o tracker

  return {
    /** Quantas inferências desta câmera estão em voo agora. */
    count: () => inFlight.size,

    /** Há folga p/ despachar mais uma? (limite `max` ≥ 1 — foco > 1, resto 1). */
    canBegin: (max) => inFlight.size < Math.max(1, max | 0),

    /** Registra um job despachado (ocupa um slot). */
    begin: (jobId) => {
      inFlight.add(jobId);
    },

    /** Libera o slot SEM aplicar (worker morreu, send falhou, dropped, erro). Idempotente. */
    abort: (jobId) => {
      inFlight.delete(jobId);
    },

    /**
     * Resposta de SUCESSO chegou: libera o slot e diz se deve alimentar o tracker.
     * @returns {boolean} true = é NOSSA e a MAIS NOVA (aplica); false = órfã (não estava em voo)
     *   OU fora de ordem (captura ≤ última aplicada → descarta, não faz o tempo do tracker voltar).
     */
    settle: (jobId, captureTs) => {
      if (!inFlight.delete(jobId)) return false; // órfã: respawn/prune já limpou este slot
      if (captureTs <= lastAppliedTs) return false; // fora de ordem: frame mais velho — descarta
      lastAppliedTs = captureTs;
      return true;
    },
  };
}

module.exports = { createInflightSlots };
