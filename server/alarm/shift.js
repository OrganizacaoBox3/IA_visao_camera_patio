// ─────────────────────────────────────────────────────────────────────────────
// shift.js — GATE DE TURNO da política de alarme (spec-turnos-por-zona §4/F3 e E4
// da spec-alerta-por-atividade). Camada ÚNICA que decide se um alarme já
// classificado é SUPRIMIDO pela JANELA da zona onde ele nasceu. Vive na POLÍTICA
// (chamada por alarmPolicy.evaluate LOGO APÓS o shelve, espelhando o padrão dele:
// uma camada, um mecanismo, uma decisão binária) — o PRODUTOR nunca muda: o motor
// sempre produz, a política suprime (semântica já documentada em presence-alert.js).
//
// AS DUAS DIREÇÕES (a matriz da spec §7 — direção do alerta × janela):
//   • INATIVIDADE (tipo "atividade") em zona com turnos: só passa DENTRO do turno e
//     FORA das pausas. Fora do turno, zona vazia é o ESPERADO (OEE: schedule loss,
//     não downtime) — suprime. Na pausa idem (CA-2/CA-3).
//   • PRESENÇA (tipo "presenca") em zona proibida: `arming` decide —
//     "sempre" (24/7, default) | "dentro-turnos" | "fora-turnos" (CA-5/E4). A PAUSA
//     NÃO desarma: área proibida no almoço segue proibida (a pausa é "vazio
//     esperado" para a ociosidade, não "presença liberada" para a vigilância).
//   • Qualquer outro tipo (fadiga/leitura/objetos) NÃO é gateado nesta onda — o
//     turno é o denominador da OCIOSIDADE e da VIGILÂNCIA; ampliar é decisão nova.
//
// FAIL-OPEN por design (o gate CALA alarme — errar para o lado do silêncio é o
// perigoso): zona não identificada, zona sem shiftIds, ou shiftIds DANGLING (turno
// excluído do cadastro) ⇒ PASSA (comportamento 24/7 de hoje, CA-5). Só suprime com
// atribuição EXISTENTE e resolvida.
//
// RESOLUÇÃO: shift-clock.resolveShift (fonte ÚNICA — overnight/borda/pausa/SITE_TZ
// moram lá e em nenhum outro lugar; armadilha 1 da spec). Aqui só se ESCOLHE o
// subconjunto de turnos da zona e se lê o veredito.
//
// CONTADOR: todo alarme suprimido pela janela é contado (shiftMetrics) e exposto em
// alarmPolicy.metrics() → GET /api/alarms/metrics (a Saúde de Alarmes mostra
// "suprimidos por turno"): supressão SILENCIOSA é como se perde a confiança no
// sistema de alarme — visibilidade sem ruído.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const camcfg = require("../camcfg");
const shiftsStore = require("../shifts");
const { resolveShift, siteTz } = require("../shift-clock");
const { log } = require("./config");
const { pickBody } = require("./keys");

const HISTORY_MS = 3_600_000; // 1h de histórico p/ o "suprimidos na última hora"

// Fontes REAIS (produção). Injetáveis (sources) só nos testes — mesmo padrão de
// deps do alarm/pipeline.js: em produção usam-se os defaults.
const DEFAULT_SOURCES = {
  getZones: (cameraId) => camcfg.getZones(cameraId),
  allShifts: () => shiftsStore.all(),
  tz: () => siteTz(),
};

// Contador de supressões (volátil, como as demais métricas observacionais).
const suppressedLog = []; // [{ ts, reason }]
let suppressedTotal = 0;

const norm = (s) =>
  String(s ?? "")
    .trim()
    .toLowerCase();

// Zona do alarme dentro da câmera. O payload traz `zona` (label normalizado por
// keys.pickZona, ou o id) — casa por label OU id. FALLBACK dos emissores LEGADOS:
// o alerta de ociosidade do cliente só carrega o TEXTO ("⚠ <câmera>: <ZONA> sem
// movimentação há 5m") e o pickZona não o resolve; aqui a zona é reconhecida pelo
// PREFIXO do corpo da mensagem — casamento ancorado (começo + fronteira de
// palavra), nunca substring solta, e só quando o `zona` explícito não casou nada.
function findZone(zonesOfCam, zona, text) {
  const key = norm(zona);
  if (key) {
    for (const z of zonesOfCam) if (norm(z.label) === key || norm(z.id) === key) return z;
  }
  const body = norm(pickBody({}, String(text || "")));
  if (!body) return null;
  for (const z of zonesOfCam) {
    const label = norm(z.label);
    if (label.length < 2 || !body.startsWith(label)) continue;
    const next = body.charAt(label.length);
    if (next === "" || !/[\p{L}\p{N}]/u.test(next)) return z; // fronteira de palavra
  }
  return null;
}

// Turnos ATRIBUÍDOS à zona que EXISTEM no cadastro (dangling é ignorado — fail-open).
function assignedShifts(zone, shifts) {
  const ids = Array.isArray(zone.shiftIds) ? zone.shiftIds : [];
  if (!ids.length) return [];
  const set = new Set(ids);
  return (Array.isArray(shifts) ? shifts : []).filter((s) => s && set.has(s.id));
}

/**
 * A DECISÃO (sem efeito colateral): o alarme é suprimido pela janela da zona?
 * @param {{cameraId?:string, zona?:string, tipo?:string, text?:string}} p
 * @param {number} now  epoch-ms do instante do alarme
 * @param {{getZones?:Function, allShifts?:Function, tz?:Function}} [sources]
 * @returns {null | {reason:string, zoneId:string}}  null = PASSA
 */
function shiftGate(p, now, sources = {}) {
  const tipo = norm(p && p.tipo);
  if (tipo !== "atividade" && tipo !== "presenca") return null; // fora do escopo do gate
  const getZones = sources.getZones || DEFAULT_SOURCES.getZones;
  const allShifts = sources.allShifts || DEFAULT_SOURCES.allShifts;
  const tz = (sources.tz || DEFAULT_SOURCES.tz)();

  const cameraId = p && p.cameraId ? String(p.cameraId) : "";
  if (!cameraId || cameraId === "_") return null; // sem câmera não há mapa zona→turnos
  const zone = findZone(getZones(cameraId) || [], p && p.zona, p && p.text);
  if (!zone) return null; // zona não identificada → passa (fail-open)

  // Cada direção lê a config da SUA zona: ociosidade só existe em zona de ATIVIDADE e armamento
  // só existe em zona PROIBIDA. Alarme cujo tipo não bate com o modo da zona não tem janela
  // definida — passa (nunca se cala um alarme com a config de outro mecanismo).
  const modo = zone.modo || "atividade";
  if (tipo === "atividade" && modo !== "atividade") return null;
  if (tipo === "presenca" && modo !== "proibida") return null;

  const arming = zone.arming || "sempre";
  // Zona PROIBIDA armada 24/7 (default) → nada a decidir (atalho antes de resolver o relógio).
  if (tipo === "presenca" && arming === "sempre") return null;

  const shifts = assignedShifts(zone, allShifts());
  if (!shifts.length) return null; // zona 24/7 (sem turnos, ou só ids órfãos) → CA-5

  const r = resolveShift(now, shifts, tz);
  const dentro = r !== null;

  if (tipo === "presenca") {
    // A pausa NÃO desarma a vigilância — só o lado de FORA/DENTRO do turno importa.
    if (arming === "dentro-turnos" && !dentro)
      return { reason: "presenca-fora-do-turno", zoneId: zone.id };
    if (arming === "fora-turnos" && dentro)
      return { reason: "presenca-dentro-do-turno", zoneId: zone.id };
    return null;
  }
  // INATIVIDADE: só alerta dentro do turno e fora das pausas (CA-2/CA-3).
  if (!dentro) return { reason: "fora-do-turno", zoneId: zone.id };
  if (r.inPause) return { reason: "em-pausa", zoneId: zone.id };
  return null;
}

/**
 * O gate COM efeito (log + contador) — é o que a política chama.
 * @returns {boolean} true = SUPRIMIDO pela janela da zona.
 */
function suppressedByShift(p, now, sources) {
  const d = shiftGate(p, now, sources);
  if (!d) return false;
  suppressedTotal += 1;
  suppressedLog.push({ ts: now, reason: d.reason });
  while (suppressedLog.length && now - suppressedLog[0].ts > HISTORY_MS) suppressedLog.shift();
  log.debug(
    { cameraId: p && p.cameraId, zona: p && p.zona, tipo: p && p.tipo, motivo: d.reason },
    "[alarm] turno: alerta suprimido pela janela da zona",
  );
  return true;
}

/**
 * Snapshot do contador (entra em alarmPolicy.metrics()). Volátil por design — o
 * estado correto após um restart é "começar limpo" (como o emitLog das métricas).
 * @returns {{total:number, lastHour:number, byReason:object}}
 */
function shiftMetrics(now = Date.now()) {
  while (suppressedLog.length && now - suppressedLog[0].ts > HISTORY_MS) suppressedLog.shift();
  const byReason = {};
  for (const e of suppressedLog) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  return { total: suppressedTotal, lastHour: suppressedLog.length, byReason };
}

// Zera o contador — SÓ p/ teste (isola o estado do singleton entre casos).
function _resetMetrics() {
  suppressedLog.length = 0;
  suppressedTotal = 0;
}

module.exports = { shiftGate, suppressedByShift, shiftMetrics, _resetMetrics };
