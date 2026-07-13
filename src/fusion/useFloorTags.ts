// TAGS NO CHÃO — hook de dados de UMA câmera: junta a calibração (âncoras dos cantos com posição
// exata, ponto de CADA estação, homografia) + as leituras BLE vivas (EMA do RSSI por FONTE, tau ~4 s,
// p/ o anel não tremer) + as tags JÁ associadas a pessoa (fusão) → a visão pronta p/ o canvas desenhar:
//   anchors  = pontos da calibração com MAC (posição EXATA; fresh = ouvida há <15 s por qualquer fonte)
//   stations = marcador + NOME de CADA antena BLE (referência dos anéis daquela fonte)
//   rings    = ANEL de distância p/ cada tag visível, UM POR FONTE que a ouve (RSSI→metros via
//              path-loss calibrado pelas âncoras daquela fonte — floor-plot.ts). HONESTO: 1 estação
//              dá DISTÂNCIA, não posição; N estações dão N distâncias, NUNCA a interseção (trilateração
//              por RSSI foi REFUTADA — n=29.907, piso 1,20 m vs separação 0,49 m; a interseção herda
//              o erro de duas → posição que não existe, Regra 11). Por isso: marcador+anel por fonte,
//              JAMAIS o ponto triangulado.
// Âncora e tag associada a pessoa NÃO ganham anel (posição já conhecida / rótulo AR já a mostra).
// Saída via REF lido no rAF de quem desenha (padrão da casa: sem re-render por tick); derivação a
// ~2 Hz sobre estados que JÁ chegam pelo socket — nenhum fetch novo por tick.
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { BtReading, CalibrationPoint } from "../api";
import { pixelToWorld, type Matrix3, type Vec2 } from "../vision/homography";
import {
  anchorResidualM,
  distFromRssi,
  fitPathLoss,
  ringPixels,
  type AnchorObs,
} from "./floor-plot";
import type { StationPoints } from "./frame";
import { useStationNames } from "./useStationNames";

/** Calibração no shape que este hook consome (exposto aditivamente por useCameraTagLabels). */
export type FloorCalibration = {
  H: Matrix3 | null;
  station: Vec2 | null; // ponto de IMAGEM (0..1) do chão onde a estação PRINCIPAL fica
  points: CalibrationPoint[];
  /** Pontos de TODAS as estações (`calibration.stations` — multi-antena F3/F5). Quando presente, o
   *  desenho ganha um MARCADOR por antena e um ANEL POR FONTE (o RSSI daquela estação); ausente/vazio
   *  = mundo de 1 antena (a estação PRINCIPAL legada). NUNCA se intersecta anéis (ver doc acima). */
  stations?: StationPoints;
};

/**
 * `label` = sufixo do MAC PRÉ-computado aqui (2 Hz) — o desenho roda por frame e não deve refazer
 * regex. `residualM` = auto-diagnóstico (backlog científico A4): |distância REAL da âncora à
 * estação − distância que o modelo de path-loss PREVÊ pro RSSI dela| — a âncora conferindo o
 * próprio modelo que ajuda a calibrar. `null` quando não há base honesta pra calcular: âncora não
 * fresca (sem leitura viva) OU modelo ainda "default" (sem calibração própria — comparar contra um
 * chute não diagnostica nada). Limiar de anomalia vive em camera/draw.ts (RESIDUAL_ANOMALY_M).
 */
export type FloorAnchor = {
  mac: string;
  px: Vec2;
  fresh: boolean;
  label: string;
  residualM: number | null;
};
/** Marcador de uma antena BLE no chão: ponto de imagem + NOME amigável (id → nome, useStationNames). */
export type FloorStation = { id: string | null; px: Vec2; label: string };
export type FloorRing = { mac: string; label: string; radiusM: number; pixels: Vec2[] };
export type FloorTagsView = {
  anchors: FloorAnchor[];
  stations: FloorStation[];
  rings: FloorRing[];
};

const TICK_MS = 500; // mesma cadência da fusão (useTagFusion) — anel é indicador, não vídeo
const EMA_TAU_MS = 4000; // suavização do RSSI (tau ~4 s): o anel respira em vez de tremer
const FRESH_MS = 15_000; // leitura mais velha que isto = tag sumida (âncora satura p/ atenção)
const PRUNE_MS = 60_000; // esquece tag calada há 1 min (o mapa de sinais não cresce sem fim)
// Espelho do teto DIST_MAX_M do floor-plot (clamp de saída do distFromRssi): raio SATURADO no teto
// não é medição — é "fora de alcance". Anel nesse raio comunicaria uma distância falsa → suprime.
const RING_MAX_M = 100;

/** Estado por (tag, FONTE): EMA do RSSI + instante da última leitura. `mac`/`source` preservam a
 *  grafia da chave; `source` = a estação que mediu (stationId em MAIÚSCULAS, "" = fonte única). */
export type TagSignal = { mac: string; source: string; ema: number; t: number; rotulo: string | null };

const macKey = (mac: string): string => mac.toUpperCase();
const KEY_SEP = "|"; // separador da chave (impossível num MAC/stationId) — key = MAC|FONTE
/** Chave do mapa de sinais: uma leitura é única por (tag, FONTE) — F5, anel honesto por antena. */
export const tagKey = (mac: string, source = ""): string => macKey(mac) + KEY_SEP + source;
const srcOf = (r: { stationId?: string }): string =>
  typeof r.stationId === "string" ? r.stationId.toUpperCase() : "";
/** Sufixo curto p/ rótulo: 4 últimos hex do MAC (sem separadores). */
const macSuffix = (mac: string): string =>
  mac
    .replace(/[^0-9a-zA-Z]/g, "")
    .slice(-4)
    .toUpperCase();

/**
 * Ingesta UMA leva de leituras no mapa de sinais (toda mutação do mapa vive AQUI): EMA por
 * (MAC, FONTE) com alpha = 1 − e^(−dt/tau) (dt real desde a leitura anterior daquela tag/fonte;
 * 1ª leitura = valor cru) + poda das tags caladas há PRUNE_MS. Determinística dado (map, readings,
 * now) — testável.
 * POOL MULTI-FONTE (spec multi-antena F5): o mesmo MAC vindo de 2+ estações no MESMO array (merge por
 * fonte de useDashboardSocket/source-pool.ts) vira 2+ SINAIS DISTINTOS — um por estação — porque cada
 * antena mede a SUA distância (o anel honesto por fonte, o que a Fase F4 ainda colapsava). Duas
 * leituras da MESMA fonte no mesmo `now`: a 2ª tem alpha=0 (dt=0) e não move o EMA (dedup de pool).
 */
export function ingestReadings(
  tags: Map<string, TagSignal>,
  readings: readonly BtReading[],
  now: number,
): void {
  for (const r of readings) {
    if (!r || typeof r.mac !== "string" || !r.mac || !Number.isFinite(r.rssi)) continue;
    const source = srcOf(r);
    const k = tagKey(r.mac, source);
    const prev = tags.get(k);
    if (prev) {
      const alpha = 1 - Math.exp(-(now - prev.t) / EMA_TAU_MS);
      prev.ema += alpha * (r.rssi - prev.ema);
      prev.t = now;
      // Segue a leitura CORRENTE nos dois sentidos (cadastro E descadastro): a chave de supressão
      // do anel é `rotulo||mac` — a MESMA da fusão (frame.ts), que usa a leitura corrente. Um rotulo
      // stale aqui divergiria da fusão e duplicaria o anel de tag já associada a pessoa.
      prev.rotulo = r.rotulo ?? null;
    } else {
      tags.set(k, { mac: r.mac, source, ema: r.rssi, t: now, rotulo: r.rotulo ?? null });
    }
  }
  for (const [k, s] of tags) if (now - s.t > PRUNE_MS) tags.delete(k);
}

/** Sinal mais RECENTE de um MAC entre todas as fontes que o ouviram (p/ o losango da âncora). */
function latestForMac(tags: ReadonlyMap<string, TagSignal>, mk: string): TagSignal | undefined {
  let best: TagSignal | undefined;
  for (const s of tags.values())
    if (macKey(s.mac) === mk && (!best || s.t > best.t)) best = s;
  return best;
}

/**
 * Deriva a visão desenhável — PURA (exportada p/ teste). Âncoras saem sempre que cadastradas
 * (px exato da calibração; fresh pela última leitura de QUALQUER fonte); estações saem todas as
 * calibradas (marcador + nome); anéis SÓ com H projetável — UM por (tag livre, FONTE que a ouve),
 * cada anel usando o RSSI DAQUELA fonte e o modelo de path-loss calibrado pelas âncoras que ELA
 * ouve. Âncoras frescas calibram o path-loss em tempo real; com <2 o modelo default DECLARADO do
 * floor-plot assume (o anel vira chute de modelo, nunca NaN). JAMAIS a interseção (posição que não
 * existe — Regra 11).
 */
export function deriveFloorView(args: {
  now: number;
  tags: ReadonlyMap<string, TagSignal>;
  anchorPoints: ReadonlyArray<CalibrationPoint & { mac: string }>;
  H: Matrix3 | null;
  station: Vec2 | null;
  /** Pontos de CADA estação (`calibration.stations`); ausente/vazio = mundo de 1 antena (station). */
  stations?: StationPoints;
  /** Tags já associadas a pessoa (chave rotulo||mac — a MESMA do FusionFrame) → sem anel. */
  assigned: ReadonlySet<string>;
  /** id → NOME amigável da estação (useStationNames); ausente → o próprio id vira rótulo. */
  stationName?: (id: string) => string;
  /** ids das estações que EXISTEM no cadastro (GET /api/bt-stations). Um ponto de `stations` cujo id
   *  não está aqui é ÓRFÃO (marcado na calibração, mas sem estação real por trás — ex.: um clique de
   *  experimento antigo) e NÃO vira marcador: uma antena que não existe não se desenha. Ausente
   *  (registro ainda carregando / hub antigo) → não filtra (retrocompat: desenha todas). */
  knownStationIds?: ReadonlySet<string>;
}): FloorTagsView {
  const { now, tags, anchorPoints, H, station, stations, assigned, stationName, knownStationIds } =
    args;

  // ── Âncoras (losangos): 1 por ponto cadastrado; fresh = ouvida por QUALQUER fonte há <15 s ──
  const anchors: FloorAnchor[] = [];
  const anchorMacs = new Set<string>();
  for (const p of anchorPoints) {
    const mk = macKey(p.mac);
    anchorMacs.add(mk);
    const best = latestForMac(tags, mk);
    const fresh = !!best && now - best.t < FRESH_MS;
    anchors.push({ mac: p.mac, px: p.px, fresh, label: macSuffix(p.mac), residualM: null });
  }

  // ── Estações a desenhar: multi-antena (`stations`) quando há; senão a PRINCIPAL legada ──
  // `source` casa com o `srcOf` das leituras (stationId em maiúsculas); a legada tem source "".
  // Só as estações que existem no cadastro viram marcador (filtra órfãos da calibração). O filtro só
  // atua com o registro carregado — vazio/ausente NÃO derruba tudo (senão a antena sumiria enquanto o
  // GET /api/bt-stations não respondeu).
  const ids = (stations ? Object.keys(stations).sort() : []).filter(
    (id) => !knownStationIds || knownStationIds.size === 0 || knownStationIds.has(id),
  );
  const stationList: Array<{ id: string | null; source: string; px: Vec2; label: string }> = ids.length
    ? ids.map((id) => ({
        id,
        source: id.toUpperCase(),
        px: stations![id],
        label: stationName?.(id) || id,
      }))
    : station
      ? [{ id: null, source: "", px: station, label: "" }]
      : [];
  const stationMarks: FloorStation[] = stationList.map((s) => ({ id: s.id, px: s.px, label: s.label }));

  const rings: FloorRing[] = [];
  if (!H || stationList.length === 0) return { anchors, stations: stationMarks, rings };

  // A PRINCIPAL (para o auto-diagnóstico A4): a de px === `station`, ou a primeira. Só ela grava
  // residualM nas âncoras — o diagnóstico é do modelo dela (as demais só desenham anéis).
  const principalIdx = Math.max(
    0,
    station ? stationList.findIndex((s) => s.px === station) : 0,
  );

  stationList.forEach((st, idx) => {
    const world = pixelToWorld(H, st.px);
    if (!world) return; // estação além do horizonte projetivo — sem origem radial honesta
    // Âncoras que ESTA fonte ouve (fresh) calibram o path-loss DELA — distância da âncora a ESTA
    // estação × RSSI medido por ELA. Sem 2 pares o floor-plot cai no default DECLARADO.
    const obs: AnchorObs[] = [];
    for (const p of anchorPoints) {
      const s = tags.get(tagKey(p.mac, st.source));
      if (s && now - s.t < FRESH_MS) obs.push({ mac: p.mac, world: p.world, rssi: s.ema });
    }
    const model = fitPathLoss(obs, world);
    // AUTO-DIAGNÓSTICO (A4) só na PRINCIPAL e só com calibração própria (source !== "default").
    if (idx === principalIdx && model.source !== "default") {
      for (const o of obs) {
        const residual = anchorResidualM(model, o, world);
        const a = anchors.find((x) => macKey(x.mac) === macKey(o.mac));
        if (a) a.residualM = residual;
      }
    }
    // Anel por tag LIVRE que ESTA fonte ouve — o RSSI é o DELA (F5, anel honesto por antena).
    for (const s of tags.values()) {
      if (s.source !== st.source) continue; // só os sinais medidos por ESTA estação
      if (now - s.t >= FRESH_MS) continue; // sumida → sem anel (não inventa presença)
      if (anchorMacs.has(macKey(s.mac))) continue; // âncora: posição JÁ conhecida (losango, não anel)
      if (assigned.has(s.rotulo || s.mac)) continue; // pessoa já rotulada (AR) — não duplica
      const radiusM = distFromRssi(model, s.ema);
      if (radiusM >= RING_MAX_M) continue; // raio no teto do clamp = fora de alcance, não medição
      const pixels = ringPixels(H, world, radiusM);
      if (pixels.length < 8) continue; // projeta pouco demais p/ comunicar um anel
      rings.push({ mac: s.mac, label: s.rotulo || macSuffix(s.mac), radiusM, pixels });
    }
  });

  return { anchors, stations: stationMarks, rings };
}

const EMPTY_SET: ReadonlySet<string> = new Set();

export function useFloorTags(params: {
  calibration: FloorCalibration;
  /** Leituras BLE vivas (bt-readings via socket) — getter estável; ausente → hook inerte. */
  getReadings?: () => BtReading[];
  /** Tags já associadas a pessoa (useTagFusion.assignedTags) — suprime o anel duplicado. */
  getAssignedTags?: () => ReadonlySet<string>;
  enabled: boolean;
}): { viewRef: RefObject<FloorTagsView | null>; available: boolean } {
  const { calibration, getReadings, getAssignedTags, enabled } = params;
  const { H, station } = calibration;
  const stations = calibration.stations;
  const viewRef = useRef<FloorTagsView | null>(null);
  const tagsRef = useRef<Map<string, TagSignal>>(new Map());
  const lastArrRef = useRef<BtReading[] | null>(null);

  // Nomes das estações (id técnico → "Doca 3") p/ rotular cada marcador — a mesma fonte única do
  // cadastro (useStationNames). Lido por REF no tick (não re-arma o laço quando o registro carrega).
  const { stations: registered, nameOf } = useStationNames(enabled);
  const nameOfRef = useRef(nameOf);
  nameOfRef.current = nameOf;
  // Ids REALMENTE cadastrados — para o marcador de antena não desenhar ponto órfão da calibração
  // (id sem estação por trás). Ref lido no tick, como o nameOf.
  const knownIdsRef = useRef<ReadonlySet<string>>(EMPTY_SET);
  knownIdsRef.current = useMemo(() => new Set(registered.map((s) => s.id)), [registered]);

  // Âncoras = pontos da calibração COM mac (o cadastro grava MAC maiúsculo; filtro defensivo).
  const anchorPoints = useMemo(
    () =>
      calibration.points.filter(
        (p): p is CalibrationPoint & { mac: string } =>
          typeof p.mac === "string" && p.mac.length > 0,
      ),
    [calibration.points],
  );
  // Gate do toggle (fullscreen): há o que mostrar quando existem âncoras OU dá p/ projetar anéis
  // (H + ao menos uma estação — principal legada OU multi-antena).
  const hasStation = !!station || !!(stations && Object.keys(stations).length > 0);
  const available = enabled && !!getReadings && (anchorPoints.length > 0 || !!(H && hasStation));

  useEffect(() => {
    if (!enabled || !getReadings) {
      viewRef.current = null;
      return;
    }
    const tick = () => {
      const now = performance.now();
      // Ingesta SÓ quando o socket entregou um array NOVO (cada evento = varredura nova; reler o
      // MESMO array não é informação — e não deve rejuvenescer o `t` de tag que já sumiu).
      const arr = getReadings();
      if (arr && arr !== lastArrRef.current) {
        lastArrRef.current = arr;
        ingestReadings(tagsRef.current, arr, now);
      }
      const view = deriveFloorView({
        now,
        tags: tagsRef.current,
        anchorPoints,
        H,
        station,
        stations,
        assigned: getAssignedTags?.() ?? EMPTY_SET,
        stationName: nameOfRef.current,
        knownStationIds: knownIdsRef.current,
      });
      // View toda VAZIA (ex.: tile com leituras mas sem calibração) publica null — quem desenha
      // (rAF, por frame, em N tiles) faz um null-check barato em vez de rodar drawFloorTags à toa.
      viewRef.current =
        view.anchors.length || view.rings.length || view.stations.length ? view : null;
    };
    tick(); // primeira derivação sem esperar o intervalo
    const id = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearInterval(id);
      viewRef.current = null;
    };
  }, [enabled, getReadings, getAssignedTags, anchorPoints, H, station, stations]);

  return { viewRef, available };
}
