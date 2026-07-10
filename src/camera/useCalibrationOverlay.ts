// Carrega a CALIBRAÇÃO (homografia + pontos cadastrados) de UMA câmera e governa o toggle da "malha"
// de conferência na câmera aberta. Responsabilidade única: entregar o estado do overlay pronto p/ o
// rAF (via refs, sem re-render por frame) e a fiação do botão — mantendo o god-file (CameraWorkspace)
// enxuto (1 chamada de hook em vez de carregar a calibração + gerir toggle+ref inline).
//
// Padrão da casa (going-gray/HUD): `on` é estado (UI/pressed) e `onRef` é o espelho lido no laço de
// desenho — a régua/overlay não pode custar re-render a cada frame. `dataRef` guarda points+H (lidos
// no rAF); `hasCalibration` gate o botão (some quando a câmera nunca foi calibrada).
import { useEffect, useRef, useState } from "react";
import { getCalibration, type CalibrationPoint } from "../api";
import { type Matrix3 } from "../vision/homography";

type CalibData = { points: CalibrationPoint[]; H: Matrix3 | null };

export function useCalibrationOverlay(cameraId: string, enabled: boolean) {
  const [on, setOnState] = useState(false);
  const onRef = useRef(false);
  const dataRef = useRef<CalibData>({ points: [], H: null });
  const [hasCalibration, setHasCalibration] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    getCalibration(cameraId)
      .then((c) => {
        if (!alive) return;
        dataRef.current = { points: c?.points ?? [], H: c?.H ?? null };
        setHasCalibration((c?.points?.length ?? 0) > 0);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cameraId, enabled]);

  // Setter único: espelha o toggle no ref (rAF) e no estado (UI) numa só unidade.
  const setOn = (v: boolean) => {
    onRef.current = v;
    setOnState(v);
  };

  return { on, setOn, onRef, dataRef, hasCalibration };
}
