// Registro de TAGS BLUETOOTH (identidade aumentada na câmera). Cadastro por nome do Bluetooth;
// a estação BLE casa o que enxerga (bt_name) com o rótulo/pessoa. Cache em memória; escrita no
// Postgres (se configurado) ou bt-tags.json (fallback) — MESMO padrão do recipients.js.
// LGPD: SÓ o cadastro é persistido (config). Leituras de RSSI são efêmeras (bt-readings.js),
// nunca gravadas — doutrina dos frames (ADR-002).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const db = require("./db");

const FILE = path.join(__dirname, "bt-tags.json");
let list = [];
let usingPg = false;

// Normaliza o nome/MAC do BT: trim + maiúsculas (MAC e nomes casam sem depender de caixa/espaço).
const norm = (s) => String(s || "").trim();
const key = (s) => norm(s).toUpperCase();

function saveFile() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch (e) {
    console.error("[bt-tags] falha ao salvar:", e.message);
  }
}
async function persist(t) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into bt_tags (id,bt_name,rotulo,ativo,criado_em) values ($1,$2,$3,$4,$5)
     on conflict (id) do update set bt_name=excluded.bt_name, rotulo=excluded.rotulo, ativo=excluded.ativo`,
    [t.id, t.btName, t.rotulo, t.ativo, t.criadoEm ?? Date.now()],
  );
}
async function persistDelete(id) {
  if (!usingPg) return saveFile();
  await db.query("delete from bt_tags where id=$1", [id]);
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select id, bt_name as "btName", rotulo, ativo, criado_em as "criadoEm" from bt_tags order by criado_em asc nulls first`,
      );
      list = r.rows;
      usingPg = true;
      console.log(`[bt-tags] ${list.length} tag(s) do Postgres`);
      return;
    } catch (e) {
      console.error("[bt-tags] Postgres indisponível, usando JSON:", e.message);
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

async function create({ btName, rotulo }) {
  const n = norm(btName);
  if (!n) return { error: "nome do Bluetooth obrigatório" };
  if (list.some((t) => key(t.btName) === key(n))) return { error: "tag já cadastrada (bt_name)" };
  const t = {
    id: "bt" + crypto.randomBytes(5).toString("hex"),
    btName: n,
    rotulo: norm(rotulo) || n,
    ativo: true,
    criadoEm: Date.now(),
  };
  list.push(t);
  await persist(t);
  return { tag: t };
}
async function update(id, patch) {
  const t = list.find((x) => x.id === id);
  if (!t) return { error: "tag não encontrada" };
  if (typeof patch.ativo === "boolean") t.ativo = patch.ativo;
  if (typeof patch.rotulo === "string") t.rotulo = norm(patch.rotulo);
  if (typeof patch.btName === "string" && norm(patch.btName)) {
    const nk = key(patch.btName);
    if (list.some((x) => x.id !== id && key(x.btName) === nk)) return { error: "bt_name já cadastrado" };
    t.btName = norm(patch.btName);
  }
  await persist(t);
  return { tag: t };
}
async function remove(id) {
  const n = list.length;
  list = list.filter((x) => x.id !== id);
  if (list.length !== n) await persistDelete(id);
  return { ok: true };
}

// Casa um nome de BT visto pela estação com a tag cadastrada (case/space-insensitive). null = desconhecida.
function match(btName) {
  const k = key(btName);
  return list.find((t) => t.ativo !== false && key(t.btName) === k) || null;
}

// UPSERT por MAC (device-facing, TC22 nomeia a tag pelo app): chave = MAC MAIÚSCULO. Atualiza o rótulo
// da tag existente ou cria uma nova (MESMO shape do create). Enriquece bt-readings/mapa via match(mac).
async function upsertByMac(mac, rotulo) {
  const m = key(mac);
  if (!m) return { error: "mac obrigatório" };
  const existente = list.find((t) => key(t.btName) === m);
  if (existente) {
    existente.rotulo = norm(rotulo) || existente.rotulo;
    await persist(existente);
    return { tag: existente };
  }
  const t = {
    id: "bt" + crypto.randomBytes(5).toString("hex"),
    btName: m,
    rotulo: norm(rotulo) || m,
    ativo: true,
    criadoEm: Date.now(),
  };
  list.push(t);
  await persist(t);
  return { tag: t };
}

// Lista device-facing (TC22 sincroniza nomes): só tags ativas, MAC MAIÚSCULO como chave + rótulo cadastrado.
function listForDevice() {
  return list.filter((t) => t.ativo !== false).map((t) => ({ mac: key(t.btName), rotulo: t.rotulo }));
}

module.exports = { init, create, update, remove, match, upsertByMac, listForDevice, all: () => list };
