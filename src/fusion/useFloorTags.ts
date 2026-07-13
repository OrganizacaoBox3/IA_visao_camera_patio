// TAGS NO CHÃO — hook de dados de UMA câmera: junta a calibração (âncoras dos cantos com posição
// exata, ponto da estação, homografia) + as leituras BLE vivas (EMA do RSSI, tau ~4 s, p/ o anel
// não tremer) + as tags JÁ associadas a pessoa (fusão) → a visão pronta p/ o canvas desenhar:
//   anchors = pontos da calibração com MAC (posição EXATA; fresh = ouvida há <15 s)
//   station = marcador do ponto da estação BLE (referência dos anéis)
//   rings   = ANEL de distância p/ cada demais tag visível (RSSI→metros via path-loss calibrado
//             pelas âncoras — floor-plot.ts). HONESTO: 1 estação dá DISTÂNCIA, não posição.
// Âncora e tag associada a pessoa NÃO ganham anel (posição já conhecida / rótulo AR já a mostra).
// Saída via REF lido no rAF de quem desenha (padrão da casa: sem re-render por tick); derivação a
// ~2 Hz sobre estados que JÁ chegam pelo socket — nenhum fetch novo por tick.
import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { BtReading, CalibrationPoint } from "../api";
import { pixelToWorld, type Matrix3, type Vec2 } from "../vision/homography";
import { anchorResidualM, distFromRssi, fitPathLoss, ringPixels, type AnchorObs } from "./floor-plot";

/** Calibração no shape que este hook consome (exposto aditivamente por useCameraTagLabels). */
export type FloorCalibration = {
  H: Matrix3 | null;
  station: Vec2 | null; // ponto de IMAGEM (0..1) do chão onde a estação fica
  points: CalibrationPoint[];
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
export type FloorRing = { mac: string; label: string; radiusM: number; pixels: Vec2[] };
export type FloorTagsView = {
  anchors: FloorAnchor[];
  station: { px: Vec2 } | null;
  rings: FloorRing[];
};

const TICK_MS = 500; // mesma cadência da fusão (useTagFusion) — anel é indicador, não vídeo
const EMA_TAU_MS = 4000; // suavização do RSSI (tau ~4 s): o anel respira em vez de tremer
const FRESH_MS = 15_000; // leitura mais velha que isto = tag sumida (âncora satura p/ atenção)
const PRUNE_MS = 60_000; // esquece tag calada há 1 min (o mapa de sinais não cresce sem fim)
// Espelho do teto DIST_MAX_M do floor-plot (clamp de saída do distFromRssi): raio SATURADO no teto
// não é medição — é "fora de alcance". Anel nesse raio comunicaria uma distância falsa → suprime.
const RING_MAX_M = 100;

/** Estado por tag: EMA do RSSI + instante da última leitura. `mac` preserva a grafia original. */
export type TagSignal = { mac: string; ema: number; t: number; rotulo: string | null };

const macKey = (mac: string): string => mac.toUpperCase();
/** Sufixo curto p/ rótulo: 4 últimos hex do MAC (sem separadores). */
const macSuffix = (mac: string): string =>
  mac
    .replace(/[^0-9a-zA-Z]/g, "")
    .slice(-4)
    .toUpperCase();

/**
 * Ingesta UMA leva de leituras no mapa de sinais (toda mutação do mapa vive AQUI): EMA por MAC
 * com alpha = 1 − e^(−dt/tau) (dt real desde a leitura anterior daquela tag; 1ª leitura = valor
 * cru) + poda das tags caladas há PRUNE_MS. Determinística dado (map, readings, now) — testável.
 * POOL MULTI-FONTE (spec multi-antena F4): o mesmo MAC pode vir de 2+ estações no MESMO array
 * (merge por fonte de useDashboardSocket/source-pool.ts). A 2ª ocorrência no mesmo `now` tem
 * alpha = 0 (dt = 0) e NÃO move o EMA: o anel segue a fonte de 1ª aparição no pool — estável,
 * nunca pisca entre rádios (o anel multi-estação honesto — RSSI×posição POR fonte — é F5).
 */
export function ingestReadings(
  tags: Map<string, TagSignal>,
  readings: readonly BtReading[],
  now: number,
): void {
  for (const r of readings) {
    if (!r || typeof r.mac !== "string" || !r.mac || !Number.isFinite(r.rssi)) continue;
    const k = macKey(r.mac);
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
      tags.set(k, { mac: r.mac, ema: r.rssi, t: now, rotulo: r.rotulo ?? null });
    }
  }
  for (const [k, s] of tags) if (now - s.t > PRUNE_MS) tags.delete(k);
}

/**
 * Deriva a visão desenhável — PURA (exportada p/ teste). Âncoras saem sempre que cadastradas
 * (px exato da calibração; fresh pela última leitura); anéis SÓ com H+station projetáveis (sem
 * eles não há projeção honesta). Âncoras frescas calibram o path-loss em tempo real; com <2 o
 * modelo default DECLARADO do floor-plot assume (o anel vira chute de modelo, nunca NaN).
 */
export function deriveFloorView(args: {
  now: number;
  tags: ReadonlyMap<string, TagSignal>;
  anchorPoints: ReadonlyArray<CalibrationPoint & { mac: string }>;
  H: Matrix3 | null;
  station: Vec2 | null;
  /** Tags já associadas a pessoa (chave rotulo||mac — a MESMA do FusionFrame) → sem anel. */
  assigned: ReadonlySet<string>;
}): FloorTagsView {
  const { now, tags, anchorPoints, H, station, assigned } = args;
  const stationWorld = H && station ? pixelToWorld(H, station) : null;

  const anchors: FloorAnchor[] = [];
  const anchorObs: AnchorObs[] = [];
  const anchorKeys = new Set<string>();
  for (const p of anchorPoints) {
    const k = macKey(p.mac);
    anchorKeys.add(k);
    const s = tags.get(k);
    const fresh = !!s && now - s.t < FRESH_MS;
    anchors.push({ mac: p.mac, px: p.px, fresh, label: macSuffix(p.mac), residualM: null });
    if (fresh && s && stationWorld) anchorObs.push({ mac: p.mac, world: p.world, rssi: s.ema });
  }

  const rings: FloorRing[] = [];
  if (H && stationWorld) {
    const model = fitPathLoss(anchorObs, stationWorld);
    // AUTO-DIAGNÓSTICO (A4): só faz sentido conferir o modelo contra si mesmo quando ele TEM
    // calibração própria (source !== "default" — sem isso não há "resíduo", só o chute do
    // regime default) — reusa o MESMO model deste tick, não reajusta nada. Só as âncoras que
    // entraram no fit (fresh + par válido, ver loop acima) recebem residualM; as demais ficam
    // null (sem leitura viva pra conferir).
    if (model.source !== "default") {
      for (const o of anchorObs) {
        const residual = anchorResidualM(model, o, stationWorld);
        const a = anchors.find((x) => macKey(x.mac) === macKey(o.mac));
        if (a) a.residualM = residual;
      }
    }
    for (const [k, s] of tags) {
      if (now - s.t >= FRESH_MS) continue; // sumida → sem anel (não inventa presença)
      if (anchorKeys.has(k)) continue; // âncora: posição JÁ conhecida (losango, não anel)
      if (assigned.has(s.rotulo || s.mac)) continue; // pessoa já rotulada (AR) — não duplica
      const radiusM = distFromRssi(model, s.ema);
      if (radiusM >= RING_MAX_M) continue; // raio no teto do clamp = fora de alcance, não medição
      const pixels = ringPixels(H, stationWorld, radiusM);
      if (pixels.length < 8) continue; // projeta pouco demais p/ comunicar um anel
      rings.push({ mac: s.mac, label: s.rotulo || macSuffix(s.mac), radiusM, pixels });
    }
  }

  return { anchors, station: station ? { px: station } : null, rings };
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
  const viewRef = useRef<FloorTagsView | null>(null);
  const tagsRef = useRef<Map<string, TagSignal>>(new Map());
  const lastArrRef = useRef<BtReading[] | null>(null);

  // Âncoras = pontos da calibração COM mac (o cadastro grava MAC maiúsculo; filtro defensivo).
  const anchorPoints = useMemo(
    () =>
      calibration.points.filter(
        (p): p is CalibrationPoint & { mac: string } => typeof p.mac === "string" && p.mac.length > 0,
      ),
    [calibration.points],
  );
  // Gate do toggle (fullscreen): há o que mostrar quando existem âncoras OU dá p/ projetar anéis.
  const available = enabled && !!getReadings && (anchorPoints.length > 0 || !!(H && station));

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
        assigned: getAssignedTags?.() ?? EMPTY_SET,
      });
      // View toda VAZIA (ex.: tile com leituras mas sem calibração) publica null — quem desenha
      // (rAF, por frame, em N tiles) faz um null-check barato em vez de rodar drawFloorTags à toa.
      viewRef.current = view.anchors.length || view.rings.length || view.station ? view : null;
    };
    tick(); // primeira derivação sem esperar o intervalo
    const id = window.setInterval(tick, TICK_MS);
    return () => {
      window.clearInterval(id);
      viewRef.current = null;
    };
  }, [enabled, getReadings, getAssignedTags, anchorPoints, H, station]);

  return { viewRef, available };
}
