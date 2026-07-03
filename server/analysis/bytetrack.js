// ─────────────────────────────────────────────────────────────────────────────
// bytetrack.js — PORT de src/vision/bytetrack.ts — mudanças de comportamento
// devem ser feitas LÁ e re-portadas; os testes (bytetrack.test.js) garantem
// paridade. CommonJS, JS puro, SEM dependências (motor de análise server-side,
// F1 do plano-analise-server-side).
//
// ByteTrack-lite (Zhang et al. 2022), reduzido ao nosso caso:
//   • 1ª PASSADA: detecções de score ALTO (≥ highScore) associam com os tracks
//     ativos por IoU (matching guloso, melhor IoU primeiro).
//   • 2ª PASSADA: detecções de score BAIXO (< highScore) recuperam tracks que
//     ficaram SEM par na 1ª passada. Score baixo SUSTENTA um track existente;
//     NUNCA cria track novo (nascimento exige score alto).
//   • PREDIÇÃO LINEAR: o gate de associação usa a posição PREDITA do track
//     (delta das 2 últimas OBSERVAÇÕES, escalado pelo dt) — id sobrevive a
//     rodadas lentas.
//   • MORTE POR TTL: track sem associação por mais que ttlMs é removido.
//   • GUARDA DE NASCIMENTO (birthIouThreshold, default 0.55): detecção alta sem
//     par que sobrepõe um track ativo além do limiar NÃO nasce — atualiza o track
//     livre (associação recuperada) ou é descartada (duplicata). Evita que UMA
//     pessoa com associação perdida vire DUAS por até ttlMs (bug de campo).
//
// LIMITAÇÃO DECLARADA (sem re-ID por aparência): em cruzamento denso, ids podem
// trocar de pessoa — o tracker segue GEOMETRIA (IoU), não aparência.
//
// COORDENADAS: bbox NORMALIZADA [x,y,w,h] 0..1, origem topo-esquerda — mesmo
// sistema de counting.js/zones.js. O caller converte de pixels e filtra a
// CLASSE ("person") ANTES; o corte por score é deste tracker. A posição
// reportada é sempre a OBSERVADA (a predição serve só ao gate).
//
// API (idêntica ao TS):
//   createByteTracker(opts?) → { update(dets, now, highScore?) → Track[],
//                                tracks() → Track[], reset() }
//   Track: { id, cx, cy, foot:{x,y}, bbox:[x,y,w,h], score, firstSeen, lastSeen }
//   iouOf(a, b) → número 0..1
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

/** IoU de duas bboxes [x,y,w,h] (mesma unidade). 0 quando não há interseção. */
function iouOf(a, b) {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Cria um ByteTracker-lite. Estado encapsulado; determinístico dado o histórico.
 * @param {{ highScore?: number, iouThreshold?: number, ttlMs?: number, birthIouThreshold?: number }} [opts]
 *   highScore: score mínimo da 1ª passada e p/ NASCER track (default 0.4).
 *   iouThreshold: IoU mínimo p/ associar detecção×track, contra a bbox predita (default 0.25).
 *   ttlMs: morte — track sem associação por mais que isso, em ms (default 1500).
 *   birthIouThreshold: GUARDA DE NASCIMENTO — det alta sem par com IoU acima disso
 *     contra um track ativo NÃO nasce: atualiza o track livre ou é descartada
 *     (default 0.55, conservador; ver comentário no TS de origem).
 */
function createByteTracker(opts = {}) {
  const highDefault = opts.highScore ?? 0.4;
  const iouThr = opts.iouThreshold ?? 0.25;
  const ttlMs = opts.ttlMs ?? 1500;
  const birthIouThr = opts.birthIouThreshold ?? 0.55;

  let seq = 0;
  let tracks = [];

  // BBox PREDITA p/ o gate de associação: última observada + velocidade × dt
  // (dt limitado ao TTL — além disso o track morre de qualquer forma).
  function predictBBox(t, now) {
    const dt = Math.min(Math.max(0, now - t.lastSeen), ttlMs);
    return [t.bbox[0] + t.vx * dt, t.bbox[1] + t.vy * dt, t.bbox[2], t.bbox[3]];
  }

  // Aplica a observação `d` ao track: atualiza velocidade (delta / dt) e posição OBSERVADA.
  function applyObservation(t, d, now) {
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

  function newTrack(d, now) {
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

  /**
   * Chamar 1x por RODADA DE DETECÇÃO (não por frame de vídeo). `highScore`
   * opcional sobrepõe o da criação. Retorna os tracks ativos (inclui os em
   * oclusão dentro do TTL).
   */
  function update(dets, now, highScore = highDefault) {
    const high = [];
    const low = [];
    for (let i = 0; i < dets.length; i++) (dets[i].score >= highScore ? high : low).push(i);

    const pred = tracks.map((t) => predictBBox(t, now));
    const detUsed = new Set();
    const trkUsed = new Set();

    // Matching GULOSO por IoU: pares (track livre × det livre) com IoU ≥ limiar,
    // atribuídos do maior IoU pro menor. Determinístico (sort estável).
    const associate = (idxs) => {
      const pairs = [];
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
    // GUARDA DE NASCIMENTO (birthIouThr): detecção sem par que sobrepõe demais um
    // track existente NÃO vira track novo — a pessoa é a mesma. Compara com a bbox
    // OBSERVADA e com a PREDITA (a associação falha justamente quando a predição
    // fugiu da observação; qualquer uma das duas acusa "mesma pessoa"). Track
    // sobreposto LIVRE → recupera a associação (atualiza); ocupado (inclusive
    // recém-nascido nesta rodada) → duplicata, descarta.
    for (const di of high) {
      if (detUsed.has(di)) continue;
      const d = dets[di];
      let bestTi = -1;
      let bestV = birthIouThr;
      for (let ti = 0; ti < tracks.length; ti++) {
        const v = Math.max(
          iouOf(tracks[ti].bbox, d.bbox),
          ti < pred.length ? iouOf(pred[ti], d.bbox) : 0,
        );
        if (v > bestV) {
          bestV = v;
          bestTi = ti;
        }
      }
      if (bestTi >= 0) {
        if (!trkUsed.has(bestTi)) {
          trkUsed.add(bestTi);
          applyObservation(tracks[bestTi], d, now);
        }
        continue; // track já pareado nesta rodada → detecção duplicada, descartada
      }
      tracks.push(newTrack(d, now));
      trkUsed.add(tracks.length - 1); // recém-nascido conta como "ocupado" p/ as próximas dets
    }

    // Morte por TTL (tracks sem par ficam com a última posição OBSERVADA até morrer).
    tracks = tracks.filter((t) => now - t.lastSeen <= ttlMs);
    return tracks;
  }

  return {
    update,
    /** Snapshot dos tracks ativos (sem avançar o estado). */
    tracks: () => tracks.slice(),
    /** Descarta todos os tracks (não reseta a sequência de ids). */
    reset: () => {
      tracks = [];
    },
  };
}

module.exports = { createByteTracker, iouOf };
