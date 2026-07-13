// ─────────────────────────────────────────────────────────────────────────────
// bytetrack.js — tracker do HUB. Espelho de PAR com src/vision/bytetrack.ts:
// mesma política, mesmos knobs, mesma semântica de emissão. Mudança de
// comportamento é feita nos DOIS arquivos, no MESMO PR — sem source-of-truth
// unilateral: o núcleo ByteTrack-lite nasceu no TS (Onda 2); as extensões
// (re-associação 2º estágio + política LOST + guarda de nascimento) nasceram AQUI
// no hub e JÁ foram portadas ao TS (f1ad355). PARIDADE: bytetrack.test.js cobre o
// comportamento DESTE lado; NÃO há teste cross-language TS↔JS (residual honesto —
// paridade mantida por revisão em par, não por sensor). CommonJS, JS puro, SEM
// dependências. Em produção o engine injeta os knobs do painel (precision.js).
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
//   • HIPÓTESE DE PARADA (F3 — spec-tracking-pessoa-parada §2 C2): depois das duas
//     passadas por posição PREDITA, as MESMAS duas passadas rodam de novo contra a
//     última bbox OBSERVADA (a "caixa congelada"). Motivo medido: com o gate de
//     movimento, entre dois probes há 6s — extrapolar a velocidade de CAMINHADA por
//     6s joga a predição para longe (o IoU zera) e a pessoa que simplesmente PAROU
//     virava id novo (ou morria, quando a det era fraca: eval/stationary cenário 4).
//     A det em cima da última posição observada é EVIDÊNCIA de que ela parou ali —
//     hipótese observation-centric do OC-SORT. Predição primeiro (quem se move casa
//     por ela); a parada só RECUPERA o que sobrou.
//   • RE-ASSOCIAÇÃO 2º ESTÁGIO (nasceu no hub; espelhada no TS — f1ad355):
//     det ALTA sem par por IoU tenta
//     casar com track sem par pela DISTÂNCIA do centro da det ao centro PREVISTO
//     (raio = reassocDist + |v|·gap; gap ≤ reassocMaxGapMs; tamanho compatível).
//     Recupera a identidade quando a fonte/gate SALTA (gap entre rodadas
//     analisadas). ANTI-TROCA: só re-associa par INEQUÍVOCO (1 track ↔ 1 det
//     plausível); qualquer ambiguidade → id novo, NUNCA troca de pessoa.
//   • ESTADO ESTACIONÁRIO (F3 — a decisão central da spec): "parado" é um ESTADO do
//     track, NÃO morte. Track cuja posição fica ESTÁVEL (centro dentro de
//     stationaryTolerance da âncora) por stationaryEnterRounds observações vira
//     ESTACIONÁRIO: caixa congelada, velocidade ZERO, e a partir daí
//       — o TTL deixa de ser DEATH CLOCK e vira PISO: o probe atrasado/pool saturado
//         não mata mais quem está lá (CA-3);
//       — morre por EVIDÊNCIA **E** relógio: > stationaryMaxMisses rodadas ANALISADAS
//         sem match (rodada PULADA pelo gate não chega aqui, logo não conta como miss —
//         "não vi" ≠ "não estava") **e** ttlMs desde o último match (senão, em cena
//         MOVIMENTADA — gate analisando a 2fps — 4 oclusões seguidas matariam o dwell
//         em 2s, mais cedo que hoje). + teto opcional stationaryMaxMs;
//       — segue EMITIDO enquanto vivo (ausência de movimento é evidência de PRESENÇA:
//         a zona fica OCIOSA — pessoa presente, sem movimento — nunca VAZIA, CA-5);
//       — fica FORA do 2º estágio (re-associação por DISTÂNCIA): ele não se moveu,
//         então pessoa NOVA que aparece no raio NÃO pode herdar seu id (anti-hijack,
//         CA-4 — o custo de id-hijack cresce com a persistência do track).
//     Sai do estado na 1ª observação que se desloca além da tolerância (aí volta ao
//     regime de relógio). Precedentes: Frigate (stationary threshold/interval),
//     OC-SORT (caixa congelada + v=0), Axis (estacionário CONTA como ocupação).
//   • MORTE POR TTL (só tracks MÓVEIS): track sem associação por mais que ttlMs é removido.
//   • POLÍTICA LOST (nasceu no hub; espelhada no TS — f1ad355): track sem match há > lostAfterMisses
//     rodadas ANALISADAS vira LOST — segue vivo INTERNAMENTE (re-associável até
//     o TTL) mas FORA do retorno de update(): não vira overlay/ocupação/contagem
//     (mata o RASTRO de máscaras congeladas até o TTL — bug de campo). Se
//     re-associar, volta a ser emitido com o MESMO id. A graça (misses ≤
//     lostAfterMisses, ou ≤ stationaryMaxMisses p/ ESTACIONÁRIO) só vale p/ OCLUSÃO:
//     em rodada de REALOCAÇÃO (nasceu track novo OU o 2º estágio re-associou) o
//     sem-match é marcado REFUTADO (`ghosted`) e sai da emissão até re-associar — a
//     det da pessoa foi p/ outro lugar; emitir o congelado é o próprio rastro. O
//     `ghosted` é PEGAJOSO (não só na rodada da realocação) porque o estacionário
//     tem graça longa: sem isso, a caixa congelada voltaria ao payload na rodada
//     seguinte ao salto (o rastro do eval:counting "salto extremo 3×").
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
//   lostAfterMisses; ESTACIONÁRIO vivo é sempre emitível); tracks() é o snapshot
//   INTERNO (inclui LOST ocultos).
//   Track: { id, cx, cy, foot:{x,y}, bbox:[x,y,w,h], score, firstSeen, lastSeen,
//            stationary }
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
 *           reassocDist?: number, reassocMaxGapMs?: number, lostAfterMisses?: number,
 *           stationaryTolerance?: number, stationaryEnterRounds?: number,
 *           stationaryMaxMisses?: number, stationaryMaxMs?: number }} [opts]
 *   highScore: score mínimo da 1ª passada e p/ NASCER track (default 0.4).
 *   iouThreshold: IoU mínimo p/ associar detecção×track, contra a bbox predita (default 0.25).
 *   ttlMs: morte por RELÓGIO do track MÓVEL — sem associação por mais que isso, em ms
 *     (default 1500). P/ o ESTACIONÁRIO não mata sozinho: vira PISO da morte por evidência.
 *   birthIouThreshold: GUARDA DE NASCIMENTO — det alta sem par com IoU acima disso
 *     contra um track ativo NÃO nasce: atualiza o track livre ou é descartada
 *     (default 0.55, conservador; ver comentário no TS de origem).
 *   reassocDist: FOLGA do raio do 2º estágio (norm.; raio = folga + |v|·gap).
 *     0 desliga o estágio. Default 0.12 — dono do default de produção: precision.js.
 *   reassocMaxGapMs: gap máximo desde lastSeen p/ tentar o 2º estágio (default 2500).
 *   lostAfterMisses: rodadas sem match antes do track MÓVEL sair da EMISSÃO (default 1 =
 *     1 rodada de graça; vive internamente até o TTL p/ re-associação).
 *   stationaryTolerance: deslocamento máximo do centro (norm.) que ainda é JITTER de bbox,
 *     não movimento — âncora do estado estacionário (default 0.01, o mesmo minMove do counter).
 *   stationaryEnterRounds: observações estáveis consecutivas p/ ENTRAR em estacionário
 *     (default 2 — sob o gate, 2 probes ≈ 12s de imobilidade).
 *   stationaryMaxMisses: MORTE POR EVIDÊNCIA — rodadas ANALISADAS consecutivas sem match
 *     que o estacionário tolera (default 3; a partir da 4ª ele morre, mas só depois de
 *     ttlMs desde o último match — os dois gates juntos). Também é a graça de EMISSÃO dele.
 *   stationaryMaxMs: teto opcional de vida do estacionário, em ms (0 = SEM teto, default).
 */
function createByteTracker(opts = {}) {
  const highDefault = opts.highScore ?? 0.4;
  const iouThr = opts.iouThreshold ?? 0.25;
  const ttlMs = opts.ttlMs ?? 1500;
  const birthIouThr = opts.birthIouThreshold ?? 0.55;
  const reassocDist = opts.reassocDist ?? 0.12;
  const reassocMaxGapMs = opts.reassocMaxGapMs ?? 2500;
  const lostAfterMisses = opts.lostAfterMisses ?? 1;
  // Estado ESTACIONÁRIO (F3) — defaults ESPELHAM precision.js (fonte única do painel).
  const stationaryTol = opts.stationaryTolerance ?? 0.01;
  const stationaryEnterRounds = opts.stationaryEnterRounds ?? 2;
  const stationaryMaxMisses = opts.stationaryMaxMisses ?? 3;
  const stationaryMaxMs = opts.stationaryMaxMs ?? 0;

  let seq = 0;
  let tracks = [];
  let reassociations = 0; // acumulado de re-associações do 2º estágio (sensor: telemetry)

  // BBox PREDITA p/ o gate de associação: última observada + velocidade × dt
  // (dt limitado ao TTL — além disso o track morre de qualquer forma).
  // ESTACIONÁRIO: caixa CONGELADA (v já é 0; explicitar evita que um resíduo de
  // velocidade arraste a predição de quem, por definição, não se move).
  function predictBBox(t, now) {
    if (t.stationary) return [t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]];
    const dt = Math.min(Math.max(0, now - t.lastSeen), ttlMs);
    return [t.bbox[0] + t.vx * dt, t.bbox[1] + t.vy * dt, t.bbox[2], t.bbox[3]];
  }

  // Graça de EMISSÃO/vida sem match: estacionário tolera stationaryMaxMisses rodadas
  // ANALISADAS (morte por evidência); móvel tolera lostAfterMisses (anti-rastro).
  function graceOf(t) {
    return t.stationary ? stationaryMaxMisses : lostAfterMisses;
  }

  // EMITÍVEL? (a política de emissão, num lugar só — ver o bloco no fim de update()).
  // LOST = vivo e NÃO emitível: some do overlay/ocupação/contagem, segue re-associável.
  function emitable(t) {
    return t.misses === 0 || (!t.ghosted && t.misses <= graceOf(t));
  }

  // Aplica a observação `d` ao track: máquina do estado ESTACIONÁRIO + velocidade
  // (delta / dt) + posição OBSERVADA (a reportada é SEMPRE a observada).
  function applyObservation(t, d, now) {
    const dt = now - t.lastSeen;
    const cx = d.bbox[0] + d.bbox[2] / 2;
    const cy = d.bbox[1] + d.bbox[3] / 2;
    // ESTADO ESTACIONÁRIO: a observação ficou dentro da tolerância da ÂNCORA (a posição
    // onde a imobilidade começou)? Comparar com a âncora — e não com a observação
    // anterior — é o que torna o gate tolerante a JITTER de bbox (o inimigo nº 1 segundo
    // o Frigate) sem deixar passar deriva lenta: quem escorrega acumula e estoura a
    // tolerância; quem só treme oscila em volta dela.
    if (Math.hypot(cx - t.anchorX, cy - t.anchorY) <= stationaryTol) {
      t.stillRounds += 1;
      t.vx = 0; // caixa congelada, velocidade zero (OC-SORT)
      t.vy = 0;
      if (!t.stationary && t.stillRounds >= stationaryEnterRounds) {
        t.stationary = true;
        t.stationarySince = now;
      }
    } else {
      if (dt > 0) {
        t.vx = (d.bbox[0] - t.bbox[0]) / dt;
        t.vy = (d.bbox[1] - t.bbox[1]) / dt;
      }
      t.stillRounds = 0; // moveu-se: volta ao regime MÓVEL (TTL de relógio, 2º estágio)
      t.stationary = false;
      t.stationarySince = 0;
      t.anchorX = cx;
      t.anchorY = cy;
    }
    t.bbox = [d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]];
    t.cx = cx;
    t.cy = cy;
    t.foot = { x: clamp01(cx), y: clamp01(d.bbox[1] + d.bbox[3]) };
    t.score = d.score;
    t.lastSeen = now;
    t.misses = 0; // matcheado nesta rodada → volta (ou permanece) na emissão
    t.ghosted = false; // evidência fresca: a refutação por realocação cai
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
      stationary: false, // estado ESTACIONÁRIO (isento de TTL, morre por evidência)
      stationarySince: 0, // quando entrou no estado (base do teto stationaryMaxMs)
      stillRounds: 0, // observações consecutivas dentro da tolerância da âncora
      anchorX: cx, // ÂNCORA da imobilidade (centro de onde ele "parou")
      anchorY: cy,
      ghosted: false, // REFUTADO por realocação: fora da emissão até re-associar
    };
  }

  /**
   * Chamar 1x por RODADA DE DETECÇÃO ANALISADA (não por frame, e não nas rodadas que
   * o gate de movimento PULA — é isso que dá sentido à morte por evidência do
   * estacionário). `highScore` opcional sobrepõe o da criação. Retorna os tracks
   * EMITÍVEIS: matcheados + oclusos em graça (móvel: misses ≤ lostAfterMisses;
   * ESTACIONÁRIO: enquanto vivo) e não REFUTADOS por realocação. LOST ficam internos
   * (tracks()) até morrer — política de emissão no header.
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
    // atribuídos do maior IoU pro menor. Determinístico (sort estável). `boxOf`
    // escolhe a HIPÓTESE de onde o track está: PREDITA (andou) ou CONGELADA (parou).
    const associate = (idxs, boxOf) => {
      const pairs = [];
      for (let ti = 0; ti < tracks.length; ti++) {
        if (trkUsed.has(ti)) continue;
        for (const di of idxs) {
          if (detUsed.has(di)) continue;
          const v = iouOf(boxOf(ti), dets[di].bbox);
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
    const predBox = (ti) => pred[ti];
    const frozenBox = (ti) => tracks[ti].bbox;

    associate(high, predBox); // 1ª passada: score alto × todos os tracks
    associate(low, predBox); // 2ª passada: score baixo RECUPERA os tracks que sobraram
    // HIPÓTESE DE PARADA (F3): o que sobrou tenta casar com a última bbox OBSERVADA.
    // A predição é a hipótese FORTE (roda primeiro — quem se move casa por ela); a
    // parada RECUPERA quem a predição envelhecida jogou longe: a pessoa que parou
    // entre dois probes de 6s tem a det EM CIMA da caixa congelada (IoU ≈ 1) e a
    // predita a 0.3 do frame de distância (IoU 0). Vale nas duas passadas — o caso de
    // campo é justamente a pessoa SENTADA com score fraco (2ª passada).
    associate(high, frozenBox);
    associate(low, frozenBox);

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
    // ANTI-HIJACK (F3): track ESTACIONÁRIO fica FORA deste estágio. Ele NÃO se moveu —
    // uma det ALTA a até `reassocDist` dele é outra pessoa (ou ele próprio, e aí o IoU
    // com a caixa congelada já teria casado). Deixá-lo aqui era o ímã de id-hijack: a
    // pessoa NOVA que entra no raio herdaria o id do parado E arrastaria a caixa dele
    // p/ cima dela — a caixa do parado sumiria justamente por ele estar parado (CA-4).
    if (reassocDist > 0) {
      const cand = [];
      const perTrack = new Map(); // ti → nº de dets plausíveis
      const perDet = new Map(); // di → nº de tracks plausíveis
      for (let ti = 0; ti < tracks.length; ti++) {
        if (trkUsed.has(ti) || tracks[ti].stationary) continue;
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
    // newTrack). Base em RODADAS, não tempo: robusto ao dt variável do gate/probe —
    // e é o que dá sentido à MORTE POR EVIDÊNCIA (rodada PULADA pelo gate não chega
    // aqui: "não vi" nunca vira "não estava"). Sem-match em rodada de REALOCAÇÃO é
    // REFUTADO (`ghosted`): a det da pessoa apareceu em OUTRO lugar; o congelado é o
    // próprio rastro e fica fora da emissão até re-associar (pegajoso — o estacionário
    // tem graça longa e voltaria ao payload na rodada seguinte ao salto).
    for (let ti = 0; ti < tracks.length; ti++) {
      if (trkUsed.has(ti)) continue;
      tracks[ti].misses += 1;
      if (relocated) tracks[ti].ghosted = true;
    }

    // MORTE — duas leis, uma por regime (spec-tracking-pessoa-parada §2 C2):
    //   • MÓVEL: por RELÓGIO (ttlMs desde o último match; a última posição OBSERVADA
    //     fica congelada até morrer).
    //   • ESTACIONÁRIO: por EVIDÊNCIA **E** relógio mínimo — precisa de > M rodadas
    //     ANALISADAS sem match E de ttlMs desde o último match. Os dois juntos porque
    //     cada um sozinho erra: só o RELÓGIO é o bug que a F3 conserta (probe atrasado/
    //     pool saturado mata quem está lá — CA-3: rodada que não rodou não é evidência
    //     de ausência); só a EVIDÊNCIA mataria a pessoa parada em CENA MOVIMENTADA (com
    //     outra gente/empilhadeira em quadro o gate analisa a 2fps, e 4 rodadas de
    //     oclusão = 2s matariam o dwell — MAIS cedo que o TTL de hoje). Somados: nunca
    //     mais cedo que o relógio de hoje, nunca sem evidência. Teto opcional
    //     (stationaryMaxMs) p/ o caso patológico.
    tracks = tracks.filter((t) => {
      if (!t.stationary) return now - t.lastSeen <= ttlMs;
      if (t.misses > stationaryMaxMisses && now - t.lastSeen > ttlMs) return false;
      return !(stationaryMaxMs > 0 && now - t.stationarySince > stationaryMaxMs);
    });
    // POLÍTICA DE EMISSÃO (anti-rastro):
    //   • LOST (misses > graça) fica FORA do retorno — vive internamente
    //     (tracks()/2º estágio) até o TTL, sem alimentar overlay/ocupação/contagem.
    //   • GRAÇA (0 < misses ≤ graceOf): emitido p/ oclusão/miss não piscar overlay/
    //     zona (recall a 2fps é intermitente). Para o ESTACIONÁRIO a graça é a própria
    //     janela de vida (stationaryMaxMisses): enquanto ele não for REFUTADO, a caixa
    //     congelada É a evidência de presença — a zona fica OCIOSA, nunca VAZIA (CA-5).
    //   • …EXCETO se REFUTADO por realocação (`ghosted`): a det da pessoa foi p/ outro
    //     lugar — o sem-match congelado é o próprio rastro. Custo declarado: pessoa A
    //     oclusa na exata rodada em que B entra pisca até re-associar (barato perto do
    //     rastro; e A mantém o id/dwell, que é o que a métrica consome).
    return tracks.filter(emitable);
  }

  return {
    update,
    /** Snapshot INTERNO dos tracks vivos (inclui LOST ocultos da emissão). */
    tracks: () => tracks.slice(),
    /** Descarta todos os tracks (não reseta a sequência de ids nem o acumulado de stats). */
    reset: () => {
      tracks = [];
    },
    /**
     * Sensores da política anti-rastro: re-associações acumuladas + LOST ocultos agora
     * + ESTACIONÁRIOS vivos agora (pessoas presentes e paradas — o que alimenta a
     * leitura de zona OCIOSA; sensor de campo do F3).
     */
    stats: () => ({
      reassociations,
      lost: tracks.reduce((n, t) => n + (emitable(t) ? 0 : 1), 0),
      stationary: tracks.reduce((n, t) => n + (t.stationary ? 1 : 0), 0),
    }),
  };
}

module.exports = { createByteTracker, iouOf };
