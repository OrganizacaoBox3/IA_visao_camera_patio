// Histórico/indicadores no Postgres (substitui o IndexedDB do browser → dado centralizado).
// Espelha a lógica de merge do antigo store.ts (acúmulo por bucket) em UPSERT SQL.
// Buckets/eventos voltam em camelCase (alias) para o front montar os mesmos "cells" de hoje.
//
// FALLBACK JSON (padrão da casa, espelha events.js): sem Postgres — ou com PG
// falhando — o ingest agrega EM MEMÓRIA por bucket (hora×chave, mesma chave do
// schema.sql) e persiste em server/data-hist.json com escrita atômica
// (tmp+rename) e flush write-behind com intervalo ADAPTATIVO (ver bloco do
// flush). Os objetos guardados têm EXATAMENTE a forma camelCase dos SELECTs
// abaixo, então o front não distingue PG de JSON.
// LGPD: só indicadores agregados/metadados — nunca imagens/frames.
const fs = require("node:fs");
const path = require("node:path");
const db = require("./db");

const HOUR = 3_600_000;
const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;

// ── FALLBACK JSON: estado + persistência ─────────────────────────────────────
// DATA_HIST_PATH: override do arquivo do fallback (default = server/data-hist.json). Ops pode
// relocar (ex.: volume dedicado); o teste de contrato aponta p/ um tmp — não toca o estado real.
const FILE = process.env.DATA_HIST_PATH || path.join(__dirname, "data-hist.json");
const KINDS = ["ativ", "read", "obj", "fad", "flow"];
const RETENTION_DAYS = Math.max(1, Number(process.env.DATA_HIST_RETENTION_DAYS ?? 30));
const DAY_MS = 86_400_000;
const FLUSH_MS = 2_000; // degrau BASE do flush adaptativo (ver flushIntervalMs abaixo)

const emptyStore = () => ({
  buckets: { ativ: {}, read: {}, obj: {}, fad: {}, flow: {} }, // id → bucket (upsert em memória)
  events: { ativ: [], read: [], obj: [], fad: [], flow: [] }, // linhas cruas (ts desc na leitura)
});
let mem = emptyStore();
let flushTimer = null;
let warnedPgDown = false;

// Poda por idade (~RETENTION_DAYS): buckets por hourStart, eventos por ts.
function prune() {
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
  for (const k of KINDS) {
    for (const [id, b] of Object.entries(mem.buckets[k]))
      if (!(Number(b?.hourStart) >= cutoff)) delete mem.buckets[k][id];
    mem.events[k] = mem.events[k].filter((e) => Number(e?.ts) >= cutoff);
  }
}

// Carrega o arquivo no boot (require) — estrutura inválida/ausente ⇒ começa vazio.
(function loadFile() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const k of KINDS) {
      const bk = raw?.buckets?.[k];
      if (bk && typeof bk === "object" && !Array.isArray(bk)) mem.buckets[k] = bk;
      if (Array.isArray(raw?.events?.[k])) mem.events[k] = raw.events[k];
    }
    prune();
  } catch {
    mem = emptyStore(); // sem arquivo ainda (ou corrompido) — começa vazio
  }
})();

// Log de boot 1× (o módulo carrega uma vez): deixa claro onde o histórico vive.
if (!db.configured()) console.log("[data] histórico em fallback JSON (sem Postgres)");

// PG configurado mas falhando em runtime → avisa 1× e segue no JSON.
function warnPgDown(e) {
  if (warnedPgDown) return;
  warnedPgDown = true;
  console.error("[data] Postgres falhou — histórico segue em fallback JSON:", e.message);
}

// ── Flush do fallback JSON: write-behind assíncrono + intervalo adaptativo ───
// Custo MEDIDO do flush completo (stringify+write+rename do histórico INTEIRO), perf round 3,
// frente 3, achado h (analises/perf-round3/frente3-hub-hotloops.md):
//   29 ms @1k · 78 ms @10k · 566 ms @50k eventos — e antes era tudo SÍNCRONO a cada ≤2s.
// Duas defesas: (a) write+rename saem do event loop via fs.promises, com no máximo 1 write em
// voo (o stringify continua síncrono no loop — amortizado por b); (b) o intervalo entre flushes
// CRESCE com o histórico (flushIntervalMs abaixo). Formato do arquivo INALTERADO (retrocompat).
// TRADE-OFF DECLARADO: a janela de perda em queda abrupta cresce junto (até ~30s de ingest com
// histórico grande; antes ≤2s). Aceitável porque produção usa Postgres — o fallback JSON é
// homolog/dev — e o shutdown limpo grava um write final síncrono (flushFinalSync).

// Intervalo adaptativo (puro, exportado p/ teste). Degraus calibrados pelo custo medido acima:
// 2s até 5k eventos (flush ~29 ms) · 10s até 50k (~78-566 ms) · 30s acima (>566 ms).
function flushIntervalMs(eventCount) {
  if (eventCount <= 5_000) return FLUSH_MS; // 2s
  if (eventCount <= 50_000) return 10_000;
  return 30_000;
}
function totalEvents() {
  let n = 0;
  for (const k of KINDS) n += mem.events[k].length;
  return n;
}

let writing = false; // guard: no máximo 1 write assíncrono em voo
let dirtyWhileWriting = false; // flush pedido durante o write em voo → reagenda no finally

// Escrita ATÔMICA (tmp+rename): nunca deixa data-hist.json truncado no disco.
async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (writing) {
    dirtyWhileWriting = true; // o finally do write em voo reagenda
    return;
  }
  writing = true;
  prune();
  const json = JSON.stringify(mem); // síncrono no loop — amortizado pelo intervalo adaptativo
  try {
    await fs.promises.writeFile(FILE + ".tmp", json);
    await fs.promises.rename(FILE + ".tmp", FILE);
  } catch (e) {
    console.error("[data] falha ao salvar data-hist.json:", e.message);
  } finally {
    writing = false;
    if (dirtyWhileWriting) {
      dirtyWhileWriting = false;
      scheduleFlush();
    }
  }
}
// Debounce adaptativo: o ingest chega a cada amostra; agrupamos escritas em disco.
function scheduleFlush() {
  if (writing) {
    dirtyWhileWriting = true;
    return;
  }
  if (flushTimer) return;
  flushTimer = setTimeout(flushNow, flushIntervalMs(totalEvents()));
  if (flushTimer.unref) flushTimer.unref();
}

// Write FINAL no shutdown — síncrono (único lugar onde bloquear o loop é aceitável: o processo
// está morrendo). Sem ele, o write-behind perderia o último intervalo pendente. Usa um tmp
// PRÓPRIO (.final.tmp) p/ não colidir com um write assíncrono abandonado em voo no mesmo path.
// No-op sem flush pendente (inclusive no caminho Postgres — handlers são inofensivos lá).
function flushFinalSync() {
  if (!flushTimer && !writing && !dirtyWhileWriting) return;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    prune();
    fs.writeFileSync(FILE + ".final.tmp", JSON.stringify(mem));
    fs.renameSync(FILE + ".final.tmp", FILE);
  } catch (e) {
    console.error("[data] falha no write final de data-hist.json:", e.message);
  }
}
process.once("exit", flushFinalSync);
// Garante que o "exit" acima rode também em SIGINT/SIGTERM sem outro handler no processo
// (com go2rtc ligado, o handler dele já chama process.exit — mesmo padrão de go2rtc.js).
process.once("SIGINT", () => process.exit(0));
process.once("SIGTERM", () => process.exit(0));

// ── FALLBACK JSON: agregação por bucket (mesma semântica dos UPSERTs SQL) ────
const J_INGEST = {
  "ativ:samples"(p) {
    const hs = hourOf(Date.now());
    for (const sm of p.samples || []) {
      const id = `${p.cameraId}|${sm.zoneId}|${hs}`;
      let b = mem.buckets.ativ[id];
      if (!b)
        b = mem.buckets.ativ[id] = {
          id,
          cameraId: p.cameraId ?? null,
          area: null,
          atividade: null,
          hourStart: hs,
          idleMs: 0,
          alerts: 0,
          samples: 0,
          activeSamples: 0,
          peoplePeak: 0,
        };
      b.idleMs += Number(sm.idleMs) || 0;
      b.samples += Number(sm.frames) || 0;
      b.activeSamples += Number(sm.activeFrames) || 0;
      b.peoplePeak = Math.max(b.peoplePeak, Number(sm.people) || 0);
      b.area = sm.label ?? null; // como o UPSERT: area/atividade = excluded
      b.atividade = sm.atividade ?? null;
    }
  },
  "ativ:alert"(a) {
    mem.events.ativ.push({
      ts: a.ts,
      camera: a.cameraLabel ?? null,
      cameraId: a.cameraId ?? null,
      area: a.area ?? null,
      atividade: a.atividade ?? null,
      durationMin: a.durationMin ?? null,
      shift: a.shift ?? null,
    });
    const hs = hourOf(a.ts);
    const id = `${a.cameraId}|${a.zoneId}|${hs}`;
    const b = mem.buckets.ativ[id];
    if (b) b.alerts += 1; // como o SQL: on conflict só incrementa alerts
    else
      mem.buckets.ativ[id] = {
        id,
        cameraId: a.cameraId ?? null,
        area: a.area ?? null,
        atividade: a.atividade ?? null,
        hourStart: hs,
        idleMs: 0,
        alerts: 1,
        samples: 0,
        activeSamples: 0,
        peoplePeak: 0,
      };
  },
  "read:read"(r) {
    const hs = hourOf(r.ts);
    const id = `${r.ponto}|${hs}`;
    let b = mem.buckets.read[id];
    if (!b)
      b = mem.buckets.read[id] = {
        id,
        ponto: r.ponto ?? null,
        hourStart: hs,
        boxes: 0,
        reads: 0,
        multiReads: 0,
        passages: 0,
        perCamera: {},
      };
    b.reads += 1;
    b.boxes += r.newBox ? 1 : 0;
    b.multiReads += r.becameMulti ? 1 : 0;
    b.perCamera[r.cameraId] = {
      label: r.cameraLabel,
      reads: (Number(b.perCamera[r.cameraId]?.reads) || 0) + 1,
    };
    if (r.newBox)
      mem.events.read.push({
        ts: r.ts,
        ponto: r.ponto ?? null,
        code: r.code ?? null,
        cameras: 1,
        shift: r.shift ?? null,
      });
  },
  "read:pass"(p) {
    const hs = hourOf(p.ts);
    const id = `${p.ponto}|${hs}`;
    let b = mem.buckets.read[id];
    if (!b)
      b = mem.buckets.read[id] = {
        id,
        ponto: p.ponto ?? null,
        hourStart: hs,
        boxes: 0,
        reads: 0,
        multiReads: 0,
        passages: 0,
        perCamera: {},
      };
    b.passages += 1;
  },
  "obj:samples"(p) {
    const hs = hourOf(Date.now());
    for (const sm of p.samples || []) {
      const id = `${sm.setor}|${sm.classe}|${hs}`;
      let b = mem.buckets.obj[id];
      if (!b)
        b = mem.buckets.obj[id] = {
          id,
          setor: sm.setor ?? null,
          classe: sm.classe ?? null,
          hourStart: hs,
          samples: 0,
          countSum: 0,
          peak: 0,
          present: 0,
        };
      b.samples += Number(sm.samples) || 0;
      b.countSum += Number(sm.countSum) || 0;
      b.peak = Math.max(b.peak, Number(sm.peak) || 0);
      b.present += Number(sm.present) || 0;
    }
  },
  "obj:event"(e) {
    mem.events.obj.push({
      ts: e.ts,
      type: e.type ?? null,
      setor: e.setor ?? null,
      classe: e.classe ?? null,
      shift: e.shift ?? null,
    });
  },
  "fad:samples"(p) {
    const hs = hourOf(Date.now());
    const id = `${p.posto}|${hs}`;
    let b = mem.buckets.fad[id];
    if (!b)
      b = mem.buckets.fad[id] = {
        id,
        posto: p.posto ?? null,
        hourStart: hs,
        samples: 0,
        ok: 0,
        fadiga: 0,
        celular: 0,
        duplo: 0,
        earSum: 0,
        earSamples: 0,
      };
    b.samples += Number(p.samples) || 0;
    b.ok += Number(p.ok) || 0;
    b.fadiga += Number(p.fadiga) || 0;
    b.celular += Number(p.celular) || 0;
    b.duplo += Number(p.duplo) || 0;
    b.earSum += Number(p.earSum) || 0;
    b.earSamples += Number(p.earSamples) || 0;
  },
  "fad:event"(e) {
    mem.events.fad.push({
      ts: e.ts,
      posto: e.posto ?? null,
      type: e.type ?? null,
      shift: e.shift ?? null,
    });
  },
  // Fluxo de pessoas (tripwire): evento por cruzamento — só metadados (LGPD).
  // Bucket já gravado com as chaves finais do contrato ("in"/"out").
  "flow:cross"(c) {
    const hs = hourOf(c.ts);
    const id = `${c.cameraId}|${c.tripwireId}|${hs}`;
    let b = mem.buckets.flow[id];
    if (!b)
      b = mem.buckets.flow[id] = {
        id,
        cameraId: c.cameraId ?? null,
        cameraLabel: c.cameraLabel ?? null,
        tripwireId: c.tripwireId ?? null,
        hourStart: hs,
        in: 0,
        out: 0,
      };
    if (c.dir === "in") b.in += 1;
    else if (c.dir === "out") b.out += 1;
    b.cameraLabel = c.cameraLabel ?? null; // como o UPSERT: label = excluded
    mem.events.flow.push({
      ts: c.ts,
      cameraId: c.cameraId ?? null,
      cameraLabel: c.cameraLabel ?? null,
      tripwireId: c.tripwireId ?? null,
      dir: c.dir ?? null,
      shift: c.shift ?? null,
    });
  },
};

function jsonIngest(key, p) {
  const fn = J_INGEST[key];
  if (!fn) return;
  fn(p);
  scheduleFlush();
}

// ── INGEST (incremental, ao vivo) ─────────────────────────────────────────────
// PG preferencial quando configurado (caminho intocado); sem PG — ou com PG
// lançando erro — a mesma gravação cai no fallback JSON.
async function ingest(kind, op, p) {
  if (!p) return;
  const key = `${kind}:${op}`;
  if (db.configured()) {
    const fn = INGEST[key];
    if (!fn) return;
    try {
      await fn(p);
      return;
    } catch (e) {
      warnPgDown(e);
    }
  }
  jsonIngest(key, p);
}

const INGEST = {
  "ativ:samples": async (p) => {
    const hs = hourOf(Date.now());
    for (const sm of p.samples || []) {
      await db.query(
        `insert into ativ_buckets (id,camera_id,area,atividade,hour_start,idle_ms,samples,active_samples,people_peak)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (id) do update set
           idle_ms=ativ_buckets.idle_ms+excluded.idle_ms,
           samples=ativ_buckets.samples+excluded.samples,
           active_samples=ativ_buckets.active_samples+excluded.active_samples,
           people_peak=greatest(ativ_buckets.people_peak,excluded.people_peak),
           area=excluded.area, atividade=excluded.atividade`,
        [
          `${p.cameraId}|${sm.zoneId}|${hs}`,
          p.cameraId,
          sm.label,
          sm.atividade,
          hs,
          sm.idleMs,
          sm.frames,
          sm.activeFrames,
          sm.people,
        ],
      );
    }
  },
  "ativ:alert": async (a) => {
    await db.query(
      `insert into ativ_events (ts,camera_id,camera,area,atividade,duration_min,shift) values ($1,$2,$3,$4,$5,$6,$7)`,
      [a.ts, a.cameraId, a.cameraLabel, a.area, a.atividade, a.durationMin, a.shift],
    );
    const hs = hourOf(a.ts);
    await db.query(
      `insert into ativ_buckets (id,camera_id,area,atividade,hour_start,alerts) values ($1,$2,$3,$4,$5,1)
      on conflict (id) do update set alerts=ativ_buckets.alerts+1`,
      [`${a.cameraId}|${a.zoneId}|${hs}`, a.cameraId, a.area, a.atividade, hs],
    );
  },
  "read:read": async (r) => {
    const hs = hourOf(r.ts),
      id = `${r.ponto}|${hs}`;
    await db.query(
      `insert into read_buckets (id,ponto,hour_start,boxes,reads,multi_reads,per_camera)
       values ($1,$2,$3,$4,1,$5, jsonb_build_object($6::text, jsonb_build_object('label',$7::text,'reads',1)))
       on conflict (id) do update set
         reads=read_buckets.reads+1,
         boxes=read_buckets.boxes+$4,
         multi_reads=read_buckets.multi_reads+$5,
         per_camera=jsonb_set(read_buckets.per_camera, array[$6::text],
           jsonb_build_object('label',$7::text,'reads', coalesce((read_buckets.per_camera->$6->>'reads')::int,0)+1))`,
      [id, r.ponto, hs, r.newBox ? 1 : 0, r.becameMulti ? 1 : 0, r.cameraId, r.cameraLabel],
    );
    if (r.newBox)
      await db.query(
        `insert into read_events (ts,ponto,code,cameras,shift) values ($1,$2,$3,1,$4)`,
        [r.ts, r.ponto, r.code, r.shift],
      );
  },
  "read:pass": async (p) => {
    const hs = hourOf(p.ts);
    await db.query(
      `insert into read_buckets (id,ponto,hour_start,passages) values ($1,$2,$3,1)
      on conflict (id) do update set passages=read_buckets.passages+1`,
      [`${p.ponto}|${hs}`, p.ponto, hs],
    );
  },
  "obj:samples": async (p) => {
    const hs = hourOf(Date.now());
    for (const sm of p.samples || []) {
      await db.query(
        `insert into obj_buckets (id,setor,classe,hour_start,samples,count_sum,peak,present)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set
           samples=obj_buckets.samples+excluded.samples,
           count_sum=obj_buckets.count_sum+excluded.count_sum,
           peak=greatest(obj_buckets.peak,excluded.peak),
           present=obj_buckets.present+excluded.present`,
        [
          `${sm.setor}|${sm.classe}|${hs}`,
          sm.setor,
          sm.classe,
          hs,
          sm.samples,
          sm.countSum,
          sm.peak,
          sm.present,
        ],
      );
    }
  },
  "obj:event": async (e) => {
    await db.query(`insert into obj_events (ts,type,setor,classe,shift) values ($1,$2,$3,$4,$5)`, [
      e.ts,
      e.type,
      e.setor,
      e.classe,
      e.shift,
    ]);
  },
  "fad:samples": async (p) => {
    const hs = hourOf(Date.now());
    await db.query(
      `insert into fad_buckets (id,posto,hour_start,samples,ok,fadiga,celular,duplo,ear_sum,ear_samples)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do update set
         samples=fad_buckets.samples+excluded.samples, ok=fad_buckets.ok+excluded.ok,
         fadiga=fad_buckets.fadiga+excluded.fadiga, celular=fad_buckets.celular+excluded.celular,
         duplo=fad_buckets.duplo+excluded.duplo, ear_sum=fad_buckets.ear_sum+excluded.ear_sum,
         ear_samples=fad_buckets.ear_samples+excluded.ear_samples`,
      [
        `${p.posto}|${hs}`,
        p.posto,
        hs,
        p.samples,
        p.ok,
        p.fadiga,
        p.celular,
        p.duplo,
        p.earSum,
        p.earSamples,
      ],
    );
  },
  "fad:event": async (e) => {
    await db.query(`insert into fad_events (ts,posto,type,shift) values ($1,$2,$3,$4)`, [
      e.ts,
      e.posto,
      e.type,
      e.shift,
    ]);
  },
  "flow:cross": async (c) => {
    const hs = hourOf(c.ts);
    await db.query(
      `insert into flow_buckets (id,camera_id,camera_label,tripwire_id,hour_start,in_count,out_count)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set
         in_count=flow_buckets.in_count+excluded.in_count,
         out_count=flow_buckets.out_count+excluded.out_count,
         camera_label=excluded.camera_label`,
      [
        `${c.cameraId}|${c.tripwireId}|${hs}`,
        c.cameraId,
        c.cameraLabel,
        c.tripwireId,
        hs,
        c.dir === "in" ? 1 : 0,
        c.dir === "out" ? 1 : 0,
      ],
    );
    await db.query(
      `insert into flow_events (ts,camera_id,camera_label,tripwire_id,dir,shift) values ($1,$2,$3,$4,$5,$6)`,
      [c.ts, c.cameraId, c.cameraLabel, c.tripwireId, c.dir, c.shift],
    );
  },
};

// ── LEITURA (buckets/eventos crus, camelCase) ─────────────────────────────────
const BUCKET_SQL = {
  ativ: `select id, camera_id as "cameraId", area, atividade, hour_start as "hourStart", idle_ms as "idleMs", alerts, samples, active_samples as "activeSamples", people_peak as "peoplePeak" from ativ_buckets`,
  read: `select id, ponto, hour_start as "hourStart", boxes, reads, multi_reads as "multiReads", passages, per_camera as "perCamera" from read_buckets`,
  obj: `select id, setor, classe, hour_start as "hourStart", samples, count_sum as "countSum", peak, present from obj_buckets`,
  fad: `select id, posto, hour_start as "hourStart", samples, ok, fadiga, celular, duplo, ear_sum as "earSum", ear_samples as "earSamples" from fad_buckets`,
  flow: `select id, camera_id as "cameraId", camera_label as "cameraLabel", tripwire_id as "tripwireId", hour_start as "hourStart", in_count as "in", out_count as "out" from flow_buckets`,
};
const EVENT_SQL = {
  ativ: `select ts, camera, camera_id as "cameraId", area, atividade, duration_min as "durationMin", shift from ativ_events order by ts desc`,
  read: `select ts, ponto, code, cameras, shift from read_events order by ts desc`,
  obj: `select ts, type, setor, classe, shift from obj_events order by ts desc`,
  fad: `select ts, posto, type, shift from fad_events order by ts desc`,
  flow: `select ts, camera_id as "cameraId", camera_label as "cameraLabel", tripwire_id as "tripwireId", dir, shift from flow_events order by ts desc`,
};
async function buckets(kind) {
  if (!KINDS.includes(kind)) return [];
  if (db.configured()) {
    try {
      return (await db.query(BUCKET_SQL[kind])).rows;
    } catch (e) {
      warnPgDown(e);
    }
  }
  return Object.values(mem.buckets[kind]);
}
async function events(kind) {
  if (!KINDS.includes(kind)) return [];
  if (db.configured()) {
    try {
      return (await db.query(EVENT_SQL[kind])).rows;
    } catch (e) {
      warnPgDown(e);
    }
  }
  return [...mem.events[kind]].sort((a, b) => b.ts - a.ts); // como o SQL: ts desc
}

// Status da persistência do histórico (p/ "vazio honesto" na UI):
// { persistence: "pg"|"json", counts: { ativ, read, obj, fad } } — counts = nº de buckets.
async function status() {
  if (db.configured()) {
    try {
      const r = await db.query(
        `select (select count(*)::int from ativ_buckets) as "ativ",
                (select count(*)::int from read_buckets) as "read",
                (select count(*)::int from obj_buckets) as "obj",
                (select count(*)::int from fad_buckets) as "fad",
                (select count(*)::int from flow_buckets) as "flow"`,
      );
      return { persistence: "pg", counts: r.rows[0] };
    } catch (e) {
      warnPgDown(e);
    }
  }
  const counts = {};
  for (const k of KINDS) counts[k] = Object.keys(mem.buckets[k]).length;
  return { persistence: "json", counts };
}

async function clear() {
  // Fallback JSON: zera memória e grava já (ação explícita — sem debounce adaptativo).
  mem = emptyStore();
  await flushNow();
  if (!db.configured()) return;
  await db.query(
    `truncate ativ_buckets, ativ_events, read_buckets, read_events, obj_buckets, obj_events, fad_buckets, fad_events, flow_buckets, flow_events`,
  );
}

module.exports = {
  ingest,
  buckets,
  events,
  status,
  clear,
  flushIntervalMs, // exportado p/ teste/unit (puro: nº de eventos → intervalo de flush)
};
