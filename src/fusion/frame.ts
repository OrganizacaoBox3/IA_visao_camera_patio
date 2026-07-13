// Monta o FusionFrame que o associador (associate.ts) consome, a partir do que a câmera+estação dão:
// as CAIXAS das pessoas (analysis-tracks, 0..1) viram DISTÂNCIA à estação (via homografia se a câmera
// está calibrada; senão um proxy monotônico pelo tamanho da caixa), e as leituras BLE viram {tag, rssi}.
// Puro/sem estado → testável isolado. Responsabilidade única: traduzir os dados brutos p/ o frame.
import { pixelToWorld, type Matrix3, type Vec2 } from "../vision/homography";
import type { FusionFrame, TagReading } from "./associate";

/** Caixa de pessoa (subset do track do hub): id + bbox [x,y,w,h] normalizado 0..1. */
export type DrawTrack = { id: number; bbox: readonly [number, number, number, number] };
/** Leitura BLE crua (shape do bt-readings): rótulo quando cadastrada, senão o MAC.
 *  `distM` (OPCIONAL, v4): distância ABSOLUTA tag→estação (m) estimada pelo modelo RSSI→distância
 *  calibrado pelas âncoras (floor-plot.ts) — repassada intacta ao associador como 2ª evidência.
 *  `sourceId` (OPCIONAL, ADR-013 item 3): id da FONTE que mediu (a estação BLE — o `stationId` do
 *  ingest/gravação). AUSENTE = fonte única implícita — a semântica de todo o código de hoje
 *  (simulador `sim.ts`, leituras sem fonte declarada): tratadas como vindas da mesma e única
 *  fonte, exatamente como antes do campo existir. Preenchido pelo loader de gravação
 *  (session-loader.ts) OU derivado de `stationId` aqui (o elo do caminho vivo — ver abaixo);
 *  nenhum consumidor o exige — vocabulário aditivo p/ multi-fonte (2ª antena/AoA/UWB), ver
 *  evidence.ts (arquivado na tag research-fusion-arc-2026-07-12).
 *  `stationId` (OPCIONAL, spec multi-antena F4): o shape das leituras AO VIVO (BtReading do
 *  bt-readings) carrega o id da estação NESTE campo — buildFusionFrame o mapeia p/ `sourceId`
 *  (o ELO que faltava: sem ele a partição por fonte do motor via sempre 1 grupo ao vivo). */
export type RawReading = {
  mac: string;
  rotulo: string | null;
  rssi: number;
  distM?: number;
  sourceId?: string;
  stationId?: string;
};

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
 * @param excludeTags MACs (MAIÚSCULOS) a excluir das leituras ANTES da fusão — as tags-âncora
 *   CADASTRADAS (calibration.points[].mac): posição conhecida e fixa, JAMAIS estão numa pessoa;
 *   oferecê-las ao associador só gera falso-rótulo (medido na revisão adversarial de 2026-07-10:
 *   todo o ganho da v4 era âncoras deixando de grudar em gente — a exclusão captura esse ganho
 *   sem depender do modelo RSSI→distância, logo IMUNE a viés de RSSI). Compara pelo MAC da
 *   leitura em maiúsculas. ADITIVO: ausente/vazio = comportamento intacto.
 */
export function buildFusionFrame(
  tracks: readonly DrawTrack[],
  readings: readonly RawReading[],
  H: Matrix3 | null,
  now: number,
  stationPx: Vec2 = STATION_PX,
  excludeTags?: ReadonlySet<string>,
): FusionFrame {
  const stationWorld = H ? pixelToWorld(H, stationPx) : null;
  // `metric: true` SÓ quando a distância saiu da homografia (metros reais) — o proxy de caixa não
  // ganha a flag, e a evidência absoluta do associador (gate/blend, v4) fica inerte nele.
  const outTracks: FusionFrame["tracks"] = tracks.map((t) => {
    if (H && stationWorld) {
      const g = pixelToWorld(H, foot(t.bbox));
      if (g)
        return {
          trackId: t.id,
          dist: Math.hypot(g.x - stationWorld.x, g.y - stationWorld.y),
          metric: true,
        };
    }
    return { trackId: t.id, dist: boxProxyDist(t.bbox) };
  });
  // Âncora cadastrada NUNCA é candidata (excludeTags — ver doc acima); distM (quando o chamador
  // calibrou o modelo pelas âncoras) é repassado intacto; ausente → leitura idêntica à pré-v4
  // (retrocompat dura: nem a chave existe).
  const outReadings: TagReading[] = [];
  for (const r of readings) {
    if (excludeTags && excludeTags.has(r.mac.toUpperCase())) continue;
    const out: TagReading = { tag: r.rotulo || r.mac, rssi: r.rssi };
    if (r.distM !== undefined) out.distM = r.distM;
    // O ELO stationId→sourceId (spec multi-antena F4): as leituras AO VIVO carregam a fonte em
    // `stationId` e ninguém a mapeava — RssiSample.sourceId chegava vazio e partitionBySource via
    // sempre 1 grupo. sourceId EXPLÍCITO (replay/session-loader) tem precedência; ambos ausentes
    // (ou stationId vazio) → chave ausente (retrocompat dura: fonte única implícita — CA-3).
    if (r.sourceId !== undefined) out.sourceId = r.sourceId; // fonte → fusão multi-fonte (ADR-013)
    else if (typeof r.stationId === "string" && r.stationId.length > 0) out.sourceId = r.stationId;
    outReadings.push(out);
  }
  return { ts: now, readings: outReadings, tracks: outTracks };
}
