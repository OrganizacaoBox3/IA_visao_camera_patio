// Histórico/indicadores no Postgres (substitui o IndexedDB do browser → dado centralizado).
// Espelha a lógica de merge do antigo store.ts (acúmulo por bucket) em UPSERT SQL.
// Buckets/eventos voltam em camelCase (alias) para o front montar os mesmos "cells" de hoje.
const db = require("./db");

const HOUR = 3_600_000;
const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;

// ── INGEST (incremental, ao vivo) ─────────────────────────────────────────────
async function ingest(kind, op, p) {
  if (!db.configured() || !p) return;
  const fn = INGEST[`${kind}:${op}`];
  if (fn) await fn(p);
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
};

// ── LEITURA (buckets/eventos crus, camelCase) ─────────────────────────────────
const BUCKET_SQL = {
  ativ: `select id, camera_id as "cameraId", area, atividade, hour_start as "hourStart", idle_ms as "idleMs", alerts, samples, active_samples as "activeSamples", people_peak as "peoplePeak" from ativ_buckets`,
  read: `select id, ponto, hour_start as "hourStart", boxes, reads, multi_reads as "multiReads", passages, per_camera as "perCamera" from read_buckets`,
  obj: `select id, setor, classe, hour_start as "hourStart", samples, count_sum as "countSum", peak, present from obj_buckets`,
  fad: `select id, posto, hour_start as "hourStart", samples, ok, fadiga, celular, duplo, ear_sum as "earSum", ear_samples as "earSamples" from fad_buckets`,
};
const EVENT_SQL = {
  ativ: `select ts, camera, camera_id as "cameraId", area, atividade, duration_min as "durationMin", shift from ativ_events order by ts desc`,
  read: `select ts, ponto, code, cameras, shift from read_events order by ts desc`,
  obj: `select ts, type, setor, classe, shift from obj_events order by ts desc`,
  fad: `select ts, posto, type, shift from fad_events order by ts desc`,
};
async function buckets(kind) {
  if (!db.configured()) return [];
  return (await db.query(BUCKET_SQL[kind])).rows;
}
async function events(kind) {
  if (!db.configured()) return [];
  return (await db.query(EVENT_SQL[kind])).rows;
}

async function clear() {
  if (!db.configured()) return;
  await db.query(
    `truncate ativ_buckets, ativ_events, read_buckets, read_events, obj_buckets, obj_events, fad_buckets, fad_events`,
  );
}

module.exports = { ingest, buckets, events, clear };
