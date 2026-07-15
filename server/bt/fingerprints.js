// FINGERPRINTS de RSSI (survey de localização indoor por Bluetooth): cada fingerprint é a assinatura
// RSSI das antenas (estações BLE) medida num PONTO CONHECIDO da planta ("Doca 3", "Corredor A"). É a
// base de referência que um classificador usa depois para inferir onde uma tag está a partir do RSSI
// que ela vê. Diferente da planta baixa (floorplan.js, SINGLETON), aqui é uma LISTA (array de amostras
// de survey) — o mesmo padrão de ARRAY de stations.js. Cache em memória + Postgres (se configurado) ou
// fingerprints.json (fallback) — MESMO padrão de floorplan.js/stations.js/camcfg.js.
//
// LGPD: SÓ metadados de medição (rótulo do ponto, posição em metros e estatísticas de RSSI por antena).
// Nenhuma imagem, frame ou PII — doutrina dos frames (ADR-002).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const db = require("../db");

const FILE = path.join(__dirname, "fingerprints.json");

// id de estação/antena = MESMO formato que o app do celular valida e que stations.js aceita.
const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// Rótulo do ponto de survey: obrigatório, 1..64 caracteres (após trim).
const LABEL_MAX = 64;

let list = [];
let usingPg = false;

// ── Validação defensiva (espelho do estilo de floorplan.js/camcfg.js) ────────
// Número finito qualquer — RSSI (mean/std) e posições em metros são grandezas do mundo (sinal livre;
// NÃO se clampa no servidor: a coordenada pode ser negativa/na borda; o RSSI é tipicamente negativo).
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const norm = (s) => String(s ?? "").trim();

// Saneia o vetor de assinatura RSSI: descarta ENTRADA A ENTRADA o que for inválido (id da antena fora
// do formato, ou mean/std/n não-finitos, ou n < 1), como a allowlist da casa faz. Devolve sempre um
// objeto novo (nada do input vaza). NÃO clampa RSSI (valores negativos são o normal).
function cleanVec(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [id, v] of Object.entries(input)) {
    const key = norm(id);
    if (!ID_RE.test(key)) continue; // id da antena fora do formato → descarta silenciosamente
    if (!v || typeof v !== "object") continue;
    if (!fin(v.mean) || !fin(v.std) || !fin(v.n)) continue; // estatística não-finita → descarta
    if (v.n < 1) continue; // n é contagem de amostras: precisa de ao menos 1
    out[key] = { mean: v.mean, std: v.std, n: v.n }; // números livres, SEM clamp
  }
  return out;
}

// Valida um fingerprint inteiro. Rótulo ausente/vazio e vetor sem NENHUMA antena válida são erro do
// CLIENTE → lança com `badRequest` (a rota devolve 400 com a mensagem). x/y opcionais são saneados
// (descarte silencioso do campo, não do item). Devolve o objeto limpo e pronto p/ persistir (SEM id —
// o id é atribuído por quem chama `add`).
function clean(fp) {
  if (!fp || typeof fp !== "object") {
    throw Object.assign(new Error("fingerprint inválido"), { badRequest: true });
  }
  const label = norm(fp.label);
  if (!label) {
    throw Object.assign(new Error("rótulo (label) do ponto de survey é obrigatório"), {
      badRequest: true,
    });
  }
  if (label.length > LABEL_MAX) {
    throw Object.assign(new Error(`rótulo (label): máximo ${LABEL_MAX} caracteres`), {
      badRequest: true,
    });
  }
  const vec = cleanVec(fp.vec);
  if (Object.keys(vec).length === 0) {
    throw Object.assign(new Error("fingerprint sem antenas"), { badRequest: true });
  }
  const out = { label, vec };
  // x/y são opcionais: se presentes e finitos, entram (coordenadas livres em metros, SEM clamp); se
  // inválidos, o CAMPO é descartado — não rejeita o item (a posição é acessória à assinatura RSSI).
  if (fin(fp.x)) out.x = fp.x;
  if (fin(fp.y)) out.y = fp.y;
  // createdAt vem do chamador (o front carimba); não é crítico → ausente/inválido vira 0.
  out.createdAt = fin(fp.createdAt) ? fp.createdAt : 0;
  return out;
}

// ── Persistência ─────────────────────────────────────────────────────────────
// LANÇA em falha — de propósito: add/remove tratam e FAZEM ROLLBACK da memória (contra "persistência
// falsa"). MESMO padrão de floorplan.js/stations.js.
function saveFile() {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
async function persistUpsert(fp) {
  if (!usingPg) return saveFile();
  await db.query(
    "insert into bt_fingerprints (id,data) values ($1,$2) on conflict (id) do update set data=excluded.data",
    [fp.id, JSON.stringify(fp)],
  );
}
async function persistDelete(id) {
  if (!usingPg) return saveFile();
  await db.query("delete from bt_fingerprints where id=$1", [id]);
}

async function init() {
  if (db.configured()) {
    try {
      // Tabela idempotente (o schema.sql é a fonte única do resto; aqui, como é um store novo,
      // garantimos a tabela própria sem alterar tabelas existentes — aditivo, COMO floorplan fez).
      await db.query(
        "create table if not exists bt_fingerprints (id text primary key, data jsonb not null)",
      );
      const r = await db.query("select data from bt_fingerprints order by (data->>'createdAt')::bigint asc nulls first");
      // Cada linha é saneada; um `id` durável é preservado (o data guarda o próprio id).
      list = r.rows
        .map((row) => sanitizeStored(row.data))
        .filter((fp) => fp !== null);
      usingPg = true;
      console.log(`[bt-fingerprints] ${list.length} fingerprint(s) do Postgres`);
      return;
    } catch (e) {
      console.error("[bt-fingerprints] Postgres indisponível/dado inválido, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    list = Array.isArray(a) ? a.map(sanitizeStored).filter((fp) => fp !== null) : [];
  } catch {
    list = []; // arquivo ausente/corrompido → lista vazia
  }
}

// Saneia um item JÁ persistido (que carrega o próprio id): revalida o corpo e re-anexa o id. Um item
// gravado inválido é descartado (retorna null) em vez de derrubar o boot — MESMO espírito do clean de
// floorplan cair no vazio quando o dado gravado é ruim.
function sanitizeStored(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = norm(raw.id);
  if (!id) return null;
  try {
    return { id, ...clean(raw) };
  } catch {
    return null; // corpo gravado inválido → descarta esse item, sem derrubar os demais
  }
}

/** A lista atual de fingerprints (ou `[]` se nunca salvo). */
function listAll() {
  return list;
}

/**
 * Adiciona um fingerprint e persiste. DURÁVEL-PRIMEIRO com ROLLBACK (mesma garantia de
 * floorplan.js/stations.js): valida → gera id → muta memória → persiste; se a persistência falhar,
 * remove da memória e devolve erro 503. Erro de VALIDAÇÃO (label vazio, vec sem antena) sai com
 * `badRequest` ANTES de mutar nada. NÃO deduplica por label (o survey pode ter várias amostras do
 * mesmo ponto — o classificador lida com isso). Devolve o fingerprint salvo (com id).
 */
async function add(fp) {
  const cleaned = clean(fp); // lança badRequest se inválido — nada foi mutado ainda
  // id gerado no server (evita colisão e não depende do cliente): prefixo legível + UUID.
  const saved = { id: `fp-${crypto.randomUUID()}`, ...cleaned };
  list.push(saved);
  try {
    await persistUpsert(saved);
  } catch (e) {
    list = list.filter((x) => x !== saved); // rollback: o fingerprint não durou → some da memória
    console.error("[bt-fingerprints] FALHA ao salvar fingerprint (rollback):", e.message);
    throw Object.assign(
      new Error("falha ao salvar o fingerprint — persistência indisponível"),
      { status: 503 },
    );
  }
  return saved;
}

/**
 * Remove um fingerprint por id e persiste. Rollback em falha de persistência (503). id inexistente →
 * { ok:false } (sem erro — a rota responde 200 com ok:false, como stations.remove idempotente).
 */
async function remove(id) {
  const key = norm(id);
  const idx = list.findIndex((x) => x.id === key);
  if (idx === -1) return { ok: false };
  const [removed] = list.splice(idx, 1); // remoção otimista
  try {
    await persistDelete(key);
  } catch (e) {
    list.splice(idx, 0, removed); // rollback: re-insere na posição original
    console.error("[bt-fingerprints] FALHA ao remover fingerprint (rollback):", e.message);
    throw Object.assign(
      new Error("falha ao remover o fingerprint — persistência indisponível"),
      { status: 503 },
    );
  }
  return { ok: true };
}

module.exports = {
  init,
  list: listAll,
  add,
  remove,
  // Puro (sem I/O), exportado p/ teste da validação/saneamento.
  clean,
  ID_RE,
  LABEL_MAX,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
