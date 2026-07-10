// Gerador SINTÉTICO de cenários (dev.md §3): produz uma gravação (batches de evidência) + o GROUND TRUTH,
// sem hardware. Permite desenvolver e barrar regressão do motor ANTES de dados reais de multi-estação.
// 100% determinístico — LCG com seed injetado, sem Math.random/Date.now (replay-safe, doutrina).
import type { LatLon } from "./entity";
import type { EvidenceBatch } from "./evidence";

/** LCG (Numerical Recipes) — PRNG determinístico e barato. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Normal padrão via Box–Muller, a partir do LCG. */
function randn(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (!u) u = rng();
  while (!v) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Conversão local metros↔graus (aproximação plana, suficiente p/ o cenário sintético).
const M_PER_DEG_LAT = 111_320;
function mPerDegLon(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/** Distância aproximada em metros entre dois lat/lon (plano local). */
export function distM(a: LatLon, b: LatLon): number {
  const dLat = (a.lat - b.lat) * M_PER_DEG_LAT;
  const dLon = (a.lon - b.lon) * mPerDegLon((a.lat + b.lat) / 2);
  return Math.hypot(dLat, dLon);
}

/** Ground truth: a posição REAL de cada tag num instante. */
export type TruthPoint = { ts: number; positions: Record<string, LatLon> };

export type ScenarioOpts = {
  /** Nº de instantes (1 s cada). */
  steps?: number;
  /** Desvio do ruído do GPS do coletor (m). */
  gpsNoiseM?: number;
  /** Alcance BLE: o coletor "vê" a tag se a distância real < rangeM. */
  rangeM?: number;
  /** Origem geográfica do cenário. */
  base?: LatLon;
};

/**
 * Cenário canônico: uma tag PARADA ("AA", na origem) + uma tag que se MOVE ("BB", o carroção, desliza
 * 0→80 m) e um coletor que patrulha em vaivém (0→100 m, cosseno). A cada instante o coletor reporta seu
 * GPS (ruidoso) + as tags dentro do alcance. Devolve as evidências + o ground truth por instante.
 */
export function simulateScenario(
  opts: ScenarioOpts,
  seed: number,
): { batches: EvidenceBatch[]; truth: TruthPoint[] } {
  const steps = opts.steps ?? 60;
  const gpsNoiseM = opts.gpsNoiseM ?? 5;
  const rangeM = opts.rangeM ?? 30;
  const base = opts.base ?? { lat: -3.688, lon: -40.348 };
  const rng = lcg(seed);

  const dLat = 1 / M_PER_DEG_LAT; // 1 m em graus de latitude
  const dLon = 1 / mPerDegLon(base.lat); // 1 m em graus de longitude
  const offset = (mNorth: number, mEast: number): LatLon => ({
    lat: base.lat + mNorth * dLat,
    lon: base.lon + mEast * dLon,
  });

  const tagFixed = offset(0, 0); // "AA" — parada
  const movingAt = (i: number): LatLon => offset(0, (80 * i) / steps); // "BB" — desliza 0..80 m

  const batches: EvidenceBatch[] = [];
  const truth: TruthPoint[] = [];

  for (let i = 0; i < steps; i++) {
    const ts = i * 1000;
    // Coletor: vaivém suave 0..100 m no eixo leste.
    const patrol = 100 * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / steps));
    const collectorTrue = offset(0, patrol);
    const collectorPos: LatLon = {
      lat: collectorTrue.lat + randn(rng) * gpsNoiseM * dLat,
      lon: collectorTrue.lon + randn(rng) * gpsNoiseM * dLon,
    };

    const positions: Record<string, LatLon> = { AA: tagFixed, BB: movingAt(i) };
    const seen: { tagId: string; rssi: number }[] = [];
    for (const id of Object.keys(positions)) {
      const d = distM(collectorTrue, positions[id]);
      if (d < rangeM) seen.push({ tagId: id, rssi: Math.round(-40 - d) }); // RSSI ~ -(40 + d)
    }

    batches.push({ ts, collectorPos, accuracyM: gpsNoiseM, seen });
    truth.push({ ts, positions });
  }

  return { batches, truth };
}
