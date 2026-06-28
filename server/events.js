// ============================================================================
// Eventos de alarme com acknowledge (Onda B, item 7) — espinha dorsal.
// ----------------------------------------------------------------------------
// Store dos EVENTOS DE ALARME que a política (alarmPolicy.js) decide enviar.
// Transforma o stream "fire-and-forget" do Andon/WhatsApp numa FILA ACIONÁVEL,
// com estados (new → acknowledged → forwarded) para a central operar.
//
// PADRÃO DE PERSISTÊNCIA (espelha recipients.js/settings.js):
//   cache em memória + Postgres se db.configured(); senão fallback em
//   server/alarms.json. A decisão é tomada no init() (flag usingPg).
//
// LGPD (OBRIGATÓRIO): persistimos SOMENTE METADADOS — nada de imagens/frames.
//   Todos os campos são texto/identificadores/timestamps. NÃO há snapshot por
//   padrão. Espelha o princípio do schema.sql ("só indicadores, nunca imagens").
//
// MODELO DE UM EVENTO:
//   { id, ts, cameraId?, cameraLabel?, zona?, tipo, priority, text,
//     state, ackBy?, ackAt? }
//   - priority ∈ advisory | high | critical   (já calculada pela política)
//   - state    ∈ new | acknowledged | forwarded
//
// RETENÇÃO (configurável):
//   ALARM_EVENTS_RETENTION       (default 1000) Nº máx. de eventos guardados.
//   ALARM_EVENTS_RETENTION_DAYS  (default 0=off) Descarta eventos mais antigos
//                                que X dias (0 desliga o corte por idade).
//   ALARM_LOG_LEVEL              (default "info") Nível do logger pino.
// ============================================================================
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const db = require("./db");

const log = require("pino")({ name: "alarm-events", level: process.env.ALARM_LOG_LEVEL || "info" });

const FILE = path.join(__dirname, "alarms.json");
const RETENTION = Math.max(1, Number(process.env.ALARM_EVENTS_RETENTION ?? 1000));
const RETENTION_DAYS = Math.max(0, Number(process.env.ALARM_EVENTS_RETENTION_DAYS ?? 0));
const DAY_MS = 86_400_000;

const STATES = new Set(["new", "acknowledged", "forwarded"]);
const PRIORITIES = new Set(["advisory", "high", "critical"]);

// Cache em memória, SEMPRE ordenado por ts desc (mais recente primeiro).
let list = [];
let usingPg = false;

const clean = (s) => { const v = String(s == null ? "" : s).trim(); return v || undefined; };

// Monta um registro de alarme só com METADADOS (sem imagem/frame).
function build(e) {
  return {
    id: e.id || "a" + Date.now().toString(36) + crypto.randomBytes(4).toString("hex"),
    ts: Number(e.ts) || Date.now(),
    cameraId: clean(e.cameraId && e.cameraId !== "_" ? e.cameraId : ""),
    cameraLabel: clean(e.cameraLabel),
    zona: clean(e.zona && e.zona !== "*" ? e.zona : ""),
    tipo: clean(e.tipo) || "atividade",
    priority: PRIORITIES.has(e.priority) ? e.priority : "advisory",
    text: String(e.text || "").trim(),
    state: STATES.has(e.state) ? e.state : "new",
    ackBy: clean(e.ackBy),
    ackAt: e.ackAt != null ? Number(e.ackAt) : undefined,
  };
}

// ── Persistência ──────────────────────────────────────────────────────────
function saveFile() {
  try { fs.writeFileSync(FILE, JSON.stringify(list, null, 2)); }
  catch (e) { log.error({ err: e.message }, "[alarm-events] falha ao salvar JSON"); }
}
async function persist(ev) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into alarm_events (id,ts,camera_id,camera_label,zona,tipo,priority,text,state,ack_by,ack_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update set
       state=excluded.state, ack_by=excluded.ack_by, ack_at=excluded.ack_at`,
    [ev.id, ev.ts, ev.cameraId ?? null, ev.cameraLabel ?? null, ev.zona ?? null, ev.tipo,
     ev.priority, ev.text, ev.state, ev.ackBy ?? null, ev.ackAt ?? null]
  );
}

// Aplica retenção (nº máx. + idade) no cache e no armazenamento.
async function enforceRetention() {
  const cutoff = RETENTION_DAYS > 0 ? Date.now() - RETENTION_DAYS * DAY_MS : 0;
  const before = list.length;
  if (cutoff) list = list.filter((e) => e.ts >= cutoff);
  if (list.length > RETENTION) list = list.slice(0, RETENTION);
  if (!usingPg) { if (list.length !== before) saveFile(); return; }
  try {
    if (cutoff) await db.query("delete from alarm_events where ts < $1", [cutoff]);
    await db.query(
      "delete from alarm_events where id not in (select id from alarm_events order by ts desc limit $1)",
      [RETENTION]
    );
  } catch (e) { log.error({ err: e.message }, "[alarm-events] falha na retenção (PG)"); }
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select id, ts, camera_id as "cameraId", camera_label as "cameraLabel", zona, tipo,
                priority, text, state, ack_by as "ackBy", ack_at as "ackAt"
         from alarm_events order by ts desc limit $1`,
        [RETENTION]
      );
      list = r.rows.map(build);
      usingPg = true;
      log.info({ n: list.length }, "[alarm-events] carregados do Postgres");
      return;
    } catch (e) { log.error({ err: e.message }, "[alarm-events] Postgres indisponível, usando JSON"); }
  }
  usingPg = false;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(a)) list = a.map(build).sort((x, y) => y.ts - x.ts).slice(0, RETENTION);
  } catch { list = []; }
  log.info({ n: list.length }, "[alarm-events] carregados do JSON (fallback)");
}

// ── API do store ────────────────────────────────────────────────────────────
// Grava um novo evento de alarme (metadados). Retorna o evento criado.
async function record(e) {
  const ev = build({ ...e, id: undefined, state: "new", ackBy: undefined, ackAt: undefined });
  list.unshift(ev);
  await persist(ev);
  await enforceRetention();
  log.info({ id: ev.id, cameraId: ev.cameraId, tipo: ev.tipo, priority: ev.priority, state: ev.state }, "[alarm-events] alarme gravado");
  return ev;
}

// Marca um evento como acknowledged. Idempotente sobre o estado final.
async function ack(id, by) {
  const ev = list.find((x) => x.id === id);
  if (!ev) return { error: "alarme não encontrado" };
  ev.state = "acknowledged";
  ev.ackBy = clean(by) || ev.ackBy || "—";
  ev.ackAt = Date.now();
  await persist(ev);
  log.info({ id: ev.id, ackBy: ev.ackBy, state: ev.state }, "[alarm-events] alarme reconhecido (ack)");
  return { event: ev };
}

// Marca um evento como forwarded (encaminhado). Opcional.
async function forward(id, by) {
  const ev = list.find((x) => x.id === id);
  if (!ev) return { error: "alarme não encontrado" };
  ev.state = "forwarded";
  if (clean(by)) ev.ackBy = clean(by);
  if (!ev.ackAt) ev.ackAt = Date.now();
  await persist(ev);
  log.info({ id: ev.id, by: ev.ackBy, state: ev.state }, "[alarm-events] alarme encaminhado (forward)");
  return { event: ev };
}

// Lista filtrada (sempre ts desc). { limit, since, state, priority }.
function query({ limit, since, state, priority } = {}) {
  let out = list;
  if (since != null && !Number.isNaN(Number(since))) { const s = Number(since); out = out.filter((e) => e.ts > s); }
  if (state && STATES.has(state)) out = out.filter((e) => e.state === state);
  if (priority && PRIORITIES.has(priority)) out = out.filter((e) => e.priority === priority);
  let n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) n = 200;
  n = Math.min(n, RETENTION);
  return out.slice(0, n);
}

function get(id) { return list.find((x) => x.id === id) || null; }

module.exports = { init, record, ack, forward, query, get, all: () => list };
