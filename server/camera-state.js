// ─────────────────────────────────────────────────────────────────────────────
// camera-state.js — O ESTADO OPERACIONAL DA CÂMERA: ela DEVERIA estar funcionando agora?
//
// O PROBLEMA. O cadastro só sabia dizer `enabled: true|false`. Com isso, uma câmera que o
// técnico desparafusou para limpar a lente é indistinguível de uma câmera de produção que
// caiu: as duas ficam sem vídeo, as duas abrem incidente, as duas acordam alguém no WhatsApp.
// O alarme que avisa de um trabalho PROGRAMADO é ruído — e ruído com aparência de emergência
// é o que ensina o operador a ignorar o vermelho.
//
// OS QUATRO ESTADOS (o vocabulário é o da operação, não o do banco):
//   producao    — no ar, vigiando. É a ÚNICA que alarma. Default de tudo.
//   teste       — instalada, em avaliação (mira, foco, zona sendo desenhada). Mede e grava;
//                 não notifica ninguém: o técnico está OLHANDO para ela agora.
//   manutencao  — intervenção programada. Mede o que conseguir; não notifica.
//   desativada  — fora de operação. Não analisa, não alarma, não entra em denominador de
//                 cobertura (não é "não medimos": é "não era para medir").
//
// A DIFERENÇA ENTRE ESTE GATE E O SHELVE. O shelve é AÇÃO pontual do operador ("cala esta
// zona por 30min"), tem expiração e é sobre um alarme. Este é ESTADO do ativo: dura o que a
// manutenção durar, vale para TODOS os alarmes daquela câmera e é informação de cadastro —
// quem olha o relatório precisa saber que aquela câmera não deveria estar vendo nada.
//
// "QUEM CALA, MOSTRA QUE CALOU" (doutrina). Suprimir em silêncio é como se perde a confiança
// num sistema de alarme. Por isso cada supressão daqui é CONTADA e exposta em
// `/api/alarms/metrics` (suppressedByCameraState*), do mesmo jeito que o gate de turno faz.
//
// FAIL-OPEN. Sem cadastro, sem registro, ou com estado desconhecido, a resposta é
// "está em produção" — na dúvida o alarme SAI. Um alarme a mais custa uma mensagem; um alarme
// a menos custa o incidente que ninguém viu.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

/** Os estados válidos, em ordem de "quanto se espera dela". */
const ESTADOS = Object.freeze(["producao", "teste", "manutencao", "desativada"]);

/** Rótulo pt-BR — fonte única (a UI importa daqui via /api/cameras). */
const ESTADO_LABEL = Object.freeze({
  producao: "Produção",
  teste: "Teste",
  manutencao: "Manutenção",
  desativada: "Desativada",
});

/** Uma frase por estado, para a tela explicar a consequência em vez de só nomear o estado. */
const ESTADO_NOTA = Object.freeze({
  producao: "No ar e vigiando — é a única que dispara notificação.",
  teste: "Em avaliação: continua medindo e gravando histórico, mas não notifica ninguém.",
  manutencao: "Intervenção programada: mede o que conseguir e não notifica ninguém.",
  desativada: "Fora de operação: não analisa, não alarma e não conta como período sem medição.",
});

const ehEstado = (v) => typeof v === "string" && ESTADOS.includes(v);

/**
 * Normaliza o estado de um registro de câmera, MIGRANDO o `enabled` legado.
 * Registro antigo só tem `enabled`: `false` vira "desativada", `true` vira "producao" — é a
 * leitura fiel do que aquele booleano significava.
 * @param {{estado?:string, enabled?:boolean}|null|undefined} rec
 * @returns {"producao"|"teste"|"manutencao"|"desativada"}
 */
function estadoDe(rec) {
  if (!rec) return "producao"; // fail-open: sem cadastro, trata como produção
  if (ehEstado(rec.estado)) return rec.estado;
  return rec.enabled === false ? "desativada" : "producao";
}

/** A câmera deveria estar vendo alguma coisa agora? (produção, teste e manutenção: sim) */
function deveriaEstarVendo(rec) {
  return estadoDe(rec) !== "desativada";
}

/** A câmera pode NOTIFICAR (WhatsApp/Andon/fila acionável)? Só produção. */
function podeNotificar(rec) {
  return estadoDe(rec) === "producao";
}

/** A câmera entra no DENOMINADOR de cobertura de análise? (desativada não: não era p/ medir) */
function contaParaCobertura(rec) {
  return deveriaEstarVendo(rec);
}

module.exports = {
  ESTADOS,
  ESTADO_LABEL,
  ESTADO_NOTA,
  ehEstado,
  estadoDe,
  deveriaEstarVendo,
  podeNotificar,
  contaParaCobertura,
};
