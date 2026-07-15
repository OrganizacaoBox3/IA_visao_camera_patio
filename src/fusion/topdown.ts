// VISTA SUPERIOR (top-down) 2D do chão calibrado — núcleo PURO (sem DOM/React), testável.
//
// PARA QUÊ: rodar um teste SÓ COM OS BEACONS BLUETOOTH, sem a câmera. O dono quer ver, para cada
// tag, QUAL BEACON está MAIS PRÓXIMO (e a distância estimada). Este módulo deriva a geometria em
// MUNDO (metros); o desenho (camera/drawTopdown.ts) e a fiação (camera/tabs/Vista2DTab.tsx) ficam à
// parte — a mesma separação cálculo↔pintura de floor-polygon.ts / floor-plot.ts.
//
// FÍSICA HONESTA (inegociável — a mesma de floor-plot.ts): 1 estação + RSSI dá DISTÂNCIA, não
// posição. A viz honesta de uma tag é um ANEL de raio d ao redor do beacon; NUNCA um ponto
// inventado (rótulo errado é pior que nenhum). Com N beacons ouvindo a tag, há N anéis — um por
// beacon — e DESTACAMOS o mais próximo (MAIOR rssi = menor distância). JAMAIS a interseção
// (trilateração por RSSI foi REFUTADA — ver useFloorTags.ts). Só beacons VIVOS medem.
//
// Diferença para deriveFloorView (useFloorTags): aquele projeta os anéis em PIXEL para desenhar
// SOBRE a câmera; AQUI o alvo é o top-down, então o núcleo devolve coordenadas de MUNDO (o beacon
// via pixelToWorld(H, station.px); os cantos via pixelToWorld(H, corner.px)) e o desenho fita o
// bbox do chão no canvas (worldToCanvas). Responsabilidade única: a geometria de mundo da vista.

import { pixelToWorld, type Matrix3, type Vec2 } from "../vision/homography";
import { distFromRssi, fitPathLoss, type AnchorObs, type PathLossModel } from "./floor-plot";

/** Estação BLE no chão: id técnico (casa com o `stationId` das leituras), ponto de IMAGEM (0..1),
 *  nome amigável opcional e se está VIVA (postou recentemente — critério do chamador, <15 s). */
export type TopdownStation = { id: string; px: Vec2; label?: string; live?: boolean };
/** Observação de âncora para o fit do path-loss DE UMA estação: a âncora tem posição-mundo conhecida
 *  (corner) e a estação a ouviu com este rssi. `mac` é informativo (o fit usa só world+rssi). */
export type TopdownAnchor = { stationId: string; world: Vec2; rssi: number; mac?: string };
/** Leitura BLE crua por (estação, tag): quem mediu (stationId), a tag (mac) e o rssi. */
export type TopdownReading = { stationId: string; mac: string; rssi: number; rotulo?: string | null };

export type TopdownBeacon = { id: string; label: string; world: Vec2; live: boolean };
export type TopdownRing = { beaconId: string; radiusM: number };
export type TopdownNearest = { beaconId: string; distM: number };
export type TopdownTag = {
  mac: string;
  label: string;
  /** Beacon de MAIOR rssi entre os VIVOS que ouvem a tag (o mais próximo), ou null se nenhum ouve. */
  nearest: TopdownNearest | null;
  /** Um anel por beacon vivo que ouve a tag (raio = distância estimada por aquele beacon). */
  rings: TopdownRing[];
};
export type TopdownView = {
  /** Os cantos do chão em MUNDO (metros) — vazio sem H/sem calibração. */
  floorWorld: Vec2[];
  beacons: TopdownBeacon[];
  tags: TopdownTag[];
};

export type TopdownArgs = {
  H: Matrix3 | null;
  /** Cantos do chão em PIXEL (0..1) — os pontos da calibração (points[].px). */
  corners: Vec2[];
  stations: TopdownStation[];
  /** Observações de âncora p/ calibrar o path-loss por estação (opcional → modelo default declarado). */
  anchors?: TopdownAnchor[];
  readings: TopdownReading[];
};

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isVec = (v: unknown): v is Vec2 =>
  !!v && typeof v === "object" && isFiniteNum((v as Vec2).x) && isFiniteNum((v as Vec2).y);
/** Chave de fonte: casa `station.id` com `reading.stationId` (mesmo critério de useFloorTags:
 *  MAIÚSCULAS; "" = fonte única legada). */
const srcKey = (id: string | undefined | null): string => (typeof id === "string" ? id.toUpperCase() : "");
const macKey = (mac: string): string => mac.toUpperCase();
/** Sufixo curto p/ rótulo: 4 últimos hex do MAC. */
const macSuffix = (mac: string): string =>
  mac.replace(/[^0-9a-zA-Z]/g, "").slice(-4).toUpperCase();
// Espelho do teto DIST_MAX_M do floor-plot: raio SATURADO não é medição — é "fora de alcance".
const RING_MAX_M = 100;

/**
 * Deriva a vista de topo — PURA. Robusta a dados faltando:
 *  - sem H → floorWorld e beacons VAZIOS (sem homografia não há mundo), tags sem nearest;
 *  - beacon além do horizonte projetivo (pixelToWorld null) → não entra;
 *  - beacon MORTO (live=false) → não mede: nem anel, nem nearest;
 *  - tag sem beacon vivo que a ouça → nearest null, rings [].
 * nearest = beacon de MAIOR rssi entre os vivos (o sinal físico mais forte = o mais próximo); a
 * distM sai do modelo de path-loss DAQUELE beacon (calibrado pelas suas âncoras, ou default declarado).
 */
export function deriveTopdownView(args: TopdownArgs): TopdownView {
  const H = args?.H ?? null;
  const cornersIn = Array.isArray(args?.corners) ? args.corners : [];
  const stationsIn = Array.isArray(args?.stations) ? args.stations : [];
  const anchorsIn = Array.isArray(args?.anchors) ? args.anchors : [];
  const readingsIn = Array.isArray(args?.readings) ? args.readings : [];

  // ── Chão em MUNDO: cada canto (px) projetado por H. Sem H → vazio. ──
  const floorWorld: Vec2[] = [];
  if (H) {
    for (const c of cornersIn) {
      if (!isVec(c)) continue;
      const w = pixelToWorld(H, c);
      if (w) floorWorld.push(w);
    }
  }

  // ── Beacons em MUNDO + modelo de path-loss por fonte. Sem H → nenhum beacon (não há mundo). ──
  const beacons: TopdownBeacon[] = [];
  const worldByKey = new Map<string, Vec2>();
  const idByKey = new Map<string, string>();
  const liveByKey = new Map<string, boolean>();
  const modelByKey = new Map<string, PathLossModel>();
  if (H) {
    for (const st of stationsIn) {
      if (!st || !isVec(st.px)) continue;
      const world = pixelToWorld(H, st.px);
      if (!world) continue; // além do horizonte projetivo — sem origem radial honesta
      const key = srcKey(st.id);
      const live = !!st.live;
      beacons.push({ id: st.id, label: (st.label ?? "").trim() || st.id || "Estação", world, live });
      worldByKey.set(key, world);
      idByKey.set(key, st.id);
      liveByKey.set(key, live);
      // Path-loss DESTA estação: âncoras que ela ouve (world conhecido + rssi dela). <2 → default.
      const obs: AnchorObs[] = anchorsIn
        .filter((a) => a && srcKey(a.stationId) === key && isVec(a.world) && isFiniteNum(a.rssi))
        .map((a) => ({ mac: a.mac ?? "", world: a.world, rssi: a.rssi }));
      modelByKey.set(key, fitPathLoss(obs, world));
    }
  }

  // ── Tags: 1 por MAC ouvido por algum beacon VIVO. Anel por beacon; nearest = MAIOR rssi. ──
  // Só beacons vivos entram (dead beacon não mede nada honesto). Dedup por (mac, fonte): fica o
  // MAIOR rssi daquela leva (determinístico).
  const byMac = new Map<
    string,
    { mac: string; rotulo: string | null; heard: Map<string, number> }
  >();
  for (const r of readingsIn) {
    if (!r || typeof r.mac !== "string" || !r.mac || !isFiniteNum(r.rssi)) continue;
    const key = srcKey(r.stationId);
    if (!worldByKey.has(key) || !liveByKey.get(key)) continue; // beacon inexistente ou morto → fora
    const mk = macKey(r.mac);
    let e = byMac.get(mk);
    if (!e) {
      e = { mac: r.mac, rotulo: r.rotulo ?? null, heard: new Map() };
      byMac.set(mk, e);
    }
    const prev = e.heard.get(key);
    if (prev === undefined || r.rssi > prev) e.heard.set(key, r.rssi);
    if (r.rotulo) e.rotulo = r.rotulo;
  }

  const tags: TopdownTag[] = [];
  for (const e of byMac.values()) {
    const rings: TopdownRing[] = [];
    let nearest: TopdownNearest | null = null;
    let bestRssi = -Infinity;
    for (const [key, rssi] of e.heard) {
      const model = modelByKey.get(key);
      if (!model) continue;
      const beaconId = idByKey.get(key) ?? key;
      const distM = distFromRssi(model, rssi);
      if (distM < RING_MAX_M) rings.push({ beaconId, radiusM: distM });
      if (rssi > bestRssi) {
        bestRssi = rssi;
        nearest = { beaconId, distM };
      }
    }
    rings.sort((a, b) => a.beaconId.localeCompare(b.beaconId));
    tags.push({ mac: e.mac, label: e.rotulo || macSuffix(e.mac), nearest, rings });
  }
  tags.sort((a, b) => macKey(a.mac).localeCompare(macKey(b.mac)));

  return { floorWorld, beacons, tags };
}

// ── Enquadramento no canvas (fit do bbox de mundo, com margem, Y para baixo) ──

export type TopdownBbox = { minX: number; minY: number; maxX: number; maxY: number };
export type TopdownTransform = { scale: number; project: (w: Vec2) => Vec2 };

/** Bbox de um conjunto de pontos de mundo. null se não há ponto válido. */
export function bboxOf(points: readonly Vec2[]): TopdownBbox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const p of points) {
    if (!isVec(p)) continue;
    any = true;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/** Bbox que cobre o chão + os beacons + a EXTENSÃO dos anéis (para o anel caber no enquadramento). */
export function topdownBounds(view: TopdownView): TopdownBbox | null {
  const pts: Vec2[] = [...view.floorWorld];
  const worldById = new Map(view.beacons.map((b) => [b.id, b.world] as const));
  for (const b of view.beacons) pts.push(b.world);
  for (const t of view.tags)
    for (const r of t.rings) {
      const w = worldById.get(r.beaconId);
      if (!w || !isFiniteNum(r.radiusM)) continue;
      pts.push(
        { x: w.x - r.radiusM, y: w.y },
        { x: w.x + r.radiusM, y: w.y },
        { x: w.x, y: w.y - r.radiusM },
        { x: w.x, y: w.y + r.radiusM },
      );
    }
  return bboxOf(pts);
}

/**
 * Transform que FITA `bbox` (metros) dentro de `canvas` (px) com `margin` (px), preservando a razão
 * de aspecto (escala uniforme) e CENTRALIZANDO. Y NÃO é invertido (o mundo já é do plano do chão;
 * "Y para baixo" = mapeia direto ao Y do canvas). Robusto: canvas/margem inválidos → clamp;
 * bbox degenerado (ponto único / uma dimensão nula) → escala 1 px/m (nunca NaN/Infinity).
 */
export function worldToCanvas(
  bbox: TopdownBbox | null,
  canvas: { w: number; h: number },
  margin: number,
): TopdownTransform {
  const m = isFiniteNum(margin) && margin >= 0 ? margin : 0;
  const cw = isFiniteNum(canvas?.w) && canvas.w > 0 ? canvas.w : 1;
  const ch = isFiniteNum(canvas?.h) && canvas.h > 0 ? canvas.h : 1;
  const availW = Math.max(1, cw - 2 * m);
  const availH = Math.max(1, ch - 2 * m);
  const minX = bbox ? bbox.minX : 0;
  const minY = bbox ? bbox.minY : 0;
  const bw = bbox ? bbox.maxX - bbox.minX : 0;
  const bh = bbox ? bbox.maxY - bbox.minY : 0;
  const sx = bw > 0 ? availW / bw : Infinity;
  const sy = bh > 0 ? availH / bh : Infinity;
  let scale = Math.min(sx, sy);
  if (!isFiniteNum(scale) || scale <= 0) scale = 1; // bbox degenerado → 1 px/m
  const drawnW = bw * scale;
  const drawnH = bh * scale;
  const ox = m + (availW - drawnW) / 2 - minX * scale;
  const oy = m + (availH - drawnH) / 2 - minY * scale;
  const project = (w: Vec2): Vec2 => ({ x: ox + w.x * scale, y: oy + w.y * scale });
  return { scale, project };
}
