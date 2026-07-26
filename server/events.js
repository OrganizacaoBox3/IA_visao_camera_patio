// Store dos EVENTOS DE ALARME que a política decide enviar: transforma o stream
// "fire-and-forget" do Andon/WhatsApp numa FILA ACIONÁVEL (new → acknowledged → forwarded).
// Persistência: cache em memória + Postgres se configurado, senão server/alarms.json.
// LGPD (ADR-002): persistimos SOMENTE METADADOS (texto/ids/timestamps) — nunca imagem/frame.
//
// MODELO DE UM EVENTO (contrato com routes/alarms e o front):
//   { id, ts, cameraId?, cameraLabel?, zona?, tipo, priority, text, state, ackBy?, ackAt? }
//   - priority ∈ advisory | high | critical   (já calculada pela política)
//   - state    ∈ new | acknowledged | forwarded
//
// RETENÇÃO (configurável):
//   ALARM_EVENTS_RETENTION       (default 1000) Nº máx. de eventos guardados.
//   ALARM_EVENTS_RETENTION_DAYS  (default 0=off) Descarta eventos mais antigos que X dias.
//   ALARM_LOG_LEVEL              (default "info") Nível do logger pino.
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

const clean = (s) => {
  const v = String(s == null ? "" : s).trim();
  return v || undefined;
};

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
// LANÇA em falha — de propósito: record/ack/forward tratam e FAZEM ROLLBACK da memória (contra
// "persistência falsa": o alarme que aparece na fila e some no restart). MESMO padrão de shifts.js.
// A RETENÇÃO (housekeeping) é a exceção: envolve seu saveFile em try/catch (best-effort, retenta).
function saveFile() {
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}
async function persist(ev) {
  if (!usingPg) return saveFile();
  await db.query(
    `insert into alarm_events (id,ts,camera_id,camera_label,zona,tipo,priority,text,state,ack_by,ack_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     on conflict (id) do update set
       state=excluded.state, ack_by=excluded.ack_by, ack_at=excluded.ack_at`,
    [
      ev.id,
      ev.ts,
      ev.cameraId ?? null,
      ev.cameraLabel ?? null,
      ev.zona ?? null,
      ev.tipo,
      ev.priority,
      ev.text,
      ev.state,
      ev.ackBy ?? null,
      ev.ackAt ?? null,
    ],
  );
}

// Aplica retenção (nº máx. + idade) no cache e no armazenamento.
async function enforceRetention() {
  const cutoff = RETENTION_DAYS > 0 ? Date.now() - RETENTION_DAYS * DAY_MS : 0;
  const before = list.length;
  if (cutoff) list = list.filter((e) => e.ts >= cutoff);
  if (list.length > RETENTION) list = list.slice(0, RETENTION);
  if (!usingPg) {
    // Best-effort: a retenção é housekeeping (o evento novo JÁ está durável via record→persist). Uma
    // falha aqui não pode fazer rollback nem lançar — só loga e a poda ocorre no próximo ciclo.
    if (list.length !== before) {
      try {
        saveFile();
      } catch (e) {
        log.error({ err: e.message }, "[alarm-events] falha ao salvar JSON (retenção, retenta)");
      }
    }
    return;
  }
  try {
    if (cutoff) await db.query("delete from alarm_events where ts < $1", [cutoff]);
    await db.query(
      "delete from alarm_events where id not in (select id from alarm_events order by ts desc limit $1)",
      [RETENTION],
    );
  } catch (e) {
    log.error({ err: e.message }, "[alarm-events] falha na retenção (PG)");
  }
}

async function init() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select id, ts, camera_id as "cameraId", camera_label as "cameraLabel", zona, tipo,
                priority, text, state, ack_by as "ackBy", ack_at as "ackAt"
         from alarm_events order by ts desc limit $1`,
        [RETENTION],
      );
      list = r.rows.map(build);
      usingPg = true;
      log.info({ n: list.length }, "[alarm-events] carregados do Postgres");
      return;
    } catch (e) {
      log.error({ err: e.message }, "[alarm-events] Postgres indisponível, usando JSON");
    }
  }
  usingPg = false;
  try {
    const a = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(a))
      list = a
        .map(build)
        .sort((x, y) => y.ts - x.ts)
        .slice(0, RETENTION);
  } catch {
    list = [];
  }
  log.info({ n: list.length }, "[alarm-events] carregados do JSON (fallback)");
}

// ── API do store ────────────────────────────────────────────────────────────
// Grava um novo evento de alarme (metadados). Retorna o evento criado.
// Erro de persistência padronizado (ack/forward usam .status p/ o 503 na rota; record LANÇA, e o
// pipeline já trata com .catch — ver alarm/pipeline.js — então um alarme não-durável não é emitido).
const PERSIST_ERROR = (acao) => ({
  error: `falha ao ${acao} o alarme — a persistência está indisponível; tente novamente`,
  status: 503,
});

async function record(e) {
  const ev = build({ ...e, id: undefined, state: "new", ackBy: undefined, ackAt: undefined });
  list.unshift(ev); // otimista
  try {
    await persist(ev);
  } catch (err) {
    list = list.filter((x) => x !== ev); // rollback: nada de alarme-fantasma na fila
    log.error({ err: err.message }, "[alarm-events] FALHA ao gravar alarme (rollback)");
    throw err; // o pipeline (.catch) não emite o evento — memória fica coerente com o durável
  }
  await enforceRetention();
  log.info(
    { id: ev.id, cameraId: ev.cameraId, tipo: ev.tipo, priority: ev.priority, state: ev.state },
    "[alarm-events] alarme gravado",
  );
  return ev;
}

// Marca um evento como acknowledged. Idempotente sobre o estado final.
async function ack(id, by) {
  const ev = list.find((x) => x.id === id);
  if (!ev) return { error: "alarme não encontrado" };
  const before = { ...ev }; // snapshot p/ rollback
  ev.state = "acknowledged";
  ev.ackBy = clean(by) || ev.ackBy || "—";
  ev.ackAt = Date.now();
  try {
    await persist(ev);
  } catch (e) {
    Object.assign(ev, before); // rollback: o ack não gravou → estado volta ao anterior
    log.error({ err: e.message }, "[alarm-events] FALHA no ack (persistência)");
    return PERSIST_ERROR("reconhecer");
  }
  log.info(
    { id: ev.id, ackBy: ev.ackBy, state: ev.state },
    "[alarm-events] alarme reconhecido (ack)",
  );
  return { event: ev };
}

// Marca um evento como forwarded (encaminhado). Opcional.
async function forward(id, by) {
  const ev = list.find((x) => x.id === id);
  if (!ev) return { error: "alarme não encontrado" };
  const before = { ...ev }; // snapshot p/ rollback
  ev.state = "forwarded";
  if (clean(by)) ev.ackBy = clean(by);
  if (!ev.ackAt) ev.ackAt = Date.now();
  try {
    await persist(ev);
  } catch (e) {
    Object.assign(ev, before); // rollback: o forward não gravou → estado volta ao anterior
    log.error({ err: e.message }, "[alarm-events] FALHA no forward (persistência)");
    return PERSIST_ERROR("encaminhar");
  }
  log.info(
    { id: ev.id, by: ev.ackBy, state: ev.state },
    "[alarm-events] alarme encaminhado (forward)",
  );
  return { event: ev };
}

// Aplica os FILTROS da consulta, sem cortar (o universo da pergunta, sempre ts desc).
// Separado do corte de propósito: `total` só é honesto se contar DEPOIS do filtro e ANTES do limite.
function match({ since, state, priority } = {}) {
  let out = list;
  if (since != null && !Number.isNaN(Number(since))) {
    const s = Number(since);
    out = out.filter((e) => e.ts > s);
  }
  if (state && STATES.has(state)) out = out.filter((e) => e.state === state);
  if (priority && PRIORITIES.has(priority)) out = out.filter((e) => e.priority === priority);
  return out;
}

// Tamanho da página: default 200; teto na RETENÇÃO (pedir mais do que se guarda é impossível).
function pageSize(limit) {
  let n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) n = 200;
  return Math.min(n, RETENTION);
}

// Página + META DOS DOIS CORTES que a lista sofre (contrato aditivo — ver routes/alarms.js).
// Existe porque KPI/tendência calculados sobre página cortada SUBCONTAM EM SILÊNCIO:
//   1) `truncated`/`total` — o corte do `limit` (quem consome precisa poder dizer "500 de N");
//   2) `retentionClipped`  — o corte INVISÍVEL: a fila só guarda RETENTION eventos, então o que é
//      mais antigo já foi descartado e nem entra no `total`. Só acusamos quando isso REALMENTE
//      afeta a janela pedida (o mais antigo guardado é mais novo que o `since`) — senão viraria
//      aviso permanente em qualquer instalação movimentada, que é ruído, não informação.
function page(opts = {}) {
  const out = match(opts);
  const n = pageSize(opts.limit);
  const items = out.slice(0, n);
  const oldestTs = list.length ? list[list.length - 1].ts : null;
  const since = Number(opts.since);
  return {
    events: items,
    total: out.length, // universo APÓS os filtros e ANTES do corte
    truncated: out.length > items.length,
    limit: n,
    retention: RETENTION,
    oldestTs,
    retentionClipped:
      list.length >= RETENTION && Number.isFinite(since) && oldestTs != null && oldestTs > since,
  };
}

// Lista filtrada (sempre ts desc). { limit, since, state, priority }. CONTRATO ORIGINAL: array puro.
function query(opts = {}) {
  return page(opts).events;
}

function get(id) {
  return list.find((x) => x.id === id) || null;
}

module.exports = {
  init,
  record,
  ack,
  forward,
  query,
  page, // página + meta do corte (limit/retenção) — contrato aditivo de GET /api/alarms?meta=1
  get,
  all: () => list,
  persistence: () => (usingPg ? "pg" : "json"), // guardião de persistência (persistence-health.js)
};
