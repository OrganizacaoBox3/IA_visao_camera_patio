// Poll leve das leituras BLE VIVAS ("tags visíveis agora"). Seam extraído do CalibrationPanel, onde
// os passos "referência" e "âncoras" precisavam da mesma lista ao vivo. Efêmero (LGPD): só metadados
// de rádio (mac/rotulo/rssi), nada de imagem, e nada persiste — some ao desmontar/desabilitar.
//   • enabled=false → não faz poll; mantém a última lista já lida (não zera), como o inline original.
//   • enabled=true  → carrega já e re-carrega a cada ~2s.
//   • all=true      → usa /api/bt/readings?all=1: uma linha POR (estação, tag), preservando o RSSI de
//     CADA estação para a MESMA tag (o endpoint padrão colapsa por MAC e perde o por-estação). É o
//     que a multilateração da Planta BLE exige — várias antenas ouvindo a mesma tag ao mesmo tempo.
import { useEffect, useState } from "react";
import { getBtReadings, getBtReadingsAll, type BtReading } from "../api";

export function useBleReadings(enabled: boolean, all = false): BtReading[] {
  const [readings, setReadings] = useState<BtReading[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const load = () =>
      (all ? getBtReadingsAll() : getBtReadings())
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
  }, [enabled, all]);
  return readings;
}
