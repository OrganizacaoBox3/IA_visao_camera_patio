// Compõe, para UMA câmera: a homografia salva (metros) + a fusão tag↔pessoa (useTagFusion) → um REF
// estável do getter de rótulo (nome da tag associada a cada track). O ref é lido no rAF/canvas sem
// re-armar o laço de desenho. Responsabilidade única: entregar o `labelFor` da câmera — mantendo o
// god-file (CameraWorkspace) enxuto (1 chamada em vez de carregar calibração + rodar a fusão inline).
import { useEffect, useRef, useState } from "react";
import { getCalibration, type BtReading } from "../api";
import { type Matrix3, type Vec2 } from "../vision/homography";
import { useTagFusion } from "./useTagFusion";
import type { HubAnalysis } from "../types/analysis";

export function useCameraTagLabels(params: {
  cameraId: string;
  getHubAnalysis?: () => HubAnalysis | null;
  getReadings?: () => BtReading[];
  enabled: boolean;
  /** SYNC AO VIVO (mesmo idioma do tripwiresRev/ADR-006): revisão incrementada pela central a cada
   *  `camcfg-updated {kind:"calibration"}` — cada incremento re-busca H/station (1 fetch por evento).
   *  Ausente → comportamento atual preservado (busca 1× por mount). */
  calibrationRev?: number;
}) {
  const { cameraId, getHubAnalysis, getReadings, enabled, calibrationRev } = params;

  // Homografia da câmera (null = não calibrada → a fusão usa o proxy por tamanho de caixa) +
  // o ponto do chão onde fica a estação BLE (origem da correlação RSSI×distância; null = default).
  const [calH, setCalH] = useState<Matrix3 | null>(null);
  const [station, setStation] = useState<Vec2 | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getCalibration(cameraId)
      .then((c) => {
        if (!alive) return;
        setCalH(c?.H ?? null);
        setStation(c?.station ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // calibrationRev na dep: recalibrou em outro posto → re-busca (o guard `alive` cobre a corrida).
  }, [cameraId, enabled, calibrationRev]);

  const { labelFor } = useTagFusion({
    getHubAnalysis,
    getReadings,
    H: calH,
    stationPx: station ?? undefined,
    enabled,
  });

  // Ref estável p/ o rAF (labelFor do hook já é estável; o ref evita tocar as deps do efeito do canvas).
  const labelForRef = useRef(labelFor);
  useEffect(() => {
    labelForRef.current = labelFor;
  }, [labelFor]);
  return labelForRef;
}
