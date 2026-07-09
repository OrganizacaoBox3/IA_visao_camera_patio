// Monta o FusionFrame que o associador (associate.ts) consome, a partir do que a câmera+estação dão:
// as CAIXAS das pessoas (analysis-tracks, 0..1) viram DISTÂNCIA à estação (via homografia se a câmera
// está calibrada; senão um proxy monotônico pelo tamanho da caixa), e as leituras BLE viram {tag, rssi}.
// Puro/sem estado → testável isolado. Responsabilidade única: traduzir os dados brutos p/ o frame.
import { pixelToWorld, type Matrix3, type Vec2 } from "../vision/homography";
import type { FusionFrame, TagReading } from "./associate";

/** Caixa de pessoa (subset do track do hub): id + bbox [x,y,w,h] normalizado 0..1. */
export type DrawTrack = { id: number; bbox: readonly [number, number, number, number] };
/** Leitura BLE crua (shape do bt-readings): rótulo quando cadastrada, senão o MAC. */
export type RawReading = { mac: string; rotulo: string | null; rssi: number };

// Padrão da estação: base-centro da imagem (0.5, 1.0) = ponto do chão MAIS PERTO da câmera. Assume a
// estação junto da câmera (caminho C). Trocável se a estação ficar em outro ponto conhecido do chão.
const STATION_PX: Vec2 = { x: 0.5, y: 1.0 };

/** Pé da caixa (bottom-center) em coords normalizadas — a âncora no chão da pessoa. */
function foot(bbox: readonly [number, number, number, number]): Vec2 {
  return { x: bbox[0] + bbox[2] / 2, y: bbox[1] + bbox[3] };
}

// Sem calibração: caixa MAIOR = pessoa mais PERTO = distância MENOR. Proxy monotônico (não é metro real,
// mas a fusão usa só a TENDÊNCIA no tempo, então serve p/ correlacionar com o RSSI).
function boxProxyDist(bbox: readonly [number, number, number, number]): number {
  return 1 / Math.max(0.01, bbox[3]);
}

/**
 * @param H homografia da câmera (null = não calibrada → usa o proxy de caixa)
 * @param stationPx ponto do chão da estação em coords de imagem (default: base-centro)
 */
export function buildFusionFrame(
  tracks: readonly DrawTrack[],
  readings: readonly RawReading[],
  H: Matrix3 | null,
  now: number,
  stationPx: Vec2 = STATION_PX,
): FusionFrame {
  const stationWorld = H ? pixelToWorld(H, stationPx) : null;
  const outTracks = tracks.map((t) => {
    let dist: number;
    if (H && stationWorld) {
      const g = pixelToWorld(H, foot(t.bbox));
      dist = g ? Math.hypot(g.x - stationWorld.x, g.y - stationWorld.y) : boxProxyDist(t.bbox);
    } else {
      dist = boxProxyDist(t.bbox);
    }
    return { trackId: t.id, dist };
  });
  const outReadings: TagReading[] = readings.map((r) => ({ tag: r.rotulo || r.mac, rssi: r.rssi }));
  return { ts: now, readings: outReadings, tracks: outTracks };
}
