// Poll leve das leituras BLE VIVAS ("tags visíveis agora"). Seam extraído do CalibrationPanel, onde
// os passos "referência" e "âncoras" precisavam da mesma lista ao vivo. Efêmero (LGPD): só metadados
// de rádio (mac/rotulo/rssi), nada de imagem, e nada persiste — some ao desmontar/desabilitar.
//   • enabled=false → não faz poll; mantém a última lista já lida (não zera), como o inline original.
//   • enabled=true  → carrega já e re-carrega a cada ~2s.
import { useEffect, useState } from "react";
import { getBtReadings, type BtReading } from "../api";

export function useBleReadings(enabled: boolean): BtReading[] {
  const [readings, setReadings] = useState<BtReading[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      getBtReadings()
        .then((r) => {
          if (!cancelled) setReadings(r);
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [enabled]);
  return readings;
}
