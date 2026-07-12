// Loader da GRAVAÇÃO DE CAMPO da fusão (Frente B): converte o JSONL gravado pelo servidor
// (server/bt/fusion-session.jsonl — linhas "cal"/"trk"/"ble", SÓ metadados, LGPD) no
// SimFusionScenario que o harness de replay já consome (replay-fusion.ts) — assim o associador
// DE PRODUÇÃO roda sobre dados REAIS pelo MESMO caminho de código do gate sintético.
// Responsabilidade única: parse + resample fiel à produção. Simular, associar e medir moram ao lado.
//
// Decisões documentadas (fidelidade à produção, não conveniência):
// - RESAMPLE em grade de tickMs (default 500 ms, o TICK_MS do useTagFusion): a produção NÃO consome
//   evento a evento — a cada tick ela lê o estado ACUMULADO dos snapshots. Fiel ao cliente real:
//   • tracks: o último "trk" da câmera vale ATÉ O PRÓXIMO (o getter do hub devolve o último payload
//     cru, SEM gate de idade; rodadas VAZIAS são gravadas pelo recorder e já representam "sem
//     detecção"). NENHUM tick é emitido antes do primeiro "trk" da câmera — antes disso a produção
//     nem teria `hd` (useTagFusion retorna cedo sem o getHubAnalysis).
//   • readings: cada evento "ble" SUBSTITUI o snapshot INTEIRO (useDashboardSocket:152-154 faz
//     `btReadingsRef.current = p.readings` — sem merge por MAC, sem staleness); o último batch vale
//     até o próximo. Batch vazio → tick com readings [] → replayFusion PULA o tick, espelhando o
//     `!readings.length` do useTagFusion.
// - VERDADE GLOBAL em todo tick: o assign() de produção decide também em ticks de rodada vazia
//   (currentTrackIds cai no último frame NÃO-vazio da janela — associate.ts); filtrar a verdade
//   pelos tracks presentes no tick deixaria essas decisões escaparem da métrica. Anexar a anotação
//   inteira é inócuo: a métrica só avalia trackIds presentes nos assignments.
// - Timestamps REBASEADOS para t0=0: a gravação usa epoch (Date.now); a produção alimenta o
//   associador com performance.now (começa perto de 0) e o warmupMs das métricas é ABSOLUTO.
//   Rebasear preserva os deltas (tudo que o associador usa) e mantém o warmup significativo.
// - `rotulo` é sempre null no replay: o recorder nem o grava (minimização LGPD — só {mac, rssi});
//   a identidade da tag é SEMPRE o MAC em MAIÚSCULO, porque a verdade-terreno é anotada por MAC.
//   Isso DIFERE da produção com rótulos cadastrados em dois pontos: (1) a string do tag participa
//   da ordem lexicográfica das colunas e do desempate do guloso no associador; (2) em produção,
//   rotulo DUPLICADO em MACs distintos FUNDE as séries de RSSI (frame.ts usa rotulo||mac como
//   chave). Sem mapa mac→rotulo por ora (YAGNI) — declarado, não escondido.
// - Linha suja é PULADA sem lançar (dado real vem sujo); item inválido dentro de tracks/readings é
//   descartado sem derrubar a linha. Loader nunca lança por dado ruim — devolve o que deu pra ler.
// - SANEAMENTO de ts: evento com ts além de ±24 h do ts MEDIANO é descartado (relógio suspeito —
//   ex.: 0 misturado a epoch); e a grade tem teto duro de 500 000 posições (trunca com
//   console.warn). Sem isso, um outlier geraria bilhões de ticks (OOM) — "nunca trava" inclui isso.
// - Sem cameraId explícito, vale a PRIMEIRA câmera vista no arquivo; "trk"/"cal" de outras câmeras
//   são ignorados (inclusive na grade de ticks). "ble" não filtra por stationId (MVP = 1 estação;
//   com várias, cada evento substitui o snapshot inteiro — exatamente o que o cliente vê do
//   bt-readings do hub).
// - Vários "cal" da câmera: o ÚLTIMO vence (recalibração sobrescreve, como a config de produção).
//   station null/ausente → stationPx default (0.5, 1.0), o MESMO default do frame.ts ("estação
//   junto da câmera") — replayFusion só o consome com H não-null; H null → proxy de caixa.
// - Cauda menor que um tick após o último tick da grade é descartada: a produção só a veria no
//   tick SEGUINTE, que não existe na gravação.
// - Descarte NUNCA é mudo: o retorno traz `diag` ADITIVO (linhas totais/descartadas, câmeras vistas)
//   e console.warn sinaliza >1 câmera no arquivo ou cameraId pedido que não casa nada.
// - Linha "meta" (ADITIVA, 2026-07-10 — ver `session-recorder.js`): versão do algoritmo/knobs da
//   sessão (`gitRev` + `fusionConfig`, espelho do `DEFAULTS` de associate.ts). NÃO participa da
//   grade de ticks (não tem cameraId, não é cal/trk/ble) — é lida à parte e exposta em `meta` no
//   retorno (aditivo a `SimFusionScenario`); "último vence" se houver mais de uma (mesmo padrão do
//   "cal"). Gravações ANTIGAS sem essa linha continuam funcionando idênticas — `meta` sai `null`.
// - `sourceId` nas readings (ADITIVO, ADR-013 item 3): a linha "ble" NOVA traz `sourceKind`
//   ("ble-rssi" — ver session-recorder.js) e o loader então PRESERVA o `stationId` do evento como
//   `sourceId` de cada RawReading (antes era descartado). Gate deliberado pela PRESENÇA de
//   `sourceKind`: gravação ANTIGA (sem sourceKind) parseia BYTE-IDÊNTICA ao que sempre parseou
//   (retrocompat dura, provada por teste — nem a chave `sourceId` existe), e é a linha que DECLARA
//   seu sourceKind que opta pelo vocabulário multi-fonte. Nenhum consumidor exige o campo hoje
//   (fonte única implícita — ver frame.ts); ele existe p/ a 2ª antena/AoA/UWB entrarem pela mesma
//   porta (evidence.ts, arquivado na tag research-fusion-arc-2026-07-12).
import { replayFusion } from "./replay-fusion";
import { TagTrackAssociator } from "./associate";
import type { FusionConfig, PairFunnel } from "./associate";
import { buildFusionFrame } from "./frame";
import type { SimFusionScenario, SimTick } from "./sim";
import type { DrawTrack, RawReading } from "./frame";
import type { IdentityMetrics } from "./identity-metrics";
import type { Matrix3, Vec2 } from "../vision/homography";

/** Verdade-terreno anotada MANUALMENTE pós-coleta: trackId REAL → MAC da tag (null = pessoa SEM tag).
 *  Tracks não anotados ficam FORA do truthTagByTrack — a métrica os ignora como fantasmas. */
export type SessionTruth = Record<number, string | null>;

export type SessionLoadOpts = {
  /** Câmera a replayar; default = a primeira vista no arquivo. */
  cameraId?: string;
  /** Período da grade de resample (ms); default 500 = TICK_MS do useTagFusion. */
  tickMs?: number;
};

/** Diagnóstico ADITIVO do parse — descarte nunca é mudo (câmera errada ≠ métricas zeradas sem sinal). */
export type SessionDiag = {
  /** Linhas recebidas (inclui vazias/sujas). */
  linesTotal: number;
  /** Linhas que NÃO viraram evento (vazias, corrompidas, tipo desconhecido, campos inválidos). */
  linesDropped: number;
  /** Eventos "cal"/"trk" válidos por cameraId visto no arquivo (>1 chave = câmera trocando de id?). */
  cameras: Record<string, number>;
};

/** Versão do algoritmo/knobs da sessão (linha "meta" — ver session-recorder.js). `gitRev` null =
 *  git indisponível no momento da gravação (não é erro). `fusionConfig` é o espelho manual dos
 *  DEFAULTS de associate.ts tal como a linha trouxe (não validado campo-a-campo — é reportado
 *  cru; `gitRev` é a fonte de verdade em caso de dúvida sobre o valor exato de um knob). */
export type SessionMeta = {
  gitRev: string | null;
  fusionConfig: Record<string, unknown>;
};

/** SimFusionScenario + diagnóstico do parse + meta da sessão. Aditivo — quem espera
 *  SimFusionScenario segue servido; `meta` é `null` em gravações antigas (sem linha "meta"). */
export type LoadedFusionSession = SimFusionScenario & { diag: SessionDiag; meta: SessionMeta | null };

const DEFAULT_TICK_MS = 500; // TICK_MS do useTagFusion de produção
const DEFAULT_STATION_PX: Vec2 = { x: 0.5, y: 1.0 }; // mesmo default do frame.ts (estação junto da câmera)
const TS_OUTLIER_MS = 24 * 60 * 60 * 1000; // evento além de ±24 h do ts mediano = relógio suspeito
const MAX_TICKS = 500_000; // teto duro da grade (nunca OOM por ts ruim/tickMs minúsculo)

// ——— Eventos internos (a linha JSONL já validada e normalizada) ———

type CalEvent = { t: "cal"; ts: number; cameraId: string; H: Matrix3 | null; station: Vec2 | null };
type TrkEvent = { t: "trk"; ts: number; cameraId: string; tracks: DrawTrack[] };
type BleEvent = { t: "ble"; ts: number; readings: RawReading[] };
/** Linha "meta" — sem cameraId (não participa do filtro por câmera nem da grade de ticks). */
type MetaEvent = { t: "meta"; ts: number; gitRev: string | null; fusionConfig: Record<string, unknown> };
type SessionEvent = CalEvent | TrkEvent | BleEvent | MetaEvent;

// ——— Guards de parse (dado real vem sujo — validar tudo, nunca lançar) ———

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** H da linha "cal": null ou array de 9 números finitos. undefined = inválido (linha suja). */
function parseH(v: unknown): Matrix3 | null | undefined {
  if (v === null) return null;
  if (!Array.isArray(v) || v.length !== 9 || !v.every(isFiniteNumber)) return undefined;
  return [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]];
}

/** station da linha "cal": null/ausente → null (default documentado); objeto {x,y} finito → Vec2. */
function parseStation(v: unknown): Vec2 | null | undefined {
  if (v === null || v === undefined) return null;
  const o = asRecord(v);
  if (!o || !isFiniteNumber(o.x) || !isFiniteNumber(o.y)) return undefined;
  return { x: o.x, y: o.y };
}

/** Um item de tracks: {id, bbox:[x,y,w,h]} — inválido é descartado sem derrubar a linha. */
function parseTrack(v: unknown): DrawTrack | null {
  const o = asRecord(v);
  if (!o || !isFiniteNumber(o.id)) return null;
  const b = o.bbox;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(isFiniteNumber)) return null;
  return { id: o.id, bbox: [b[0], b[1], b[2], b[3]] };
}

/** Um item de readings: {mac, rssi} — rotulo é sempre null (identidade = MAC maiúsculo; ver cabeçalho).
 *  `sourceId` (quando o chamador o passa — linha "ble" nova com sourceKind, ver cabeçalho) é
 *  estampado em cada reading; ausente → nem a chave existe (retrocompat dura, fonte única implícita). */
function parseReading(v: unknown, sourceId?: string): RawReading | null {
  const o = asRecord(v);
  if (!o || typeof o.mac !== "string" || o.mac.length === 0 || !isFiniteNumber(o.rssi)) return null;
  const out: RawReading = { mac: o.mac.toUpperCase(), rotulo: null, rssi: o.rssi };
  if (sourceId !== undefined) out.sourceId = sourceId;
  return out;
}

/** Parse de UMA linha JSONL → evento tipado, ou null se a linha é suja (pulada + contada no diag). */
function parseLine(line: string): SessionEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null; // linha truncada/corrompida — dado real vem sujo
  }
  const o = asRecord(raw);
  if (!o || !isFiniteNumber(o.ts)) return null;

  if (o.t === "cal") {
    if (typeof o.cameraId !== "string" || o.cameraId.length === 0) return null;
    const H = parseH(o.H);
    const station = parseStation(o.station);
    if (H === undefined || station === undefined) return null;
    return { t: "cal", ts: o.ts, cameraId: o.cameraId, H, station };
  }
  if (o.t === "trk") {
    if (typeof o.cameraId !== "string" || o.cameraId.length === 0) return null;
    if (!Array.isArray(o.tracks)) return null;
    const tracks: DrawTrack[] = [];
    for (const item of o.tracks) {
      const trk = parseTrack(item);
      if (trk) tracks.push(trk);
    }
    return { t: "trk", ts: o.ts, cameraId: o.cameraId, tracks };
  }
  if (o.t === "ble") {
    if (!Array.isArray(o.readings)) return null;
    // sourceId = stationId, SÓ quando a linha declara sourceKind (formato novo — ver cabeçalho);
    // linha antiga sem sourceKind parseia idêntica ao de sempre (sem a chave sourceId).
    const sourceId =
      typeof o.sourceKind === "string" && typeof o.stationId === "string" && o.stationId.length > 0
        ? o.stationId
        : undefined;
    const readings: RawReading[] = [];
    for (const item of o.readings) {
      const r = parseReading(item, sourceId);
      if (r) readings.push(r);
    }
    return { t: "ble", ts: o.ts, readings };
  }
  if (o.t === "meta") {
    const fc = asRecord(o.fusionConfig);
    if (!fc) return null; // sem fusionConfig a linha "meta" não serve pra nada — conta como suja
    const gitRev = typeof o.gitRev === "string" ? o.gitRev : null;
    return { t: "meta", ts: o.ts, gitRev, fusionConfig: fc };
  }
  return null; // tipo desconhecido — contrato aditivo: eventos novos não derrubam o loader
}

/** ts mediano (mediana inferior) de uma lista NÃO-vazia de eventos — âncora do saneamento ±24 h. */
function medianTs(events: SessionEvent[]): number {
  const ts = events.map((e) => e.ts).sort((a, b) => a - b);
  return ts[(ts.length - 1) >> 1];
}

/**
 * Converte a gravação de campo (linhas do JSONL) no SimFusionScenario que replayFusion consome
 * (+ `diag` aditivo do parse). Resample fiel à produção: grade de tickMs a partir do primeiro
 * evento saneado; cada tick carrega o último "trk" da câmera (vale até o próximo; nada é emitido
 * antes do primeiro "trk") e o último batch "ble" INTEIRO (cada evento substitui o snapshot —
 * batch vazio → replayFusion pula o tick). `truth` é a anotação manual pós-coleta
 * (trackId → MAC | null), anexada GLOBALMENTE a todo tick (ver cabeçalho); MACs normalizados a
 * MAIÚSCULO dos dois lados. Nunca lança por dado ruim; ts fora de ±24 h do mediano é descartado
 * e a grade tem teto de 500 000 ticks.
 */
export function parseFusionSession(
  lines: string[],
  truth: SessionTruth,
  opts?: SessionLoadOpts,
): LoadedFusionSession {
  const tickMs =
    opts?.tickMs !== undefined && isFiniteNumber(opts.tickMs) && opts.tickMs > 0
      ? opts.tickMs
      : DEFAULT_TICK_MS;

  // Parse na ordem do arquivo (a "primeira câmera vista" é decidida ANTES de ordenar por ts).
  const parsed: SessionEvent[] = [];
  const cameras: Record<string, number> = {};
  let linesDropped = 0;
  for (const line of lines) {
    const ev = parseLine(line);
    if (!ev) {
      linesDropped++;
      continue;
    }
    parsed.push(ev);
    if (ev.t === "cal" || ev.t === "trk") cameras[ev.cameraId] = (cameras[ev.cameraId] ?? 0) + 1;
  }
  const diag: SessionDiag = { linesTotal: lines.length, linesDropped, cameras };

  // Meta da sessão (linha "meta" — ver header): o ÚLTIMO vence, mesmo padrão do "cal". Opcional —
  // gravações antigas sem essa linha devolvem `meta: null` (não afeta nada mais no scenario).
  let sessionMeta: SessionMeta | null = null;
  for (const ev of parsed) {
    if (ev.t === "meta") sessionMeta = { gitRev: ev.gitRev, fusionConfig: ev.fusionConfig };
  }

  // Câmera do replay: a pedida, ou a primeira vista num "cal"/"trk" do arquivo.
  let cameraId = opts?.cameraId;
  if (cameraId === undefined) {
    for (const ev of parsed) {
      if (ev.t === "cal" || ev.t === "trk") {
        cameraId = ev.cameraId;
        break;
      }
    }
  }

  // Descarte nunca é mudo: sinaliza arquivo multi-câmera e cameraId pedido que não casa nada.
  const cameraIds = Object.keys(cameras);
  if (cameraIds.length > 1)
    console.warn(
      `session-loader: ${cameraIds.length} câmeras no arquivo (${cameraIds.join(", ")}) — replay usa "${cameraId}"`,
    );
  if (opts?.cameraId !== undefined && !(opts.cameraId in cameras))
    console.warn(
      `session-loader: cameraId "${opts.cameraId}" não aparece em nenhum "cal"/"trk" — métricas sairão zeradas`,
    );

  // Só os eventos que a produção desta câmera veria; saneados por ts e ordenados (gravação pode
  // intercalar e relógio pode vir sujo — ver cabeçalho). "meta" fica de fora (já extraída acima,
  // não tem cameraId e não alimenta a grade de ticks).
  let events = parsed.filter((ev) => ev.t !== "meta" && (ev.t === "ble" || ev.cameraId === cameraId));
  if (events.length > 0) {
    const median = medianTs(events);
    const sane = events.filter((ev) => Math.abs(ev.ts - median) <= TS_OUTLIER_MS);
    if (sane.length < events.length)
      console.warn(
        `session-loader: ${events.length - sane.length} evento(s) com ts além de ±24h do mediano descartado(s) (relógio suspeito)`,
      );
    events = sane;
  }
  events.sort((a, b) => a.ts - b.ts);

  // Calibração: o ÚLTIMO "cal" da câmera vence; station null → default do frame.ts (documentado).
  let H: Matrix3 | null = null;
  let stationPx: Vec2 = DEFAULT_STATION_PX;
  for (const ev of events) {
    if (ev.t === "cal") {
      H = ev.H;
      stationPx = ev.station ?? DEFAULT_STATION_PX;
    }
  }

  // Verdade GLOBAL (MAC maiúsculo), construída UMA vez e anexada a todo tick — a métrica só avalia
  // trackIds presentes nos assignments, e o assign() decide até em ticks de rodada vazia.
  const truthTagByTrack: Record<number, string | null> = {};
  for (const [key, mac] of Object.entries(truth)) {
    const id = Number(key);
    if (Number.isFinite(id)) truthTagByTrack[id] = mac === null ? null : mac.toUpperCase();
  }

  const ticks: SimTick[] = [];
  if (events.length > 0) {
    const t0 = events[0].ts;
    const tEnd = events[events.length - 1].ts;
    let i = 0; // ponteiro de consumo dos eventos (cada um é aplicado UMA vez, em ordem)
    let lastTrk: DrawTrack[] | null = null; // null até o 1º "trk" — antes disso a produção nem teria hd
    let lastBle: RawReading[] = []; // último batch INTEIRO (cada evento substitui o snapshot)
    let slots = 0; // posições de grade consumidas (teto duro — nunca OOM)

    for (let tickTs = t0; tickTs <= tEnd; tickTs += tickMs) {
      if (slots >= MAX_TICKS) {
        console.warn(
          `session-loader: grade truncada em ${MAX_TICKS} ticks (ts suspeitos ou tickMs muito pequeno)`,
        );
        break;
      }
      slots++;

      // Aplica todos os eventos até o instante da grade (a produção lê o estado acumulado no tick).
      while (i < events.length && events[i].ts <= tickTs) {
        const ev = events[i];
        if (ev.t === "trk") lastTrk = ev.tracks;
        else if (ev.t === "ble") lastBle = ev.readings;
        i++;
      }

      // Sem nenhum "trk" ainda = produção sem hd → tick não existe (useTagFusion retorna cedo).
      if (lastTrk === null) continue;

      // ts REBASEADO (t0=0) — preserva deltas e mantém o warmupMs das métricas significativo.
      // tracks/readings/verdade são REFERÊNCIAS compartilhadas (snapshots imutáveis no replay).
      ticks.push({ ts: tickTs - t0, tracks: lastTrk, readings: lastBle, truthTagByTrack });
    }
  }

  return { ticks, H, stationPx, diag, meta: sessionMeta };
}

/**
 * Açúcar da Frente B: parse da gravação + replayFusion DE PRODUÇÃO (mesma alimentação do gate
 * sintético — tick sem BLE é pulado, push+assign nos demais) + métricas de identidade.
 * `warmupMs` repassado ao replay (sessões reais curtas podem pedir warmup menor que os 8 s default).
 */
export function replayFusionSession(
  lines: string[],
  truth: SessionTruth,
  cfg?: FusionConfig,
  opts?: SessionLoadOpts & { warmupMs?: number },
): { metrics: IdentityMetrics; scenario: LoadedFusionSession } {
  const scenario = parseFusionSession(lines, truth, opts);
  const { metrics } = replayFusion(scenario, cfg, opts?.warmupMs);
  return { metrics, scenario };
}

/** O funil de vetos de UM tick do replay (ts REBASEADO, t0=0 — igual aos ticks do cenário). */
export type FunnelTick = { ts: number; pairs: PairFunnel[] };

/**
 * FUNIL INSTRUMENTADO SOBRE GRAVAÇÃO DE CAMPO (ADITIVO, 2026-07-11): o MESMO replay fiel do
 * replayFusionSession — parse + resample fiéis à produção, tick sem BLE PULADO, push a cada tick
 * processado — mas em vez de medir identidade contra uma verdade, chama diagnoseFunnel(ts) a cada
 * tick e devolve a série de funis (+ o cenário com diag/meta). NÃO precisa de verdade-terreno: o
 * diagnóstico só responde "qual gate matou cada par (track, tag)", não "quem estava certo".
 * Sessões de campo não têm âncoras exportadas (parseFusionSession não as produz) → o caminho de
 * calibração de path-loss do replayFusion é inerte aqui por construção; a alimentação (stationPx
 * só com H, buildFusionFrame idêntico) espelha o replayFusion de produção.
 */
export function diagnoseFusionSession(
  lines: string[],
  opts?: SessionLoadOpts & { cfg?: FusionConfig },
): { funnels: FunnelTick[]; scenario: LoadedFusionSession } {
  const scenario = parseFusionSession(lines, {}, opts);
  const assoc = new TagTrackAssociator(opts?.cfg);
  const funnels: FunnelTick[] = [];
  // Mesma regra do replayFusion: stationPx calibrado só acompanha H presente (H null → proxy).
  const stationPx = scenario.H ? scenario.stationPx : undefined;
  for (const tick of scenario.ticks) {
    if (tick.readings.length === 0) continue; // produção pula o tick sem BLE (useTagFusion)
    assoc.push(buildFusionFrame(tick.tracks, tick.readings, scenario.H, tick.ts, stationPx));
    funnels.push({ ts: tick.ts, pairs: assoc.diagnoseFunnel(tick.ts) });
  }
  return { funnels, scenario };
}

// ——— Definição conceitual: episódio-candidato a PSEUDO-LABEL (pedido do especialista científico,
// 2026-07-10 — dev.md §6: "smoother como gerador de pseudo-labels"). ———
//
// GAP CONHECIDO (ver session-recorder.js, GAP (a)): a gravação de campo HOJE não inclui a decisão
// do associador por tick — `TagTrackAssociator.assign()` roda no CLIENTE (`useTagFusion.ts`), não
// no hub que grava o JSONL. Nenhuma sessão gravada hoje tem `AssignmentTick[]` para alimentar
// `findPseudoLabelCandidates`. O que segue é a DEFINIÇÃO tipada e uma implementação de referência,
// prontas para o dia em que a gravação de decisões for viabilizada (endpoint novo ou wiring
// client-side — fase futura, fora de escopo aqui).

/** Um tick de decisão do associador — o formato mínimo que `Assignment` (associate.ts) tem HOJE
 *  (trackId/tag/confidence) mais o `ts` do tick. `margin`/`hadConflict` são OPCIONAIS: se/quando
 *  `Assignment` ganhar esses campos (frente paralela), passam a fluir aqui sem quebrar nada — sem
 *  eles, a guarda de margem/conflito do minerador (abaixo) simplesmente não filtra por eles. */
export type AssignmentTick = {
  ts: number;
  trackId: number;
  tag: string | null;
  confidence: number;
  /** Margem top-2 do par escolhido (quando o associador expõe — ver associate.ts). Ausente = não
   *  disponível nesta gravação/versão; o minerador então não pode exigir margem mínima para esse tick. */
  margin?: number;
  /** true = havia concorrente disputando o mesmo track/tag naquele tick (quando exposto). */
  hadConflict?: boolean;
};

/** Episódio-candidato a pseudo-label: um trecho contínuo, para o MESMO trackId, em que a MESMA tag
 *  foi mantida com margem alta e sem conflito por tempo suficiente — "o sistema estava confiante e
 *  por quê" (matéria-prima para treinar um smoother/estimador retroativo sem anotação manual extra).
 *  NÃO é o rótulo em si — é o CANDIDATO; a decisão de promovê-lo a pseudo-label (threshold de
 *  qualidade final, amostragem, deduplicação entre sessões) fica para quem consumir esta lista. */
export type PseudoLabelCandidate = {
  trackId: number;
  tag: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  /** Menor `margin` observado no episódio; `null` se `margin` nunca esteve presente na série
   *  (gravação sem essa informação — ver GAP acima). */
  minMarginInEpisode: number | null;
};

/** Ver docstring de `PseudoLabelCandidate`. Sustentação mínima e piso de margem alta por padrão —
 *  ambos ajustáveis; um episódio termina (e é cortado em dois) no primeiro tick que muda de tag,
 *  cai abaixo da margem exigida, ou reporta conflito — o que É, por construção, o único sinal de
 *  id-switch/ambiguidade observável neste nível de dado (não há acesso ao estado interno do
 *  tracker aqui, só à saída do associador por tick). */
const DEFAULT_PL_MIN_DURATION_MS = 5000; // "N segundos" do pedido — piso conservador de sustentação
const DEFAULT_PL_MIN_MARGIN = 0.15; // acima do minMargin padrão do associador (0.1) — folga extra p/ candidato

export function findPseudoLabelCandidates(
  assignments: readonly AssignmentTick[],
  opts?: { minDurationMs?: number; minMargin?: number },
): PseudoLabelCandidate[] {
  const minDurationMs = opts?.minDurationMs ?? DEFAULT_PL_MIN_DURATION_MS;
  const minMargin = opts?.minMargin ?? DEFAULT_PL_MIN_MARGIN;

  // Agrupa por trackId e ordena por ts — cada grupo é a linha do tempo de UMA pessoa rastreada;
  // um id-switch de verdade (o tracker troca o ID físico da pessoa) automaticamente vira DOIS
  // grupos distintos aqui, então nunca estica um episódio através dele.
  const byTrack = new Map<number, AssignmentTick[]>();
  for (const a of assignments) {
    let arr = byTrack.get(a.trackId);
    if (!arr) {
      arr = [];
      byTrack.set(a.trackId, arr);
    }
    arr.push(a);
  }

  const out: PseudoLabelCandidate[] = [];
  for (const [trackId, ticks] of byTrack) {
    const sorted = [...ticks].sort((x, y) => x.ts - y.ts);

    let runStart = -1;
    let runTag: string | null = null;
    let runHasMargin = false;
    let runMinMargin: number | null = null;

    const flush = (endIdx: number): void => {
      if (runStart < 0 || runTag === null) return;
      const start = sorted[runStart];
      const end = sorted[endIdx];
      const durationMs = end.ts - start.ts;
      if (durationMs >= minDurationMs) {
        out.push({
          trackId,
          tag: runTag,
          startTs: start.ts,
          endTs: end.ts,
          durationMs,
          minMarginInEpisode: runHasMargin ? runMinMargin : null,
        });
      }
    };

    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const marginOk = t.margin === undefined || t.margin >= minMargin;
      const conflictOk = t.hadConflict !== true;
      const qualifies = t.tag !== null && marginOk && conflictOk;
      const sameTagAsRun = runStart >= 0 && t.tag === runTag;

      if (qualifies && sameTagAsRun) {
        if (t.margin !== undefined) {
          runHasMargin = true;
          runMinMargin = runMinMargin === null ? t.margin : Math.min(runMinMargin, t.margin);
        }
        continue;
      }

      // Tick não estica o episódio corrente (mudou de tag, caiu a margem, ou houve conflito):
      // fecha o que estava aberto antes de decidir se este tick abre um novo.
      if (runStart >= 0) flush(i - 1);

      if (qualifies) {
        runStart = i;
        runTag = t.tag;
        runHasMargin = t.margin !== undefined;
        runMinMargin = t.margin ?? null;
      } else {
        runStart = -1;
        runTag = null;
        runHasMargin = false;
        runMinMargin = null;
      }
    }
    if (runStart >= 0) flush(sorted.length - 1);
  }

  out.sort((a, b) => a.trackId - b.trackId || a.startTs - b.startTs);
  return out;
}
