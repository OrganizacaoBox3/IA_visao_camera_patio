// Fonte canônica dos números de WhatsApp. Cada destinatário pertence a um usuário; um usuário
// pode ter vários números e, no máximo, um deles é o principal exibido em "Meu perfil".
// Cache em memória; escrita no Postgres (se configurado) ou recipients.json (fallback).
const fs = require("node:fs");
const crypto = require("node:crypto");
const { statePath } = require("./state-dir");
const db = require("./db");
const users = require("./users");

const FILE = statePath("recipients.json");
const TMP = statePath("recipients.json.tmp");
const MIGRATION_BACKUP = statePath("recipients.pre-user-link.bak.json");
let list = [];
let usingPg = false;

const norm = (s) => String(s || "").replace(/\D/g, "");
const cloneList = () => list.map((r) => ({ ...r, tipos: [...(r.tipos || [])] }));

function saveFile() {
  fs.writeFileSync(TMP, JSON.stringify(list, null, 2));
  fs.renameSync(TMP, FILE);
}

function values(r) {
  return [
    r.id,
    r.nome,
    r.numero,
    r.ativo,
    r.somenteCriticos,
    JSON.stringify(r.tipos || []),
    r.criadoEm ?? Date.now(),
    r.userId || null,
    !!r.principal,
    r.optInEm ?? null,
  ];
}

async function persistWith(queryable, r) {
  await queryable.query(
    `insert into recipients
       (id,nome,numero,ativo,somente_criticos,tipos,criado_em,user_id,principal,opt_in_em)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (id) do update set nome=excluded.nome, numero=excluded.numero,
       ativo=excluded.ativo, somente_criticos=excluded.somente_criticos,
       tipos=excluded.tipos, user_id=excluded.user_id, principal=excluded.principal,
       opt_in_em=excluded.opt_in_em`,
    values(r),
  );
}

async function persistMany(changed, resetPrincipalOwners = []) {
  if (!usingPg) return saveFile();
  await db.transaction(async (client) => {
    for (const userId of new Set(resetPrincipalOwners.filter(Boolean)))
      await client.query("update recipients set principal=false where user_id=$1", [userId]);
    for (const r of changed) await persistWith(client, r);
  });
}

async function persistDelete(id) {
  if (!usingPg) return saveFile();
  await db.query("delete from recipients where id=$1", [id]);
}

function backupJsonBeforeMigration() {
  if (!fs.existsSync(FILE) || fs.existsSync(MIGRATION_BACKUP)) return;
  fs.copyFileSync(FILE, MIGRATION_BACKUP, fs.constants.COPYFILE_EXCL);
}

function defaultPrefs(u) {
  const f = u.filtros || {};
  return {
    ativo: f.ativo !== false,
    somenteCriticos: !!f.somenteCriticos,
    tipos: Array.isArray(f.tipos) ? f.tipos : [],
  };
}

// Migração idempotente do modelo antigo:
//  · números avulsos sem dono → primeiro superadmin (o admin real do estado, nunca nome inventado);
//  · número legado de perfil → principal do próprio usuário;
//  · admin sem perfil → destinatário mais antigo dele vira principal.
// Os campos antigos dos usuários permanecem intactos como trilha de rollback; a aplicação passa a
// ler apenas recipients após esta etapa. Conflito de número já pertencente a outro usuário é
// reportado e não é sobrescrito silenciosamente.
async function migrateLegacy() {
  const before = cloneList();
  const allUsers = users.all();
  const pendingUsers = allUsers.filter((u) => Number(u.recipientMigrationVersion || 0) < 1);
  const admin = allUsers.find((u) => u.papel === "superadmin") || null;
  let changed = false;
  const conflicts = [];

  for (const u of pendingUsers) {
    const numero = norm(u.whatsapp);
    if (!numero) continue;
    let r = list.find((item) => item.numero === numero);
    if (r && r.userId && r.userId !== u.id) {
      conflicts.push(u.usuario);
      continue;
    }
    if (!r) {
      const prefs = defaultPrefs(u);
      r = {
        id: "r" + crypto.randomBytes(5).toString("hex"),
        nome: u.usuario,
        numero,
        ativo: prefs.ativo,
        somenteCriticos: prefs.somenteCriticos,
        tipos: prefs.tipos,
        criadoEm: u.criadoEm ?? Date.now(),
        userId: u.id,
        principal: true,
        optInEm: u.optInEm ?? null,
      };
      list.push(r);
      changed = true;
    } else {
      if (r.userId !== u.id || !r.principal || r.optInEm !== (u.optInEm ?? null)) changed = true;
      r.userId = u.id;
      r.principal = true;
      r.optInEm = u.optInEm ?? null;
    }
    for (const other of list) {
      if (other !== r && other.userId === u.id && other.principal) {
        other.principal = false;
        changed = true;
      }
    }
  }

  for (const r of list) {
    if (!r.userId && admin) {
      r.userId = admin.id;
      r.principal = false;
      // O cadastro avulso antigo já carregava o consentimento sob responsabilidade do admin.
      // Usa a data original do registro para não inventar uma data posterior à coleta.
      r.optInEm = r.optInEm ?? r.criadoEm ?? Date.now();
      changed = true;
    }
  }

  if (admin && !list.some((r) => r.userId === admin.id && r.principal)) {
    const oldest = list.find((r) => r.userId === admin.id);
    if (oldest) {
      oldest.principal = true;
      changed = true;
    }
  }

  if (conflicts.length) {
    list = before;
    throw new Error(
      `conflito na migração: número legado já pertence a outro usuário (${conflicts.join(", ")})`,
    );
  }
  if (list.some((r) => !r.userId)) {
    list = before;
    throw new Error("há destinatários sem usuário e nenhum superadmin disponível");
  }

  const pendingIds = pendingUsers.map((u) => u.id);
  const oldVersions = pendingUsers.map((u) => [u, u.recipientMigrationVersion]);
  try {
    if (usingPg) {
      // Vínculos, principais e marcador de usuário formam UMA transação. Assim um commit parcial
      // nunca faz a aplicação acreditar que a importação terminou.
      await db.transaction(async (client) => {
        if (changed) {
          for (const userId of new Set(list.filter((r) => r.principal).map((r) => r.userId)))
            await client.query("update recipients set principal=false where user_id=$1", [userId]);
          for (const r of list) await persistWith(client, r);
        }
        await users.markRecipientMigration(pendingIds, 1, client);
      });
    } else {
      if (changed) {
        backupJsonBeforeMigration();
        saveFile();
      }
      await users.markRecipientMigration(pendingIds, 1);
    }
    if (changed) console.log(`[recipients] migração por usuário concluída (${list.length} número(s))`);
  } catch (e) {
    list = before;
    for (const [u, version] of oldVersions) u.recipientMigrationVersion = version;
    if (!usingPg && changed) {
      try {
        saveFile();
      } catch (restoreError) {
        console.error("[recipients] FALHA ao restaurar JSON após rollback:", restoreError.message);
      }
    }
    console.error("[recipients] FALHA na migração por usuário (rollback aplicado):", e.message);
    throw e;
  }
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select id, nome, numero, ativo, somente_criticos as "somenteCriticos", tipos,
          criado_em as "criadoEm", user_id as "userId", principal, opt_in_em as "optInEm"
         from recipients order by criado_em asc nulls first`,
      );
      list = r.rows.map((item) => ({ ...item, tipos: item.tipos || [] }));
      usingPg = true;
    } catch (e) {
      console.error("[recipients] Postgres indisponível, usando JSON:", e.message);
    }
    if (usingPg) {
      // Falha de migração NÃO cai silenciosamente para JSON: migrateLegacy aplica rollback e
      // propaga o erro, impedindo meia-migração em produção.
      await migrateLegacy();
      console.log(`[recipients] ${list.length} destinatário(s) do Postgres`);
      return;
    }
  }
  usingPg = false;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    list = Array.isArray(a) ? a : [];
  } catch {
    list = [];
  }
  await migrateLegacy();
}

const PERSIST_ERROR = (acao) => ({
  error: `falha ao ${acao} o destinatário — a persistência está indisponível; tente novamente`,
  status: 503,
});

function validOwner(userId) {
  return !!userId && !!users.getById(String(userId));
}

async function create(input) {
  const { nome, numero, somenteCriticos, tipos, userId, principal, ativo, optInEm } = input;
  const n = norm(numero);
  if (n.length < 10) return { error: "número inválido (use DDI+DDD, ex.: 5584999999999)" };
  // Mantém o contrato anterior: o CREATE rejeita número normalizado repetido globalmente.
  if (list.some((r) => r.numero === n)) return { error: "número já cadastrado" };
  if (!validOwner(userId)) return { error: "usuário responsável inválido" };
  const r = {
    id: "r" + crypto.randomBytes(5).toString("hex"),
    nome: String(nome || "").trim() || n,
    numero: n,
    ativo: ativo !== false,
    somenteCriticos: somenteCriticos !== false,
    tipos: Array.isArray(tipos) ? tipos : [],
    criadoEm: Date.now(),
    userId: String(userId),
    principal: !!principal,
    optInEm: Object.hasOwn(input, "optInEm") ? optInEm ?? null : Date.now(),
  };
  const before = cloneList();
  if (r.principal)
    for (const other of list) if (other.userId === r.userId) other.principal = false;
  list.push(r);
  try {
    await persistMany(
      r.principal ? list.filter((x) => x.userId === r.userId) : [r],
      r.principal ? [r.userId] : [],
    );
  } catch (e) {
    list = before;
    console.error("[recipients] FALHA ao salvar destinatário (persistência):", e.message);
    return PERSIST_ERROR("salvar");
  }
  return { recipient: r };
}

async function update(id, patch) {
  const r = list.find((x) => x.id === id);
  if (!r) return { error: "destinatário não encontrado" };
  const before = cloneList();
  const oldUserId = r.userId;
  if (typeof patch.ativo === "boolean") r.ativo = patch.ativo;
  if (typeof patch.nome === "string") r.nome = patch.nome.trim();
  if (typeof patch.numero === "string") r.numero = norm(patch.numero);
  if (typeof patch.somenteCriticos === "boolean") r.somenteCriticos = patch.somenteCriticos;
  if (Array.isArray(patch.tipos)) r.tipos = patch.tipos;
  if (Object.hasOwn(patch, "optInEm")) r.optInEm = patch.optInEm ?? null;
  if (Object.hasOwn(patch, "userId")) {
    if (!validOwner(patch.userId)) {
      list = before;
      return { error: "usuário responsável inválido" };
    }
    r.userId = String(patch.userId);
    if (r.userId !== oldUserId && !Object.hasOwn(patch, "principal")) r.principal = false;
  }
  if (typeof patch.principal === "boolean") r.principal = patch.principal;
  if (r.principal)
    for (const other of list)
      if (other !== r && other.userId === r.userId) other.principal = false;
  const affectedOwners = new Set([oldUserId, r.userId]);
  try {
    await persistMany(
      list.filter((x) => affectedOwners.has(x.userId)),
      r.principal ? [r.userId] : [],
    );
  } catch (e) {
    list = before;
    console.error("[recipients] FALHA ao editar destinatário (persistência):", e.message);
    return PERSIST_ERROR("salvar");
  }
  return { recipient: r };
}

async function remove(id) {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: true };
  const [removed] = list.splice(idx, 1);
  try {
    await persistDelete(id);
  } catch (e) {
    list.splice(idx, 0, removed);
    console.error("[recipients] FALHA ao remover destinatário (persistência):", e.message);
    return PERSIST_ERROR("remover");
  }
  return { ok: true };
}

function principalForUser(userId) {
  return list.find((r) => r.userId === String(userId) && r.principal) || null;
}

function profileForUser(userId) {
  const u = users.getById(userId);
  if (!u) return null;
  const r = principalForUser(userId);
  return {
    ...users.publicUser(u),
    whatsapp: r?.numero || "",
    filtros: r
      ? { ativo: r.ativo, somenteCriticos: r.somenteCriticos, tipos: r.tipos || [] }
      : null,
    optInEm: r?.optInEm ?? null,
  };
}

async function updateProfile(userId, patch) {
  const u = users.getById(userId);
  if (!u) return { error: "usuário não encontrado" };
  const numero = typeof patch.whatsapp === "string" ? norm(patch.whatsapp) : null;
  if (numero && numero.length < 10)
    return { error: "número inválido (use DDI+DDD, ex.: 5584999999999)" };
  const current = principalForUser(userId);
  if (numero === "") {
    if (current) {
      const removed = await remove(current.id);
      if (removed.error) return removed;
    }
    return { user: profileForUser(userId) };
  }
  const prefs = patch.filtros && typeof patch.filtros === "object" ? patch.filtros : null;
  const optInEm =
    typeof patch.optIn === "boolean"
      ? patch.optIn
        ? current?.optInEm || Date.now()
        : null
      : current?.optInEm ?? null;
  if (!current) {
    if (!numero) return { user: profileForUser(userId) };
    const made = await create({
      nome: u.usuario,
      numero,
      userId,
      principal: true,
      ativo: prefs ? !!prefs.ativo : true,
      // Compatibilidade com o perfil antigo: sem filtros explícitos, recebia todos os alertas.
      somenteCriticos: prefs ? !!prefs.somenteCriticos : false,
      tipos: prefs && Array.isArray(prefs.tipos) ? prefs.tipos : [],
      optInEm,
    });
    if (made.error) return made;
    return { user: profileForUser(userId) };
  }
  const changes = { optInEm };
  if (numero) changes.numero = numero;
  if (prefs) {
    changes.ativo = !!prefs.ativo;
    changes.somenteCriticos = !!prefs.somenteCriticos;
    changes.tipos = Array.isArray(prefs.tipos) ? prefs.tipos : [];
  }
  const saved = await update(current.id, changes);
  if (saved.error) return saved;
  return { user: profileForUser(userId) };
}

module.exports = {
  init,
  create,
  update,
  remove,
  migrateLegacy,
  principalForUser,
  profileForUser,
  updateProfile,
  all: () => list,
  persistence: () => (usingPg ? "pg" : "json"),
};
