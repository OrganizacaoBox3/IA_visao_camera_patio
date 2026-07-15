// overview.js — a agregação da FROTA por escopo (Fase 2). Reusa EXATAMENTE o mesmo filtro de
// acesso do CRUD (access.buildFullTree + auth.canAccess) para listar só os nós ACESSÍVEIS ao
// escopo do token, e conta alarm_event das últimas 24h POR SITE via withTenant — RLS-safe: a
// leitura de alarm_event NUNCA sai de withTenant (invariante da Fase 0; spec §5).
//
// Custo: N transações withTenant (N = sites acessíveis, cada uma um COUNT curto), capado em
// SITE_COUNT_CAP para não explodir num escopo enorme. O cap é DECLARADO no retorno
// (alarms24hCapped:true + alarms24h:null nos sites não contados) — nunca trunca em silêncio.
const auth = require("./auth");
const access = require("./access");
const stores = require("./stores");
const db = require("./db");

const ONLINE_MS = 600_000; // 10 min = 2× o intervalo de heartbeat (spec §Fase2)
const WINDOW_24H_MS = 24 * 3600 * 1000;
const SITE_COUNT_CAP = 200; // teto de contagens withTenant por overview (declarado no retorno)

// Conta alarm_event com ts >= since de UM site, DENTRO do withTenant (a policy RLS isola a
// leitura ao tenant da transação). count(*)::int → Number direto (sem bigint-string).
async function countAlarmsSince(siteId, since) {
  return db.withTenant(siteId, async (cl) => {
    const r = await cl.query("select count(*)::int as n from alarm_event where ts >= $1", [since]);
    return r.rows[0] ? Number(r.rows[0].n) : 0;
  });
}

// Monta o overview do escopo do chamador. nowMs injetável para teste determinístico da janela.
async function buildOverview(claims, nowMs = Date.now()) {
  const tree = await access.buildFullTree();
  const [ps, cs, ss] = await Promise.all([
    stores.partners.list(),
    stores.clientes.list(),
    stores.sites.list(),
  ]);

  const partners = ps
    .filter((p) => auth.canAccess(claims, { type: "partner", id: p.id }, tree))
    .map((p) => ({ id: p.id, nome: p.nome }));
  const clientes = cs
    .filter((c) => auth.canAccess(claims, { type: "cliente", id: c.id }, tree))
    .map((c) => ({ id: c.id, partner_id: c.partner_id, nome: c.nome }));
  const accessibleSites = ss.filter((s) => auth.canAccess(claims, { type: "site", id: s.id }, tree));

  // Cap das contagens: nunca truncar em silêncio — os sites além do teto entram com
  // alarms24h:null e o retorno ganha alarms24hCapped:true (o front mostra "—" honesto).
  const since = nowMs - WINDOW_24H_MS;
  const capped = accessibleSites.length > SITE_COUNT_CAP;
  const toCount = capped ? accessibleSites.slice(0, SITE_COUNT_CAP) : accessibleSites;

  // Sequencial de propósito: cada withTenant toma uma conexão do pool (max 5); disparar
  // centenas em paralelo esgotaria o pool. O COUNT indexado por ts é barato.
  const counts = new Map();
  for (const s of toCount) {
    counts.set(s.id, await countAlarmsSince(s.id, since));
  }

  const sites = accessibleSites.map((s) => ({
    id: s.id,
    cliente_id: s.cliente_id,
    nome: s.nome,
    last_seen: s.last_seen ?? null,
    online: s.last_seen != null && nowMs - s.last_seen < ONLINE_MS,
    alarms24h: counts.has(s.id) ? counts.get(s.id) : null,
  }));

  const out = {
    scope: { scope_type: claims.scope_type, scope_id: claims.scope_id ?? null, role: claims.papel ?? null },
    partners,
    clientes,
    sites,
  };
  if (capped) out.alarms24hCapped = true;
  return out;
}

module.exports = { buildOverview, countAlarmsSince, ONLINE_MS, WINDOW_24H_MS, SITE_COUNT_CAP };
