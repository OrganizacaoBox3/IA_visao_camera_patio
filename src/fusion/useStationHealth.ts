// Hook de OBSERVABILIDADE da estação de referência (FASE 2). Responsabilidade única: o TIMING/estado —
// a cada ~2s puxa o snapshot BLE (getBtReadings) e roda o núcleo puro (stationHealth.ts), guardando o
// baseline EMA num useRef entre ticks. A matemática mora em stationHealth.ts (puro/testado).
// Desligado (enabled=false / sem refMac) → devolve "down" e NÃO faz fetch. Erro de fetch = silêncio.
import { useEffect, useRef, useState } from "react";
import { getBtReadings } from "../api";
import { computeStationHealth, rssiAt1m, type StationHealth } from "./stationHealth";

type Params = { refMac?: string; distMeters?: number; enabled?: boolean };

// O que o hook devolve: a saúde + a estimativa RSSI@1m (só quando há rssi e distância conhecida).
export type StationHealthView = StationHealth & { rssiAt1m: number | null };

const TICK_MS = 2000; // re-leitura do snapshot (o vivo real é o socket noutras telas; aqui é heartbeat leve)
const DOWN: StationHealth = {
  alive: false,
  rssi: null,
  baseline: null,
  driftDb: null,
  status: "down",
};

export function useStationHealth({ refMac, distMeters, enabled = true }: Params): StationHealthView {
  const [health, setHealth] = useState<StationHealth>(DOWN);
  const baseline = useRef<number | null>(null); // EMA acumulada entre ticks (fora do render)

  useEffect(() => {
    if (!enabled || !refMac) {
      baseline.current = null;
      setHealth(DOWN);
      return;
    }
    let dead = false;
    const poll = () => {
      getBtReadings()
        .then((rows) => {
          if (dead) return;
          const now = performance.now();
          const h = computeStationHealth(rows ?? [], refMac, baseline.current, now);
          baseline.current = h.baseline;
          setHealth(h);
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

  // RSSI@1m é derivado no render (reage a distMeters sem re-disparar fetch).
  const at1m =
    health.rssi != null && distMeters != null ? rssiAt1m(health.rssi, distMeters) : null;
  return { ...health, rssiAt1m: at1m };
}
