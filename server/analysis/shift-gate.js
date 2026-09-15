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
// SEM TURNO = NÃO PROCESSA (decisão do dono, 15/09/2026: "se não tem turno não deve processar
// nada daquela câmera"). Isto INVERTE, e só aqui dentro do motor, o fail-open da spec de turnos,
// onde zona sem `shiftIds` vale 24/7. A leitura do dono é outra: câmera sem janela declarada não
// é câmera para vigiar 24h — é câmera que ninguém configurou, e vigiar por omissão é o que vinha
// custando 68% da fatura. O gate de ALARME (alarm/shift.js) segue fail-open e intocado: o que
// muda é quando o motor GASTA CPU, não quando o alarme dispara.
//
// O PREÇO DISSO, dito por extenso: com o gate ligado e as zonas sem turno atribuído, o motor
// para de analisar TUDO — o sistema fica cego até alguém configurar os turnos na tela. É um
// desligamento global disfarçado de economia, e é exatamente o tipo de falso-OK que mata dado em
// silêncio. Por isso os dois motivos de sono são SEPARADOS no log (`sem-config` × `fora-janela`):
// dormir fora do turno é o esperado; dormir por falta de configuração é pendência operacional e
// tem de gritar. Por isso também o gate nasce DESLIGADO.
//
// Fail-open que PERMANECE: zona COM turno atribuído e o gate de alarme deixando passar → a
// câmera fica acordada (zona proibida armada "fora-turnos" inclusive). Onde há configuração, a
// dúvida continua resolvida a favor de analisar.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const camcfg = require("../camcfg");
const shiftsStore = require("../shifts");
const { shiftGate } = require("../alarm/shift");

// Liga/desliga. DESLIGADO por default: mudar o que o motor processa é mudança de comportamento
// operacional e não deve chegar de carona num deploy. `ANALYSIS_SHIFT_GATE=1` liga.
const GATE_ON = process.env.ANALYSIS_SHIFT_GATE === "1";

/** O tipo de alarme que a zona pode gerar — é o que decide qual janela vale (ver alarm/shift.js). */
function tipoDaZona(zone) {
  return (zone && zone.modo) === "proibida" ? "presenca" : "atividade";
}

/**
 * A zona tem janela DECLARADA? Espelha o `assignedShifts` de alarm/shift.js: id órfão (turno
 * excluído do cadastro) e turno inativo não contam — se contassem, uma zona "configurada" com
 * ids mortos passaria por configurada e o motor rodaria 24/7 achando que havia janela.
 */
function zonaTemTurno(zone, todosOsTurnos) {
  const ids = zone && Array.isArray(zone.shiftIds) ? zone.shiftIds : [];
  if (!ids.length) return false;
  const set = new Set(ids);
  return (Array.isArray(todosOsTurnos) ? todosOsTurnos : []).some(
    (s) => s && set.has(s.id) && s.ativo !== false,
  );
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
  const allShifts = deps.allShifts || (() => shiftsStore.all());
  const gate = deps.gate || shiftGate;

  const zonas = getZones(cameraId) || [];
  // Sem zona nenhuma não há janela declarada em lugar nenhum → dorme por FALTA DE CONFIGURAÇÃO.
  if (!zonas.length) return { dorme: true, motivo: "sem-config" };

  const turnos = allShifts();
  let algumaComTurno = false;
  for (const z of zonas) {
    // Zona sem janela declarada não justifica gastar CPU (a inversão que o dono pediu). Não
    // interrompe o laço: outra zona da mesma câmera pode ter turno e mandar acordar.
    if (!zonaTemTurno(z, turnos)) continue;
    algumaComTurno = true;
    const tipo = tipoDaZona(z);
    // `zona` vai pelo id E `text` pelo label porque o findZone do gate aceita os dois caminhos
    // (o alarme real chega ora com um, ora com outro).
    const veredito = gate({ cameraId, zona: z.id, text: z.label, tipo }, now);
    // null = este alarme PASSARIA agora → há vigilância viva nesta câmera → não dorme.
    if (veredito === null) return { dorme: false, motivo: `zona-ativa:${z.id}` };
  }
  // Os dois motivos ficam SEPARADOS de propósito: "fora-janela" é a economia funcionando;
  // "sem-config" é pendência operacional (ninguém atribuiu turno) e precisa aparecer como tal —
  // senão um parque inteiro cego passa por economia bem-sucedida.
  return algumaComTurno
    ? { dorme: true, motivo: "fora-janela" }
    : { dorme: true, motivo: "sem-config" };
}

module.exports = { cameraPodeDormir, GATE_ON };
