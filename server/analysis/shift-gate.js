// ─────────────────────────────────────────────────────────────────────────────
// shift-gate.js — a câmera precisa ser analisada NESTE instante?
//
// POR QUE EXISTE: hoje o motor analisa 24/7 e o turno só decide, DEPOIS, se o alarme sai
// (server/alarm/shift.js — "o motor sempre produz, a política suprime"). Fora do turno isso
// gasta CPU para produzir um alerta que será descartado: pela própria spec de turnos, o tempo
// fora do turno é Schedule Loss, excluído da conta de eficiência — não vira alarme NEM métrica.
// Medição que motivou (Fly/gru, 15/09/2026): o host roda com load average mediano 10,32 em
// 4 vCPU, saturado 44% das horas, com 15 câmeras. CPU gasta fora do turno é CPU tirada do
// turno, onde o alerta importa.
//
// A REGRA, e por que ela não pode criar buraco de vigilância: a câmera só dorme quando NENHUM
// alarme dela seria possível agora. Quem responde isso é o MESMO `shiftGate` que a política de
// alarme usa — não uma segunda leitura de turno. Isso é deliberado: duas fontes de turno
// divergindo é a armadilha 1 da spec, e aqui o estrago seria pior que um número errado (seria
// o motor dormindo enquanto o alarme se acharia armado). Enquanto o gate deixar UM alarme
// passar, a câmera não dorme.
//
// O caso que obriga esse desenho: zona PROIBIDA com `arming: "fora-turnos"` vigia justamente
// FORA do expediente (invasão de madrugada). Um gate ingênuo — "fora do turno, desliga" —
// mataria exatamente a vigilância que essa zona existe para fazer. Perguntando ao gate de
// alarme, esse caso se resolve sozinho: ele NÃO suprime lá fora, então a câmera não dorme.
//
// FAIL-OPEN herdado: zona não identificada, sem turnos, com ids órfãos ou tipo fora do escopo
// → `shiftGate` devolve null (passa) → a câmera fica acordada. Na dúvida, analisa. O custo de
// errar para cá é dinheiro; para o outro lado seria cegueira silenciosa.
//
// PRÉ-REQUISITO DE CONFIGURAÇÃO (honestidade: sem isto, não economiza nada): a economia só
// aparece nas câmeras cujas zonas TÊM turno atribuído (`Zone.shiftIds`). Zona sem turno é 24/7
// por design da spec, e segue 24/7 aqui.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const camcfg = require("../camcfg");
const { shiftGate } = require("../alarm/shift");

// Liga/desliga. DESLIGADO por default: mudar o que o motor processa é mudança de comportamento
// operacional e não deve chegar de carona num deploy. `ANALYSIS_SHIFT_GATE=1` liga.
const GATE_ON = process.env.ANALYSIS_SHIFT_GATE === "1";

/** O tipo de alarme que a zona pode gerar — é o que decide qual janela vale (ver alarm/shift.js). */
function tipoDaZona(zone) {
  return (zone && zone.modo) === "proibida" ? "presenca" : "atividade";
}

/**
 * A câmera pode dormir agora?
 *
 * @param {string} cameraId
 * @param {number} now epoch-ms
 * @param {{getZones?:Function, gate?:Function, ligado?:boolean}} [deps] injeção p/ teste
 * @returns {{dorme:boolean, motivo:string}} `motivo` alimenta a telemetria — supressão
 *   silenciosa é como se perde a confiança no sistema (mesma razão do contador em alarm/shift.js).
 */
function cameraPodeDormir(cameraId, now, deps = {}) {
  const ligado = deps.ligado !== undefined ? deps.ligado : GATE_ON;
  if (!ligado) return { dorme: false, motivo: "gate-desligado" };

  const getZones = deps.getZones || ((id) => camcfg.getZones(id));
  const gate = deps.gate || shiftGate;

  const zonas = getZones(cameraId) || [];
  // Sem zona não há mapa zona→turno: a câmera pode estar ali por contagem de linha, foco ou
  // só telemetria de fluxo. Nada a decidir → fica acordada.
  if (!zonas.length) return { dorme: false, motivo: "sem-zonas" };

  for (const z of zonas) {
    const tipo = tipoDaZona(z);
    // `zona` vai pelo id E `text` pelo label porque o findZone do gate aceita os dois caminhos
    // (o alarme real chega ora com um, ora com outro).
    const veredito = gate({ cameraId, zona: z.id, text: z.label, tipo }, now);
    // null = este alarme PASSARIA agora → há vigilância viva nesta câmera → não dorme.
    if (veredito === null) return { dorme: false, motivo: `zona-ativa:${z.id}` };
  }
  return { dorme: true, motivo: "todas-as-zonas-fora-de-janela" };
}

module.exports = { cameraPodeDormir, GATE_ON };
