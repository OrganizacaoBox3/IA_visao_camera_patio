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
// CARIMBO DE TURNO (bloco abaixo): o ingest é o CHOKE POINT de TODOS os produtores de histórico
// (motor do hub, navegador, futuros) — é aqui, e em nenhum outro lugar, que a linha ganha turno.
const camcfg = require("./camcfg");
const shiftsStore = require("./shifts");
const { resolveShift, siteTz } = require("./shift-clock");

const HOUR = 3_600_000;
const hourOf = (ts) => Math.floor(ts / HOUR) * HOUR;

// ── CARIMBO DE TURNO no INGEST (spec-turnos-por-zona F3/F5) ──────────────────
// O `shiftOf` hardcoded (06/14/22, "Manhã/Tarde/Noite") que vivia no motor MORREU: a fonte é o
// CADASTRO (server/shifts.js) e a resolução é a ÚNICA (server/shift-clock.js — overnight, borda,
// pausa e SITE_TZ moram lá). Aqui só se ESCOLHE o cadastro relevante e se GRAVA o veredito.
//
// TRÊS estados (e o SQL só tem dois: valor/NULL) — daí o SENTINELA `OUT` (string vazia):
//   shiftId "sh…" → DENTRO de um turno cadastrado (+ nome em `shift`, businessDate, inPause)
//   shiftId ''    → resolvido e FORA de turno (D7: fora do turno não é ociosidade)
//   SEM carimbo   → nenhum turno ATIVO aplicável (zona sem shiftIds, cadastro vazio, ids órfãos):
//                   NADA é gravado e a linha se comporta EXATAMENTE como hoje (CA-5). O relatório
//                   a decodifica pelo legado (o 06/14/22 sobrevive só lá, como retrocompat de
//                   LEITURA — src/report/calc/common.ts). "Sem carimbo" ≠ "fora do turno": um é
//                   ausência de INFORMAÇÃO, o outro é informação. Colapsar os dois inventaria
//                   "atividade fora de turno" em cima de todo o histórico legado.
//
// DUPLA ESCRITA (aditivo, retrocompat): o campo legado `shift` continua sendo gravado — agora com
// o NOME do turno resolvido — e os campos novos (shiftId/businessDate/inPause) entram ao lado.
const OUT = ""; // sentinela de FORA DE TURNO na coluna shift_id (NULL = sem carimbo)
const OUT_LABEL = "Fora de turno";

// Fontes REAIS (produção). Injetáveis só no teste (_setStampSources) — mesmo padrão de deps do
// alarm/shift.js: em produção usam-se os defaults.
let sources = {
  getZones: (cameraId) => camcfg.getZones(cameraId),
  allShifts: () => shiftsStore.all(),
  tz: () => siteTz(),
};

/**
 * O carimbo de um instante contra um conjunto de turnos. PURO.
 * @returns {null | {shiftId:string, shift:string|null, businessDate:string|null, inPause:boolean}}
 *          null = SEM carimbo (nenhum turno ativo aplicável → comportamento de hoje).
 */
function shiftStampOf(ts, shifts, tz) {
  // Turno INATIVO não vale como grade: uma zona cujos turnos foram todos desativados volta a ser
  // 24/7 (sem carimbo) — nunca "tudo fora do turno" (fail-open, como o gate de alarme).
  const ativos = (Array.isArray(shifts) ? shifts : []).filter((s) => s && s.ativo !== false);
  if (!ativos.length) return null;
  const r = resolveShift(ts, ativos, tz);
  if (!r) return { shiftId: OUT, shift: OUT_LABEL, businessDate: null, inPause: false };
  const s = ativos.find((x) => x.id === r.shiftId);
  return {
    shiftId: r.shiftId,
    shift: (s && s.nome) || r.shiftId,
    businessDate: r.businessDate,
    inPause: r.inPause === true,
  };
}

// Carimbo de uma ZONA (atividade): os turnos são os ATRIBUÍDOS a ela (Zone.shiftIds — F2).
// Zona sem turnos = 24/7 = comportamento atual. Id DANGLING (turno excluído do cadastro) é
// ignorado — some do subconjunto e, se sobrar vazio, a zona volta a 24/7 (fail-open).
function stampForZone(cameraId, zoneId, ts) {
  const zone = (sources.getZones(cameraId) || []).find((z) => z && z.id === zoneId);
  const ids = zone && Array.isArray(zone.shiftIds) ? zone.shiftIds : [];
  if (!ids.length) return null;
  const set = new Set(ids);
  return shiftStampOf(ts, (sources.allShifts() || []).filter((s) => s && set.has(s.id)), sources.tz());
}

// Carimbo de uma LINHA de contagem (flow/tripwire): a linha NÃO tem zona (spec §8), então a
// referência é a grade GLOBAL do cadastro — a decisão que faltava na pendência "como atribuir
// turno a um tripwire". Sem cadastro, nada é carimbado (o de hoje).
function stampGlobal(ts) {
  return shiftStampOf(ts, sources.allShifts() || [], sources.tz());
}

/** Chave do bucket de atividade. SEM carimbo → id LEGADO de 3 segmentos (a MESMA linha de hoje).
 *  Com carimbo, o turno entra na chave (a hora sozinha é grosseira demais: um turno que começa
 *  06:30 corta o bucket das 06h ao meio — e a pausa, idem). `~p` = trecho em PAUSA (D3). */
function ativBucketId(cameraId, zoneId, hourStart, stamp) {
  const base = `${cameraId}|${zoneId}|${hourStart}`;
  if (!stamp) return base;
  const turno = stamp.shiftId === OUT ? "fora" : stamp.shiftId;
  return `${base}|${turno}${stamp.inPause ? "~p" : ""}`;
}

/** Leitura: decodifica o sentinela para o contrato do front (src/report/calc/common.ts):
 *  string = dentro · null = FORA · campo AUSENTE = sem carimbo. Devolve CÓPIA (as linhas do
 *  fallback JSON são o estado vivo em memória — mutá-las corromperia o store). */
function decodeStamp(row) {
  const r = { ...row };
  if (r.shiftId === OUT) {
    r.shiftId = null; // resolvido e fora de turno (D7)
    r.inPause = false;
  } else if (r.shiftId === null || r.shiftId === undefined) {
    delete r.shiftId; // sem carimbo: o campo tem que sair AUSENTE, nunca null
    delete r.inPause;
    delete r.businessDate;
  }
  return r;
}

// Injeção das fontes do carimbo — SÓ p/ teste (isola do camcfg/shifts reais, que fazem I/O).
function _setStampSources(s) {
  sources = { ...sources, ...s };
}

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
// frente 3, achado h (docs/analises/perf-round3/frente3-hub-hotloops.md):
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
// Campos do carimbo gravados na linha (bucket/evento). SEM carimbo → nada é gravado: a linha
// nasce igual à de hoje (e o decodeStamp da leitura a devolve como "sem carimbo").
const stampFields = (stamp) =>
  stamp
    ? {
        shiftId: stamp.shiftId,
        shift: stamp.shift,
        inPause: stamp.inPause,
        businessDate: stamp.businessDate,
      }
    : {};

const J_INGEST = {
  "ativ:samples"(p) {
    const now = Date.now();
    const hs = hourOf(now);
    for (const sm of p.samples || []) {
      // Turno resolvido POR SAMPLE (a janela do ingest é de ~3s — ANALYSIS_AGG_MS), nunca por
      // hora: é o que dá precisão de segundos na borda do turno e dentro da pausa.
      const stamp = stampForZone(p.cameraId, sm.zoneId, now);
      const id = ativBucketId(p.cameraId, sm.zoneId, hs, stamp);
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
          ...stampFields(stamp), // o turno faz parte da CHAVE → constante dentro do bucket
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
    // O alerta é carimbado com o SEU ts (não com o "agora" da gravação) e com os turnos da SUA
    // zona — o mesmo carimbo dos samples ⇒ o alerta cai no MESMO bucket (a chave bate).
    const stamp = stampForZone(a.cameraId, a.zoneId, a.ts);
    mem.events.ativ.push({
      ts: a.ts,
      camera: a.cameraLabel ?? null,
      cameraId: a.cameraId ?? null,
      area: a.area ?? null,
      atividade: a.atividade ?? null,
      durationMin: a.durationMin ?? null,
      // dupla escrita: o rótulo legado agora é o NOME do turno resolvido (stampFields sobrescreve
      // `shift`); SEM carimbo, preserva o que o produtor mandou (hint de retrocompat do cliente).
      shift: a.shift ?? null,
      ...stampFields(stamp),
    });
    const hs = hourOf(a.ts);
    const id = ativBucketId(a.cameraId, a.zoneId, hs, stamp);
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
        ...stampFields(stamp),
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
      shift: c.shift ?? null, // sobrescrito pelo NOME do turno quando há carimbo (stampFields)
      ...stampFields(stampGlobal(c.ts)),
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
    const now = Date.now();
    const hs = hourOf(now);
    for (const sm of p.samples || []) {
      // Turno POR SAMPLE (janela de ~3s), nunca por hora — e entra na CHAVE do bucket.
      const stamp = stampForZone(p.cameraId, sm.zoneId, now);
      await db.query(
        `insert into ativ_buckets (id,camera_id,area,atividade,hour_start,idle_ms,samples,active_samples,people_peak,shift_id,shift,in_pause,business_date)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (id) do update set
           idle_ms=ativ_buckets.idle_ms+excluded.idle_ms,
           samples=ativ_buckets.samples+excluded.samples,
           active_samples=ativ_buckets.active_samples+excluded.active_samples,
           people_peak=greatest(ativ_buckets.people_peak,excluded.people_peak),
           area=excluded.area, atividade=excluded.atividade`,
        [
          ativBucketId(p.cameraId, sm.zoneId, hs, stamp),
          p.cameraId,
          sm.label,
          sm.atividade,
          hs,
          sm.idleMs,
          sm.frames,
          sm.activeFrames,
          sm.people,
          stamp ? stamp.shiftId : null,
          stamp ? stamp.shift : null,
          stamp ? stamp.inPause : null,
          stamp ? stamp.businessDate : null,
        ],
      );
    }
  },
  "ativ:alert": async (a) => {
    // Carimbo com o ts DO ALERTA e os turnos da SUA zona → mesma chave dos samples da janela.
    const stamp = stampForZone(a.cameraId, a.zoneId, a.ts);
    await db.query(
      `insert into ativ_events (ts,camera_id,camera,area,atividade,duration_min,shift,shift_id,in_pause,business_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        a.ts,
        a.cameraId,
        a.cameraLabel,
        a.area,
        a.atividade,
        a.durationMin,
        stamp ? stamp.shift : (a.shift ?? null), // dupla escrita: legado = NOME do turno resolvido
        stamp ? stamp.shiftId : null,
        stamp ? stamp.inPause : null,
        stamp ? stamp.businessDate : null,
      ],
    );
    const hs = hourOf(a.ts);
    await db.query(
      `insert into ativ_buckets (id,camera_id,area,atividade,hour_start,alerts,shift_id,shift,in_pause,business_date)
       values ($1,$2,$3,$4,$5,1,$6,$7,$8,$9)
      on conflict (id) do update set alerts=ativ_buckets.alerts+1`,
      [
        ativBucketId(a.cameraId, a.zoneId, hs, stamp),
        a.cameraId,
        a.area,
        a.atividade,
        hs,
        stamp ? stamp.shiftId : null,
        stamp ? stamp.shift : null,
        stamp ? stamp.inPause : null,
        stamp ? stamp.businessDate : null,
      ],
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
    // A LINHA de contagem não tem zona (spec §8) → o carimbo usa a grade GLOBAL do cadastro.
    const stamp = stampGlobal(c.ts);
    await db.query(
      `insert into flow_events (ts,camera_id,camera_label,tripwire_id,dir,shift,shift_id,in_pause,business_date)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        c.ts,
        c.cameraId,
        c.cameraLabel,
        c.tripwireId,
        c.dir,
        stamp ? stamp.shift : (c.shift ?? null), // dupla escrita (legado = NOME do turno)
        stamp ? stamp.shiftId : null,
        stamp ? stamp.inPause : null,
        stamp ? stamp.businessDate : null,
      ],
    );
  },
};

// ── LEITURA (buckets/eventos crus, camelCase) ─────────────────────────────────
// O carimbo de turno viaja nos SELECTs de ativ/flow e passa pelo decodeStamp (sentinela '' →
// null = fora; NULL → campo AUSENTE = sem carimbo) — o contrato de 3 estados do relatório.
const BUCKET_SQL = {
  ativ: `select id, camera_id as "cameraId", area, atividade, hour_start as "hourStart", idle_ms as "idleMs", alerts, samples, active_samples as "activeSamples", people_peak as "peoplePeak", shift_id as "shiftId", shift, in_pause as "inPause", business_date as "businessDate" from ativ_buckets`,
  read: `select id, ponto, hour_start as "hourStart", boxes, reads, multi_reads as "multiReads", passages, per_camera as "perCamera" from read_buckets`,
  obj: `select id, setor, classe, hour_start as "hourStart", samples, count_sum as "countSum", peak, present from obj_buckets`,
  fad: `select id, posto, hour_start as "hourStart", samples, ok, fadiga, celular, duplo, ear_sum as "earSum", ear_samples as "earSamples" from fad_buckets`,
  flow: `select id, camera_id as "cameraId", camera_label as "cameraLabel", tripwire_id as "tripwireId", hour_start as "hourStart", in_count as "in", out_count as "out" from flow_buckets`,
};
const EVENT_SQL = {
  ativ: `select ts, camera, camera_id as "cameraId", area, atividade, duration_min as "durationMin", shift, shift_id as "shiftId", in_pause as "inPause", business_date as "businessDate" from ativ_events order by ts desc`,
  read: `select ts, ponto, code, cameras, shift from read_events order by ts desc`,
  obj: `select ts, type, setor, classe, shift from obj_events order by ts desc`,
  fad: `select ts, posto, type, shift from fad_events order by ts desc`,
  flow: `select ts, camera_id as "cameraId", camera_label as "cameraLabel", tripwire_id as "tripwireId", dir, shift, shift_id as "shiftId", in_pause as "inPause", business_date as "businessDate" from flow_events order by ts desc`,
};
// Mesmo decode nos DOIS caminhos (PG e JSON): o fallback grava o sentinela igual ao SQL, então a
// leitura é idêntica — o front não distingue PG de JSON (contrato do topo do arquivo).
const decodeRows = (rows) => rows.map(decodeStamp);

async function buckets(kind) {
  if (!KINDS.includes(kind)) return [];
  if (db.configured()) {
    try {
      return decodeRows((await db.query(BUCKET_SQL[kind])).rows);
    } catch (e) {
      warnPgDown(e);
    }
  }
  return decodeRows(Object.values(mem.buckets[kind]));
}
async function events(kind) {
  if (!KINDS.includes(kind)) return [];
  if (db.configured()) {
    try {
      return decodeRows((await db.query(EVENT_SQL[kind])).rows);
    } catch (e) {
      warnPgDown(e);
    }
  }
  return decodeRows([...mem.events[kind]].sort((a, b) => b.ts - a.ts)); // como o SQL: ts desc
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
  // Carimbo de turno — puros, exportados p/ teste (pgstore.stamp.test.js):
  shiftStampOf, // (ts, shifts, tz) → carimbo | null (sem cadastro ativo = sem carimbo)
  ativBucketId, // (cameraId, zoneId, hourStart, stamp) → id (3 segmentos sem carimbo — CA-5)
  decodeStamp, // linha do banco → contrato de 3 estados do relatório (dentro/fora/sem-carimbo)
  _setStampSources, // injeção das fontes (camcfg/shifts/tz) — SÓ teste
};
