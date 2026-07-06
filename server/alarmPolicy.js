// ============================================================================
// Política de alarmes (ISA-18.2 / EEMUA 191) — Onda A, item 2 + Onda C, item 14
// ----------------------------------------------------------------------------
// Filtro/agregador aplicado ANTES do envio aos canais (Andon webhook em
// alerts.js e WhatsApp em dispatch.js). O objetivo é tratar o Andon/WhatsApp
// como um SISTEMA DE ALARME (acionável, priorizado, sem inundação) e não como
// um stream cru de eventos — o antídoto contra "alerta falso em massa".
//
// O ponto de entrada é evaluate(p). Ele recebe o mesmo payload do socket
// "alert" ({ text, ts, [cameraId], [zona], [tipo] }) e devolve UMA decisão:
//   • null                        → alerta suprimido (não envia a nenhum canal)
//   • { text, ts, priority, ... } → alerta a enviar (texto pode ser um RESUMO
//                                    de causa-raiz quando houve inundação)
// A decisão é tomada UMA vez e roteada para os dois canais, garantindo que os
// contadores de inundação não sejam contados em dobro.
//
// Este arquivo é um ÍNDICE fino: compõe os submódulos de server/alarm/ e expõe
// a API pública estável. Mecanismos (uma responsabilidade por módulo):
//   • alarm/config   — envs/defaults + logger compartilhado.
//   • alarm/state    — estado em memória compartilhado (dedup/flood/flap/…).
//   • alarm/keys     — derivação/normalização de chaves a partir do payload.
//   • alarm/priority — priorização em 3 níveis + construção da decisão.
//   • alarm/flood    — supressão de inundação por câmera (colapso em resumo).
//   • alarm/flap     — anti-flapping (chattering) com cooldown/off-delay.
//   • alarm/shelve   — shelving (ISA-18.2): silêncio temporário com expiração.
//   • alarm/persist  — persistência resiliente das shelves (alarm-shelves.json).
//   • alarm/metrics  — métricas de taxa/racionalização (EEMUA 191).
//
// ALARM_POLICY_ENABLED="0"/"false" degrada evaluate() para só classificar e
// repassar (sem dedup/colapso/flap); shelving e métricas continuam ativos. Toda
// supressão/colapso é logada (pino). Ver alarm/config.js p/ as variáveis de
// ambiente e alarm/persist.js p/ a semântica de persistência das shelves.
// ============================================================================
const { classify } = require("./alarm/classify");

const { log, ENABLED, DEDUP_MS, FLOOD_WINDOW_MS, FLAP_WINDOW_MS } = require("./alarm/config");
const { dedup, floodWin, floodState, shelved, flap, emitLog } = require("./alarm/state");
const { pickCamera, pickBody, pickZona } = require("./alarm/keys");
const { priorityOf, makeDecision } = require("./alarm/priority");
const { applyFlood } = require("./alarm/flood");
const { flapSuppress } = require("./alarm/flap");
const { shelveKeyFor, isShelved, shelve, unshelve, listShelved } = require("./alarm/shelve");
const { init } = require("./alarm/persist");
const { recordEmit, metrics } = require("./alarm/metrics");

// Limpeza preguiçosa dos mapas para evitar crescimento ilimitado.
function gc(now) {
  if (dedup.size > 1000) for (const [k, t] of dedup) if (now - t > DEDUP_MS) dedup.delete(k);
  if (floodWin.size > 500)
    for (const [k, w] of floodWin)
      if (!w.length || now - w[w.length - 1] > FLOOD_WINDOW_MS) floodWin.delete(k);
  if (flap.size > 1000)
    for (const [k, st] of flap)
      if (
        now >= st.cooldownUntil &&
        (!st.fires.length || now - st.fires[st.fires.length - 1] > FLAP_WINDOW_MS)
      )
        flap.delete(k);
}

/**
 * Avalia um alerta e devolve a decisão de envio (ou null se suprimido).
 * @param {{text:string, ts?:number, cameraId?:string, zona?:string, tipo?:string}} p
 * @returns {null | {text:string, ts:number, priority:string, summary:boolean, cameraId?:string, zona?:string, tipo?:string, critico?:boolean, count?:number}}
 */
function evaluate(p) {
  if (!p) return null;
  const text = String(p.text || "").trim();
  if (!text) return null;
  const ts = p.ts || Date.now();
  const now = Date.now();
  const meta = classify(text);
  const priority = priorityOf(text, meta);

  const cameraId = pickCamera(p, text);
  const zona = pickZona(p, text);
  const tipo = p.tipo || meta.tipo;

  // 0) Shelving — silêncio temporário (manutenção). Camada anterior a tudo;
  //    vale mesmo com a política desligada (é uma ação explícita do operador).
  const sk = isShelved(cameraId, zona, tipo, now);
  if (sk) {
    log.debug(
      { key: sk, cameraId, zona, tipo },
      "[alarm] shelved: alerta suprimido (silêncio temporário)",
    );
    return null;
  }

  // Política desligada → só classifica e repassa (retrocompatível),
  // contabilizando a emissão para as métricas.
  if (!ENABLED) {
    recordEmit(priority, now);
    return makeDecision(text, ts, priority, { tipo: meta.tipo, critico: meta.critico });
  }

  // Chave lógica: cameraId|zona|tipo. Sem zona identificável, usa o corpo da
  // mensagem para não colapsar mensagens distintas (mantém o dedup conservador).
  const zonaKey = zona || pickBody(p, text);
  const key = `${cameraId}|${zonaKey}|${tipo}`;

  // 1) Deduplicação temporal por chave lógica.
  const prev = dedup.get(key);
  if (prev && now - prev < DEDUP_MS) {
    log.debug({ key }, "[alarm] dedup: repetição suprimida na janela");
    return null;
  }
  dedup.set(key, now);
  gc(now);

  // 1b) Anti-flapping — suprime chattering da mesma chave (off-delay/cooldown).
  if (flapSuppress(key, now)) return null;

  // 2) Supressão de inundação por câmera (+ priorização já calculada).
  const decision = applyFlood(cameraId, zona, text, ts, priority, now, meta);

  // 3) Métricas: contabiliza apenas alarmes EMITIDOS (decisão não-nula).
  if (decision) recordEmit(decision.priority, now);

  return decision;
}

// Restauração preguiçosa no require — repovoa as shelves persistidas SEM exigir
// que index.js chame init(). Idempotente; envolto em try/catch por segurança.
try {
  init();
} catch (e) {
  log.error({ err: e.message }, "[alarm] init() falhou (ignarada)");
}

module.exports = {
  evaluate,
  classify,
  priorityOf,
  // Inicialização explícita opcional (restauração também ocorre no require).
  init,
  // Shelving (persistido em disco; ver alarm-shelves.json)
  shelve,
  unshelve,
  listShelved,
  isShelved,
  shelveKeyFor,
  // Métricas / racionalização (voláteis — não persistidas por design)
  metrics,
  _state: { dedup, floodWin, floodState, shelved, flap, emitLog },
};
