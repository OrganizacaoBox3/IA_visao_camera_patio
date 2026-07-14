// Login: a parte PURA (seleção de escopo) mora aqui, testável sem banco. O handler HTTP
// (verifica scrypt, busca memberships, emite token) fica em index.js e usa selectScope.
//
// Seleção de escopo desta fase (spec §3 + decisão do dono): se o usuário tem >1 membership,
// o token carrega a de MAIOR privilégio na árvore (platform > partner > cliente > site). É uma
// escolha SIMPLES e segura como padrão inicial. A seleção multi-membership fina (o usuário
// escolher com qual "chapéu" entrar, ou o token carregar várias) fica p/ DEPOIS — documentado.
const auth = require("./auth");

// menor rank = maior privilégio. Espelha a ordem de auth.SCOPE_TYPES (platform primeiro).
function rankOf(scopeType) {
  const i = auth.SCOPE_TYPES.indexOf(scopeType);
  return i === -1 ? Number.POSITIVE_INFINITY : i; // escopo desconhecido → menos privilégio
}

// Escolhe a membership de MAIOR privilégio. Empate → a primeira (ordem estável de entrada,
// tipicamente criado_em asc). Sem memberships → null (o handler responde 403).
function selectScope(memberships) {
  if (!Array.isArray(memberships) || memberships.length === 0) return null;
  let best = null;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const m of memberships) {
    const r = rankOf(m.scope_type);
    if (r < bestRank) {
      bestRank = r;
      best = m;
    }
  }
  return best;
}

module.exports = { selectScope, rankOf };
