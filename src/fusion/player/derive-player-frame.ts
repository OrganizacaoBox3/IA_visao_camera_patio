// Bancada de simulação (docs/cientifica/simulador.md) — Fase 0, Trilha P: núcleo PURO do player de
// replay. NÃO simula, não associa, não recomputa nada — só projeta o que já está no tick (mesma
// disciplina do resto do domínio: floor-plot.ts/floor-polygon.ts são geometria pura testável, o
// desenho em canvas é uma camada fina por cima). O que este módulo devolve É o que o harness mediu —
// nenhum bit novo, só coordenadas prontas pras DUAS vistas do player (planta top-down + câmera).
//
// Vista-CÂMERA: as bboxes tal como gravadas (nenhuma transformação) — é literalmente o que a
// produção viu naquele tick (analysis-tracks). Vista-PLANTA (top-down): o PÉ de cada bbox
// (bottom-center — mesmo ponto que frame.ts usa pra fusão) projetado a mundo via H
// (pixelToWorld/homography.ts). Sem H (cenário não-calibrado ou câmera real sem calibração), a
// planta simplesmente não tem posição pra essa pista — `worldPos: null`, nunca um ponto inventado
// (mesma honestidade do resto do projeto: rótulo/posição errada é pior que nenhuma).
//
// Responsabilidade única: derivar o frame desenhável de UM tick. Sem DOM, sem canvas, sem React.
import type { SimAnchor, SimTick } from "../sim";
import type { Matrix3, Vec2 } from "../../vision/homography";
import { pixelToWorld } from "../../vision/homography";

export type PlayerCameraTrack = { id: number; bbox: readonly [number, number, number, number] };
export type PlayerPlantaTrack = { id: number; worldPos: Vec2 | null };

export type PlayerFrame = {
  ts: number;
  /** Vista-câmera: bboxes tal como gravadas, sem transformação. */
  camera: PlayerCameraTrack[];
  /** Vista-planta: pé de cada track projetado a mundo (null = sem H ou além do horizonte). */
  planta: PlayerPlantaTrack[];
  /** Verdade-terreno do tick (só existe em gravação sintética — real não tem, ver session-loader.ts). */
  truthTagByTrack: Record<number, string | null>;
  /** Posições-mundo das tags-âncora, quando o cenário as exporta (SimFusionScenario.anchors). */
  anchorsWorld: { mac: string; world: Vec2 }[];
  /** Posição-mundo da estação BLE — null sem H (mesma regra da planta). */
  stationWorld: Vec2 | null;
};

/** Pé (bottom-center) de um bbox [x,y,w,h] normalizado — o MESMO ponto que a produção usa (frame.ts). */
function footOf(bbox: readonly [number, number, number, number]): Vec2 {
  const [x, y, w, h] = bbox;
  return { x: x + w / 2, y: y + h };
}

/**
 * Deriva o frame desenhável de UM tick (`SimTick`, o mesmo formato que `SimFusionScenario`/
 * `LoadedFusionSession` usam — sintético e real compartilham o tipo, mesma razão pela qual "o MESMO
 * player abre os dois mundos" é um critério de aceite, não um extra). `H`/`stationPx`/`anchors`
 * vêm do cenário (constantes por replay, não por tick).
 */
export function derivePlayerFrame(
  tick: SimTick,
  H: Matrix3 | null,
  stationPx: Vec2,
  anchors?: readonly SimAnchor[],
): PlayerFrame {
  const camera: PlayerCameraTrack[] = tick.tracks.map((t) => ({ id: t.id, bbox: t.bbox }));
  const planta: PlayerPlantaTrack[] = tick.tracks.map((t) => ({
    id: t.id,
    worldPos: H ? pixelToWorld(H, footOf(t.bbox)) : null,
  }));
  return {
    ts: tick.ts,
    camera,
    planta,
    truthTagByTrack: tick.truthTagByTrack,
    anchorsWorld: (anchors ?? []).map((a) => ({ mac: a.mac, world: a.world })),
    stationWorld: H ? pixelToWorld(H, stationPx) : null,
  };
}
