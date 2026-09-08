// ─────────────────────────────────────────────────────────────────────────────
// focus.js — Registro de FOCO do operador (contrato socket `analysis-focus`,
// ADITIVO): qual câmera cada dashboard tem aberta em tela cheia. A câmera FOCADA
// = UNIÃO entre todos os sockets (vários dashboards podem olhar câmeras
// diferentes); a contribuição de um socket some quando ele libera/desconecta.
// PURO/determinístico (focus.test.js) — o efeito (reajustar a cadência da câmera
// que entrou/saiu do foco) fica no engine, guiado pelo Set `changed` devolvido.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// Cadência efetiva de UMA câmera por PRECEDÊNCIA: FOCO > LINHA > PROIBIDA > normal/OCIOSA.
// Focada (aberta em tela cheia por ≥1 dashboard) amostra a rounds.focus mesmo com linha.
// Parametrizada nos round-ms (não lê env) → determinística e testável.
//
// `rounds.idle` (2026-09-08) é a cadência de quem NÃO precisa de cadência: câmera sem linha,
// sem foco e sem zona proibida só produz OCUPAÇÃO por zona — e esse indicador passou a ser
// ponderado por TEMPO (pipeline.js), então amostrar menos NÃO o enviesa, só reduz
// `observedMs`, que é honesto e visível no relatório. Ela é DERIVADA da capacidade medida
// (idleRoundMs, abaixo): com pool sobrando, `idle === normal` e nada muda.
//
// POR QUE a zona PROIBIDA entra na classe protegida: ali a cadência é SEGURANÇA — o dwell da
// máquina de presença (presence-alert.js) só observa em rodada de inferência, então alongar a
// rodada ATRASA o alarme de invasão. Estatística pode ser grossa; alarme não.
function pickRoundMs({ focused, hasLine, hasProib }, rounds) {
  if (focused) return rounds.focus;
  if (hasLine) return rounds.line;
  if (hasProib) return rounds.normal; // segurança: nunca cai p/ a cadência ociosa
  return rounds.idle ?? rounds.normal; // `idle` ausente = comportamento anterior
}

// ── CADÊNCIA OCIOSA DERIVADA DA CAPACIDADE MEDIDA ────────────────────────────
// MEDIDO em produção (2026-09-08): 17 câmeras, 2-3 workers, capacidade ~4 inferências/s
// contra uma DEMANDA declarada de ~26/s (1 fps × 14 normais + 2 fps × linhas + 6 fps do foco).
// Demanda 6× acima da capacidade ⇒ toda câmera converge para `capacidade ÷ nº de câmeras`,
// e a prioridade declarada (foco > linha > normal) não é entregue a ninguém: a câmera FOCADA
// recebia 0,25 de 6 análises/s. Consequência de produto: a contagem de LINHA exige a mesma
// pessoa amostrada dos DOIS lados; a 0,25/s ela cruza a cena inteira entre duas amostras.
//
// SIMULADO com a capacidade real (17 câmeras, 3 workers, 750ms/inferência):
//   hoje (ociosas @1fps) ....... linha 0,27/s · latência de fila 3250ms
//   ociosas @10s ............... linha 0,68/s · latência 750ms   (2,5× mais amostras)
//   ociosas @10s + paralelo 2 .. linha 0,88/s · latência 1500ms  (3,3×)
// Também MEDIDO que ORDENAR a fila por prioridade não muda nada (0,84 → 0,85): sob demanda
// contínua, quem realoca throughput é REDUZIR DEMANDA, não escolher melhor a próxima vaga.
// (Um módulo de admissão por prioridade foi escrito, medido, e DESCARTADO por isso.)
//
// A cadência ociosa é DERIVADA, não um número solto: o que sobra da capacidade depois da
// classe protegida, dividido entre as ociosas. Pool sobrando ⇒ devolve `roundMsNormal`
// (frota pequena não paga nada); pool afogado ⇒ satura no teto.
// PURA (capacidade/demanda por parâmetro) — contrato em focus.test.js.
function idleRoundMs({ capacidadeFps, demandaProtegidaFps, nOciosas, roundMsNormal, tetoMs }) {
  const cap = Number(capacidadeFps) || 0;
  const n = Math.max(0, Math.floor(nOciosas) || 0);
  const normal = Math.max(1, Number(roundMsNormal) || 1000);
  const teto = Math.max(normal, Number(tetoMs) || normal);
  if (n === 0 || cap <= 0) return normal; // sem ociosas ou sem medição ⇒ não mexe
  const sobra = cap - (Number(demandaProtegidaFps) || 0);
  if (sobra <= 0) return teto; // a classe protegida já consome tudo: ociosas no teto
  const fpsPorOciosa = sobra / n;
  const ms = Math.round(1000 / fpsPorOciosa);
  return Math.min(teto, Math.max(normal, ms)); // nunca MAIS RÁPIDO que o normal
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

module.exports = { pickRoundMs, idleRoundMs, focusUnion, createFocusRegistry };
