// Cadastro DINÂMICO de câmeras IP/RTSP (CRUD em runtime). Persistência simples em cameras.json
// (não há tabela no schema.sql — mantém-se conservador, sem migração de banco). Espelha o padrão
// de recipients.js (cache em memória + arquivo). As fontes legadas seguem em rtsp.sources.json
// (carregadas no boot por rtsp.js); este módulo cuida apenas das câmeras adicionadas pela UI/API.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "cameras.json");
const TRANSPORTS = ["tcp", "udp", "http", "auto"]; // só se aplica a fontes rtsp://
const URL_RE = /^(rtsp|rtsps|http|https):\/\//i; // aceita RTSP, HLS (.m3u8) e MJPEG (http)

let list = [];

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }
  catch (e) { console.error("[cameras] falha ao salvar cameras.json:", e.message); }
}

function clampNum(v, min, max) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function init() {
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(a)) list = a.filter((c) => c && c.id && c.url);
  } catch { list = []; }
  console.log(`[cameras] ${list.length} câmera(s) dinâmica(s) carregada(s) de cameras.json`);
  return list;
}

function all() { return list; }
function get(id) { return list.find((c) => c.id === id) || null; }

function create(p) {
  p = p || {};
  const url = String(p.url || "").trim();
  if (!url) return { error: "url obrigatória" };
  if (!URL_RE.test(url)) return { error: "url deve começar com rtsp://, rtsps:// ou http(s)://" };
  const rec = {
    id: "cam-" + crypto.randomBytes(5).toString("hex"), // id estável (não posicional) — não quebra zonas ao reordenar
    label: String(p.label || "").trim() || "Câmera IP",
    url,
    transport: TRANSPORTS.includes(String(p.transport)) ? String(p.transport) : undefined,
    fps: clampNum(p.fps, 1, 30),
    width: clampNum(p.width, 160, 1920),
    quality: clampNum(p.quality, 1, 31),
    enabled: p.enabled !== false,
    criadoEm: Date.now(),
  };
  list.push(rec);
  save();
  return { camera: rec };
}

function update(id, patch) {
  const rec = get(id);
  if (!rec) return { error: "câmera não encontrada" };
  patch = patch || {};
  if (typeof patch.label === "string" && patch.label.trim()) rec.label = patch.label.trim();
  if (typeof patch.url === "string" && patch.url.trim()) {
    const u = patch.url.trim();
    if (!URL_RE.test(u)) return { error: "url inválida (use rtsp://, rtsps:// ou http(s)://)" };
    rec.url = u;
  }
  if (patch.transport !== undefined) rec.transport = TRANSPORTS.includes(String(patch.transport)) ? String(patch.transport) : undefined;
  if (patch.fps !== undefined) rec.fps = clampNum(patch.fps, 1, 30);
  if (patch.width !== undefined) rec.width = clampNum(patch.width, 160, 1920);
  if (patch.quality !== undefined) rec.quality = clampNum(patch.quality, 1, 31);
  if (typeof patch.enabled === "boolean") rec.enabled = patch.enabled;
  save();
  return { camera: rec };
}

function remove(id) {
  const n = list.length;
  list = list.filter((c) => c.id !== id);
  if (list.length === n) return { error: "câmera não encontrada" };
  save();
  return { ok: true };
}

module.exports = { init, all, get, create, update, remove };
