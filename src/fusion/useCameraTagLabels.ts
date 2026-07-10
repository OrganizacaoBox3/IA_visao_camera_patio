// Compõe, para UMA câmera: a homografia salva (metros) + a fusão tag↔pessoa (useTagFusion) → um REF
// estável do getter de rótulo (nome da tag associada a cada track). O ref é lido no rAF/canvas sem
// re-armar o laço de desenho. Responsabilidade única: entregar o `labelFor` da câmera — mantendo o
// god-file (CameraWorkspace) enxuto (1 chamada em vez de carregar calibração + rodar a fusão inline).
// ADITIVO (tags no chão): também expõe a CALIBRAÇÃO carregada (H + station + points c/ mac/world)
// e o getter das tags já associadas — insumos do useFloorTags, sem 2º fetch da mesma calibração.
import { useEffect, useRef, useState } from "react";
import { getCalibration, type BtReading } from "../api";
import { useTagFusion } from "./useTagFusion";
import type { FloorCalibration } from "./useFloorTags";
import type { HubAnalysis } from "../types/analysis";

const EMPTY_CALIBRATION: FloorCalibration = { H: null, station: null, points: [] };

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

  // Calibração da câmera num estado só (H, station e points mudam JUNTOS — 1 fetch, 1 set):
  // H (null = não calibrada → a fusão usa o proxy por tamanho de caixa), station (ponto do chão
  // da estação BLE; null = default) e points (âncoras dos cantos — consumidas pelo useFloorTags).
  const [calibration, setCalibration] = useState<FloorCalibration>(EMPTY_CALIBRATION);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getCalibration(cameraId)
      .then((c) => {
        if (!alive) return;
        setCalibration({ H: c?.H ?? null, station: c?.station ?? null, points: c?.points ?? [] });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // calibrationRev na dep: recalibrou em outro posto → re-busca (o guard `alive` cobre a corrida).
  }, [cameraId, enabled, calibrationRev]);

  const { labelFor, assignedTags } = useTagFusion({
    getHubAnalysis,
    getReadings,
    H: calibration.H,
    stationPx: calibration.station ?? undefined,
    enabled,
  });

  // Ref estável p/ o rAF (labelFor do hook já é estável; o ref evita tocar as deps do efeito do canvas).
  const labelForRef = useRef(labelFor);
  useEffect(() => {
    labelForRef.current = labelFor;
  }, [labelFor]);
  return { labelForRef, calibration, assignedTags };
}
