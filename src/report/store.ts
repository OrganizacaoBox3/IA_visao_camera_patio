// Persistência de HISTÓRICO do Relatório — I/O contra a API do hub (Postgres/JSON).
// Somente INDICADORES (LGPD: nunca imagens). record* = POST /api/ingest (fire-and-forget).
// load* = GET /api/data/*. clearAll = clear. Agregações puras vivem em ./calc.
import { apiGet, apiSend, listAlarms } from "../api";
import {
  shiftOf,
  type Dataset,
  type Cell,
  type EventRow,
  type ReadingDataset,
  type ReadingCell,
  type ReadingEventRow,
  type ObjectDataset,
  type ObjectCell,
  type ObjectEventRow,
  type FadigaDataset,
  type FadigaCell,
  type FadigaEventRow,
  type FlowDataset,
  type FlowCell,
} from "./calc";

const DAY = 86_400_000;
const shiftFor = (ts: number) => shiftOf(new Date(ts).getHours());

// ── Geometria de JANELA compartilhada pelos load*Dataset (extraída do boilerplate 5×) ──
// Ambas PURAS: dado o mesmo `hourStarts`/`startMs` (e `now`) devolvem o mesmo resultado.

/** Dia-base (startMs = meia-noite do bucket mais antigo) e nº de dias cobertos até `now`.
 *  Espelha a derivação repetida em loadDataset/loadReading/loadObject/loadFadiga/loadFlow.
 *  Requer `hourStarts` NÃO vazio (os chamadores já tratam a lista vazia antes). */
export function deriveWindow(
  hourStarts: number[],
  now: number = Date.now(),
): { days: number; startMs: number } {
  const startMs = Math.floor(Math.min(...hourStarts) / DAY) * DAY;
  const days = Math.max(1, Math.ceil((now - startMs) / DAY));
  return { days, startMs };
}

/** Posição de um bucket na janela: índice do dia (0-based desde startMs) e hora do dia (0..23). */
export function cellTime(hourStart: number, startMs: number): { dayIndex: number; hour: number } {
  return {
    dayIndex: Math.floor((hourStart - startMs) / DAY),
    hour: new Date(hourStart).getHours(),
  };
}

// Telemetria de falha do ingest: contador módulo-nível de falhas CONSECUTIVAS + warn 1× por
// sequência — "gravando" precisa ser distinguível de "perdendo dados" (sem toast global: o
// ingest roda no dashboard, não no relatório).
let ingestFailures = 0;
let ingestLastError: string | null = null;

// envio resiliente: gravação nunca pode lançar dentro do loop de vídeo
function ingest(kind: string, op: string, payload: unknown): Promise<void> {
  return apiSend("POST", "/api/ingest", { kind, op, payload })
    .then(() => {
      ingestFailures = 0; // sucesso fecha a sequência; nova falha volta a avisar 1×
    })
    .catch((e) => {
      ingestFailures += 1;
      ingestLastError = e instanceof Error ? e.message : String(e);
      if (ingestFailures === 1)
        console.warn(
          `[ingest] histórico NÃO está sendo gravado (${kind}/${op}): ${ingestLastError}`,
        );
    });
}
// Leitura do histórico: o erro é PROPAGADO — quem chama (ReportPage) distingue erro de vazio
// ("API fora do ar" nunca pode parecer "sem dados").
function fetchBuckets<T>(kind: string): Promise<T[]> {
  return apiGet<T[]>(`/api/data/${kind}/buckets`);
}
function fetchEvents<T>(kind: string): Promise<T[]> {
  return apiGet<T[]>(`/api/data/${kind}/events`);
}

// ── Modo ATIVIDADE ────────────────────────────────────────────────────────────
export type ZoneSample = {
  zoneId: string;
  label: string;
  atividade: string;
  idleMs: number;
  frames: number;
  activeFrames: number;
  people: number;
};
export type SamplePayload = { cameraId: string; samples: ZoneSample[] };
export type AlertPayload = {
  cameraId: string;
  cameraLabel: string;
  zoneId: string;
  area: string;
  atividade: string;
  ts: number;
  durationMin: number;
};
type Bucket = {
  id: string;
  cameraId: string;
  area: string;
  atividade: string;
  hourStart: number;
  idleMs: number;
  alerts: number;
  samples: number;
  activeSamples: number;
  peoplePeak: number;
};

export function recordSamples(p: SamplePayload): Promise<void> {
  return p.samples.length ? ingest("ativ", "samples", p) : Promise.resolve();
}
export function recordAlert(a: AlertPayload): Promise<void> {
  return ingest("ativ", "alert", { ...a, shift: shiftFor(a.ts) });
}

// Extensão ADITIVA de Cell: o tipo canônico (calc/atividade) segue intocado — pessoas entram
// como campo opcional só p/ quem quiser ler.
export interface AtivCell extends Cell {
  peoplePeak?: number;
}
// Pico de pessoas num recorte de células (usado pelo KPI do painel Atividade).
export function peoplePeakOf(cells: Cell[]): number {
  let max = 0;
  for (const c of cells) {
    const p = (c as AtivCell).peoplePeak;
    if (typeof p === "number" && p > max) max = p;
  }
  return max;
}

export async function loadDataset(): Promise<Dataset> {
  const buckets = await fetchBuckets<Bucket>("ativ");
  if (!buckets.length) return { days: 0, areas: [], cameraOf: {}, cells: [], startMs: Date.now() };
  const { days, startMs } = deriveWindow(buckets.map((b) => b.hourStart));
  const areas = new Set<string>();
  const cells: AtivCell[] = buckets.map((b) => {
    areas.add(b.area);
    return {
      area: b.area,
      ...cellTime(b.hourStart, startMs),
      idleMin: Math.round(b.idleMs / 60000),
      alerts: b.alerts,
      activePct: b.samples ? Math.round((b.activeSamples / b.samples) * 100) : 0,
      atividade: b.atividade,
      // o SELECT do hub expõe people_peak como "peoplePeak" (campo aditivo — hub antigo omite)
      peoplePeak: typeof b.peoplePeak === "number" ? b.peoplePeak : 0,
    };
  });
  return { days, areas: [...areas].sort(), cameraOf: {}, cells, startMs };
}

export async function loadEvents(): Promise<EventRow[]> {
  const evs = await fetchEvents<{
    ts: number;
    camera?: string;
    cameraId?: string;
    area: string;
    durationMin: number;
    shift: EventRow["shift"];
  }>("ativ");
  return evs.map((e) => ({
    ts: e.ts,
    area: e.area,
    camera: e.camera ?? e.cameraId ?? "—",
    durationMin: e.durationMin,
    shift: e.shift,
  }));
}

// ── Modo LEITURA ────────────────────────────────────────────────────────────--
export type ReadRecord = {
  ponto: string;
  cameraId: string;
  cameraLabel: string;
  code: string;
  ts: number;
  newBox: boolean;
  becameMulti: boolean;
};
type ReadingBucket = {
  id: string;
  ponto: string;
  hourStart: number;
  boxes: number;
  reads: number;
  multiReads: number;
  passages: number;
  perCamera: Record<string, { label: string; reads: number }>;
};

export function recordPass(ponto: string, ts: number): Promise<void> {
  return ingest("read", "pass", { ponto, ts });
}

// ── Fluxo de pessoas (tripwire) — evento por CRUZAMENTO, só metadados (LGPD ok). ──
// Contrato do kind "flow": op "cross" { cameraId, cameraLabel, tripwireId, dir, ts, shift }.
// O servidor agrega em buckets hora×câmera×linha (in/out) + guarda o evento cru.
export type FlowCross = {
  cameraId: string;
  cameraLabel: string;
  tripwireId: string;
  dir: "in" | "out";
  ts: number;
};
export function recordFlow(ev: FlowCross): Promise<void> {
  return ingest("flow", "cross", { ...ev, shift: shiftFor(ev.ts) });
}
/** Bucket de fluxo devolvido pelo servidor (hora×câmera×linha). */
export type FlowBucket = {
  cameraId: string;
  cameraLabel: string;
  tripwireId: string;
  hourStart: number;
  in: number;
  out: number;
};
/** Acumulado do DIA por linha (p/ o HUD/painel sobreviverem a reload). Erro propaga. */
export async function loadFlowToday(
  cameraId: string,
): Promise<Record<string, { in: number; out: number }>> {
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const buckets = await fetchBuckets<FlowBucket>("flow");
  const acc: Record<string, { in: number; out: number }> = {};
  for (const b of buckets) {
    if (b.cameraId !== cameraId || b.hourStart < dayStart) continue;
    const a = (acc[b.tripwireId] ??= { in: 0, out: 0 });
    a.in += b.in;
    a.out += b.out;
  }
  return acc;
}
// Agregações do fluxo (flowWindow/flowKpis/flowByHour/flowByLine) vivem em ./calc/flow —
// aqui fica só o I/O que monta o dataset.

/** Buckets de flow → dataset (mesmo padrão de loadDataset/loadReadingDataset). Erro PROPAGA:
 *  num hub antigo sem o kind "flow" o GET falha e quem chama oculta a seção (graceful). */
export async function loadFlowDataset(): Promise<FlowDataset> {
  const buckets = await fetchBuckets<FlowBucket>("flow");
  if (!buckets.length) return { days: 0, cells: [], startMs: Date.now() };
  const { days, startMs } = deriveWindow(buckets.map((b) => b.hourStart));
  const cells: FlowCell[] = buckets.map((b) => ({
    cameraId: b.cameraId,
    cameraLabel: b.cameraLabel,
    tripwireId: b.tripwireId,
    ...cellTime(b.hourStart, startMs),
    in: b.in,
    out: b.out,
  }));
  return { days, cells, startMs };
}

export function recordReads(r: ReadRecord): Promise<void> {
  return ingest("read", "read", { ...r, shift: shiftFor(r.ts) });
}

export async function loadReadingDataset(): Promise<ReadingDataset> {
  const buckets = await fetchBuckets<ReadingBucket>("read");
  if (!buckets.length)
    return { days: 0, pontos: [], cameraLabels: {}, cells: [], startMs: Date.now() };
  const { days, startMs } = deriveWindow(buckets.map((b) => b.hourStart));
  const pontos = new Set<string>();
  const cameraLabels: Record<string, string> = {};
  const cells: ReadingCell[] = buckets.map((b) => {
    pontos.add(b.ponto);
    const perCamera: Record<string, number> = {};
    for (const [cid, v] of Object.entries(b.perCamera ?? {})) {
      perCamera[cid] = v.reads;
      cameraLabels[cid] = v.label;
    }
    return {
      ponto: b.ponto,
      ...cellTime(b.hourStart, startMs),
      boxes: b.boxes,
      reads: b.reads,
      multiReads: b.multiReads,
      passages: b.passages ?? b.boxes,
      perCamera,
    };
  });
  return { days, pontos: [...pontos].sort(), cameraLabels, cells, startMs };
}

export async function loadReadingEvents(): Promise<ReadingEventRow[]> {
  return fetchEvents<ReadingEventRow>("read");
}

// ── Modo OBJETOS ──────────────────────────────────────────────────────────────
export type ObjSample = {
  setor: string;
  classe: string;
  samples: number;
  countSum: number;
  peak: number;
  present: number;
};
export type ObjectSamplePayload = { samples: ObjSample[] };
export type ObjectEvent = { type: string; setor: string; classe: string; ts: number };
type ObjectBucket = {
  id: string;
  setor: string;
  classe: string;
  hourStart: number;
  samples: number;
  countSum: number;
  peak: number;
  present: number;
};

export function recordObjectSamples(p: ObjectSamplePayload): Promise<void> {
  return p.samples.length ? ingest("obj", "samples", p) : Promise.resolve();
}
export function recordObjectEvent(e: ObjectEvent): Promise<void> {
  return ingest("obj", "event", { ...e, shift: shiftFor(e.ts) });
}

export async function loadObjectDataset(): Promise<ObjectDataset> {
  const buckets = await fetchBuckets<ObjectBucket>("obj");
  if (!buckets.length) return { days: 0, setores: [], classes: [], cells: [], startMs: Date.now() };
  const { days, startMs } = deriveWindow(buckets.map((b) => b.hourStart));
  const setores = new Set<string>(),
    classes = new Set<string>();
  const cells: ObjectCell[] = buckets.map((b) => {
    setores.add(b.setor);
    classes.add(b.classe);
    return {
      setor: b.setor,
      classe: b.classe,
      ...cellTime(b.hourStart, startMs),
      samples: b.samples,
      countSum: b.countSum,
      peak: b.peak,
      present: b.present,
    };
  });
  return { days, setores: [...setores].sort(), classes: [...classes].sort(), cells, startMs };
}

export async function loadObjectEvents(): Promise<ObjectEventRow[]> {
  return fetchEvents<ObjectEventRow>("obj");
}

// ── Modo FADIGA ─────────────────────────────────────────────────────────────--
export type FadigaSamplePayload = {
  posto: string;
  samples: number;
  ok: number;
  fadiga: number;
  celular: number;
  duplo: number;
  earSum: number;
  earSamples: number;
};
export type FadigaEvent = { posto: string; type: string; ts: number };
type FadigaBucket = {
  id: string;
  posto: string;
  hourStart: number;
  samples: number;
  ok: number;
  fadiga: number;
  celular: number;
  duplo: number;
  earSum: number;
  earSamples: number;
};

export function recordFadigaSamples(p: FadigaSamplePayload): Promise<void> {
  return p.samples ? ingest("fad", "samples", p) : Promise.resolve();
}
export function recordFadigaEvent(e: FadigaEvent): Promise<void> {
  return ingest("fad", "event", { ...e, shift: shiftFor(e.ts) });
}

export async function loadFadigaDataset(): Promise<FadigaDataset> {
  const buckets = await fetchBuckets<FadigaBucket>("fad");
  if (!buckets.length) return { days: 0, postos: [], cells: [], startMs: Date.now() };
  const { days, startMs } = deriveWindow(buckets.map((b) => b.hourStart));
  const postos = new Set<string>();
  const cells: FadigaCell[] = buckets.map((b) => {
    postos.add(b.posto);
    return {
      posto: b.posto,
      ...cellTime(b.hourStart, startMs),
      samples: b.samples,
      ok: b.ok,
      fadiga: b.fadiga,
      celular: b.celular,
      duplo: b.duplo,
      earSum: b.earSum,
      earSamples: b.earSamples,
    };
  });
  return { days, postos: [...postos].sort(), cells, startMs };
}

export async function loadFadigaEvents(): Promise<FadigaEventRow[]> {
  return fetchEvents<FadigaEventRow>("fad");
}

// Erro PROPAGA → a UI confirma sucesso ou avisa a falha de "limpar histórico".
export async function clearAll(): Promise<void> {
  await apiSend("POST", "/api/data/clear");
}

// ── EVENTOS DE ALARME (consome contrato B1: GET /api/alarms) ──────────────────
// SÓ METADADOS (sem imagens, LGPD). Erro PROPAGA (mesmo padrão dos load* acima).
// FONTE ÚNICA: alias do cliente de api.ts — nome público preservado p/ quem importa via store.
export const loadAlarms = listAlarms;
