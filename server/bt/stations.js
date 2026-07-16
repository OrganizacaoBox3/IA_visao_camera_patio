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

// LANÇA em falha — de propósito: o CRUD do operador (update/remove) e o registro de estação NOVA em
// `seen` tratam e FAZEM ROLLBACK da memória (contra "persistência falsa"). MESMO padrão de shifts.js.
// A gravação ESPAÇADA do `ultimaVezEm` (write-behind) é a ÚNICA exceção: lá o erro é engolido e
// retenta no próximo tick (o valor é barato e reconstruído a cada leitura).
function saveFile() {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
async function persist(s) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into bt_stations (id,nome,ativo,primeira_vez_em,ultima_vez_em,ultima_leitura_em,scanning)
     values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (id) do update set nome=excluded.nome, ativo=excluded.ativo,
       ultima_vez_em=excluded.ultima_vez_em, ultima_leitura_em=excluded.ultima_leitura_em,
       scanning=excluded.scanning`,
    [
      s.id,
      s.nome,
      s.ativo,
      s.primeiraVezEm ?? null,
      s.ultimaVezEm ?? null,
      s.ultimaLeituraEm ?? null,
      s.scanning ?? null,
    ],
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
        `select id, nome, ativo, primeira_vez_em as "primeiraVezEm", ultima_vez_em as "ultimaVezEm",
                ultima_leitura_em as "ultimaLeituraEm", scanning
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
 *
 * `meta` (ADITIVO, detecção de estação CEGA — causa C1/bug B6, o coletor que postou 22 h de
 * `readings: []` sem alarme porque o scan morreu com a tela apagada):
 *   • hadReadings: true ⇒ este POST trouxe ≥1 leitura → carimba `ultimaLeituraEm` (null = nunca);
 *   • scanning: boolean ⇒ último estado de scan reportado pelo app (null = app não manda).
 * Não-boolean é ignorado em silêncio (retrocompat: payload antigo segue bit-idêntico).
 * RETROCOMPAT de assinatura: `seen(id, now)` (número no 2º arg) era a forma antiga — segue aceita.
 */
async function seen(id, meta = {}, now = Date.now()) {
  if (typeof meta === "number") {
    now = meta; // assinatura antiga: seen(id, now)
    meta = {};
  }
  const key = norm(id);
  if (!ID_RE.test(key)) return { error: "id de estação inválido" };
  const hadReadings = meta.hadReadings === true;
  const scanning = typeof meta.scanning === "boolean" ? meta.scanning : undefined;
  const existente = list.find((s) => s.id === key);
  if (existente) {
    existente.ultimaVezEm = now; // write-behind: a memória já está fresca p/ o GET
    if (hadReadings) existente.ultimaLeituraEm = now;
    else if (existente.ultimaLeituraEm === undefined) existente.ultimaLeituraEm = null; // registro pré-campo ganha o campo
    if (scanning !== undefined) existente.scanning = scanning;
    else if (existente.scanning === undefined) existente.scanning = null;
    // Gravação ESPAÇADA (SEEN_PERSIST_MS), BEST-EFFORT: o `ultimaVezEm` é barato e reconstruído a
    // cada leitura — uma falha aqui não vira "persistência falsa" (o dado JÁ existe no disco), então
    // só loga e retenta no próximo tick, sem derrubar a leitura. `lastPersist` só avança se gravou.
    if (now - (lastPersist.get(key) ?? 0) >= SEEN_PERSIST_MS) {
      try {
        await persist(existente);
        lastPersist.set(key, now);
      } catch (e) {
        console.error("[bt-stations] falha ao gravar ultimaVezEm (write-behind, retenta):", e.message);
      }
    }
    return { station: existente, criada: false };
  }
  // Estação NOVA = um CREATE: durável-primeiro com rollback. Sem isso, uma falha de escrita deixaria
  // uma estação-fantasma na tela /estacoes que sumiria no restart. Rollback ⇒ ela reaparece no próximo
  // POST de leitura (a estação posta a ~1–2 Hz). A rota (bt-station.js) é fail-safe e ignora o retorno.
  const s = {
    id: key,
    nome: key,
    ativo: true,
    primeiraVezEm: now,
    ultimaVezEm: now,
    ultimaLeituraEm: hadReadings ? now : null, // null = NUNCA trouxe leitura (candidata a CEGA)
    scanning: scanning ?? null, // null = o app (ainda) não reporta o estado do scan
  };
  list.push(s);
  try {
    await persist(s);
  } catch (e) {
    list = list.filter((x) => x !== s); // rollback: nenhuma estação-fantasma
    console.error("[bt-stations] FALHA ao registrar estação nova (rollback):", e.message);
    return { error: "falha ao registrar estação — persistência indisponível", status: 503 };
  }
  lastPersist.set(key, now);
  console.log(`[bt-stations] estação NOVA descoberta: ${key} (pendente de nome)`);
  return { station: s, criada: true };
}

// DURÁVEL-PRIMEIRO com ROLLBACK (mesma garantia de shifts.js): a falha vira 503 que a rota faz surface.
const PERSIST_ERROR = (acao) => ({
  error: `falha ao ${acao} a estação — a persistência está indisponível; tente novamente`,
  status: 503,
});

/** PATCH parcial do operador: renomear e/ou (des)ativar. Validação no SERVIDOR. */
async function update(id, patch = {}) {
  const s = list.find((x) => x.id === id);
  if (!s) return { error: "estação não encontrada" };
  const before = { ...s }; // snapshot p/ rollback
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
  try {
    await persist(s);
  } catch (e) {
    Object.assign(s, before); // rollback: a edição não gravou → memória volta ao anterior
    console.error("[bt-stations] FALHA ao editar estação (persistência):", e.message);
    return PERSIST_ERROR("salvar");
  }
  return { station: s };
}

async function remove(id) {
  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: true, removida: false };
  const [removed] = list.splice(idx, 1); // remoção otimista
  const hadPersist = lastPersist.get(id);
  lastPersist.delete(id);
  try {
    await persistDelete(id);
  } catch (e) {
    list.splice(idx, 0, removed); // rollback: re-insere na posição original
    if (hadPersist !== undefined) lastPersist.set(id, hadPersist);
    console.error("[bt-stations] FALHA ao remover estação (persistência):", e.message);
    return PERSIST_ERROR("remover");
  }
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
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
