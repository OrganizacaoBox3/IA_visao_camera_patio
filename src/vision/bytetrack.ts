// ─────────────────────────────────────────────────────────────────────────────
// bytetrack.ts — ByteTrack-lite: rastreador multi-alvo PURO em TS (Onda 2 do
// plano-contagem-pessoas). SEM React, SEM canvas, SEM I/O, SEM dependências.
//
// Ideia central do ByteTrack (Zhang et al. 2022), reduzida ao nosso caso:
//   • 1ª PASSADA: detecções de score ALTO (≥ highScore) associam com os tracks
//     ativos por IoU (matching guloso, melhor IoU primeiro).
//   • 2ª PASSADA: detecções de score BAIXO (< highScore — o que o pipeline
//     antigo jogava fora!) recuperam tracks que ficaram SEM par na 1ª passada
//     (oclusão parcial, alvo distante que pontua menos). Score baixo SUSTENTA
//     um track existente; NUNCA cria track novo (nascimento exige score alto).
//   • PREDIÇÃO LINEAR: o gate de associação usa a posição PREDITA do track
//     (delta das 2 últimas OBSERVAÇÕES, escalado pelo dt). Em rodadas lentas
//     (perfil LR full: ~0,5–1,3s entre rodadas) o deslocamento real quebra o
//     IoU com a última bbox observada; a predição o recupera e o id sobrevive.
//   • MORTE POR TTL: track sem associação por mais que ttlMs é removido.
//
// LIMITAÇÃO DECLARADA (sem re-ID por aparência): em cruzamento denso, ids podem
// trocar de pessoa — o tracker segue GEOMETRIA (IoU), não aparência. Ver o
// teste "cruzamento denso" em bytetrack.test.ts. Re-ID in-browser tem
// custo/benefício ruim na nossa cadência (risco declarado no plano).
//
// COORDENADAS: bbox NORMALIZADA [x,y,w,h] 0..1, origem topo-esquerda — o mesmo
// sistema de counting.ts/zones.ts. O caller converte de pixels (Detection.bbox
// px / frameW,H) e filtra a CLASSE ("person") ANTES; o corte por score é deste
// tracker (highScore separa as passadas). A posição reportada é sempre a
// OBSERVADA (a predição serve só ao gate — track sem par não "anda sozinho",
// o que inventaria cruzamentos).
// ─────────────────────────────────────────────────────────────────────────────

/** BBox normalizada [x, y, w, h] (0..1, origem topo-esquerda). */
export type NormBBox = [number, number, number, number];

/** Detecção de entrada (já filtrada por classe pelo caller; bbox normalizada). */
export type TrackerDet = { score: number; bbox: readonly [number, number, number, number] };

/** Track ativo. `foot` = bottom-center do bbox (âncora de contagem por linha). */
export type ByteTrack = {
  id: number;
  /** Centróide normalizado. */
  cx: number;
  cy: number;
  /** PÉ do bbox (bottom-center), clampado 0..1 — âncora p/ counting.ts (item 1.4). */
  foot: { x: number; y: number };
  bbox: NormBBox;
  /** Score da ÚLTIMA detecção associada (pode ser baixo na 2ª passada). */
  score: number;
  firstSeen: number;
  lastSeen: number;
};

export type ByteTrackerOptions = {
  /** Score mínimo da 1ª passada e p/ NASCER track. Default 0.4 (people.scoreThreshold). */
  highScore?: number;
  /** IoU mínimo p/ associar detecção×track (contra a bbox predita). Default 0.25. */
  iouThreshold?: number;
  /** Morte: track sem associação por mais que isso (ms). Default 1500. */
  ttlMs?: number;
};

export type ByteTracker = {
  /**
   * Chamar 1x por RODADA DE DETECÇÃO (não por frame de vídeo: realimentar o
   * mesmo resultado stale zeraria a velocidade e mataria a predição).
   * `highScore` opcional sobrepõe o da criação (perfil longo alcance em runtime).
   * Retorna os tracks ativos (inclui os em oclusão dentro do TTL).
   */
  update: (dets: ReadonlyArray<TrackerDet>, now: number, highScore?: number) => ByteTrack[];
  /** Snapshot dos tracks ativos (sem avançar o estado). */
  tracks: () => ByteTrack[];
  /** Descarta todos os tracks (não reseta a sequência de ids). */
  reset: () => void;
};

/** IoU de duas bboxes [x,y,w,h] (mesma unidade). 0 quando não há interseção. */
export function iouOf(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

type InternalTrack = ByteTrack & {
  /** Velocidade (unid. normalizada / ms) do canto do bbox, das 2 últimas observações. */
  vx: number;
  vy: number;
};

/** Cria um ByteTracker-lite. Estado encapsulado; determinístico dado o histórico. */
export function createByteTracker(opts: ByteTrackerOptions = {}): ByteTracker {
  const highDefault = opts.highScore ?? 0.4;
  const iouThr = opts.iouThreshold ?? 0.25;
  const ttlMs = opts.ttlMs ?? 1500;

  let seq = 0;
  let tracks: InternalTrack[] = [];

  // BBox PREDITA p/ o gate de associação: última observada + velocidade × dt
  // (dt limitado ao TTL — além disso o track morre de qualquer forma).
  function predictBBox(t: InternalTrack, now: number): NormBBox {
    const dt = Math.min(Math.max(0, now - t.lastSeen), ttlMs);
    return [t.bbox[0] + t.vx * dt, t.bbox[1] + t.vy * dt, t.bbox[2], t.bbox[3]];
  }

  // Aplica a observação `d` ao track: atualiza velocidade (delta / dt) e posição OBSERVADA.
  function applyObservation(t: InternalTrack, d: TrackerDet, now: number): void {
    const dt = now - t.lastSeen;
    if (dt > 0) {
      t.vx = (d.bbox[0] - t.bbox[0]) / dt;
      t.vy = (d.bbox[1] - t.bbox[1]) / dt;
    }
    t.bbox = [d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]];
    t.cx = d.bbox[0] + d.bbox[2] / 2;
    t.cy = d.bbox[1] + d.bbox[3] / 2;
    t.foot = { x: clamp01(t.cx), y: clamp01(d.bbox[1] + d.bbox[3]) };
    t.score = d.score;
    t.lastSeen = now;
  }

  function newTrack(d: TrackerDet, now: number): InternalTrack {
    const cx = d.bbox[0] + d.bbox[2] / 2;
    const cy = d.bbox[1] + d.bbox[3] / 2;
    return {
      id: ++seq,
      cx,
      cy,
      foot: { x: clamp01(cx), y: clamp01(d.bbox[1] + d.bbox[3]) },
      bbox: [d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]],
      score: d.score,
      firstSeen: now,
      lastSeen: now,
      vx: 0,
      vy: 0,
    };
  }

  function update(
    dets: ReadonlyArray<TrackerDet>,
    now: number,
    highScore = highDefault,
  ): ByteTrack[] {
    const high: number[] = [];
    const low: number[] = [];
    for (let i = 0; i < dets.length; i++) (dets[i].score >= highScore ? high : low).push(i);

    const pred = tracks.map((t) => predictBBox(t, now));
    const detUsed = new Set<number>();
    const trkUsed = new Set<number>();

    // Matching GULOSO por IoU: pares (track livre × det livre) com IoU ≥ limiar,
    // atribuídos do maior IoU pro menor. Determinístico (sort estável).
    const associate = (idxs: number[]): void => {
      const pairs: { ti: number; di: number; iou: number }[] = [];
      for (let ti = 0; ti < tracks.length; ti++) {
        if (trkUsed.has(ti)) continue;
        for (const di of idxs) {
          if (detUsed.has(di)) continue;
          const v = iouOf(pred[ti], dets[di].bbox);
          if (v >= iouThr) pairs.push({ ti, di, iou: v });
        }
      }
      pairs.sort((a, b) => b.iou - a.iou);
      for (const p of pairs) {
        if (trkUsed.has(p.ti) || detUsed.has(p.di)) continue;
        trkUsed.add(p.ti);
        detUsed.add(p.di);
        applyObservation(tracks[p.ti], dets[p.di], now);
      }
    };

    associate(high); // 1ª passada: score alto × todos os tracks
    associate(low); // 2ª passada: score baixo RECUPERA os tracks que sobraram

    // Nascimento: SÓ detecção de score alto sem par (baixa sem par é descartada).
    for (const di of high) if (!detUsed.has(di)) tracks.push(newTrack(dets[di], now));

    // Morte por TTL (tracks sem par ficam com a última posição OBSERVADA até morrer).
    tracks = tracks.filter((t) => now - t.lastSeen <= ttlMs);
    return tracks;
  }

  return {
    update,
    tracks: () => tracks.slice(),
    reset: () => {
      tracks = [];
    },
  };
}
