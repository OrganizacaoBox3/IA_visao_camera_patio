// ─────────────────────────────────────────────────────────────────────────────
// camera-gate.js — GATE DE ESTADO OPERACIONAL. Câmera em teste, manutenção ou desativada não
// dispara notificação. É a resposta à pergunta "esta câmera DEVERIA estar funcionando agora?".
//
// POR QUE É UMA CAMADA DA POLÍTICA E NÃO UM `if` NO MOTOR DE SAÚDE. Uma câmera desparafusada
// para limpeza não gera só "sem vídeo": ela gera presença fantasma enquanto o técnico passa na
// frente, lotação absurda quando a mira muda, contagem errada com a lente meio suja. Tratar o
// caso só no alarme de saúde consertaria um sintoma e deixaria os outros. Aqui vale para
// TUDO que aquela câmera emitir, que é o que o dono pediu: "não devem gerar falsos alertas".
//
// IRMÃO DO GATE DE TURNO (shift.js), de propósito e no mesmo ponto do pipeline: ANTES do
// dedup/flood — um alarme que o estado cala não deve nem consumir a chave de dedup, senão o
// primeiro alarme REAL depois de voltar à produção seria engolido como "repetição".
//
// O QUE ELE NÃO FAZ: não apaga o incidente. O health-incidents continua abrindo, mantendo e
// fechando o incidente da câmera em manutenção, e ele continua visível em /api/analysis/status
// — quem está fazendo a manutenção precisa ver o efeito do que está mexendo. O que este gate
// corta é a NOTIFICAÇÃO (WhatsApp/Andon/fila acionável).
//
// "QUEM CALA, MOSTRA QUE CALOU": toda supressão é contada e exposta em /api/alarms/metrics
// (`suppressedByCameraState*`), com a quebra por estado. Supressão silenciosa é como se perde
// a confiança num sistema de alarme.
//
// FAIL-OPEN em todas as bordas: sem cameraId, sem cadastro, com erro na leitura ou com estado
// desconhecido, o alarme PASSA. Errar para o lado do ruído custa uma mensagem; errar para o
// lado do silêncio custa o incidente que ninguém viu.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const { log } = require("./config");
const { estadoDe, podeNotificar } = require("../camera-state");

const HISTORY_MS = 3_600_000; // 1 h de histórico p/ a métrica "está calando AGORA?"

let suppressedTotal = 0;
const suppressedLog = []; // [{ ts, estado }]

// Fonte do cadastro em lazy require: cameras.js não pode ser carregado no topo (ciclo de
// require com o index.js) e o gate precisa funcionar mesmo se o módulo não existir.
const DEFAULT_SOURCES = {
  getCamera(id) {
    try {
      return require("../cameras").get(id);
    } catch {
      return null; // fail-open
    }
  },
};

/**
 * A DECISÃO (sem efeito colateral): este alarme é suprimido pelo estado da câmera?
 * @param {{cameraId?:string}} p
 * @param {{getCamera?:Function}} [sources] injeção p/ teste
 * @returns {null | {estado:string}} null = PASSA
 */
function cameraGate(p, sources = {}) {
  const cameraId = p && p.cameraId ? String(p.cameraId).trim() : "";
  // "_" é a sentinela de "câmera não identificada" do keys.js — sem câmera não há estado.
  if (!cameraId || cameraId === "_") return null;
  const getCamera = sources.getCamera || DEFAULT_SOURCES.getCamera;
  let rec;
  try {
    rec = getCamera(cameraId);
  } catch {
    return null; // fail-open
  }
  // Câmera fora do cadastro dinâmico (nó de câmera do navegador, fonte RTSP legada do
  // rtsp.sources.json): não há estado declarado, então ela é tratada como produção.
  if (!rec) return null;
  if (podeNotificar(rec)) return null;
  return { estado: estadoDe(rec) };
}

/**
 * O gate COM efeito (log + contador) — é o que a política chama.
 * @returns {boolean} true = SUPRIMIDO pelo estado operacional da câmera.
 */
function suppressedByCameraState(p, now = Date.now(), sources) {
  const d = cameraGate(p, sources);
  if (!d) return false;
  suppressedTotal += 1;
  suppressedLog.push({ ts: now, estado: d.estado });
  while (suppressedLog.length && now - suppressedLog[0].ts > HISTORY_MS) suppressedLog.shift();
  log.debug(
    { cameraId: p && p.cameraId, tipo: p && p.tipo, estado: d.estado },
    "[alarm] estado da câmera: notificação suprimida (câmera não está em produção)",
  );
  return true;
}

/**
 * Snapshot do contador (entra em alarmPolicy.metrics()). Volátil por design, como o do gate
 * de turno: o estado correto depois de um restart é "começar limpo".
 * @returns {{total:number, lastHour:number, byEstado:object}}
 */
function cameraStateMetrics(now = Date.now()) {
  while (suppressedLog.length && now - suppressedLog[0].ts > HISTORY_MS) suppressedLog.shift();
  const byEstado = {};
  for (const e of suppressedLog) byEstado[e.estado] = (byEstado[e.estado] || 0) + 1;
  return { total: suppressedTotal, lastHour: suppressedLog.length, byEstado };
}

// Zera o contador — SÓ p/ teste (isola o estado do singleton entre casos).
function _resetMetrics() {
  suppressedLog.length = 0;
  suppressedTotal = 0;
}

module.exports = { cameraGate, suppressedByCameraState, cameraStateMetrics, _resetMetrics };
