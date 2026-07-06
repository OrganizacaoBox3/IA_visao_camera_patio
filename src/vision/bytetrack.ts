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
//   • PREDIÇÃO LINEAR dt-AWARE: o gate de associação usa a posição PREDITA do
//     track (delta das 2 últimas OBSERVAÇÕES, escalado pelo dt REAL desde a
//     última observação). Em rodadas lentas (perfil LR full: ~0,5–1,3s) o
//     deslocamento real quebra o IoU com a última bbox observada; a predição o
//     recupera e o id sobrevive.
//   • RE-ASSOCIAÇÃO 2º ESTÁGIO: stream que SALTA (stall/gap) desloca o alvo além
//     de qualquer IoU — as caixas nem se tocam. Detecção ALTA sem par por IoU
//     tenta casar com track sem par pela DISTÂNCIA do centro da det ao centro
//     PREVISTO (raio = reassocDist + |v|·gap; gap ≤ reassocMaxGapMs; tamanho
//     compatível). ANTI-TROCA: só re-associa par INEQUÍVOCO (1 track ↔ 1 det
//     plausível); qualquer ambiguidade → id novo, NUNCA troca de pessoa.
//   • MORTE POR TTL: track sem associação por mais que ttlMs é removido.
//   • POLÍTICA LOST: track sem match há > lostAfterMisses rodadas ANALISADAS vira
//     LOST — segue vivo INTERNAMENTE (re-associável até o TTL) mas FORA do
//     retorno de update(): não vira desenho/ocupação/contagem (mata o RASTRO de
//     caixas congeladas até o TTL — bug de campo). Se re-associar, volta a ser
//     emitido com o MESMO id.
//   • GUARDA DE NASCIMENTO (birthIouThreshold, default 0.55): detecção alta sem
//     par que sobrepõe um track ativo além do limiar NÃO nasce — atualiza o track
//     livre (associação recuperada) ou é descartada (duplicata). Evita que UMA
//     pessoa com associação perdida vire DUAS por até ttlMs (bug de campo).
//
// PARIDADE HUB↔FRONT (doutrina): a POLÍTICA deste arquivo espelha
// server/analysis/bytetrack.js (F1) — mesmos knobs, mesmos defaults, mesma
// semântica de emissão. Mudança de comportamento é feita em PAR. Diferença
// declarada: o hub expõe stats() (telemetria de re-associações) — extensão
// server-only, fora do contrato espelhado.
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
  /**
   * GUARDA DE NASCIMENTO (bug de campo "2 pessoas onde há 1"): detecção alta SEM
   * par que sobrepõe um track ativo além disso NÃO nasce — a pessoa é a MESMA, a
   * associação é que falhou (predição ruim) ou a detecção é duplicata. Se o track
   * sobreposto está LIVRE nesta rodada, a detecção o ATUALIZA (recupera a
   * associação); se já foi pareado, a detecção é DESCARTADA (caixa duplicada).
   * Default 0.55 — CONSERVADOR de propósito: duas pessoas realmente próximas
   * ficam bem abaixo disso (lado a lado IoU ≈ 0.2–0.3); só sobreposição de "mesma
   * pessoa" passa de 0.55. Trade-off declarado: em oclusão QUASE total (IoU>0.55
   * entre duas pessoas reais), a segunda só nasce quando se separarem.
   */
  birthIouThreshold?: number;
  /**
   * RE-ASSOCIAÇÃO 2º ESTÁGIO (bug de campo "stream salta"): FOLGA do raio de
   * aceitação (norm.; raio = folga + |v|·gap) p/ casar detecção ALTA sem par por
   * IoU a um track sem par pela distância do centro da det ao centro PREVISTO —
   * o salto zera o IoU (as caixas nem se tocam), mas a distância curta + tamanho
   * compatível + par INEQUÍVOCO (1 track ↔ 1 det plausível) acusam "mesma
   * pessoa". Qualquer ambiguidade → id novo, NUNCA troca de pessoa. 0 desliga o
   * estágio. Default 0.12 — folga apertada de propósito: o termo |v|·gap já
   * cobre o deslocamento plausível de quem se move; a folga só absorve o erro de
   * predição. Trade-off declarado (sem re-ID por aparência): pessoa nova surgindo
   * dentro do raio de um track sumido pode herdar o id — mitigado por raio
   * apertado + inequívoco + tamanho compatível.
   */
  reassocDist?: number;
  /** Gap máximo desde lastSeen p/ tentar o 2º estágio (ms). Default 2500. */
  reassocMaxGapMs?: number;
  /**
   * POLÍTICA LOST (bug de campo "rastro de caixas até o TTL"): rodadas ANALISADAS
   * sem match antes do track sair da EMISSÃO (some do desenho/ocupação/contagem);
   * vive internamente até o ttlMs p/ re-associação com o MESMO id. Default 1 =
   * 1 rodada de GRAÇA: flicker de 1 rodada do detector é comum — segurar a caixa
   * 1 rodada evita presença/ocupação piscando; na falta seguinte o rastro some.
   */
  lostAfterMisses?: number;
};

export type ByteTracker = {
  /**
   * Chamar 1x por RODADA DE DETECÇÃO (não por frame de vídeo: realimentar o
   * mesmo resultado stale zeraria a velocidade e mataria a predição).
   * `highScore` opcional sobrepõe o da criação (perfil longo alcance em runtime).
   * Retorna SÓ os tracks EMITÍVEIS (ativos + oclusão em graça ≤ lostAfterMisses;
   * a graça é SUSPENSA em rodada de realocação — ver política de emissão no corpo);
   * tracks LOST vivem internamente até o TTL, invisíveis ao consumidor — quem
   * desenha/conta ocupação não precisa filtrar nada.
   */
  update: (dets: ReadonlyArray<TrackerDet>, now: number, highScore?: number) => ByteTrack[];
  /** Snapshot INTERNO (inclui LOST ocultos; a emissão é o retorno de update()). */
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
  /** Rodadas ANALISADAS consecutivas sem par. > lostAfterMisses ⇒ LOST (vivo, não emitido). */
  misses: number;
};

/** Cria um ByteTracker-lite. Estado encapsulado; determinístico dado o histórico. */
export function createByteTracker(opts: ByteTrackerOptions = {}): ByteTracker {
  const highDefault = opts.highScore ?? 0.4;
  const iouThr = opts.iouThreshold ?? 0.25;
  const ttlMs = opts.ttlMs ?? 1500;
  const birthIouThr = opts.birthIouThreshold ?? 0.55;
  const reassocDist = opts.reassocDist ?? 0.12;
  const reassocMaxGapMs = opts.reassocMaxGapMs ?? 2500;
  const lostAfterMisses = opts.lostAfterMisses ?? 1;

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
    t.misses = 0; // observação zera a contagem — LOST re-identificado volta a ser emitido
  }

  // Tamanho compatível p/ o 2º estágio: nenhuma dimensão dobra/cai à metade entre
  // duas observações próximas no tempo — pessoa não muda de escala tão rápido;
  // det de escala muito diferente perto da posição prevista é OUTRA coisa.
  function sizeCompatible(
    a: readonly [number, number, number, number],
    b: readonly [number, number, number, number],
  ): boolean {
    const rw = a[2] >= b[2] ? a[2] / b[2] : b[2] / a[2];
    const rh = a[3] >= b[3] ? a[3] / b[3] : b[3] / a[3];
    return rw <= 2 && rh <= 2;
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
      misses: 0,
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
    let relocated = false; // rodada teve NASCIMENTO ou RE-ASSOCIAÇÃO (ver política de emissão)

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

    // 2º ESTÁGIO — RE-ASSOCIAÇÃO POR DISTÂNCIA (salto de fonte/stall): quando o gap entre
    // rodadas analisadas cresce, a predição erra mais que o próprio bbox e o IoU zera — a
    // MESMA pessoa viraria id novo a cada salto. Det ALTA sem par tenta então o track sem
    // par (inclusive LOST) pela distância do centro da det ao centro PREVISTO; o raio
    // cresce com a incerteza da extrapolação (|v|·gap) + folga fixa (reassocDist). Gates:
    // gap ≤ reassocMaxGapMs (salto extremo/oclusão longa → id novo, aceito) e tamanho de
    // bbox compatível. ANTI-TROCA: só casa par INEQUÍVOCO — det com exatamente 1 track
    // plausível E track com exatamente 1 det plausível; ambiguidade → id novo, nunca troca
    // de pessoa (mesma classe de risco declarado do "sem re-ID por aparência").
    if (reassocDist > 0) {
      const cand: { ti: number; di: number }[] = [];
      const perTrack = new Map<number, number>(); // ti → nº de dets plausíveis
      const perDet = new Map<number, number>(); // di → nº de tracks plausíveis
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
    // newTrack). Base em RODADAS, não tempo: robusto ao dt variável entre rodadas.
    for (let ti = 0; ti < tracks.length; ti++) if (!trkUsed.has(ti)) tracks[ti].misses += 1;

    // Morte por TTL (tracks sem par ficam com a última posição OBSERVADA até morrer).
    tracks = tracks.filter((t) => now - t.lastSeen <= ttlMs);
    // POLÍTICA DE EMISSÃO (anti-rastro):
    //   • LOST (misses > lostAfterMisses) fica FORA do retorno — vive internamente
    //     (tracks()/2º estágio) até o TTL, sem alimentar desenho/ocupação/contagem.
    //   • GRAÇA (0 < misses ≤ lostAfterMisses): emitido p/ oclusão/miss de 1 rodada
    //     não piscar overlay/presença (recall do detector é intermitente)…
    //   • …EXCETO em rodada de REALOCAÇÃO (nascimento/re-associação): a det da
    //     pessoa foi p/ outro lugar — o sem-match congelado é o próprio rastro.
    //     Custo declarado: pessoa A oclusa na exata rodada em que B entra pisca 1
    //     rodada (raro; barato perto do rastro de até TTL por salto).
    return tracks.filter((t) => t.misses === 0 || (!relocated && t.misses <= lostAfterMisses));
  }

  return {
    update,
    tracks: () => tracks.slice(),
    reset: () => {
      tracks = [];
    },
  };
}
