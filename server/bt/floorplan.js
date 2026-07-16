// Configuração da PLANTA BAIXA do local (singleton, não indexado por câmera): as DIMENSÕES do
// galpão em metros + a posição X,Y (também em METROS) de cada estação BLE no piso. É o mapa 2D
// onde a UI desenha as estações e, mais tarde, deriva presença por área. Cache em memória +
// Postgres (se configurado) ou floorplan.json (fallback) — MESMO padrão de stations.js/camcfg.js.
//
// LGPD: SÓ geometria/ids (largura/altura do local e coordenadas das estações). Nenhuma imagem,
// frame ou PII — doutrina dos frames (ADR-002).
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");

const FILE = path.join(__dirname, "floorplan.json");

// Singleton: uma ÚNICA linha na tabela bt_floorplan (id fixo). O local é um só — não há chave de
// câmera aqui (é o mapa do CD inteiro), então guardamos o objeto num registro de id constante.
const ROW_ID = "default";

// id de estação = MESMO formato que o app do celular valida e que stations.js aceita.
const ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// Estado padrão VAZIO: "nunca configurado". O front trata widthM=0 como "aplique defaults".
const EMPTY = () => ({ widthM: 0, heightM: 0, stations: {}, workAreas: [] });

let current = EMPTY();
let usingPg = false;

// ── Validação defensiva (espelho do estilo de camcfg.js) ─────────────────────
// Número finito qualquer — as posições em metros são coordenadas do mundo (sinal livre; NÃO se
// clampa no servidor: a estação pode ficar na borda, em 0, ou até fora do retângulo desenhado).
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const norm = (s) => String(s ?? "").trim();

// Saneia o mapa de estações: descarta ENTRADA A ENTRADA o que for inválido (id fora do formato ou
// x/y não-finito), como a allowlist da casa faz — mas NUNCA descarta por estar fora do retângulo
// (a posição pode ser negativa/na borda). Devolve sempre um objeto novo (nada do input vaza).
function cleanStations(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [id, p] of Object.entries(input)) {
    const key = norm(id);
    if (!ID_RE.test(key)) continue; // id fora do formato → descarta silenciosamente
    if (!p || typeof p !== "object") continue;
    if (!fin(p.x) || !fin(p.y)) continue; // x/y não-finito → descarta silenciosamente
    out[key] = { x: p.x, y: p.y }; // números livres (metros), SEM clamp
  }
  return out;
}

const AREA_MIN_POINTS = 3;
const AREA_MAX_POINTS = 20;
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const onSegment = (p, q, r) =>
  Math.min(p.x, r.x) <= q.x &&
  q.x <= Math.max(p.x, r.x) &&
  Math.min(p.y, r.y) <= q.y &&
  q.y <= Math.max(p.y, r.y);
function segmentsIntersect(a, b, c, d) {
  const d1 = cross(c, d, a),
    d2 = cross(c, d, b),
    d3 = cross(a, b, c),
    d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  return (
    (d1 === 0 && onSegment(c, a, d)) ||
    (d2 === 0 && onSegment(c, b, d)) ||
    (d3 === 0 && onSegment(a, c, b)) ||
    (d4 === 0 && onSegment(a, d, b))
  );
}
function isSimplePolygon(points) {
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (
        segmentsIntersect(
          points[i],
          points[(i + 1) % points.length],
          points[j],
          points[(j + 1) % points.length],
        )
      )
        return false;
    }
  return true;
}
function rectanglePolygon(raw) {
  if (!raw.center || !fin(raw.center.x) || !fin(raw.center.y)) return null;
  if (!fin(raw.widthM) || raw.widthM <= 0 || !fin(raw.heightM) || raw.heightM <= 0) return null;
  const x0 = raw.center.x - raw.widthM / 2,
    x1 = raw.center.x + raw.widthM / 2;
  const y0 = raw.center.y - raw.heightM / 2,
    y1 = raw.center.y + raw.heightM / 2;
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

// Áreas físicas usam polígono métrico. Retângulos antigos são migrados para quatro vértices;
// reconhecer uma zona BLE nunca desloca uma tag para esta geometria.
function cleanWorkAreas(input, widthM, heightM, strict = false) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    if (strict) throw Object.assign(new Error("áreas de trabalho inválidas"), { badRequest: true });
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const id = norm(raw.id);
    const label = norm(raw.label);
    if (!ID_RE.test(id) || seen.has(id) || !label || label.length > 64) continue;
    const hasPolygon = Array.isArray(raw.polygon);
    const polygon = hasPolygon
      ? raw.polygon.map((point) => ({ x: point?.x, y: point?.y }))
      : rectanglePolygon(raw);
    if (!polygon || polygon.length < AREA_MIN_POINTS || polygon.length > AREA_MAX_POINTS) continue;
    if (polygon.some((point) => !fin(point.x) || !fin(point.y))) continue;
    if (
      polygon.some((point) => point.x < 0 || point.x > widthM || point.y < 0 || point.y > heightM)
    )
      continue;
    if (!isSimplePolygon(polygon)) continue;
    const xs = polygon.map((point) => point.x),
      ys = polygon.map((point) => point.y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    seen.add(id);
    out.push({
      id,
      label,
      polygon,
      center: hasPolygon
        ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
        : { x: raw.center.x, y: raw.center.y },
      widthM: hasPolygon ? maxX - minX : raw.widthM,
      heightM: hasPolygon ? maxY - minY : raw.heightM,
    });
  }
  if (strict && out.length !== input.length) {
    throw Object.assign(
      new Error("uma ou mais áreas são inválidas, duplicadas ou estão fora da planta"),
      { badRequest: true },
    );
  }
  return out;
}

// Valida a planta inteira. Dimensões inválidas são erro do CLIENTE (não há default são para o
// tamanho do galpão) → lança com `badRequest` (a rota devolve 400 com a mensagem). As estações
// são saneadas (descarte silencioso), como a allowlist. Devolve o objeto limpo e pronto p/ persistir.
function clean(fp, strictAreas = false) {
  if (!fp || typeof fp !== "object") {
    throw Object.assign(new Error("planta baixa inválida"), { badRequest: true });
  }
  if (!fin(fp.widthM) || fp.widthM <= 0) {
    throw Object.assign(new Error("largura (widthM) deve ser um número maior que zero"), {
      badRequest: true,
    });
  }
  if (!fin(fp.heightM) || fp.heightM <= 0) {
    throw Object.assign(new Error("comprimento (heightM) deve ser um número maior que zero"), {
      badRequest: true,
    });
  }
  return {
    widthM: fp.widthM,
    heightM: fp.heightM,
    stations: cleanStations(fp.stations),
    workAreas: cleanWorkAreas(fp.workAreas, fp.widthM, fp.heightM, strictAreas),
  };
}

// ── Persistência ─────────────────────────────────────────────────────────────
// LANÇA em falha — de propósito: o save faz ROLLBACK da memória e propaga (contra "persistência
// falsa"). MESMO padrão de stations.js/camcfg.js.
function saveFile() {
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
}
async function persist() {
  if (!usingPg) return saveFile();
  await db.query(
    "insert into bt_floorplan (id,data) values ($1,$2) on conflict (id) do update set data=excluded.data",
    [ROW_ID, JSON.stringify(current)],
  );
}

async function init() {
  if (db.configured()) {
    try {
      // Tabela idempotente (o schema.sql é a fonte única do resto; aqui, como é um store novo e
      // singleton, garantimos a linha própria sem alterar tabelas existentes — aditivo).
      await db.query(
        "create table if not exists bt_floorplan (id text primary key, data jsonb not null)",
      );
      const r = await db.query("select data from bt_floorplan where id=$1", [ROW_ID]);
      current = r.rows.length ? clean(r.rows[0].data) : EMPTY();
      usingPg = true;
      console.log("[bt-floorplan] planta baixa do Postgres");
      return;
    } catch (e) {
      // Dado gravado inválido (clean lançou) NÃO derruba o boot: cai no vazio e o operador re-salva.
      console.error("[bt-floorplan] Postgres indisponível/dado inválido, usando JSON:", e.message);
    }
  }
  usingPg = false;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    current = clean(data);
  } catch {
    current = EMPTY(); // arquivo ausente/corrompido/dimensões inválidas → vazio (o front usa defaults)
  }
}

/** A planta atual (ou o vazio `{ widthM:0, heightM:0, stations:{} }` se nunca salva). */
function get() {
  return current;
}

/**
 * Substitui a planta baixa e persiste. DURÁVEL-PRIMEIRO com ROLLBACK (mesma garantia de
 * stations.js/camcfg.js): valida → muta memória → persiste; se a persistência falhar, volta a
 * memória ao estado anterior e propaga o erro (com status 503, p/ a rota fazer surface). Erro de
 * VALIDAÇÃO (dimensões) sai com `badRequest` ANTES de mutar nada. Devolve a planta salva.
 */
async function save(fp) {
  const cleaned = clean(fp, true); // save é estrito: geometria inválida nunca some com falso sucesso
  const before = current;
  current = cleaned;
  try {
    await persist();
  } catch (e) {
    current = before; // rollback: a gravação não durou → a memória não pode mentir
    console.error("[bt-floorplan] FALHA ao salvar a planta baixa (rollback):", e.message);
    throw Object.assign(new Error("falha ao salvar a planta baixa — persistência indisponível"), {
      status: 503,
    });
  }
  return current;
}

module.exports = {
  init,
  get,
  save,
  // Puro (sem I/O), exportado p/ teste do round-trip da allowlist de estações.
  clean,
  cleanWorkAreas,
  ID_RE,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
