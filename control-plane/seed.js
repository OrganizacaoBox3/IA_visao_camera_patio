// Bootstrap do ovo-galinha: sem NENHUM usuário não dá p/ logar. Cria (idempotente) um
// platform-admin a partir de env — no molde do superadmin do hub (server/users.js:142-154).
//
//   CP_ADMIN_EMAIL / CP_ADMIN_PASSWORD — se ausentes, usa um DEFAULT INSEGURO só p/ dev,
//   com WARN gritado (a disciplina da casa: default inseguro nunca silencioso).
//
// Idempotente: reexecutar não duplica. Garante (1) o app_user existe e (2) tem uma membership
// de escopo 'platform'. NÃO reescreve a senha de um usuário já existente (não sobrepõe o que o
// operador já trocou). Rode: `npm run seed` (com CP_PG* / CP_DATABASE_URL apontando ao banco).
const db = require("./db");
const stores = require("./stores");
const password = require("./password");

const DEFAULT_EMAIL = "admin@control-plane.local";
const DEFAULT_PASSWORD = "cp-admin-inseguro-troque";

async function seed() {
  const email = process.env.CP_ADMIN_EMAIL || DEFAULT_EMAIL;
  const pwd = process.env.CP_ADMIN_PASSWORD || DEFAULT_PASSWORD;
  if (!process.env.CP_ADMIN_PASSWORD) {
    console.warn(
      "[cp/seed] ⚠️  usando SENHA DEFAULT INSEGURA — defina CP_ADMIN_PASSWORD (e CP_ADMIN_EMAIL) em produção e TROQUE.",
    );
  }
  if (!db.configured()) {
    console.error("[cp/seed] Postgres NÃO configurado (CP_DATABASE_URL ou CP_PGHOST+CP_PGDATABASE). Nada feito.");
    return { ok: false };
  }
  await db.init(); // garante o schema (idempotente)

  let u = await stores.users.getByEmailWithHash(email);
  if (!u) {
    u = await stores.users.create({ email, senhaHash: password.hashPassword(pwd) });
    console.log(`[cp/seed] platform-admin '${email}' criado — TROQUE a senha.`);
  } else {
    console.log(`[cp/seed] usuário '${email}' já existe (senha preservada).`);
  }

  const ms = await stores.memberships.listByUser(u.id);
  if (!ms.some((m) => m.scope_type === "platform")) {
    await stores.memberships.create({ user_id: u.id, scope_type: "platform", scope_id: null, role: "platform-admin" });
    console.log("[cp/seed] membership platform-admin criada.");
  } else {
    console.log("[cp/seed] membership platform já existe.");
  }
  return { ok: true, userId: u.id, email };
}

if (require.main === module) {
  seed()
    .then(() => db.end())
    .catch((e) => {
      console.error("[cp/seed] falha:", e);
      process.exit(1);
    });
}

module.exports = { seed };
