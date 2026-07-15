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
const EMPTY = () => ({ widthM: 0, heightM: 0, stations: {} });

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

// Valida a planta inteira. Dimensões inválidas são erro do CLIENTE (não há default são para o
// tamanho do galpão) → lança com `badRequest` (a rota devolve 400 com a mensagem). As estações
// são saneadas (descarte silencioso), como a allowlist. Devolve o objeto limpo e pronto p/ persistir.
function clean(fp) {
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
  return { widthM: fp.widthM, heightM: fp.heightM, stations: cleanStations(fp.stations) };
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
      await db.query("create table if not exists bt_floorplan (id text primary key, data jsonb not null)");
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
  const cleaned = clean(fp); // lança badRequest se dimensões inválidas — nada foi mutado ainda
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
  ID_RE,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
