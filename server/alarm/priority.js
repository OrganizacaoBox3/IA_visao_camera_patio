// Priorização em 3 níveis (advisory / high / critical) e construção da decisão.
// `critical` é reservado (mantém o % baixo, meta EEMUA 191 ≤5%).

// Prioridade em 3 níveis. critical é reservado (mantém o % baixo, meta ≤5%).
function priorityOf(text, meta) {
  if (meta.critico) return "critical"; // marcador ⚠ no texto
  if (
    /\boffline\b|sem[\s-]?sinal|sem[\s-]?conex|feed\s+caiu|c[âa]mera.*(caiu|fora)|desconect|timeout|falha/i.test(
      text,
    )
  ) {
    return "high";
  }
  if (/parad|parou|risco|fadiga|sonol/i.test(text)) return "high";
  return "advisory";
}

function maxPriority(a, b) {
  const rank = { advisory: 0, high: 1, critical: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function makeDecision(text, ts, priority, extra) {
  return Object.assign({ text, ts, priority, summary: false }, extra);
}

module.exports = { priorityOf, maxPriority, makeDecision };
