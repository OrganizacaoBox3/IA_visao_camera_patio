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
  type Fingerprint,
} from "../api";
import { useBleReadings } from "../camera/useBleReadings";
import { aggregateSamples, classify, type Classification } from "../fusion/fingerprint";
import type { Vec2 } from "../vision/homography";

/** Resultado da auto-validação de uma captura: a antena mais forte e a margem sobre a 2ª (dB). */
export type CaptureCheck = { strongest: string; strongestRssi: number; margin: number; nAntenas: number; nAmostras: number };

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

const POLL_WINDOW_MS = 1500; // cadência das amostras durante a captura (~a mesma do BLE vivo)

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
    // Agrupa por MAC → vetor {stationId: rssi} (a leitura mais recente por estação vence).
    const vecByMac = new Map<string, Record<string, number>>();
    for (const r of readings) {
      if (!r.mac || typeof r.rssi !== "number") continue;
      const v = vecByMac.get(r.mac) ?? {};
      v[r.stationId ?? ""] = r.rssi;
      vecByMac.set(r.mac, v);
    }
    const out = new Map<string, Classification>();
    for (const [mac, vec] of vecByMac) out.set(mac, classify(vec, fingerprints));
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
        // Junta N janelas de leitura; POOL por estação de TODAS as tags ali (todas no mesmo ponto).
        const pool: Record<string, number[]> = {};
        const shots = Math.max(2, Math.round((seconds * 1000) / POLL_WINDOW_MS));
        for (let i = 0; i < shots; i++) {
          try {
            const rd = await getBtReadingsAll();
            for (const r of rd) {
              if (!r.stationId || typeof r.rssi !== "number") continue;
              (pool[r.stationId] ??= []).push(r.rssi);
            }
          } catch {
            /* uma janela falhou; segue */
          }
          if (i < shots - 1) await new Promise((res) => setTimeout(res, POLL_WINDOW_MS));
        }
        const vec = aggregateSamples(pool);
        const ants = Object.entries(vec);
        if (!ants.length) return { ok: false, error: "Nenhuma antena ouviu tags aqui — encoste as tags e tente de novo." };
        // Auto-validação: a antena mais forte e a margem sobre a 2ª (a captura "em cima" tem margem alta).
        const ranked = ants.map(([id, c]) => ({ id, mean: c.mean })).sort((a, b) => b.mean - a.mean);
        const check: CaptureCheck = {
          strongest: ranked[0].id,
          strongestRssi: Math.round(ranked[0].mean),
          margin: ranked.length > 1 ? Math.round(ranked[0].mean - ranked[1].mean) : Infinity,
          nAntenas: ranked.length,
          nAmostras: Object.values(pool).reduce((s, a) => s + a.length, 0),
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
