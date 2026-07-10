// Orquestra a fusão tag↔pessoa de UMA câmera: a cada ~500ms monta um FusionFrame (tracks do hub +
// leituras BLE + homografia da câmera) e roda o associador (associate.ts) → mapa trackId→rótulo. Devolve
// um `labelFor` estável p/ o overlay pintar. Responsabilidade única: o TIMING/estado; a matemática mora
// em associate.ts e frame.ts (puros/testados). Desligado (enabled=false / sem readings) → labelFor null.
import { useEffect, useMemo, useRef } from "react";
import { TagTrackAssociator } from "./associate";
import { buildFusionFrame, type RawReading } from "./frame";
import type { Matrix3, Vec2 } from "../vision/homography";
import type { HubAnalysis } from "../types/analysis";

type Params = {
  getHubAnalysis?: () => HubAnalysis | null; // tracks (caixas) desta câmera
  getReadings?: () => RawReading[] | null; // leituras BLE da estação (global)
  H: Matrix3 | null; // homografia da câmera (null = fallback por tamanho de caixa)
  stationPx?: Vec2; // ponto do chão da estação (0..1); undefined = default do frame.ts
  enabled?: boolean;
};

const TICK_MS = 500; // a fusão roda a ~2Hz — a associação é por JANELA, não por frame

export function useTagFusion({ getHubAnalysis, getReadings, H, stationPx, enabled = true }: Params) {
  const assoc = useRef<TagTrackAssociator | null>(null);
  const labels = useRef<Map<number, string>>(new Map());
  // Espelho ADITIVO do mapa de rótulos: o CONJUNTO de tags já associadas a alguma pessoa
  // (chave rotulo||mac — a mesma do FusionFrame). Consumido pelo plot de tags no chão p/
  // SUPRIMIR o anel de quem já tem rótulo AR na caixa. Recomputado junto do mapa (2 Hz).
  const assigned = useRef<ReadonlySet<string>>(new Set());
  if (!assoc.current) assoc.current = new TagTrackAssociator();

  useEffect(() => {
    if (!enabled || !getHubAnalysis || !getReadings) {
      labels.current = new Map();
      assigned.current = new Set();
      return;
    }
    const a = assoc.current;
    if (!a) return;
    a.reset();
    const id = window.setInterval(() => {
      const hd = getHubAnalysis();
      const readings = getReadings();
      if (!hd || !readings || !readings.length) return;
      const now = performance.now();
      a.push(buildFusionFrame(hd.tracks, readings, H, now, stationPx));
      const m = new Map<number, string>();
      for (const as of a.assign(now)) if (as.tag) m.set(as.trackId, as.tag);
      labels.current = m;
      assigned.current = new Set(m.values());
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [getHubAnalysis, getReadings, H, stationPx, enabled]);

  // Getters estáveis (leem os refs) → não quebram o React.memo de quem consome o overlay.
  return useMemo(
    () => ({
      labelFor: (trackId: number): string | null => labels.current.get(trackId) ?? null,
      /** Tags (chave rotulo||mac) ATUALMENTE associadas a alguma pessoa — aditivo. */
      assignedTags: (): ReadonlySet<string> => assigned.current,
    }),
    [],
  );
}
