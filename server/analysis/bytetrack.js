// ─────────────────────────────────────────────────────────────────────────────
// bytetrack.js — PORT de src/vision/bytetrack.ts + EXTENSÕES server-side
// (re-associação 2º estágio e política LOST — marcadas abaixo; re-portar ao TS é
// pendência declarada). Mudanças no NÚCLEO portado devem ser feitas LÁ e
// re-portadas; os testes (bytetrack.test.js) garantem a paridade do núcleo.
// CommonJS, JS puro, SEM dependências. Em cena ESTÁVEL (match toda rodada) o
// comportamento é idêntico ao port original; as extensões só agem em salto/gap.
// Em produção o engine injeta os knobs do painel (precision.js).
//
// ByteTrack-lite (Zhang et al. 2022), reduzido ao nosso caso:
//   • 1ª PASSADA: detecções de score ALTO (≥ highScore) associam com os tracks
//     ativos por IoU (matching guloso, melhor IoU primeiro).
//   • 2ª PASSADA: detecções de score BAIXO (< highScore) recuperam tracks que
//     ficaram SEM par na 1ª passada. Score baixo SUSTENTA um track existente;
//     NUNCA cria track novo (nascimento exige score alto).
//   • PREDIÇÃO LINEAR dt-AWARE: o gate de associação usa a posição PREDITA do
//     track (delta das 2 últimas OBSERVAÇÕES em unid/ms, escalado pelo dt REAL
//     desde lastSeen) — id sobrevive a rodadas lentas/gate/probe (dt variável).
//   • RE-ASSOCIAÇÃO 2º ESTÁGIO (EXTENSÃO do port — ainda não existe no TS de
//     origem; re-portar é pendência declarada): det ALTA sem par por IoU tenta
//     casar com track sem par pela DISTÂNCIA do centro da det ao centro PREVISTO
//     (raio = reassocDist + |v|·gap; gap ≤ reassocMaxGapMs; tamanho compatível).
//     Recupera a identidade quando a fonte/gate SALTA (gap entre rodadas
//     analisadas). ANTI-TROCA: só re-associa par INEQUÍVOCO (1 track ↔ 1 det
//     plausível); qualquer ambiguidade → id novo, NUNCA troca de pessoa.
//   • MORTE POR TTL: track sem associação por mais que ttlMs é removido.
//   • POLÍTICA LOST (EXTENSÃO, idem): track sem match há > lostAfterMisses
//     rodadas ANALISADAS vira LOST — segue vivo INTERNAMENTE (re-associável até
//     o TTL) mas FORA do retorno de update(): não vira overlay/ocupação/contagem
//     (mata o RASTRO de máscaras congeladas até o TTL — bug de campo). Se
//     re-associar, volta a ser emitido com o MESMO id. A graça (misses ≤
//     lostAfterMisses) só vale p/ OCLUSÃO: em rodada de REALOCAÇÃO (nasceu track
//     novo OU o 2º estágio re-associou) o sem-match NÃO é emitido — a det da
//     pessoa foi p/ outro lugar; emitir o congelado é o próprio rastro.
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
// API (superset do TS — stats() é extensão):
//   createByteTracker(opts?) → { update(dets, now, highScore?) → Track[],
//                                tracks() → Track[], reset(), stats() }
//   update() retorna os tracks EMITÍVEIS (ativos + oclusão em graça ≤
//   lostAfterMisses); tracks() é o snapshot INTERNO (inclui LOST ocultos).
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
 * @param {{ highScore?: number, iouThreshold?: number, ttlMs?: number, birthIouThreshold?: number,
 *           reassocDist?: number, reassocMaxGapMs?: number, lostAfterMisses?: number }} [opts]
 *   highScore: score mínimo da 1ª passada e p/ NASCER track (default 0.4).
 *   iouThreshold: IoU mínimo p/ associar detecção×track, contra a bbox predita (default 0.25).
 *   ttlMs: morte — track sem associação por mais que isso, em ms (default 1500).
 *   birthIouThreshold: GUARDA DE NASCIMENTO — det alta sem par com IoU acima disso
 *     contra um track ativo NÃO nasce: atualiza o track livre ou é descartada
 *     (default 0.55, conservador; ver comentário no TS de origem).
 *   reassocDist: FOLGA do raio do 2º estágio (norm.; raio = folga + |v|·gap).
 *     0 desliga o estágio. Default 0.12 — dono do default de produção: precision.js.
 *   reassocMaxGapMs: gap máximo desde lastSeen p/ tentar o 2º estágio (default 2500).
 *   lostAfterMisses: rodadas sem match antes do track sair da EMISSÃO (default 1 =
 *     1 rodada de graça; vive internamente até o TTL p/ re-associação).
 */
function createByteTracker(opts = {}) {
  const highDefault = opts.highScore ?? 0.4;
  const iouThr = opts.iouThreshold ?? 0.25;
  const ttlMs = opts.ttlMs ?? 1500;
  const birthIouThr = opts.birthIouThreshold ?? 0.55;
  const reassocDist = opts.reassocDist ?? 0.12;
  const reassocMaxGapMs = opts.reassocMaxGapMs ?? 2500;
  const lostAfterMisses = opts.lostAfterMisses ?? 1;

  let seq = 0;
  let tracks = [];
  let reassociations = 0; // acumulado de re-associações do 2º estágio (sensor: telemetry)

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
    t.misses = 0; // matcheado nesta rodada → volta (ou permanece) na emissão
  }

  // Tamanho compatível p/ o 2º estágio: nenhuma dimensão dobra/cai à metade entre
  // duas observações próximas no tempo — pessoa não muda de escala tão rápido;
  // det de escala muito diferente perto da posição prevista é OUTRA coisa.
  function sizeCompatible(a, b) {
    const rw = a[2] >= b[2] ? a[2] / b[2] : b[2] / a[2];
    const rh = a[3] >= b[3] ? a[3] / b[3] : b[3] / a[3];
    return rw <= 2 && rh <= 2;
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
      misses: 0, // rodadas ANALISADAS consecutivas sem match (base da política LOST)
    };
  }

  /**
   * Chamar 1x por RODADA DE DETECÇÃO (não por frame de vídeo). `highScore`
   * opcional sobrepõe o da criação. Retorna os tracks EMITÍVEIS: matcheados +
   * oclusos em graça (misses ≤ lostAfterMisses, fora de rodada de realocação).
   * LOST ficam internos (tracks()) até o TTL — política de emissão no header.
   */
  function update(dets, now, highScore = highDefault) {
    const high = [];
    const low = [];
    for (let i = 0; i < dets.length; i++) (dets[i].score >= highScore ? high : low).push(i);

    const pred = tracks.map((t) => predictBBox(t, now));
    const detUsed = new Set();
    const trkUsed = new Set();
    // Rodada de REALOCAÇÃO (nascimento ou re-associação): suprime a graça de
    // emissão dos sem-match — ver política LOST no header.
    let relocated = false;

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

    // 2º ESTÁGIO — RE-ASSOCIAÇÃO POR DISTÂNCIA (salto de fonte/gate/probe): quando
    // o gap entre rodadas analisadas cresce, a predição erra mais que o próprio
    // bbox e o IoU zera — a MESMA pessoa viraria id novo a cada salto. Det ALTA sem
    // par tenta então o track sem par (inclusive LOST) pela distância do centro da
    // det ao centro PREVISTO; o raio cresce com a incerteza da extrapolação
    // (|v|·gap) + folga fixa (reassocDist). Gates: gap ≤ reassocMaxGapMs (salto
    // extremo/oclusão longa → id novo, aceito) e tamanho de bbox compatível.
    // ANTI-TROCA: só casa par INEQUÍVOCO — det com exatamente 1 track plausível E
    // track com exatamente 1 det plausível; ambiguidade → id novo, nunca troca de
    // pessoa (mesma classe de risco declarado do "sem re-ID por aparência").
    if (reassocDist > 0) {
      const cand = [];
      const perTrack = new Map(); // ti → nº de dets plausíveis
      const perDet = new Map(); // di → nº de tracks plausíveis
      for (let ti = 0; ti < tracks.length; ti++) {
        if (trkUsed.has(ti)) continue;
        const t = tracks[ti];
        const gap = now - t.lastSeen;
        if (gap <= 0 || gap > reassocMaxGapMs) continue;
        const radius = reassocDist + Math.hypot(t.vx, t.vy) * gap;
        const pcx = pred[ti][0] + pred[ti][2] / 2;
        const pcy = pred[ti][1] + pred[ti][3] / 2;
        for (const di of high) {
          if (detUsed.has(di)) continue;
          const d = dets[di];
          const dcx = d.bbox[0] + d.bbox[2] / 2;
          const dcy = d.bbox[1] + d.bbox[3] / 2;
          if (Math.hypot(dcx - pcx, dcy - pcy) > radius) continue;
          if (!sizeCompatible(t.bbox, d.bbox)) continue;
          cand.push({ ti, di });
          perTrack.set(ti, (perTrack.get(ti) || 0) + 1);
          perDet.set(di, (perDet.get(di) || 0) + 1);
        }
      }
      for (const c of cand) {
        if (perTrack.get(c.ti) !== 1 || perDet.get(c.di) !== 1) continue; // ambíguo → não re-associa
        trkUsed.add(c.ti);
        detUsed.add(c.di);
        applyObservation(tracks[c.ti], dets[c.di], now); // v vira o deslocamento REAL do gap (dt-aware)
        reassociations += 1;
        relocated = true;
      }
    }

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
      relocated = true;
    }

    // Contabiliza rodadas ANALISADAS sem match (matcheado zera em applyObservation/
    // newTrack). Base em RODADAS, não tempo: robusto ao dt variável do gate/probe.
    for (let ti = 0; ti < tracks.length; ti++) if (!trkUsed.has(ti)) tracks[ti].misses += 1;

    // Morte por TTL (tracks sem par ficam com a última posição OBSERVADA até morrer).
    tracks = tracks.filter((t) => now - t.lastSeen <= ttlMs);
    // POLÍTICA DE EMISSÃO (anti-rastro):
    //   • LOST (misses > lostAfterMisses) fica FORA do retorno — vive internamente
    //     (tracks()/2º estágio) até o TTL, sem alimentar overlay/ocupação/contagem.
    //   • GRAÇA (0 < misses ≤ lostAfterMisses): emitido p/ oclusão/miss de 1 rodada
    //     não piscar overlay/zona (recall a 2fps é intermitente)…
    //   • …EXCETO em rodada de REALOCAÇÃO (nascimento/re-associação): a det da
    //     pessoa foi p/ outro lugar — o sem-match congelado é o próprio rastro.
    //     Custo declarado: pessoa A oclusa na exata rodada em que B entra pisca 1
    //     rodada (raro; barato perto do rastro de até TTL por salto).
    return tracks.filter((t) => t.misses === 0 || (!relocated && t.misses <= lostAfterMisses));
  }

  return {
    update,
    /** Snapshot INTERNO dos tracks vivos (inclui LOST ocultos da emissão). */
    tracks: () => tracks.slice(),
    /** Descarta todos os tracks (não reseta a sequência de ids nem o acumulado de stats). */
    reset: () => {
      tracks = [];
    },
    /** Sensores da política anti-rastro: re-associações acumuladas + LOST ocultos agora. */
    stats: () => ({
      reassociations,
      lost: tracks.reduce((n, t) => n + (t.misses > lostAfterMisses ? 1 : 0), 0),
    }),
  };
}

module.exports = { createByteTracker, iouOf };
