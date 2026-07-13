// Configuração COMPARTILHADA das câmeras entre operadores/turnos:
//  • TRIPWIRES — linhas de contagem POR CÂMERA: { id, a:{x,y}, b:{x,y} } (coords normalizadas 0..1).
//  • ZONES — zonas (ROIs + modo/config) POR CÂMERA: array de Zone (formato de src/zones.ts).
//  • CAMCONFIG — config de câmera POR CÂMERA: objeto CameraCfg (formato de src/cameraConfig.ts).
// Centralizadas no hub para serem partilhadas entre operadores/turnos (não no localStorage).
// Espelha o padrão de recipients.js/settings.js: cache em memória + Postgres (se configurado) ou
// camcfg.json (fallback). LGPD: SÓ geometria/ids/config — nunca imagem, frame ou PII.
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");
// Validação de zona POLIGONAL (spec zonas-poligonais): espelho JS de src/zones.ts vive em
// analysis/zones.js (mesmo lugar do pointInPolygon que a consome) — fonte única no hub.
const { sanitizeZonePoints, polygonBBox } = require("./analysis/zones");
// TURNOS (spec-turnos-por-zona F2): a atribuição zona→turnos viaja NESTE store (campo shiftIds),
// e a regra "a grade de uma zona não pode ter overlap" (D4/CA-4) é validada no SAVE — servidor,
// não UI. Só leitura do cadastro (shifts.all()) + o parser puro do relógio.
const shiftsStore = require("./shifts");
const { parseHM, durationMin } = require("./shift-clock");

const FILE = path.join(__dirname, "camcfg.json");
let tripwires = new Map(); // cameraId -> Tripwire[]
let zones = new Map(); // cameraId -> Zone[]
let camConfigs = new Map(); // cameraId -> CameraCfg
let calibrations = new Map(); // cameraId -> Calibration (homografia px↔metros; ver cleanCalibration)
let usingPg = false;

// ── Validação defensiva (só persistimos geometria/ids/nomes/config) ──────────
const str = (v) => (typeof v === "string" ? v.trim() : "");
const isCoord = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
// Enums espelhados de src/zones.ts (ZoneMode) e src/cameraConfig.ts (CapturePreset).
// "exclusao": zona que SUPRIME detecções de pessoa (máscara p/ FP de objeto fixo) — sem o
// modo aqui, cleanZone rebaixaria a zona de exclusão p/ "atividade" ao persistir (calibração).
// "proibida": área que deve ficar VAZIA (spec alerta-por-atividade E1) — o motor do hub produz
// o alarme tipo "presenca" a partir DESTA config (dwell em presencaAlertMs).
const ZONE_MODES = new Set(["atividade", "leitura", "objetos", "fadiga", "exclusao", "proibida"]);
// Janela de armamento da zona proibida (E4 / turnos F2): "sempre" (24/7, default seguro) ou
// relativa aos turnos ATRIBUÍDOS à zona (shiftIds). Quem decide é alarm/shift.js (a política);
// aqui só se PERSISTE o enum — espelho de ZONE_ARMINGS em src/zones.ts.
const ARMING_MODES = new Set(["sempre", "dentro-turnos", "fora-turnos"]);
const CAPTURE_PRESETS = new Set(["media", "alta", "maxima"]);
// Transporte de vídeo do tile: "mjpeg" (relé socket.io, default/rollback) ou "webrtc"
// (tile <video-stream> servido pelo go2rtc). Aditivo — câmera sem o campo segue MJPEG.
const TRANSPORTS = new Set(["auto", "mjpeg", "webrtc"]);
const num = (v, d) => (typeof v === "number" && Number.isFinite(v) ? v : d);
// Número finito qualquer (metros do mundo / entradas de H podem ser negativos ou grandes).
const fin = (v) => typeof v === "number" && Number.isFinite(v);
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
    // proibida (spec alerta-por-atividade E2/E4). INVARIANTE desta allowlist (armadilha A5):
    // campo NOVO de zona TEM que ser adicionado aqui, senão o save o descarta MUDO e o motor
    // do hub nunca vê o dwell configurado. Clamp são: 0..24h; inválido → default 10s.
    presencaAlertMs: Math.min(86_400_000, Math.max(0, num(z.presencaAlertMs, 10_000))),
    arming: ARMING_MODES.has(z.arming) ? z.arming : "sempre",
    // shiftIds (spec-turnos-por-zona F2): turnos atribuídos à zona. MESMA armadilha A5 — sem o
    // campo AQUI o save o descartaria MUDO e o gate de turno (alarm/shift.js) nunca veria a
    // atribuição. Ausente/malformado → [] = zona 24/7 (comportamento atual, CA-5). Ids DANGLING
    // (turno excluído do cadastro) NÃO são podados aqui: camcfg.init() pode rodar antes de
    // shifts.init() — o gate resolve isso em runtime (fail-open).
    shiftIds: [...new Set(strList(z.shiftIds))],
  };
  if (typeof z.mask === "string" && z.mask) out.mask = z.mask;
  // points (zona POLIGONAL, spec zonas-poligonais P2/P4 — armadilha 1: campo NOVO tem que estar
  // NESTA allowlist, senão o save o descarta MUDO): ≥3 e ≤20 vértices {x,y} clampados 0..1,
  // polígono SIMPLES. Malformado → campo OMITIDO (a zona segue valendo como retângulo/máscara),
  // NUNCA []. Com points válidos, a bbox x,y,w,h é RE-DERIVADA deles no save (padrão
  // maskBBoxNorm): o pré-filtro retangular dos call-sites nunca fica velho (armadilha 3).
  // NÃO confundir com calibration.points (homografia) — objetos distintos (armadilha 10).
  const pts = sanitizeZonePoints(z.points);
  if (pts) {
    out.points = pts;
    const bb = polygonBBox(pts);
    out.x = bb.x;
    out.y = bb.y;
    out.w = bb.w;
    out.h = bb.h;
  }
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
// ── OVERLAP dos turnos de UMA zona (D4 / CA-4) — a REGRA vive no servidor ────────────────────
// A grade atribuída a uma zona é uma PARTIÇÃO do tempo: dois turnos da MESMA zona não podem se
// sobrepor (senão "dentro do turno" vira ambíguo e o gate de ociosidade perde o denominador).
// Modelo: cada turno vira intervalos em MINUTOS DA SEMANA [início, início+duração) — um por dia
// em que INICIA (D1); o overnight que passa do domingo 24h volta ao começo da semana (a semana é
// circular). Duração ∈ (0, 24h) por construção (shifts.validateShift rejeita 0) ⇒ um turno nunca
// se sobrepõe a si mesmo em dias distintos. Intervalo MEIO-ABERTO: 06–14 e 14–22 na mesma zona
// são LEGAIS (a borda pertence ao turno que INICIA — D4).
const WEEK_MIN = 7 * 24 * 60;
function weekIntervals(s) {
  const ini = parseHM(s && s.inicio);
  const fim = parseHM(s && s.fim);
  if (ini == null || fim == null) return [];
  const dur = durationMin(ini, fim);
  if (!(dur > 0)) return [];
  const out = [];
  for (const d of Array.isArray(s.dias) ? s.dias : []) {
    if (!Number.isInteger(d) || d < 0 || d > 6) continue;
    const start = (d * 24 * 60 + ini) % WEEK_MIN;
    const end = start + dur;
    if (end <= WEEK_MIN) out.push([start, end]);
    else out.push([start, WEEK_MIN], [0, end - WEEK_MIN]); // vira a semana
  }
  return out;
}
const intervalsOverlap = (a, b) => a[0] < b[1] && b[0] < a[1];

// Valida a atribuição zona→turnos de uma LISTA de zonas (já saneada por cleanZones) contra o
// cadastro de turnos. Devolve mensagem de erro (string, p/ o 400) ou null quando está tudo certo.
// Turno DANGLING (id de turno excluído) é IGNORADO aqui — o gate trata em runtime (fail-open);
// turno INATIVO conta para o overlap (reativá-lo não pode criar uma grade ambígua pelas costas).
// PURA (recebe o cadastro por parâmetro) — é o que o teste do CA-4 exercita.
function validateZoneShifts(list, shifts) {
  const byId = new Map((Array.isArray(shifts) ? shifts : []).map((s) => [s.id, s]));
  for (const z of list) {
    const assigned = (z.shiftIds || []).map((id) => byId.get(id)).filter(Boolean);
    for (let i = 0; i < assigned.length; i++) {
      const A = weekIntervals(assigned[i]);
      for (let j = i + 1; j < assigned.length; j++) {
        const B = weekIntervals(assigned[j]);
        for (const a of A)
          for (const b of B)
            if (intervalsOverlap(a, b))
              return `zona "${z.label}": os turnos "${assigned[i].nome}" e "${assigned[j].nome}" se sobrepõem — os turnos de uma mesma zona não podem se sobrepor`;
      }
    }
  }
  return null;
}

// Config de câmera (src/cameraConfig.ts CameraCfg): modo + ponto de leitura + preset + classes.
function cleanCamConfig(c) {
  if (!c || typeof c !== "object") return null;
  return {
    modo: ZONE_MODES.has(c.modo) ? c.modo : "atividade",
    pontoLeitura: str(c.pontoLeitura),
    capture: CAPTURE_PRESETS.has(c.capture) ? c.capture : "maxima",
    transport: TRANSPORTS.has(c.transport) ? c.transport : "auto",
    selectedClasses: strList(c.selectedClasses),
    // longRange liga o tiling 2×2 no motor de análise (ADR-009). INVARIANTE desta allowlist:
    // campo NOVO de config TEM que ser adicionado aqui, senão é descartado MUDO no save.
    longRange: c.longRange === true,
  };
}

// Calibração de HOMOGRAFIA por câmera (medir distância no chão em metros; ADR tags-bluetooth §3).
// `points` = correspondências px(imagem, normalizado 0..1) ↔ world(metros); `H` = matriz 3×3
// ROW-MAJOR (9 números) computada no cliente por src/vision/homography.ts. SÓ geometria/números —
// nunca imagem/frame (LGPD). Validação defensiva: ≥4 pontos, px em 0..1, world/H finitos.
function cleanCalibration(c) {
  if (!c || typeof c !== "object") return null;
  if (!Array.isArray(c.points) || c.points.length < 4) return null;
  const points = [];
  for (const p of c.points) {
    if (!p || !p.px || !p.world) return null;
    if (!isCoord(p.px.x) || !isCoord(p.px.y)) return null; // px normalizado 0..1
    if (!fin(p.world.x) || !fin(p.world.y)) return null; // metros (finitos, sinal livre)
    const pt = {
      px: { x: p.px.x, y: p.px.y },
      world: { x: p.world.x, y: p.world.y },
    };
    // mac (opcional): tag BLE ÂNCORA fixada NESTE vértice (posição conhecida) — MAC MAIÚSCULO (o
    // mesmo das leituras BLE). Aditivo: só entra quando presente/não-vazio (SÓ string curta; LGPD).
    const mac = str(p.mac).toUpperCase();
    if (mac) pt.mac = mac;
    points.push(pt);
  }
  if (!Array.isArray(c.H) || c.H.length !== 9 || !c.H.every(fin)) return null;
  const out = { points, H: c.H.slice(), updatedAt: fin(c.updatedAt) ? c.updatedAt : Date.now() };
  // station (opcional): ponto de IMAGEM (normalizado 0..1) do CHÃO onde a estação BLE fica —
  // origem da correlação RSSI×distância. Aditivo: ausente/ inválido = omitido (SÓ números; LGPD).
  const s = c.station;
  if (s && typeof s === "object" && isCoord(s.x) && isCoord(s.y)) out.station = { x: s.x, y: s.y };
  // refTag (opcional): tag FIXA de referência num ponto conhecido do chão — âncora p/ heartbeat/drift/
  // RSSI@1m. `mac` = MAC MAIÚSCULO (o mesmo das leituras BLE); `px` = ponto de IMAGEM (normalizado
  // 0..1). Aditivo: ausente/ inválido = omitido (SÓ números/strings curtas; LGPD).
  const rt = c.refTag;
  if (
    rt &&
    typeof rt === "object" &&
    typeof rt.mac === "string" &&
    rt.mac.trim() !== "" &&
    rt.px &&
    typeof rt.px === "object" &&
    isCoord(rt.px.x) &&
    isCoord(rt.px.y)
  ) {
    out.refTag = { mac: String(rt.mac).trim().toUpperCase(), px: { x: rt.px.x, y: rt.px.y } };
  }
  return out;
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
          calibrations: Object.fromEntries(calibrations),
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
// Calibração: upsert do objeto de UMA câmera (remove a linha se ficou nula).
async function persistCalibration(cameraId) {
  if (!usingPg) return saveFile();
  const cal = calibrations.get(cameraId);
  if (!cal) {
    await db.query("delete from cam_calibration where camera_id=$1", [cameraId]);
    return;
  }
  await db.query(
    "insert into cam_calibration (camera_id,data) values ($1,$2) on conflict (camera_id) do update set data=excluded.data",
    [cameraId, JSON.stringify(cal)],
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
      const rk = await db.query("select camera_id, data from cam_calibration");
      calibrations = new Map();
      for (const row of rk.rows) {
        const cal = cleanCalibration(row.data);
        if (cal) calibrations.set(String(row.camera_id), cal);
      }
      usingPg = true;
      console.log(
        `[camcfg] tripwires de ${tripwires.size}, zonas de ${zones.size}, config de ${camConfigs.size} e calibração de ${calibrations.size} câmera(s) do Postgres`,
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
    calibrations = new Map();
    for (const [cam, obj] of Object.entries((data && data.calibrations) || {})) {
      const cal = cleanCalibration(obj);
      if (cal) calibrations.set(String(cam), cal);
    }
  } catch {
    tripwires = new Map();
    zones = new Map();
    camConfigs = new Map();
    calibrations = new Map();
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
// REJEITA (throw com badRequest → 400 na rota) a grade com turnos sobrepostos na mesma zona
// (CA-4): a validação de NEGÓCIO é do servidor; a UI só exibe a mensagem. Nada é mutado antes
// de validar — save inválido deixa o estado anterior intacto.
async function saveZones(cameraId, input) {
  const id = str(cameraId);
  if (!id) return [];
  const list = cleanZones(input);
  const err = validateZoneShifts(list, shiftsStore.all());
  if (err) throw Object.assign(new Error(err), { badRequest: true });
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
// Calibração de homografia; null quando a câmera nunca foi calibrada (o front trata como ausente).
function getCalibration(cameraId) {
  return calibrations.get(str(cameraId)) || null;
}
// Substitui a calibração de uma câmera e persiste; devolve a calibração salva (ou null se inválida).
async function saveCalibration(cameraId, input) {
  const id = str(cameraId);
  if (!id) return null;
  const cal = cleanCalibration(input);
  if (!cal) return null;
  calibrations.set(id, cal);
  await persistCalibration(id);
  return cal;
}

module.exports = {
  init,
  getTripwires,
  saveTripwires,
  getZones,
  saveZones,
  getCamConfig,
  saveCamConfig,
  getCalibration,
  saveCalibration,
  // Exportado SÓ p/ teste (puro, sem I/O): o round-trip da allowlist (CA-7) valida que salvar
  // e reler uma zona preserva os campos — sem tocar no camcfg.json/Postgres reais.
  cleanZones,
  // Puro (cadastro de turnos por parâmetro): a regra de overlap da grade da zona (CA-4).
  validateZoneShifts,
};
