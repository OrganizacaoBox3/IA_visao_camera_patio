// O elo entre o canAccess PURO (auth.js) e o BANCO. canAccess exige a fatia da árvore de
// ancestrais do recurso; aqui a montamos a partir do cadastro e chamamos canAccess. TODO handler
// de CRUD passa por guardAccess/guardScope — é o isolamento das tabelas de cadastro (spec §5:
// cadastro NÃO tem RLS de linha; o guard é no app). Herança para baixo (spec §3).
const auth = require("./auth");
const stores = require("./stores");

// Fatia mínima da árvore para UM recurso (partner|cliente|site): o próprio nó + ancestrais.
// platform não precisa disto (vê tudo) — chamamos só para escopos abaixo de platform.
async function resolveTree(resource) {
  const tree = { partner: {}, cliente: {}, site: {} };
  if (!resource || !resource.type || resource.id == null) return tree;
  if (resource.type === "partner") {
    const p = await stores.partners.get(resource.id);
    if (p) tree.partner[p.id] = true;
  } else if (resource.type === "cliente") {
    const c = await stores.clientes.get(resource.id);
    if (c) {
      tree.cliente[c.id] = { partnerId: c.partner_id };
      tree.partner[c.partner_id] = true;
    }
  } else if (resource.type === "site") {
    const s = await stores.sites.get(resource.id);
    if (s) {
      const c = await stores.clientes.get(s.cliente_id);
      const partnerId = c ? c.partner_id : null;
      tree.site[s.id] = { clienteId: s.cliente_id, partnerId };
      if (c) tree.cliente[c.id] = { partnerId };
      if (partnerId) tree.partner[partnerId] = true;
    }
  }
  return tree;
}

// Árvore COMPLETA (3 queries) — para FILTRAR listas em memória com canAccess. Mais barato que
// resolver recurso a recurso quando já vamos varrer tudo; o canAccess é que enforce o escopo.
async function buildFullTree() {
  const tree = { partner: {}, cliente: {}, site: {} };
  const [ps, cs, ss] = await Promise.all([
    stores.partners.list(),
    stores.clientes.list(),
    stores.sites.list(),
  ]);
  for (const p of ps) tree.partner[p.id] = true;
  for (const c of cs) tree.cliente[c.id] = { partnerId: c.partner_id };
  for (const s of ss) {
    const c = cs.find((x) => x.id === s.cliente_id);
    tree.site[s.id] = { clienteId: s.cliente_id, partnerId: c ? c.partner_id : null };
  }
  return tree;
}

// Guard de um recurso da árvore (partner|cliente|site). platform curto-circuita sem tocar o banco.
async function guardAccess(claims, resource) {
  if (!claims) return false;
  if (claims.scope_type === "platform") return true;
  const tree = await resolveTree(resource);
  return auth.canAccess(claims, resource, tree);
}

// Guard de um ESCOPO de membership (scope_type ∈ platform|partner|cliente|site). O nível
// 'platform' não é nó da árvore de recursos: conceder/ver uma membership de platform exige ser
// platform. Abaixo disso, cai no guardAccess normal do recurso alvo.
async function guardScope(claims, scope_type, scope_id) {
  if (!claims) return false;
  if (scope_type === "platform") return claims.scope_type === "platform";
  if (scope_id == null) return false;
  return guardAccess(claims, { type: scope_type, id: scope_id });
}

// Versão PURA (sem banco) do guardScope, para FILTRAR listas com uma árvore já carregada
// (buildFullTree). platform vê tudo; membership de escopo 'platform' só é vista por platform.
function scopeInTree(claims, scope_type, scope_id, tree) {
  if (!claims) return false;
  if (claims.scope_type === "platform") return true;
  if (scope_type === "platform") return false;
  return auth.canAccess(claims, { type: scope_type, id: scope_id }, tree);
}

module.exports = { resolveTree, buildFullTree, guardAccess, guardScope, scopeInTree };
