// Última LOCALIZAÇÃO conhecida por tag Bluetooth (modelo AirTag: o TC22 é MÓVEL — enquanto vê a tag,
// a tag está na posição do celular; ao perder de vista, a última posição fica CONGELADA). Cache em
// memória; escrita no Postgres (se configurado) ou bt-locations.json (fallback) — MESMO padrão do
// bt-tags.js. LGPD: SÓ metadado (lat/lon/acc/ts), nunca imagem. É LAST-KNOWN (sem trilha/histórico —
// uma linha por tag, last-wins).
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");
const btTags = require("./bt-tags");

const FILE = path.join(__dirname, "bt-locations.json");
// MAC(maiúsculo) -> { lat, lon, acc|null, ts }
const latest = new Map();
let usingPg = false;

const key = (s) => String(s || "").trim().toUpperCase();
const valid = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

function saveFile() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(latest), null, 2));
  } catch (e) {
    console.error("[bt-locations] falha ao salvar:", e.message);
  }
}
// Persistência fire-and-forget (a rota chama update() num loop, sem await): a promise do PG NÃO pode
// virar unhandled rejection — capturamos aqui, como o saveFile já faz no fallback JSON.
function persist(mac, loc) {
  if (!usingPg) return saveFile();
  db.query(
    `insert into bt_tag_locations (mac,lat,lon,acc,ts) values ($1,$2,$3,$4,$5)
     on conflict (mac) do update set lat=excluded.lat, lon=excluded.lon, acc=excluded.acc, ts=excluded.ts`,
    [mac, loc.lat, loc.lon, loc.acc, loc.ts],
  ).catch((e) => console.error("[bt-locations] falha ao persistir:", e.message));
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query("select mac, lat, lon, acc, ts from bt_tag_locations");
      latest.clear();
      for (const row of r.rows) latest.set(key(row.mac), { lat: row.lat, lon: row.lon, acc: row.acc, ts: row.ts });
      usingPg = true;
      console.log(`[bt-locations] ${latest.size} localização(ões) do Postgres`);
      return;
    } catch (e) {
      console.error("[bt-locations] Postgres indisponível, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const o = JSON.parse(fs.readFileSync(FILE, "utf8"));
    latest.clear();
    if (o && typeof o === "object") for (const [mac, loc] of Object.entries(o)) latest.set(key(mac), loc);
  } catch {
    latest.clear();
  }
}

// Grava a última localização de UMA tag (upsert last-wins). Descarta silenciosamente lat/lon inválidos
// (fora de range / não-finitos). Persiste. `ts` injetável p/ determinismo nos testes.
function update(mac, { lat, lon, acc } = {}, ts = Date.now()) {
  const k = key(mac);
  if (!k) return null;
  const la = Number(lat);
  const lo = Number(lon);
  if (!valid(la, lo)) return null;
  const loc = { lat: la, lon: lo, acc: Number(acc) || null, ts };
  latest.set(k, loc);
  persist(k, loc);
  return loc;
}

// Snapshot enriquecido com o rótulo cadastrado (bt-tags.match). rotulo null = tag não cadastrada.
function snapshot() {
  const out = [];
  for (const [mac, loc] of latest) {
    out.push({ mac, rotulo: btTags.match(mac)?.rotulo ?? null, lat: loc.lat, lon: loc.lon, acc: loc.acc, ts: loc.ts });
  }
  return out;
}

module.exports = { init, update, snapshot };
