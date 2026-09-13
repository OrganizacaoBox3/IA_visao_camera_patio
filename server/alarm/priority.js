// Priorização em 3 níveis (advisory / high / critical) e construção da decisão.
// `critical` é RESERVADO (meta EEMUA 191 ≤5%) — e quem decide o que é crítico é a tabela de
// alarm/severity.js (natureza do evento), NÃO a grafia do texto. Ver lá o racional e a medição
// que motivou a mudança (83% de crítico porque todo emissor prefixa "⚠").
const { severityOf } = require("./severity");

// Prioridade em 3 níveis, por ordem de confiança na fonte:
//   1. severity.js  — payload explícito ou tabela (tipo × evento): a REGRA da casa;
//   2. heurística de TEXTO — LEGADO, só para emissor que não declara tipo conhecido.
// O legado continua aqui de propósito: emissor antigo (ou de fora) não pode ficar sem
// prioridade nenhuma. Mas ele deixou de decidir "crítico" por causa do "⚠" — o marcador
// virou, no máximo, "high": um caractere na mensagem não é evidência de emergência.
function priorityOf(text, meta, payload) {
  // A tabela só opina sobre tipo DECLARADO pelo emissor. `meta.tipo` é o palpite do classify
  // sobre o texto (default "atividade") — deixar a tabela decidir sobre palpite promoveria
  // qualquer mensagem solta a ATENÇÃO. Ver a nota em alarmPolicy.evaluate.
  const p = severityOf(payload);
  if (p) return p;
  if (
    /\boffline\b|sem[\s-]?sinal|sem[\s-]?conex|feed\s+caiu|c[âa]mera.*(caiu|fora)|desconect|timeout|falha/i.test(
      text,
    )
  ) {
    return "high";
  }
  if (/parad|parou|risco|fadiga|sonol/i.test(text)) return "high";
  // O "⚠" do emissor legado sinaliza "isto é um alerta", não "isto é uma emergência".
  return meta && meta.critico ? "high" : "advisory";
}

function maxPriority(a, b) {
  const rank = { advisory: 0, high: 1, critical: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function makeDecision(text, ts, priority, extra) {
  return Object.assign({ text, ts, priority, summary: false }, extra);
}

module.exports = { priorityOf, maxPriority, makeDecision };
