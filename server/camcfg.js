// Configuração COMPARTILHADA das câmeras entre operadores/turnos:
//  • VIEWS  — layouts salvos do dashboard (lista GLOBAL): { id, name, cameraIds[] }.
//  • TRIPWIRES — linhas de contagem POR CÂMERA: { id, a:{x,y}, b:{x,y} } (coords normalizadas 0..1).
// Antes viviam no localStorage de cada operador; agora ficam centralizadas para serem partilhadas.
// Espelha o padrão de recipients.js/settings.js: cache em memória + Postgres (se configurado) ou
// camcfg.json (fallback). LGPD: SÓ geometria/ids/nomes — nunca imagem, frame ou PII.
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");

const FILE = path.join(__dirname, "camcfg.json");
let views = [];            // SavedView[] — lista global ordenada
let tripwires = new Map(); // cameraId -> Tripwire[]
let usingPg = false;

// ── Validação defensiva (só persistimos geometria/ids/nomes) ─────────────────
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isCoord = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

function cleanView(v) {
  if (!v || typeof v !== "object") return null;
  const id = str(v.id);
  const name = str(v.name);
  if (!id || !name) return null;
  const cameraIds = Array.isArray(v.cameraIds) ? v.cameraIds.map(str).filter(Boolean) : [];
  return { id, name, cameraIds };
}
function cleanViews(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    const c = cleanView(v);
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}
function cleanTripwire(w) {
  if (!w || typeof w !== "object" || !w.a || !w.b) return null;
  const id = str(w.id);
  if (!id) return null;
  if (!isCoord(w.a.x) || !isCoord(w.a.y) || !isCoord(w.b.x) || !isCoord(w.b.y)) return null;
  return { id, a: { x: w.a.x, y: w.a.y }, b: { x: w.b.x, y: w.b.y } };
}
function cleanTripwires(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const w of arr) {
    const c = cleanTripwire(w);
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

// ── Persistência ─────────────────────────────────────────────────────────────
function saveFile() {
  try { fs.writeFileSync(FILE, JSON.stringify({ views, tripwires: Object.fromEntries(tripwires) }, null, 2)); }
  catch (e) { console.error("[camcfg] falha ao salvar:", e.message); }
}
// Views: substitui a lista inteira (delete-all + reinsert mantendo a ordem via `ord`).
async function persistViews() {
  if (!usingPg) return saveFile();
  await db.query("delete from app_views");
  for (let i = 0; i < views.length; i++) {
    const v = views[i];
    await db.query("insert into app_views (id,name,cameras,ord) values ($1,$2,$3,$4)", [v.id, v.name, JSON.stringify(v.cameraIds), i]);
  }
}
// Tripwires: substitui as linhas de UMA câmera (upsert; remove a linha se ficou vazia).
async function persistTripwires(cameraId) {
  if (!usingPg) return saveFile();
  const list = tripwires.get(cameraId) || [];
  if (list.length === 0) { await db.query("delete from cam_tripwires where camera_id=$1", [cameraId]); return; }
  await db.query("insert into cam_tripwires (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data", [cameraId, JSON.stringify(list)]);
}

async function init() {
  if (db.configured()) {
    try {
      const rv = await db.query("select id, name, cameras from app_views order by ord asc nulls first, id asc");
      views = rv.rows.map((r) => cleanView({ id: r.id, name: r.name, cameraIds: r.cameras })).filter(Boolean);
      const rt = await db.query("select camera_id, data from cam_tripwires");
      tripwires = new Map();
      for (const row of rt.rows) { const list = cleanTripwires(row.data); if (list.length) tripwires.set(String(row.camera_id), list); }
      usingPg = true;
      console.log(`[camcfg] ${views.length} view(s) e tripwires de ${tripwires.size} câmera(s) do Postgres`);
      return;
    } catch (e) { console.error("[camcfg] Postgres indisponível, usando JSON:", e.message); }
  }
  usingPg = false;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    views = cleanViews(data && data.views);
    tripwires = new Map();
    for (const [cam, arr] of Object.entries((data && data.tripwires) || {})) { const list = cleanTripwires(arr); if (list.length) tripwires.set(String(cam), list); }
  } catch { views = []; tripwires = new Map(); }
}

// ── API ──────────────────────────────────────────────────────────────────────
function allViews() { return views; }
// Substitui a lista inteira de views (compartilhada) e persiste; devolve a lista salva.
async function saveViews(input) {
  views = cleanViews(input);
  await persistViews();
  return views;
}
function getTripwires(cameraId) { return tripwires.get(str(cameraId)) || []; }
// Substitui as linhas de uma câmera e persiste; devolve a lista salva.
async function saveTripwires(cameraId, input) {
  const id = str(cameraId);
  if (!id) return [];
  const list = cleanTripwires(input);
  if (list.length === 0) tripwires.delete(id); else tripwires.set(id, list);
  await persistTripwires(id);
  return list;
}

module.exports = { init, allViews, saveViews, getTripwires, saveTripwires };
