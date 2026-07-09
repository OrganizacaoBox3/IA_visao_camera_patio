// FASE 2 — TAG FIXA DE REFERÊNCIA: uma tag num ponto conhecido vira ÂNCORA da estação BLE.
// Núcleo PURO (sem estado, sem React) que responde três perguntas de OBSERVABILIDADE da estação:
//   (1) HEARTBEAT — a estação está viva/lendo? (a referência aparece e é fresca)
//   (2) DRIFT     — o RSSI da referência desviou do baseline? (ambiente/antena mudou)
//   (3) RSSI@1m   — dada a distância conhecida da âncora, estima o RSSI0 (calibra o modelo log-distância)
// NÃO participa da associação tag↔pessoa (que segue por correlação, em associate.ts); é só saúde da estação.
// LGPD: só RSSI (efêmero), nada persistido.

// Shape MÍNIMO de uma leitura BLE para este módulo — evita depender do BtReading completo (puro/testável).
export type BtReadingLike = { mac: string; rssi: number; ts?: number };

export type StationHealth = {
  alive: boolean;
  rssi: number | null;
  baseline: number | null;
  driftDb: number | null;
  status: "ok" | "drift" | "down";
};

const DRIFT_DB = 6; // |rssi - baseline| acima disto → "drift" (desvio relevante de ambiente/antena)
const BASELINE_ALPHA = 0.1; // EMA suave: peso da amostra nova (0.1 ⇒ ~10 leituras de memória)

// Avalia a saúde da estação a partir das leituras atuais e do baseline anterior (EMA acumulada fora, no hook).
// `prevBaseline` é preservado mesmo quando a estação cai (não perde a referência de calibração num piscar).
export function computeStationHealth(
  readings: readonly BtReadingLike[],
  refMac: string | undefined,
  prevBaseline: number | null,
  now: number,
  staleMs = 15000,
): StationHealth {
  const down: StationHealth = {
    alive: false,
    rssi: null,
    baseline: prevBaseline,
    driftDb: null,
    status: "down",
  };
  if (!refMac) return down;
  const ref = readings.find((r) => r.mac?.toUpperCase() === refMac.toUpperCase());
  if (!ref) return down;
  // ts ausente → a leitura está na lista AGORA, logo viva (o back já poda por STALE antes do snapshot).
  const alive = ref.ts == null || now - ref.ts <= staleMs;
  if (!alive) return { ...down, rssi: ref.rssi };

  const rssi = ref.rssi;
  const baseline = prevBaseline == null ? rssi : prevBaseline * 0.9 + rssi * BASELINE_ALPHA;
  const driftDb = rssi - baseline;
  const status: StationHealth["status"] = Math.abs(driftDb) > DRIFT_DB ? "drift" : "ok";
  return { alive: true, rssi, baseline, driftDb, status };
}

// Modelo log-distância: RSSI(d) = RSSI0 - 10*n*log10(d). Dada uma leitura a distância conhecida,
// resolve RSSI0 (o RSSI esperado a 1 m) — a calibração que o painel usa p/ estimar distância de outras tags.
export function rssiAt1m(refRssi: number, distMeters: number, n = 2): number {
  return refRssi + 10 * n * Math.log10(Math.max(0.1, distMeters));
}
