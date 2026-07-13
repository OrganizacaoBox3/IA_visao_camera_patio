// Registro de ESTAÇÕES BLE (os celulares/coletores que varrem o BLE e postam em /api/bt/reading).
// Antes deste módulo a estação era IMPLÍCITA: existia só porque alguém POSTou com um stationId, e a
// UI mostrava o id técnico cru ("tc22-a1b2"). Aqui ela vira ENTIDADE: nome amigável + ativo + quando
// foi vista. Cache em memória; escrita no Postgres (se configurado) ou stations.json (fallback) —
// MESMO padrão do bt-tags.js/recipients.js.
//
// AUTO-DESCOBERTA (seen): NÃO existe cadastro manual. A estação NASCE ao postar a primeira leitura
// (nome default = o próprio id → "pendente" p/ o operador batizar). É append-only e fail-safe: quem
// chama envolve em try/catch — a LEITURA é o que importa, o registro é acessório (routes/bt-station.js).
//
// LGPD: só metadados de CONFIG (id/nome/ativo/timestamps). Nenhuma leitura de RSSI é persistida aqui
// (isso é efêmero em bt-readings.js — doutrina dos frames, ADR-002).
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");
const { STALE_MS } = require("./bt-readings");

const FILE = path.join(__dirname, "stations.json");

// VALIDAÇÃO NO SERVIDOR (o front só cadastra e exibe):
//  • id  = o que o app do celular manda no stationId — MESMO formato que o app valida.
//  • nome = rótulo amigável editável pelo operador ("Doca 3", "Expedição").
const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const NOME_MAX = 60;

// A cadência de persistência do `ultimaVezEm`: a estação posta a ~1–2 Hz e o valor em MEMÓRIA é
// atualizado SEMPRE (é ele que a UI lê no GET). No disco/Postgres a gravação é ESPAÇADA — o campo
// só serve p/ sobreviver a restart ("visto pela última vez às ..."), não vale um write por leitura.
const SEEN_PERSIST_MS = 60_000;

let list = [];
let usingPg = false;
const lastPersist = new Map(); // id -> epoch-ms da última gravação de ultimaVezEm (só memória)

const norm = (s) => String(s ?? "").trim();

function saveFile() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error("[bt-stations] falha ao salvar:", e.message);
  }
}
async function persist(s) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into bt_stations (id,nome,ativo,primeira_vez_em,ultima_vez_em) values ($1,$2,$3,$4,$5)
     on conflict (id) do update set nome=excluded.nome, ativo=excluded.ativo,
       ultima_vez_em=excluded.ultima_vez_em`,
    [s.id, s.nome, s.ativo, s.primeiraVezEm ?? null, s.ultimaVezEm ?? null],
  );
}
async function persistDelete(id) {
  if (!usingPg) return saveFile();
  await db.query("delete from bt_stations where id=$1", [id]);
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select id, nome, ativo, primeira_vez_em as "primeiraVezEm", ultima_vez_em as "ultimaVezEm"
         from bt_stations order by primeira_vez_em asc nulls first`,
      );
      list = r.rows;
      usingPg = true;
      console.log(`[bt-stations] ${list.length} estação(ões) do Postgres`);
      return;
    } catch (e) {
      console.error("[bt-stations] Postgres indisponível, usando JSON:", e.message);
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

/**
 * AUTO-DESCOBERTA — a estação se anuncia ao postar (não há POST manual de cadastro).
 * Desconhecida  → registra PENDENTE (nome = o próprio id) com primeiraVezEm/ultimaVezEm.
 * Já conhecida  → só carimba ultimaVezEm (nome/ativo do operador nunca são sobrescritos).
 * id inválido   → { error } (nunca lança; quem chama trata como acessório).
 */
async function seen(id, now = Date.now()) {
  const key = norm(id);
  if (!ID_RE.test(key)) return { error: "id de estação inválido" };
  const existente = list.find((s) => s.id === key);
  if (existente) {
    existente.ultimaVezEm = now;
    // Gravação espaçada (SEEN_PERSIST_MS): a memória já está fresca p/ o GET.
    if (now - (lastPersist.get(key) ?? 0) >= SEEN_PERSIST_MS) {
      lastPersist.set(key, now);
      await persist(existente);
    }
    return { station: existente, criada: false };
  }
  const s = { id: key, nome: key, ativo: true, primeiraVezEm: now, ultimaVezEm: now };
  list.push(s);
  lastPersist.set(key, now);
  await persist(s);
  console.log(`[bt-stations] estação NOVA descoberta: ${key} (pendente de nome)`);
  return { station: s, criada: true };
}

/** PATCH parcial do operador: renomear e/ou (des)ativar. Validação no SERVIDOR. */
async function update(id, patch = {}) {
  const s = list.find((x) => x.id === id);
  if (!s) return { error: "estação não encontrada" };
  if (patch.nome !== undefined) {
    const nome = norm(patch.nome);
    if (!nome) return { error: "nome da estação é obrigatório" };
    if (nome.length > NOME_MAX) return { error: `nome da estação: máximo ${NOME_MAX} caracteres` };
    s.nome = nome;
  }
  if (patch.ativo !== undefined) {
    if (typeof patch.ativo !== "boolean") return { error: "ativo deve ser booleano" };
    s.ativo = patch.ativo;
  }
  await persist(s);
  return { station: s };
}

async function remove(id) {
  const n = list.length;
  list = list.filter((x) => x.id !== id);
  if (list.length === n) return { ok: true, removida: false };
  lastPersist.delete(id);
  await persistDelete(id);
  return { ok: true, removida: true };
}

/** Nome amigável da estação (fallback = o próprio id, p/ quem ainda não foi batizada). */
function nameOf(id) {
  const s = list.find((x) => x.id === norm(id));
  return s ? s.nome : norm(id);
}

module.exports = {
  init,
  seen,
  update,
  remove,
  nameOf,
  all: () => list,
  get: (id) => list.find((s) => s.id === norm(id)) ?? null,
  ID_RE,
  NOME_MAX,
  STALE_MS, // mesma janela de staleness das leituras (bt-readings) — a UI deriva VIVA/SEM SINAL dela
};
