// Filtro temporal da Planta BLE. Ele recebe posições já estimadas e limita apenas a
// dinâmica publicada; não altera a zona classificada nem encaixa a tag em uma área.
export type MotionState = "parado" | "andando" | "incerto";
export type PositionPoint = { x: number; y: number };
export type PositionConfidence = "alta" | "media" | "baixa" | "nenhuma";

export type PositionObservation = {
  ts: number;
  pos: PositionPoint | null;
  confidence: PositionConfidence;
  uncertaintyM?: number;
};

export type MotionTrack = {
  pos: PositionPoint | null;
  state: MotionState;
  lastTs: number;
  lastReliableTs: number | null;
  stableCount: number;
  uncertaintyM: number;
  /** Última posição CONFIÁVEL publicada — sobrevive à expiração do hold, para a re-entrada pós-gap
   *  curto ser LIMITADA por velocidade em vez de teleporte (estabilidade C4). Null = nunca houve. */
  lastPos: PositionPoint | null;
};

export type MotionFilterConfig = {
  maxSpeedMps: number;
  stationaryRadiusM: number;
  stationaryObservations: number;
  alphaMoving: number;
  alphaStopped: number;
  holdMs: number;
  uncertaintyGrowthMps: number;
  /** Gap máximo (desde a última evidência confiável) em que a volta da posição ainda é ANCORADA na
   *  última posição conhecida (passo limitado por maxSpeedMps·Δt). Acima disso, reset honesto: a
   *  pessoa pode ter ido a qualquer lugar e prender ao passado seria inventar continuidade. */
  recoverMs: number;
};

export const DEFAULT_MOTION_FILTER_CONFIG: MotionFilterConfig = {
  maxSpeedMps: 1.8,
  stationaryRadiusM: 0.45,
  stationaryObservations: 3,
  alphaMoving: 0.55,
  alphaStopped: 0.15,
  holdMs: 10_000,
  uncertaintyGrowthMps: 0.25,
  recoverMs: 30_000,
};

const distance = (a: PositionPoint, b: PositionPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const finitePoint = (p: PositionPoint | null): p is PositionPoint =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

function moveTowards(from: PositionPoint, to: PositionPoint, limitM: number): PositionPoint {
  const d = distance(from, to);
  if (d === 0 || d <= limitM) return to;
  const ratio = limitM / d;
  return { x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio };
}

function blend(from: PositionPoint, to: PositionPoint, alpha: number): PositionPoint {
  return { x: from.x + (to.x - from.x) * alpha, y: from.y + (to.y - from.y) * alpha };
}

const usable = (o: PositionObservation) =>
  finitePoint(o.pos) && o.confidence !== "nenhuma";

export function createMotionTrack(observation: PositionObservation): MotionTrack {
  return usable(observation)
    ? {
        pos: observation.pos,
        state: "andando",
        lastTs: observation.ts,
        lastReliableTs: observation.ts,
        stableCount: 1,
        uncertaintyM: Math.max(0, observation.uncertaintyM ?? 0),
        lastPos: observation.pos,
      }
    : {
        pos: null,
        state: "incerto",
        lastTs: observation.ts,
        lastReliableTs: null,
        stableCount: 0,
        uncertaintyM: Math.max(0, observation.uncertaintyM ?? 0),
        lastPos: null,
      };
}

export function updateMotionTrack(
  current: MotionTrack,
  observation: PositionObservation,
  config: MotionFilterConfig = DEFAULT_MOTION_FILTER_CONFIG,
): MotionTrack {
  if (observation.ts <= current.lastTs) return current;
  const dtSeconds = (observation.ts - current.lastTs) / 1_000;

  if (!usable(observation)) {
    const held =
      current.lastReliableTs !== null && observation.ts - current.lastReliableTs <= config.holdMs;
    return {
      ...current,
      // `lastPos` sobrevive (via ...current) mesmo quando o hold expira e `pos` vira null —
      // é a âncora da re-entrada limitada abaixo.
      pos: held ? current.pos : null,
      state: "incerto",
      lastTs: observation.ts,
      stableCount: held ? current.stableCount : 0,
      uncertaintyM: current.uncertaintyM + config.uncertaintyGrowthMps * dtSeconds,
    };
  }
  if (!current.pos) {
    // Volta da posição após expiração do hold. Gap CURTO (≤ recoverMs desde a última evidência
    // confiável) → re-entrada ANCORADA na última posição conhecida, passo limitado por velocidade
    // (sem teleporte — estabilidade C4). Gap longo → reset honesto (createMotionTrack).
    const gapMs =
      current.lastReliableTs !== null ? observation.ts - current.lastReliableTs : Infinity;
    if (current.lastPos && gapMs <= config.recoverMs) {
      const candidate = observation.pos!;
      const bounded = moveTowards(
        current.lastPos,
        candidate,
        config.maxSpeedMps * (gapMs / 1_000),
      );
      const rejectedM = distance(candidate, bounded);
      return {
        pos: bounded,
        state: "andando",
        lastTs: observation.ts,
        lastReliableTs: observation.ts,
        stableCount: 0,
        uncertaintyM: Math.max(0, observation.uncertaintyM ?? 0, rejectedM),
        lastPos: bounded,
      };
    }
    return createMotionTrack(observation);
  }

  const candidate = observation.pos!;
  const rawStepM = distance(current.pos, candidate);
  const stableCount = rawStepM <= config.stationaryRadiusM ? current.stableCount + 1 : 0;
  const state: MotionState =
    stableCount >= config.stationaryObservations ? "parado" : "andando";
  const bounded = moveTowards(current.pos, candidate, config.maxSpeedMps * dtSeconds);
  const pos = blend(
    current.pos,
    bounded,
    state === "parado" ? config.alphaStopped : config.alphaMoving,
  );
  const rejectedM = Math.max(0, rawStepM - distance(current.pos, pos));

  return {
    pos,
    state,
    lastTs: observation.ts,
    lastReliableTs: observation.ts,
    stableCount,
    uncertaintyM: Math.max(0, observation.uncertaintyM ?? 0, rejectedM),
    lastPos: pos,
  };
}
