import { useMemo, useRef } from "react";
import type { Classification } from "../fusion/fingerprint";
import type { FloorplanView } from "../fusion/floorplan";
import {
  deriveContinuousFloorplan,
  type ContinuousFloorplanView,
  type TagRuntime,
} from "../fusion/continuous-position";

/** Mantém o estado temporal fora do núcleo puro e publica a vista operacional contínua.
 *  O estado por tag (filtro de movimento + fonte corrente + identidade) atravessa os polls para:
 *  histerese de troca de fonte, re-entrada limitada pós-gap e tags-fantasma ("última posição
 *  conhecida" quando o rádio cala) — ver estabilidade C3/C4 em
 *  docs/analises/planta-ble-localizacao-continua/estabilidade.md. */
export function useContinuousFloorplan(
  view: FloorplanView,
  classifications: ReadonlyMap<string, Classification>,
): ContinuousFloorplanView {
  const tracksRef = useRef<Map<string, TagRuntime>>(new Map());
  return useMemo(() => {
    const next = deriveContinuousFloorplan(view, classifications, tracksRef.current);
    tracksRef.current = next.tracks;
    return next.view;
  }, [view, classifications]);
}
