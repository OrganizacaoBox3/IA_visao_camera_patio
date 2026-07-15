// useTopdownView — a FIAÇÃO de dados da vista de topo (calibração + BLE vivo + liveness → a view de
// mundo). Extraído para ser compartilhado pela aba pequena (tabs/Vista2DTab) E pela tela cheia
// (Vista2DStage): o mesmo mapa em dois tamanhos, uma fonte de dados só (DRY). O núcleo puro vive em
// fusion/topdown.ts; aqui só o timing/estado (efêmero, LGPD: só metadados de rádio).
import { useEffect, useMemo, useState } from "react";
import { getCalibration } from "../api";
import { useBleReadings } from "./useBleReadings";
import { useStationNames } from "../fusion/useStationNames";
import { deriveTopdownView, type TopdownStation, type TopdownView } from "../fusion/topdown";
import type { FloorCalibration } from "../fusion/useFloorTags";

// Janela de "estação viva" — RÉPLICA do STALE_MS de server/bt/bt-readings.js (15 s), o mesmo critério
// da aba Estações / CalibracaoTab. Beacon fora dela é "sem sinal" (going-gray), não mede.
const STATION_STALE_MS = 15_000;
const EMPTY_CAL: FloorCalibration = { H: null, station: null, points: [] };

export function useTopdownView(
  cameraId: string,
  enabled = true,
): { view: TopdownView; hasCal: boolean } {
  // Calibração da câmera (H + cantos + pontos das estações). Recarrega ao trocar de câmera.
  const [cal, setCal] = useState<FloorCalibration>(EMPTY_CAL);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getCalibration(cameraId)
      .then((c) => {
        if (!alive) return;
        setCal({
          H: c?.H ?? null,
          station: c?.station ?? null,
          points: c?.points ?? [],
          ...(c?.stations ? { stations: c.stations } : {}),
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cameraId, enabled]);

  const readings = useBleReadings(enabled);
  const { stations: registered, nameOf } = useStationNames(enabled);

  // Estações VIVAS = postaram < 15 s (registro). Beacon morto entra no desenho como "sem sinal", mas
  // NÃO mede (topdown.ts filtra).
  const liveIds = useMemo(() => {
    const now = Date.now();
    return new Set(
      registered.filter((s) => s.ativo && now - s.ultimaVezEm < STATION_STALE_MS).map((s) => s.id),
    );
  }, [registered]);

  // Estações p/ o núcleo: multi-antena (calibration.stations) OU o ponto único legado (calibration.station).
  const stations = useMemo<TopdownStation[]>(() => {
    const map = cal.stations;
    if (map && Object.keys(map).length) {
      return Object.entries(map).map(([id, px]) => ({ id, px, label: nameOf(id), live: liveIds.has(id) }));
    }
    if (cal.station) return [{ id: "", px: cal.station, label: "Estação", live: liveIds.size > 0 }];
    return [];
  }, [cal.stations, cal.station, nameOf, liveIds]);

  const corners = useMemo(() => (cal.points ?? []).map((p) => p.px), [cal.points]);
  const readingsIn = useMemo(
    () => readings.map((r) => ({ stationId: r.stationId ?? "", mac: r.mac, rssi: r.rssi, rotulo: r.rotulo })),
    [readings],
  );

  // MVP: sem âncoras no fit → modelo de path-loss default DECLARADO. O NEAREST (maior RSSI) é correto
  // independentemente do modelo; a distância é estimativa grosseira. Âncoras dos cantos = FOLLOW-UP.
  const view = useMemo(
    () => deriveTopdownView({ H: cal.H, corners, stations, readings: readingsIn }),
    [cal.H, corners, stations, readingsIn],
  );
  const hasCal = !!cal.H && stations.length > 0;
  return { view, hasCal };
}
