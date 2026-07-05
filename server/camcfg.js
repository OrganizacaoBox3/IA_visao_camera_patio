// Configuração COMPARTILHADA das câmeras entre operadores/turnos:
//  • TRIPWIRES — linhas de contagem POR CÂMERA: { id, a:{x,y}, b:{x,y} } (coords normalizadas 0..1).
//  • ZONES — zonas (ROIs + modo/config) POR CÂMERA: array de Zone (formato de src/zones.ts).
//  • CAMCONFIG — config de câmera POR CÂMERA: objeto CameraCfg (formato de src/cameraConfig.ts).
// Antes viviam no localStorage de cada operador; agora ficam centralizadas para serem partilhadas.
// Espelha o padrão de recipients.js/settings.js: cache em memória + Postgres (se configurado) ou
// camcfg.json (fallback). LGPD: SÓ geometria/ids/config — nunca imagem, frame ou PII.
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");

const FILE = path.join(__dirname, "camcfg.json");
let tripwires = new Map(); // cameraId -> Tripwire[]
let zones = new Map(); // cameraId -> Zone[]
let camConfigs = new Map(); // cameraId -> CameraCfg
let usingPg = false;

// ── Validação defensiva (só persistimos geometria/ids/nomes/config) ──────────
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isCoord = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
// Enums espelhados de src/zones.ts (ZoneMode) e src/cameraConfig.ts (CapturePreset).
// "exclusao": zona que SUPRIME detecções de pessoa (máscara p/ FP de objeto fixo) — sem o
// modo aqui, cleanZone rebaixaria a zona de exclusão p/ "atividade" ao persistir (calibração).
const ZONE_MODES = new Set(["atividade", "leitura", "objetos", "fadiga", "exclusao"]);
const CAPTURE_PRESETS = new Set(["media", "alta", "maxima"]);
// Transporte de vídeo do tile (Fase 1/go2rtc): "mjpeg" (relé socket.io atual, default/rollback)
// ou "webrtc" (tile <video-stream> servido pelo go2rtc). Aditivo — câmera sem o campo segue MJPEG.
const TRANSPORTS = new Set(["auto", "mjpeg", "webrtc"]);
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp01 = (v, d) => {
  const n = num(v, d);
  return n < 0 ? 0 : n > 1 ? 1 : n;
};
const strList = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

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
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}
// Zona (src/zones.ts Zone): geometria normalizada + modo + config plana por modo.
// `mask` é opcional (string codificada); só é incluída quando presente (retrocompat).
function cleanZone(z) {
  if (!z || typeof z !== "object") return null;
  const id = str(z.id);
  if (!id) return null;
  const out = {
    id,
    label: str(z.label) || "Área",
    x: clamp01(z.x, 0),
    y: clamp01(z.y, 0),
    w: clamp01(z.w, 1),
    h: clamp01(z.h, 1),
    modo: ZONE_MODES.has(z.modo) ? z.modo : "atividade",
    idleAlertMs: Math.max(0, num(z.idleAlertMs, 0)),
    sensitivity: num(z.sensitivity, 5),
    atividade: str(z.atividade),
    ponto: str(z.ponto),
    selectedClasses: strList(z.selectedClasses),
  };
  if (typeof z.mask === "string" && z.mask) out.mask = z.mask;
  return out;
}
function cleanZones(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const z of arr) {
    const c = cleanZone(z);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}
// Config de câmera (src/cameraConfig.ts CameraCfg): modo + ponto de leitura + preset + classes.
function cleanCamConfig(c) {
  if (!c || typeof c !== "object") return null;
  return {
    modo: ZONE_MODES.has(c.modo) ? c.modo : "atividade",
    pontoLeitura: str(c.pontoLeitura),
    capture: CAPTURE_PRESETS.has(c.capture) ? c.capture : "maxima",
    // Transporte de vídeo (Fase 1/go2rtc): default "mjpeg" (comportamento atual/rollback).
    // Só "webrtc" muda o tile p/ <video-stream> servido pelo go2rtc — feature-flag por câmera.
    transport: TRANSPORTS.has(c.transport) ? c.transport : "auto",
    selectedClasses: strList(c.selectedClasses),
    // Perfil "Longo alcance/Panorâmica" (CameraCfg.longRange): o front persiste e o
    // MOTOR de análise lê p/ ligar o tiling 2×2 (F3/ADR-009). Sem esta linha o flag
    // era descartado no save e o longo alcance server-side ficava inerte.
    longRange: c.longRange === true,
  };
}

// ── Persistência ─────────────────────────────────────────────────────────────
function saveFile() {
  try {
    fs.writeFileSync(
      FILE,
      JSON.stringify(
        {
          tripwires: Object.fromEntries(tripwires),
          zones: Object.fromEntries(zones),
          camConfigs: Object.fromEntries(camConfigs),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error("[camcfg] falha ao salvar:", e.message);
  }
}
// Tripwires: substitui as linhas de UMA câmera (upsert; remove a linha se ficou vazia).
async function persistTripwires(cameraId) {
  if (!usingPg) return saveFile();
  const list = tripwires.get(cameraId) || [];
  if (list.length === 0) {
    await db.query("delete from cam_tripwires where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_tripwires (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(list)],
  );
}
// Zonas: substitui as zonas de UMA câmera (upsert; remove a linha se ficou vazia).
async function persistZones(cameraId) {
  if (!usingPg) return saveFile();
  const list = zones.get(cameraId) || [];
  if (list.length === 0) {
    await db.query("delete from cam_zones where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_zones (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(list)],
  );
}
// Config de câmera: upsert do objeto de UMA câmera (remove a linha se ficou nula).
async function persistCamConfig(cameraId) {
  if (!usingPg) return saveFile();
  const cfg = camConfigs.get(cameraId);
  if (!cfg) {
    await db.query("delete from cam_config where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_config (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(cfg)],
  );
}

async function init() {
  if (db.configured()) {
    try {
      const rt = await db.query("select camera_id, data from cam_tripwires");
      tripwires = new Map();
      for (const row of rt.rows) {
        const list = cleanTripwires(row.data);
        if (list.length) tripwires.set(String(row.camera_id), list);
      }
      const rz = await db.query("select camera_id, data from cam_zones");
      zones = new Map();
      for (const row of rz.rows) {
        const list = cleanZones(row.data);
        if (list.length) zones.set(String(row.camera_id), list);
      }
      const rc = await db.query("select camera_id, data from cam_config");
      camConfigs = new Map();
      for (const row of rc.rows) {
        const cfg = cleanCamConfig(row.data);
        if (cfg) camConfigs.set(String(row.camera_id), cfg);
      }
      usingPg = true;
      console.log(
        `[camcfg] tripwires de ${tripwires.size}, zonas de ${zones.size} e config de ${camConfigs.size} câmera(s) do Postgres`,
      );
      return;
    } catch (e) {
      console.error("[camcfg] Postgres indisponível, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    tripwires = new Map();
    for (const [cam, arr] of Object.entries((data && data.tripwires) || {})) {
      const list = cleanTripwires(arr);
      if (list.length) tripwires.set(String(cam), list);
    }
    zones = new Map();
    for (const [cam, arr] of Object.entries((data && data.zones) || {})) {
      const list = cleanZones(arr);
      if (list.length) zones.set(String(cam), list);
    }
    camConfigs = new Map();
    for (const [cam, obj] of Object.entries((data && data.camConfigs) || {})) {
      const cfg = cleanCamConfig(obj);
      if (cfg) camConfigs.set(String(cam), cfg);
    }
  } catch {
    tripwires = new Map();
    zones = new Map();
    camConfigs = new Map();
  }
}

// ── API ──────────────────────────────────────────────────────────────────────
function getTripwires(cameraId) {
  return tripwires.get(str(cameraId)) || [];
}
// Substitui as linhas de uma câmera e persiste; devolve a lista salva.
async function saveTripwires(cameraId, input) {
  const id = str(cameraId);
  if (!id) return [];
  const list = cleanTripwires(input);
  if (list.length === 0) tripwires.delete(id);
  else tripwires.set(id, list);
  await persistTripwires(id);
  return list;
}
function getZones(cameraId) {
  return zones.get(str(cameraId)) || [];
}
// Substitui as zonas de uma câmera e persiste; devolve a lista salva.
async function saveZones(cameraId, input) {
  const id = str(cameraId);
  if (!id) return [];
  const list = cleanZones(input);
  if (list.length === 0) zones.delete(id);
  else zones.set(id, list);
  await persistZones(id);
  return list;
}
// Config de câmera; null quando a câmera nunca teve config salva (o front aplica os defaults).
function getCamConfig(cameraId) {
  return camConfigs.get(str(cameraId)) || null;
}
// Substitui a config de uma câmera e persiste; devolve a config salva (ou null se inválida).
async function saveCamConfig(cameraId, input) {
  const id = str(cameraId);
  if (!id) return null;
  const cfg = cleanCamConfig(input);
  if (!cfg) return null;
  camConfigs.set(id, cfg);
  await persistCamConfig(id);
  return cfg;
}

module.exports = {
  init,
  getTripwires,
  saveTripwires,
  getZones,
  saveZones,
  getCamConfig,
  saveCamConfig,
};
