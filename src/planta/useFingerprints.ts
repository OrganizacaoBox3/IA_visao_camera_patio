// useFingerprints — a FIAÇÃO do fingerprinting na Planta BLE: carrega o survey (banco de assinaturas),
// classifica cada tag VIVA para a zona mais parecida (kNN em dB), e CAPTURA um ponto novo (o operador
// encosta tags no lugar e clica "Calibrar" → junta ~10 s de leituras de todas as tags ali → grava a
// assinatura). O núcleo puro (classify/aggregateSamples) vive em fusion/fingerprint.ts; aqui só timing/
// estado/HTTP. Efêmero exceto o survey persistido (LGPD: só metadados de rádio).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getFingerprints,
  getBtReadingsAll,
  saveFingerprint,
  deleteFingerprint,
  type BtReading,
  type Fingerprint,
} from "../api";
import { useBleReadings } from "../camera/useBleReadings";
import {
  aggregateTaggedSamples,
  classify,
  type Classification,
  type LiveEvidence,
  type LiveVec,
  type TaggedRssiSample,
} from "../fusion/fingerprint";
import type { Vec2 } from "../vision/homography";

/** Resultado da auto-validação de uma captura: a antena mais forte e a margem sobre a 2ª (dB). */
export type CaptureCheck = {
  strongest: string;
  strongestRssi: number;
  margin: number;
  nAntenas: number;
  /** Quantidade de medições físicas distintas, nunca de snapshots repetidos. */
  nAmostras: number;
  nTags: number;
  oldestMeasuredAt?: number;
  newestMeasuredAt?: number;
};

export type UseFingerprints = {
  fingerprints: Fingerprint[];
  /** Cada tag viva (mac) → classificação para a zona mais parecida (ou null se banco vazio/esparso). */
  liveByMac: Map<string, Classification>;
  /** Label em captura no momento (para desabilitar botões), ou null. */
  capturing: string | null;
  /** Captura ~`seconds` s de leituras (todas as tags ali) → agrega → salva o fingerprint do ponto. */
  capture: (
    label: string,
    xy?: Vec2 | null,
    seconds?: number,
  ) => Promise<{ ok: boolean; error?: string; fp?: Fingerprint; check?: CaptureCheck }>;
  remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
  reload: () => void;
};

const POLL_WINDOW_MS = 1000; // cadência das amostras durante a captura (~a mesma do BLE vivo, ~1s)
// Janelas do vetor VIVO, calibradas para beacons com refresh de ~1s (pedido do dono 2026-07-15,
// pós-reconfiguração das tags): medição mais velha que ~3 ciclos é obsoleta (fresh) e o skew
// tolerado entre estações é ~1,5 ciclo (sync — o POST das estações é ~500ms). Eram 6s/3s na era
// da tag de ~2,5s; apertar deixa zona/posição reagirem mais rápido a movimento real.
export const LIVE_FRESH_MS = 3_000;
export const LIVE_SYNC_MS = 1_500;

export type FreshLiveVector = { vec: LiveVec; evidence: LiveEvidence };

/** Monta vetores somente com medições recentes e pertencentes à mesma janela temporal. */
export function buildFreshLiveVectors(
  readings: readonly BtReading[],
  now = Date.now(),
  windows: { freshMs?: number; syncMs?: number } = {},
): Map<string, FreshLiveVector> {
  const freshMs = Math.max(0, windows.freshMs ?? LIVE_FRESH_MS);
  const syncMs = Math.max(0, windows.syncMs ?? LIVE_SYNC_MS);
  const byMac = new Map<string, Map<string, { rssi: number; measuredAt: number }>>();
  for (const reading of readings) {
    const mac = String(reading.mac ?? "").trim().toUpperCase();
    const stationId = String(reading.stationId ?? "").trim().toUpperCase();
    const measuredAt = reading.measuredAt ?? reading.ts;
    if (!mac || !stationId || !Number.isFinite(reading.rssi) || !Number.isFinite(measuredAt)) continue;
    const measured = measuredAt as number;
    const ageMs = now - measured;
    if (ageMs < -2_000 || ageMs > freshMs) continue;
    const stations = byMac.get(mac) ?? new Map<string, { rssi: number; measuredAt: number }>();
    const current = stations.get(stationId);
    if (!current || measured >= current.measuredAt) {
      stations.set(stationId, { rssi: reading.rssi, measuredAt: measured });
    }
    byMac.set(mac, stations);
  }

  const out = new Map<string, FreshLiveVector>();
  for (const [mac, stations] of byMac) {
    const newest = Math.max(...[...stations.values()].map((reading) => reading.measuredAt));
    const synchronized = [...stations].filter(([, reading]) => newest - reading.measuredAt <= syncMs);
    if (!synchronized.length) continue;
    const measured = synchronized.map(([, reading]) => reading.measuredAt);
    const oldest = Math.min(...measured);
    const vec = Object.fromEntries(synchronized.map(([stationId, reading]) => [stationId, reading.rssi]));
    out.set(mac, {
      vec,
      evidence: {
        liveStations: synchronized.length,
        oldestMeasuredAt: oldest,
        newestMeasuredAt: newest,
        skewMs: newest - oldest,
      },
    });
  }
  return out;
}

export type CaptureAccumulator = {
  startedAt: number;
  primed: boolean;
  watermarkBySeries: Map<string, number>;
  seen: Set<string>;
  samples: TaggedRssiSample[];
};

export function createCaptureAccumulator(startedAt = Date.now()): CaptureAccumulator {
  return {
    startedAt,
    primed: false,
    watermarkBySeries: new Map<string, number>(),
    seen: new Set<string>(),
    samples: [],
  };
}

/** Marca o snapshot anterior ao início sem comparar o relógio do navegador com o do hub. */
export function primeCaptureAccumulator(
  accumulator: CaptureAccumulator,
  readings: readonly BtReading[],
): void {
  accumulator.primed = true;
  for (const reading of readings) {
    const stationId = String(reading.stationId ?? "").trim().toUpperCase();
    const mac = String(reading.mac ?? "").trim().toUpperCase();
    const measuredAt = reading.measuredAt;
    if (!stationId || !mac || !Number.isFinite(measuredAt)) continue;
    const series = `${stationId}|${mac}`;
    const measured = measuredAt as number;
    const current = accumulator.watermarkBySeries.get(series);
    if (current === undefined || measured > current) accumulator.watermarkBySeries.set(series, measured);
  }
}

/** Acrescenta apenas medições novas e distintas à captura (Regra 8 do guia). */
export function appendCaptureReadings(
  accumulator: CaptureAccumulator,
  readings: readonly BtReading[],
): void {
  for (const reading of readings) {
    const stationId = String(reading.stationId ?? "").trim().toUpperCase();
    const mac = String(reading.mac ?? "").trim().toUpperCase();
    const measuredAt = reading.measuredAt;
    if (!stationId || !mac || !Number.isFinite(reading.rssi) || !Number.isFinite(measuredAt)) continue;
    const measured = measuredAt as number;
    const series = `${stationId}|${mac}`;
    const watermark = accumulator.watermarkBySeries.get(series);
    if (accumulator.primed) {
      if (watermark !== undefined && measured <= watermark) continue;
    } else if (measured < accumulator.startedAt) continue;
    const identity = `${stationId}|${mac}|${measuredAt}`;
    if (accumulator.seen.has(identity)) continue;
    accumulator.seen.add(identity);
    accumulator.watermarkBySeries.set(series, measured);
    accumulator.samples.push({ stationId, mac, rssi: reading.rssi, measuredAt: measured });
  }
}

export function useFingerprints(enabled = true): UseFingerprints {
  const [fingerprints, setFingerprints] = useState<Fingerprint[]>([]);
  const [capturing, setCapturing] = useState<string | null>(null);

  const reload = useCallback(() => {
    getFingerprints()
      .then((fps) => setFingerprints(Array.isArray(fps) ? fps : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload]);

  // Leituras VIVAS por (estação, tag) para classificar ao vivo.
  const readings = useBleReadings(enabled, true);
  const liveByMac = useMemo(() => {
    const out = new Map<string, Classification>();
    for (const [mac, live] of buildFreshLiveVectors(readings)) {
      out.set(mac, classify(live.vec, fingerprints, { evidence: live.evidence }));
    }
    return out;
  }, [readings, fingerprints]);

  const busyRef = useRef(false);
  const capture = useCallback(
    async (label: string, xy?: Vec2 | null, seconds = 10) => {
      const name = (label || "").trim();
      if (!name) return { ok: false, error: "Dê um nome ao ponto." };
      if (busyRef.current) return { ok: false, error: "Já há uma captura em andamento." };
      busyRef.current = true;
      setCapturing(name);
      try {
        const accumulator = createCaptureAccumulator();
        try {
          primeCaptureAccumulator(accumulator, await getBtReadingsAll());
        } catch {
          return {
            ok: false,
            error: "Não foi possível iniciar a captura. Verifique a conexão e tente novamente.",
          };
        }
        const shots = Math.max(2, Math.round((seconds * 1000) / POLL_WINDOW_MS));
        for (let i = 0; i < shots; i++) {
          try {
            const rd = await getBtReadingsAll();
            appendCaptureReadings(accumulator, rd);
          } catch {
            /* uma janela falhou; segue */
          }
          if (i < shots - 1) await new Promise((res) => setTimeout(res, POLL_WINDOW_MS));
        }
        const { vec, evidence } = aggregateTaggedSamples(accumulator.samples);
        const ants = Object.entries(vec);
        if (!ants.length) {
          return {
            ok: false,
            error: "Nenhuma medição nova foi capturada. Mantenha as tags no ponto e tente novamente.",
          };
        }
        if (ants.length < 2) {
          return {
            ok: false,
            error: "Apenas uma antena trouxe medições novas. São necessárias pelo menos duas para classificar esta zona.",
          };
        }
        // Auto-validação: a antena mais forte e a margem sobre a 2ª (a captura "em cima" tem margem alta).
        const ranked = ants.map(([id, c]) => ({ id, mean: c.mean })).sort((a, b) => b.mean - a.mean);
        const check: CaptureCheck = {
          strongest: ranked[0].id,
          strongestRssi: Math.round(ranked[0].mean),
          margin: ranked.length > 1 ? Math.round(ranked[0].mean - ranked[1].mean) : Infinity,
          nAntenas: ranked.length,
          nAmostras: evidence.nDistinct,
          nTags: evidence.nTags,
          ...(evidence.oldestMeasuredAt !== undefined
            ? {
                oldestMeasuredAt: evidence.oldestMeasuredAt,
                newestMeasuredAt: evidence.newestMeasuredAt,
              }
            : {}),
        };
        const saved = await saveFingerprint({
          label: name,
          ...(xy ? { x: xy.x, y: xy.y } : {}),
          vec,
          createdAt: Date.now(),
        });
        setFingerprints((prev) => [...prev, saved]);
        return { ok: true, fp: saved, check };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Falha ao salvar o ponto." };
      } finally {
        busyRef.current = false;
        setCapturing(null);
      }
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    try {
      await deleteFingerprint(id);
      setFingerprints((prev) => prev.filter((f) => f.id !== id));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Falha ao remover o ponto." };
    }
  }, []);

  return { fingerprints, liveByMac, capturing, capture, remove, reload };
}
