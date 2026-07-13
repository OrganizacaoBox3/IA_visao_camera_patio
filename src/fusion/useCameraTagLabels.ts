// Compõe, para UMA câmera: a homografia salva (metros) + a fusão tag↔pessoa (useTagFusion) → um REF
// estável do getter de rótulo (nome da tag associada a cada track). O ref é lido no rAF/canvas sem
// re-armar o laço de desenho. Responsabilidade única: entregar o `labelFor` da câmera — mantendo o
// god-file (CameraWorkspace) enxuto (1 chamada em vez de carregar calibração + rodar a fusão inline).
// ADITIVO (tags no chão): também expõe a CALIBRAÇÃO carregada (H + station + points c/ mac/world)
// e o getter das tags já associadas — insumos do useFloorTags, sem 2º fetch da mesma calibração.
//
// MULTI-ANTENA (F5/H4, 2026-07-13): a calibração carrega `stations` (o ponto de chão de CADA
// estação BLE) desde a spec F3 — e ele MORRIA AQUI. O motor tem a partição por fonte
// (multiSourceFisher), o frame.ts tem a geometria por fonte (distByStation), a UI salva os pontos,
// o hub persiste — mas o hook NÃO PASSAVA `stationsPx` ao useTagFusion, então `distByStation`
// NUNCA era emitido no caminho vivo e o motor jamais via a geometria da 2ª antena. Com 1 estação
// no campo isso era inócuo; com a 2ª no ar seria PERDA ATIVA de metade da evidência. O cano está
// ligado: a adaptação calibração→fusão virou função PURA (fusionInputsFrom) — testável sem render,
// que é como esta casa testa hook (não há testing-library).
import { useEffect, useMemo, useRef, useState } from "react";
import { getCalibration, type BtReading } from "../api";
import { useTagFusion } from "./useTagFusion";
import type { StationPoints } from "./frame";
import type { FloorCalibration } from "./useFloorTags";
import type { HubAnalysis } from "../types/analysis";
import type { Matrix3, Vec2 } from "../vision/homography";

const EMPTY_CALIBRATION: FloorCalibration = { H: null, station: null, points: [] };

/** Os insumos que a CALIBRAÇÃO entrega à FUSÃO — o contrato entre as duas camadas, num objeto só. */
export type FusionInputs = {
  H: Matrix3 | null;
  /** Ponto de chão da estação PRINCIPAL (0..1); undefined = default do frame.ts (0.5, 1.0). */
  stationPx?: Vec2;
  /** Ponto de chão de CADA estação, por id (= `calibration.stations`); undefined = 1 antena. */
  stationsPx?: StationPoints;
  /** MACs (MAIÚSCULOS) das tags-âncora cadastradas — jamais candidatas (ver frame.ts). */
  excludeTags?: ReadonlySet<string>;
};

/**
 * Adapta a calibração salva → insumos da fusão. PURA (sem hook, sem fetch): é aqui que mora o
 * contrato calibração→motor, e é aqui que ele é testado (useCameraTagLabels.test.ts). Se alguém
 * apagar o `stationsPx` daqui, o teste fica VERMELHO — foi exatamente esse elo que morreu calado.
 *
 * `stations` vazio ({}) → undefined: mundo de 1 antena, `distByStation` nem é emitido pelo frame
 * (retrocompat dura). Idem `excludeTags` sem nenhum MAC.
 */
export function fusionInputsFrom(c: FloorCalibration): FusionInputs {
  const macs = (c.points ?? [])
    .map((p) => p.mac)
    .filter((mac): mac is string => typeof mac === "string" && mac.length > 0)
    .map((mac) => mac.toUpperCase());
  const stations = c.stations && Object.keys(c.stations).length > 0 ? c.stations : undefined;
  const out: FusionInputs = { H: c.H };
  if (c.station) out.stationPx = c.station;
  if (stations) out.stationsPx = stations;
  if (macs.length) out.excludeTags = new Set(macs);
  return out;
}

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

  // Calibração da câmera num estado só (H, station, stations e points mudam JUNTOS — 1 fetch, 1
  // set): H (null = não calibrada → a fusão usa o proxy por tamanho de caixa), station (ponto do
  // chão da estação PRINCIPAL; null = default), stations (o ponto de CADA estação — multi-antena)
  // e points (âncoras dos cantos — consumidas pelo useFloorTags).
  const [calibration, setCalibration] = useState<FloorCalibration>(EMPTY_CALIBRATION);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getCalibration(cameraId)
      .then((c) => {
        if (!alive) return;
        setCalibration({
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
    // calibrationRev na dep: recalibrou em outro posto → re-busca (o guard `alive` cobre a corrida).
  }, [cameraId, enabled, calibrationRev]);

  // O contrato calibração→fusão, numa função pura (memoizada p/ não re-armar o efeito do motor a
  // cada render): H + estação principal + pontos de TODAS as estações + âncoras excluídas.
  const inputs = useMemo(() => fusionInputsFrom(calibration), [calibration]);

  const { labelFor, assignedTags } = useTagFusion({
    getHubAnalysis,
    getReadings,
    H: inputs.H,
    stationPx: inputs.stationPx,
    stationsPx: inputs.stationsPx,
    excludeTags: inputs.excludeTags,
    enabled,
  });

  // Ref estável p/ o rAF (labelFor do hook já é estável; o ref evita tocar as deps do efeito do canvas).
  const labelForRef = useRef(labelFor);
  useEffect(() => {
    labelForRef.current = labelFor;
  }, [labelFor]);
  return { labelForRef, calibration, assignedTags };
}
