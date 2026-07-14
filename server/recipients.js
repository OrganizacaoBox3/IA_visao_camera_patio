// Destinatários de WhatsApp do superadmin (números avulsos). Cache em memória; escrita no
// Postgres (se configurado) ou recipients.json (fallback). LGPD: consentimento é do superadmin.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const db = require("./db");

const FILE = path.join(__dirname, "recipients.json");
let list = [];
let usingPg = false;

const norm = (s) => String(s || "").replace(/\D/g, "");
// LANÇA em falha — de propósito: quem chama trata e FAZ ROLLBACK da memória (contra "persistência
// falsa": o destinatário que aparece na tela e some no restart). MESMO padrão de shifts.js.
function saveFile() {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
async function persist(r) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into recipients (id,nome,numero,ativo,somente_criticos,tipos,criado_em) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set nome=excluded.nome, numero=excluded.numero, ativo=excluded.ativo,
       somente_criticos=excluded.somente_criticos, tipos=excluded.tipos`,
    [
      r.id,
      r.nome,
      r.numero,
      r.ativo,
      r.somenteCriticos,
      JSON.stringify(r.tipos || []),
      r.criadoEm ?? Date.now(),
    ],
  );
}
async function persistDelete(id) {
  if (!usingPg) return saveFile();
  await db.query("delete from recipients where id=$1", [id]);
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select id, nome, numero, ativo, somente_criticos as "somenteCriticos", tipos, criado_em as "criadoEm" from recipients order by criado_em asc nulls first`,
      );
      list = r.rows;
      usingPg = true;
      console.log(`[recipients] ${list.length} destinatário(s) do Postgres`);
      return;
    } catch (e) {
      console.error("[recipients] Postgres indisponível, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(a)) list = a;
  } catch {
    list = [];
  }
}

// DURÁVEL-PRIMEIRO com ROLLBACK (mesma garantia de shifts.js): aplica otimista, persiste e DESFAZ a
// memória na falha — o `{ recipient }` só volta quando o dado está DURÁVEL; a falha vira 503 na rota.
const PERSIST_ERROR = (acao) => ({
  error: `falha ao ${acao} o destinatário — a persistência está indisponível; tente novamente`,
  status: 503,
});

async function create({ nome, numero, somenteCriticos, tipos }) {
  const n = norm(numero);
  if (n.length < 10) return { error: "número inválido (use DDI+DDD, ex.: 5584999999999)" };
  if (list.some((r) => r.numero === n)) return { error: "número já cadastrado" };
  const r = {
    id: "r" + crypto.randomBytes(5).toString("hex"),
    nome: String(nome || "").trim() || n,
    numero: n,
    ativo: true,
    somenteCriticos: somenteCriticos !== false,
    tipos: Array.isArray(tipos) ? tipos : [],
    criadoEm: Date.now(),
  };
  list.push(r);
  try {
    await persist(r);
  } catch (e) {
    list = list.filter((x) => x !== r); // rollback: remove exatamente o que entrou
    console.error("[recipients] FALHA ao salvar destinatário (persistência):", e.message);
    return PERSIST_ERROR("salvar");
  }
  return { recipient: r };
}
async function update(id, patch) {
  const r = list.find((x) => x.id === id);
  if (!r) return { error: "destinatário não encontrado" };
  const before = { ...r }; // snapshot p/ rollback
  if (typeof patch.ativo === "boolean") r.ativo = patch.ativo;
  if (typeof patch.nome === "string") r.nome = patch.nome.trim();
  if (typeof patch.numero === "string") r.numero = norm(patch.numero);
  if (typeof patch.somenteCriticos === "boolean") r.somenteCriticos = patch.somenteCriticos;
  if (Array.isArray(patch.tipos)) r.tipos = patch.tipos;
  try {
    await persist(r);
  } catch (e) {
    Object.assign(r, before); // rollback: a edição não gravou → memória volta ao anterior
    console.error("[recipients] FALHA ao editar destinatário (persistência):", e.message);
    return PERSIST_ERROR("salvar");
  }
  return { recipient: r };
}
async function remove(id) {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: true }; // idempotente: nada a remover
  const [removed] = list.splice(idx, 1); // remoção otimista
  try {
    await persistDelete(id);
  } catch (e) {
    list.splice(idx, 0, removed); // rollback: re-insere na posição original
    console.error("[recipients] FALHA ao remover destinatário (persistência):", e.message);
    return PERSIST_ERROR("remover");
  }
  return { ok: true };
}

module.exports = { init, create, update, remove, all: () => list };
