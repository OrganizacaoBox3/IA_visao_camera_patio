// Hook de OBSERVABILIDADE das estações de referência (FASE 2 + multi-antena F2). Responsabilidade
// única: o TIMING/estado — a cada ~2s puxa o snapshot BLE COMPLETO (?all=1: todas as fontes vivas) e
// roda o núcleo puro (stationHealth.ts) POR ESTAÇÃO, guardando um baseline EMA por fonte entre ticks.
// Estação que SUMIU do snapshot fica na lista como "down" (CA-5: a ausência do stream É o sinal) —
// a memória de estações vistas vive num useRef e zera quando o hook desliga/troca de âncora.
// Retrocompat (CA-3): com UMA estação a lista tem 1 item — mesma informação do hook antigo.
// Desligado (enabled=false / sem refMac) → devolve o chip "down" único e NÃO faz fetch.
// Erro de fetch = silêncio; hub ANTIGO (sem ?all=1 → 404) → fallback ao GET colapsado de sempre.
import { useEffect, useRef, useState } from "react";
import { apiGet, getBtReadings, type BtReading } from "../api";
import {
  computeStationsHealth,
  rssiAt1m,
  type StationHealth,
  type StationHealthEntry,
} from "./stationHealth";

type Params = { refMac?: string; distMeters?: number; enabled?: boolean };

// O que o hook devolve POR estação: a saúde + a estimativa RSSI@1m (só quando há rssi e distância
// conhecida). NOTA honesta: `distMeters` hoje é o do ÚNICO ponto de estação marcado na calibração —
// vale p/ a estação principal; distância POR estação chega com calibration.stations (F3 da spec).
export type StationHealthView = StationHealth & { stationId: string; rssiAt1m: number | null };

const TICK_MS = 2000; // re-leitura do snapshot (o vivo real é o socket noutras telas; aqui é heartbeat leve)
const DOWN: StationHealthEntry = {
  stationId: "",
  alive: false,
  rssi: null,
  baseline: null,
  driftDb: null,
  status: "down",
};

// Snapshot COMPLETO (todas as fontes). Hub antigo não conhece `?all=1` (404) → cai no GET default
// (colapsado por MAC) — comportamento idêntico ao hook antigo, 1 estação implícita.
const fetchAllReadings = () =>
  apiGet<BtReading[]>("/api/bt/readings?all=1").catch(() => getBtReadings());

export function useStationHealth({ refMac, distMeters, enabled = true }: Params): StationHealthView[] {
  const [healths, setHealths] = useState<StationHealthEntry[]>([]);
  const baselines = useRef<Map<string, number | null>>(new Map()); // EMA por estação, entre ticks
  const known = useRef<Set<string>>(new Set()); // estações já vistas (p/ manter o chip "down" de quem caiu)

  useEffect(() => {
    if (!enabled || !refMac) {
      baselines.current = new Map();
      known.current = new Set();
      setHealths([]);
      return;
    }
    let dead = false;
    const poll = () => {
      fetchAllReadings()
        .then((rows) => {
          if (dead) return;
          const readings = rows ?? [];
          for (const r of readings) known.current.add(r.stationId ?? "");
          const now = performance.now();
          const entries = computeStationsHealth(readings, refMac, baselines.current, known.current, now);
          for (const e of entries) baselines.current.set(e.stationId, e.baseline);
          setHealths(entries);
        })
        .catch(() => {
          /* estação fora / hub antigo — mantém o último estado, segue tentando no próximo tick */
        });
    };
    poll(); // primeira medição imediata (não espera o primeiro tick)
    const id = window.setInterval(poll, TICK_MS);
    return () => {
      dead = true;
      window.clearInterval(id);
    };
  }, [refMac, enabled]);

  // Nada visto ainda (ou desligado) → o chip "down" único de sempre. RSSI@1m derivado no render
  // (reage a distMeters sem re-disparar fetch).
  const list = healths.length > 0 ? healths : [DOWN];
  return list.map((h) => ({
    ...h,
    rssiAt1m: h.rssi != null && distMeters != null ? rssiAt1m(h.rssi, distMeters) : null,
  }));
}
