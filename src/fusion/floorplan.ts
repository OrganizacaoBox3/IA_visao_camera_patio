// Planta BLE — núcleo puro da estimativa geométrica RSSI → distância → X,Y.
//
// RSSI não mede posição e o modelo log-distância pode errar por dezenas de metros em ambiente
// interno. Este módulo só publica uma coordenada quando a geometria resolve um ponto dentro da
// planta e os raios concordam dentro de um limite declarado. Solução externa ou residual alto
// permanece diagnóstico (`residualM`), mas NÃO é clampada para um canto.

import type { Vec2 } from "../vision/homography";
import { distFromRssi, type PathLossModel } from "./floor-plot";
import { bboxOf, type TopdownBbox } from "./topdown";

/** Antena BLE posicionada no chão. `model` permite calibração própria da estação. */
export type FloorplanStation = {
  id: string;
  label: string;
  pos: Vec2;
  live: boolean;
  model?: PathLossModel;
};

export type FloorplanReading = {
  stationId: string;
  mac: string;
  rssi: number;
  rotulo?: string | null;
};

/** `ok` exige geometria válida E modelos calibrados; `weak` continua sendo estimativa. */
export type FloorplanFix = "ok" | "weak" | "none";
export type FloorplanQuality = "good" | "estimated" | "invalid" | "unavailable";
export type FloorplanPositionSource = "multilateration" | "two-circle" | "none";
export type FloorplanModelSource = PathLossModel["source"] | "mixed";

export type FloorplanTag = {
  mac: string;
  label: string;
  pos: Vec2 | null;
  /** Solução geométrica antes dos gates, apenas para diagnóstico; nunca é desenhada diretamente. */
  rawPos?: Vec2 | null;
  fix: FloorplanFix;
  nStations: number;
  nearest: { stationId: string; distM: number; modelSource?: PathLossModel["source"] } | null;
  /** Campos opcionais no tipo apenas para compatibilidade com fixtures antigas; a deriva sempre os preenche. */
  residualM?: number | null;
  residualLimitM?: number | null;
  quality?: FloorplanQuality;
  source?: FloorplanPositionSource;
  modelSource?: FloorplanModelSource;
};

export type FloorplanView = {
  widthM: number;
  heightM: number;
  stations: FloorplanStation[];
  tags: FloorplanTag[];
};

const DEFAULT_MODEL: PathLossModel = { rssi0: -45, n: 2.2, source: "default", samples: 0 };
const DET_EPS = 1e-9;
const BOUNDS_EPS_M = 1e-6;
// O limite escala com a diagonal, mas mantém um piso para plantas pequenas. É gate de sanidade,
// não alegação de acurácia: a validação com ground truth continua necessária para decidir qualidade.
const MIN_RESIDUAL_LIMIT_M = 0.75;
const RESIDUAL_DIAGONAL_FRACTION = 0.25;

const isFiniteNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isVec = (value: unknown): value is Vec2 =>
  !!value &&
  typeof value === "object" &&
  isFiniteNum((value as Vec2).x) &&
  isFiniteNum((value as Vec2).y);
const clamp = (value: number, lower: number, upper: number): number =>
  Math.min(upper, Math.max(lower, value));
const srcKey = (id: string | undefined | null): string =>
  typeof id === "string" ? id.toUpperCase() : "";
const macKey = (mac: string): string => mac.toUpperCase();
const macSuffix = (mac: string): string =>
  mac.replace(/[^0-9a-zA-Z]/g, "").slice(-4).toUpperCase();

const isModelSource = (source: unknown): source is PathLossModel["source"] =>
  source === "anchors" || source === "anchors-offset" || source === "default";

const isPathLossModel = (value: unknown): value is PathLossModel => {
  if (!value || typeof value !== "object") return false;
  const model = value as PathLossModel;
  return (
    isFiniteNum(model.rssi0) &&
    isFiniteNum(model.n) &&
    model.n > 0 &&
    isFiniteNum(model.samples) &&
    isModelSource(model.source)
  );
};

const insideFloor = (pos: Vec2, widthM: number, heightM: number): boolean =>
  widthM > 0 &&
  heightM > 0 &&
  pos.x >= -BOUNDS_EPS_M &&
  pos.x <= widthM + BOUNDS_EPS_M &&
  pos.y >= -BOUNDS_EPS_M &&
  pos.y <= heightM + BOUNDS_EPS_M;

const residualLimitFor = (widthM: number, heightM: number): number =>
  Math.max(MIN_RESIDUAL_LIMIT_M, Math.hypot(widthM, heightM) * RESIDUAL_DIAGONAL_FRACTION);

const rmsResidual = (pos: Vec2, observations: { pos: Vec2; distM: number }[]): number => {
  let squared = 0;
  for (const observation of observations) {
    const error = Math.hypot(pos.x - observation.pos.x, pos.y - observation.pos.y) - observation.distM;
    squared += error * error;
  }
  return Math.sqrt(squared / observations.length);
};

/**
 * Multilateração por mínimos quadrados linearizados.
 * Retorna a coordenada CRUA e o RMS dos resíduos; não aplica limites da planta.
 */
export function multilaterate(
  observations: { pos: Vec2; distM: number }[],
): { pos: Vec2; residualM: number } | null {
  if (!Array.isArray(observations)) return null;
  const points = observations.filter(
    (observation) =>
      observation && isVec(observation.pos) && isFiniteNum(observation.distM) && observation.distM >= 0,
  );
  if (points.length < 2) return null;

  const reference = points[0];
  const referenceSquared = reference.pos.x ** 2 + reference.pos.y ** 2;
  let s00 = 0;
  let s01 = 0;
  let s11 = 0;
  let t0 = 0;
  let t1 = 0;

  for (let index = 1; index < points.length; index++) {
    const current = points[index];
    const ax = 2 * (current.pos.x - reference.pos.x);
    const ay = 2 * (current.pos.y - reference.pos.y);
    const b =
      current.pos.x ** 2 +
      current.pos.y ** 2 -
      referenceSquared -
      (current.distM ** 2 - reference.distM ** 2);
    s00 += ax * ax;
    s01 += ax * ay;
    s11 += ay * ay;
    t0 += ax * b;
    t1 += ay * b;
  }

  const determinant = s00 * s11 - s01 * s01;
  if (Math.abs(determinant) < DET_EPS) return null;
  const pos = {
    x: (s11 * t0 - s01 * t1) / determinant,
    y: (-s01 * t0 + s00 * t1) / determinant,
  };
  if (!isVec(pos)) return null;
  return { pos, residualM: rmsResidual(pos, points) };
}

/**
 * Resolve duas circunferências somente quando os dados têm interseção real e exatamente uma raiz
 * cabe na planta. Duas raízes internas são ambíguas; círculos sem interseção são incompatíveis.
 */
function resolveTwoCircles(
  first: { pos: Vec2; distM: number },
  second: { pos: Vec2; distM: number },
  widthM: number,
  heightM: number,
): { pos: Vec2; residualM: number } | null {
  const dx = second.pos.x - first.pos.x;
  const dy = second.pos.y - first.pos.y;
  const centerDistance = Math.hypot(dx, dy);
  if (centerDistance < DET_EPS) return null;

  const projection =
    (first.distM ** 2 - second.distM ** 2 + centerDistance ** 2) / (2 * centerDistance);
  const perpendicularSquared = first.distM ** 2 - projection ** 2;
  if (perpendicularSquared < -BOUNDS_EPS_M) return null;

  const ux = dx / centerDistance;
  const uy = dy / centerDistance;
  const base = {
    x: first.pos.x + projection * ux,
    y: first.pos.y + projection * uy,
  };
  const offset = Math.sqrt(Math.max(0, perpendicularSquared));
  const roots = [
    { x: base.x - offset * uy, y: base.y + offset * ux },
    { x: base.x + offset * uy, y: base.y - offset * ux },
  ];
  const uniqueRoots =
    Math.hypot(roots[0].x - roots[1].x, roots[0].y - roots[1].y) <= BOUNDS_EPS_M
      ? [roots[0]]
      : roots;
  const inside = uniqueRoots.filter((root) => insideFloor(root, widthM, heightM));
  if (inside.length !== 1) return null;

  const pos = {
    x: clamp(inside[0].x, 0, widthM),
    y: clamp(inside[0].y, 0, heightM),
  };
  return { pos, residualM: rmsResidual(pos, [first, second]) };
}

const summarizeModelSources = (
  sources: PathLossModel["source"][],
): FloorplanModelSource => {
  const distinct = new Set(sources);
  return distinct.size === 1 ? sources[0] : "mixed";
};

/**
 * Deriva uma vista de um único quadro.
 *
 * Precedência do modelo por estação: `stationModels[id]` (case-insensitive) → `station.model` →
 * `model` global legado → default declarado. O argumento global permanece para compatibilidade.
 */
export function deriveFloorplanView(args: {
  widthM: number;
  heightM: number;
  stations: FloorplanStation[];
  readings: FloorplanReading[];
  model?: PathLossModel;
  stationModels?: Record<string, PathLossModel>;
}): FloorplanView {
  const widthM = isFiniteNum(args?.widthM) && args.widthM > 0 ? args.widthM : 0;
  const heightM = isFiniteNum(args?.heightM) && args.heightM > 0 ? args.heightM : 0;
  const stationsIn = Array.isArray(args?.stations) ? args.stations : [];
  const readingsIn = Array.isArray(args?.readings) ? args.readings : [];
  const fallbackModel = isPathLossModel(args?.model) ? args.model : DEFAULT_MODEL;
  const explicitModels = new Map<string, PathLossModel>();
  if (args?.stationModels && typeof args.stationModels === "object") {
    for (const [id, model] of Object.entries(args.stationModels)) {
      if (isPathLossModel(model)) explicitModels.set(srcKey(id), model);
    }
  }

  const stations: FloorplanStation[] = [];
  const liveByKey = new Map<
    string,
    { id: string; label: string; pos: Vec2; model: PathLossModel }
  >();
  for (const station of stationsIn) {
    if (!station || !isVec(station.pos)) continue;
    const label = (station.label ?? "").trim() || station.id || "Estação";
    const inlineModel = isPathLossModel(station.model) ? station.model : fallbackModel;
    const model = explicitModels.get(srcKey(station.id)) ?? inlineModel;
    stations.push({
      id: station.id,
      label,
      pos: station.pos,
      live: !!station.live,
      ...(station.model ? { model: station.model } : {}),
    });
    if (station.live) {
      liveByKey.set(srcKey(station.id), { id: station.id, label, pos: station.pos, model });
    }
  }

  const byMac = new Map<
    string,
    { mac: string; rotulo: string | null; heard: Map<string, number> }
  >();
  for (const reading of readingsIn) {
    if (
      !reading ||
      typeof reading.mac !== "string" ||
      !reading.mac ||
      !isFiniteNum(reading.rssi)
    ) {
      continue;
    }
    const stationKey = srcKey(reading.stationId);
    if (!liveByKey.has(stationKey)) continue;
    const tagKey = macKey(reading.mac);
    let entry = byMac.get(tagKey);
    if (!entry) {
      entry = { mac: reading.mac, rotulo: reading.rotulo ?? null, heard: new Map() };
      byMac.set(tagKey, entry);
    }
    const previous = entry.heard.get(stationKey);
    if (previous === undefined || reading.rssi > previous) {
      entry.heard.set(stationKey, reading.rssi);
    }
    if (reading.rotulo) entry.rotulo = reading.rotulo;
  }

  const tags: FloorplanTag[] = [];
  for (const entry of byMac.values()) {
    const heard = [...entry.heard.entries()]
      .map(([stationKey, rssi]) => {
        const station = liveByKey.get(stationKey)!;
        return {
          id: station.id,
          pos: station.pos,
          rssi,
          model: station.model,
          distM: distFromRssi(station.model, rssi),
        };
      })
      .sort((left, right) => right.rssi - left.rssi || left.id.localeCompare(right.id));
    if (heard.length === 0) continue;

    const nStations = heard.length;
    const modelSource = summarizeModelSources(heard.map((observation) => observation.model.source));
    const nearest = {
      stationId: heard[0].id,
      distM: heard[0].distM,
      modelSource: heard[0].model.source,
    };
    const residualLimitM = residualLimitFor(widthM, heightM);
    let pos: Vec2 | null = null;
    let rawPos: Vec2 | null = null;
    let fix: FloorplanFix = "none";
    let quality: FloorplanQuality = "unavailable";
    let source: FloorplanPositionSource = "none";
    let residualM: number | null = null;

    if (nStations >= 3) {
      source = "multilateration";
      const result = multilaterate(heard.map(({ pos: stationPos, distM }) => ({ pos: stationPos, distM })));
      rawPos = result?.pos ?? null;
      residualM = result?.residualM ?? null;
      const valid =
        !!result &&
        insideFloor(result.pos, widthM, heightM) &&
        result.residualM <= residualLimitM;
      if (valid && result) {
        pos = {
          x: clamp(result.pos.x, 0, widthM),
          y: clamp(result.pos.y, 0, heightM),
        };
        const fullyCalibrated = heard.every((observation) => observation.model.source === "anchors");
        fix = fullyCalibrated ? "ok" : "weak";
        quality = fullyCalibrated ? "good" : "estimated";
      } else {
        quality = "invalid";
      }
    } else if (nStations === 2) {
      source = "two-circle";
      const result = resolveTwoCircles(heard[0], heard[1], widthM, heightM);
      rawPos = result?.pos ?? null;
      residualM = result?.residualM ?? null;
      if (result && result.residualM <= residualLimitM) {
        pos = result.pos;
        fix = "weak";
        quality = "estimated";
      } else {
        quality = "invalid";
      }
    }

    tags.push({
      mac: entry.mac,
      label: entry.rotulo || macSuffix(entry.mac),
      pos,
      rawPos,
      fix,
      nStations,
      nearest,
      residualM,
      residualLimitM: source === "none" ? null : residualLimitM,
      quality,
      source,
      modelSource,
    });
  }
  tags.sort((left, right) => macKey(left.mac).localeCompare(macKey(right.mac)));

  return { widthM, heightM, stations, tags };
}

export { bboxOf };
export type { TopdownBbox };
