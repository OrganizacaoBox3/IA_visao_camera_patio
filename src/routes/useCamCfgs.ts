// Config por câmera (camcfg) para uma lista de câmeras VISÍVEIS: garante uma entrada carregada
// por câmera (default = atividade → retrocompatível) + leitor síncrono `cfgOf`.
// Dedup (regra dos 3): o mesmo efeito+leitor vivia byte-quase-idêntico em DashboardPage e
// cameras/IpCamerasSection. `setCfgs` fica exposto p/ quem escreve (write-through da tela /cameras).
import { useCallback, useEffect, useState } from "react";
import { getCameraCfg, type CameraCfg } from "../cameraConfig";

export function useCamCfgs(cameras: readonly { id: string }[]): {
  cfgs: Record<string, CameraCfg>;
  setCfgs: React.Dispatch<React.SetStateAction<Record<string, CameraCfg>>>;
  cfgOf: (id: string) => CameraCfg;
} {
  const [cfgs, setCfgs] = useState<Record<string, CameraCfg>>({});
  useEffect(() => {
    setCfgs((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const c of cameras)
        if (!next[c.id]) {
          next[c.id] = getCameraCfg(c.id);
          changed = true;
        }
      return changed ? next : prev;
    });
  }, [cameras]);
  // Leitor síncrono: cai no cache do cameraConfig p/ câmera ainda não garantida pelo efeito.
  const cfgOf = useCallback((id: string): CameraCfg => cfgs[id] ?? getCameraCfg(id), [cfgs]);
  return { cfgs, setCfgs, cfgOf };
}
