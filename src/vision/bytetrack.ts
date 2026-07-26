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
//   • HIPÓTESE DE PARADA (F3 — spec-tracking-pessoa-parada §2 C2): depois das duas
//     passadas contra a posição PREDITA, as MESMAS duas rodam contra a última bbox
//     OBSERVADA (a caixa CONGELADA). A predição é a hipótese forte (quem anda casa
//     por ela); a parada RECUPERA quem ela jogou longe — extrapolar velocidade de
//     CAMINHADA por uma rodada lenta/gap zera o IoU e a pessoa que simplesmente PAROU
//     virava id novo (ou morria, com det fraca). Det em cima da caixa congelada é
//     EVIDÊNCIA de que ela parou ali (hipótese observation-centric do OC-SORT).
//   • RE-ASSOCIAÇÃO 2º ESTÁGIO: stream que SALTA (stall/gap) desloca o alvo além
//     de qualquer IoU — as caixas nem se tocam. Detecção ALTA sem par por IoU
//     tenta casar com track sem par pela DISTÂNCIA do centro da det ao centro
//     PREVISTO (raio = reassocDist + |v|·gap; gap ≤ reassocMaxGapMs; tamanho
//     compatível). ANTI-TROCA: só re-associa par INEQUÍVOCO (1 track ↔ 1 det
//     plausível); qualquer ambiguidade → id novo, NUNCA troca de pessoa.
//   • ESTADO ESTACIONÁRIO (F3 — a decisão central da spec): "parado" é um ESTADO do
//     track, NÃO morte. Posição estável (centro dentro de stationaryTolerance da
//     ÂNCORA) por stationaryEnterRounds observações ⇒ ESTACIONÁRIO: caixa congelada,
//     velocidade ZERO, o TTL vira PISO (não mata sozinho) e a morte passa a exigir
//     EVIDÊNCIA (> stationaryMaxMisses rodadas ANALISADAS sem match — rodada não
//     analisada não conta como miss) E o relógio; segue EMITIDO na graça (ausência de movimento é evidência
//     de PRESENÇA: a zona fica OCIOSA, nunca VAZIA) e fica FORA do 2º estágio
//     (anti-hijack: ele não se moveu, pessoa NOVA no raio não herda seu id). Sai do
//     estado na 1ª observação que se desloca além da tolerância. Precedentes: Frigate
//     (stationary threshold/interval), OC-SORT (caixa congelada + v=0), Axis.
//   • MORTE POR TTL (só tracks MÓVEIS): track sem associação por mais que ttlMs é removido.
//   • POLÍTICA LOST: track sem match há > graça (lostAfterMisses; ESTACIONÁRIO:
//     stationaryMaxMisses) rodadas ANALISADAS vira LOST — segue vivo INTERNAMENTE
//     (re-associável até morrer) mas FORA do retorno de update(): não vira desenho/
//     ocupação/contagem (mata o RASTRO de caixas congeladas até o TTL — bug de campo).
//     Sem-match REFUTADO por uma REALOCAÇÃO (`ghosted`) sai da emissão até re-associar:
//     a det da pessoa foi p/ outro lugar, o congelado é o próprio rastro. A refutação é
//     LOCAL — só alcança quem está a até `refuteMaxDist` da realocação (antes era GLOBAL e
//     apagava quem só piscou do outro lado do quadro; detalhe e medição no bloco de
//     REFUTAÇÃO em update()). Se re-associar, volta com o MESMO id.
//   • GUARDA DE NASCIMENTO (birthIouThreshold, default 0.55): detecção alta sem
//     par que sobrepõe um track ativo além do limiar NÃO nasce — atualiza o track
//     livre (associação recuperada) ou é descartada (duplicata). Evita que UMA
//     pessoa com associação perdida vire DUAS por até ttlMs (bug de campo).
//
// PARIDADE HUB↔FRONT (doutrina): a POLÍTICA deste arquivo espelha
// server/analysis/bytetrack.js — mesmos knobs, mesmos defaults, mesma semântica
// de emissão. Mudança de comportamento é feita em PAR (mesmo PR); NÃO há teste
// cross-language TS↔JS — a paridade é mantida por revisão em par (residual, não
// sensor). stats() (telemetria: re-associações/LOST/parados/vivos) era extensão
// server-only e passou a existir dos DOIS lados (CT-4) — mesma forma, mesmo contrato.
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
  /** ESTACIONÁRIO: presente e PARADO (caixa congelada). Zona com ele = OCIOSA, não vazia. */
  stationary: boolean;
};

export type ByteTrackerOptions = {
  /** Score mínimo da 1ª passada e p/ NASCER track. Default 0.4 (people.scoreThreshold). */
  highScore?: number;
  /** IoU mínimo p/ associar detecção×track (contra a bbox predita). Default 0.25. */
  iouThreshold?: number;
  /**
   * Morte por RELÓGIO do track MÓVEL: sem associação por mais que isso (ms). Default
   * 1500. O ESTACIONÁRIO é ISENTO — ele morre por EVIDÊNCIA (stationaryMaxMisses).
   */
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
   * GUARDA DE NASCIMENTO POR CONTENÇÃO (bug de campo "2 caixas na MESMA pessoa", 2026-07-25):
   * o detector (D-FINE/coco) emite query duplicada como caixa PARCIAL (cabeça/torso) DENTRO
   * da caixa inteira — IoU ~0.1-0.3 passa pelo birthIouThreshold (que mede sobreposição) e
   * nascia um 2º track na mesma pessoa. Det alta sem par cuja CONTENÇÃO (interseção/área da
   * caixa MENOR) com um track (observado OU predito) ≥ isto NÃO nasce: track livre →
   * atualiza (recupera, inclusive corrigindo caixa parcial que virou track); ocupado →
   * descarta (duplicata). SÓ avaliado contra track FRESCO (misses 0 — visto na última
   * rodada analisada): duplicata é fenômeno de cena fresca; track em miss + escala muito
   * diferente é o caso do 2º estágio ("escala não muda tão rápido" → id novo, contrato
   * testado). POR QUE AQUI e não no NMS do detector: MEDIDO no gate — contenção no NMS
   * derruba recall_all 4,4pp (pessoa parcialmente contida em cena densa é gente REAL). No
   * nascimento o custo é só ADIAR o track novo de quem está ≥70% contido em outro (oclusão
   * profunda) até se separar — mesma classe de trade-off já declarada do birthIouThreshold.
   * 0.7 espelha o containment do dedupe de tiling. 0 desliga.
   * Default 0.7. SENSOR: bytetrack.test.(ts|js) + eval:counting.
   */
  birthContainment?: number;
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
  /**
   * TETO de plausibilidade da REFUTAÇÃO por realocação (norm.). O critério principal é RELATIVO
   * (só o track mais PRÓXIMO da realocação é refutado); este teto corta o caso degenerado de
   * poucos tracks vivos, onde "o mais próximo" pode estar do outro lado do quadro. 0 desliga o
   * teto (só o critério relativo). Default 0.6 — dono do valor de produção: precision.js.
   */
  refuteMaxDist?: number;
  /**
   * ESTADO ESTACIONÁRIO (F3) — deslocamento máximo do centro (norm.) que ainda é
   * JITTER de bbox, e não movimento. Medido contra a ÂNCORA (onde a imobilidade
   * começou), não contra a observação anterior: quem TREME oscila em volta dela; quem
   * DERIVA acumula e estoura a tolerância. Default 0.01 = o mesmo minMove do counter
   * (a MESMA noção de micro-jitter — um número, dois consumidores). Apertar demais
   * é FAIL-SAFE: o track só não entra no estado (volta ao regime de relógio de hoje).
   */
  stationaryTolerance?: number;
  /**
   * Observações ESTÁVEIS consecutivas p/ ENTRAR em estacionário. Default 3 no front
   * (rodada ~350ms → ~1s de imobilidade); o hub usa 2 (sob o gate, 2 probes ≈ 12s —
   * a ordem de grandeza do stationary.threshold do Frigate). NUNCA 1: o track precisa
   * de mais de uma evidência de imobilidade antes de sair do 2º estágio (anti-hijack).
   */
  stationaryEnterRounds?: number;
  /**
   * MORTE POR EVIDÊNCIA: rodadas ANALISADAS consecutivas sem match que o ESTACIONÁRIO
   * tolera (a seguinte mata). Default 3. É também a graça de EMISSÃO dele — enquanto
   * vivo e não refutado, a caixa congelada É a evidência de presença. Subir = mais
   * ghost quando a pessoa some sem ser vista saindo; baixar = a pessoa parada com
   * detector piscando morre e o dwell zera. Sensor: eval/stationary.mjs.
   */
  stationaryMaxMisses?: number;
  /**
   * Teto opcional de vida do estacionário (ms). 0 = SEM teto (default): matar por
   * RELÓGIO um track re-confirmado por evidência a cada probe é exatamente o bug que
   * a F3 conserta (o dwell zeraria no meio do turno). Existe como escape-hatch p/ o
   * caso patológico (det fantasma eternamente re-confirmada — cujo tratamento certo é
   * a auto-máscara/zona de exclusão, não o tracker).
   */
  stationaryMaxMs?: number;
};

export type ByteTracker = {
  /**
   * Chamar 1x por RODADA DE DETECÇÃO (não por frame de vídeo: realimentar o
   * mesmo resultado stale zeraria a velocidade e mataria a predição).
   * `highScore` opcional sobrepõe o da criação (perfil longo alcance em runtime).
   * Chamar SÓ em rodada ANALISADA (é isso que dá sentido à morte por evidência do
   * estacionário). Retorna SÓ os tracks EMITÍVEIS (ativos + oclusão em graça — móvel:
   * ≤ lostAfterMisses; ESTACIONÁRIO: enquanto vivo —, exceto os REFUTADOS por
   * realocação); tracks LOST vivem internamente, invisíveis ao consumidor — quem
   * desenha/conta ocupação não precisa filtrar nada.
   */
  update: (dets: ReadonlyArray<TrackerDet>, now: number, highScore?: number) => ByteTrack[];
  /** Snapshot INTERNO (inclui LOST ocultos; a emissão é o retorno de update()). */
  tracks: () => ByteTrack[];
  /** Descarta todos os tracks (não reseta a sequência de ids nem o acumulado de stats). */
  reset: () => void;
  /**
   * Sensores da política anti-rastro (espelho do hub — CT-4): re-associações
   * ACUMULADAS + LOST ocultos AGORA + ESTACIONÁRIOS vivos AGORA + ALIVE = total de
   * tracks vivos INTERNOS (emitíveis ou não). `alive - stationary` = quantas pessoas o
   * tracker tem em MOVIMENTO agora — quem decide pular rodada usa isso p/ saber se
   * havia gente se movendo quando pulou.
   */
  stats: () => { reassociations: number; lost: number; stationary: number; alive: number };
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

/** CONTENÇÃO: interseção / área da caixa MENOR (0..1) — a mesma conta de nms.ts/fuseTiles.
 *  Local (não importada) de propósito: mantém o port 1:1 com server/analysis/bytetrack.js. */
function containmentOf(
  a: readonly [number, number, number, number],
  b: readonly [number, number, number, number],
): number {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const minArea = Math.min(a[2] * a[3], b[2] * b[3]);
  return minArea > 0 ? (ix * iy) / minArea : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

type InternalTrack = ByteTrack & {
  /** Velocidade (unid. normalizada / ms) do canto do bbox, das 2 últimas observações. */
  vx: number;
  vy: number;
  /** Rodadas ANALISADAS consecutivas sem par. > graça ⇒ LOST (vivo, não emitido). */
  misses: number;
  /** Quando entrou em ESTACIONÁRIO (base do teto stationaryMaxMs). */
  stationarySince: number;
  /** Observações consecutivas dentro da tolerância da âncora (entrada no estado). */
  stillRounds: number;
  /** ÂNCORA da imobilidade: o centro de onde ele "parou" (o jitter oscila em volta dela). */
  anchorX: number;
  anchorY: number;
  /** REFUTADO por realocação (a det da pessoa apareceu em OUTRO lugar): fora da emissão. */
  ghosted: boolean;
};

/** Cria um ByteTracker-lite. Estado encapsulado; determinístico dado o histórico. */
export function createByteTracker(opts: ByteTrackerOptions = {}): ByteTracker {
  const highDefault = opts.highScore ?? 0.4;
  const iouThr = opts.iouThreshold ?? 0.25;
  const ttlMs = opts.ttlMs ?? 1500;
  const birthIouThr = opts.birthIouThreshold ?? 0.55;
  const birthContainment = opts.birthContainment ?? 0.7;
  const reassocDist = opts.reassocDist ?? 0.12;
  const reassocMaxGapMs = opts.reassocMaxGapMs ?? 2500;
  const lostAfterMisses = opts.lostAfterMisses ?? 1;
  const refuteMaxDist = opts.refuteMaxDist ?? 0.6;
  // Estado ESTACIONÁRIO (F3) — defaults ESPELHAM config.people.track (dono dos knobs).
  const stationaryTol = opts.stationaryTolerance ?? 0.01;
  const stationaryEnterRounds = opts.stationaryEnterRounds ?? 3;
  const stationaryMaxMisses = opts.stationaryMaxMisses ?? 3;
  const stationaryMaxMs = opts.stationaryMaxMs ?? 0;

  let seq = 0;
  let tracks: InternalTrack[] = [];
  let reassociations = 0; // acumulado de re-associações do 2º estágio (sensor: stats())

  // BBox PREDITA p/ o gate de associação: última observada + velocidade × dt
  // (dt limitado ao TTL — além disso o track morre de qualquer forma).
  // ESTACIONÁRIO: caixa CONGELADA (v já é 0; explicitar evita que resíduo de
  // velocidade arraste a predição de quem, por definição, não se move).
  function predictBBox(t: InternalTrack, now: number): NormBBox {
    if (t.stationary) return [t.bbox[0], t.bbox[1], t.bbox[2], t.bbox[3]];
    const dt = Math.min(Math.max(0, now - t.lastSeen), ttlMs);
    return [t.bbox[0] + t.vx * dt, t.bbox[1] + t.vy * dt, t.bbox[2], t.bbox[3]];
  }

  // Graça de EMISSÃO/vida sem match: estacionário tolera stationaryMaxMisses rodadas
  // ANALISADAS (morte por evidência); móvel tolera lostAfterMisses (anti-rastro).
  const graceOf = (t: InternalTrack): number =>
    t.stationary ? stationaryMaxMisses : lostAfterMisses;

  // EMITÍVEL? (a política de emissão, num lugar só — ver o bloco no fim de update()).
  // LOST = vivo e NÃO emitível: some do desenho/ocupação/contagem, segue re-associável.
  const emitable = (t: InternalTrack): boolean =>
    t.misses === 0 || (!t.ghosted && t.misses <= graceOf(t));

  // Aplica a observação `d` ao track: máquina do estado ESTACIONÁRIO + velocidade
  // (delta / dt) + posição OBSERVADA (a reportada é SEMPRE a observada).
  function applyObservation(t: InternalTrack, d: TrackerDet, now: number): void {
    const dt = now - t.lastSeen;
    const cx = d.bbox[0] + d.bbox[2] / 2;
    const cy = d.bbox[1] + d.bbox[3] / 2;
    // ESTADO ESTACIONÁRIO: a observação caiu dentro da tolerância da ÂNCORA (a posição
    // onde a imobilidade começou)? Comparar com a âncora — e não com a observação
    // anterior — é o que torna o gate tolerante a JITTER de bbox (o inimigo nº 1 segundo
    // o Frigate) sem deixar passar deriva lenta.
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
    t.misses = 0; // observação zera a contagem — LOST re-identificado volta a ser emitido
    t.ghosted = false; // evidência fresca: a refutação por realocação cai
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
      stationary: false,
      stationarySince: 0,
      stillRounds: 0,
      anchorX: cx,
      anchorY: cy,
      ghosted: false,
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
    // REALOCAÇÕES da rodada: uma entrada por det que NASCEU track novo ou que o 2º
    // estágio RE-ASSOCIOU, com o centro da det e o índice do track que ela alimentou
    // (o "dono"). A refutação por realocação é LOCAL — bloco "REFUTAÇÃO" mais abaixo.
    const relocations: { cx: number; cy: number; owner: number }[] = [];

    // Matching GULOSO por IoU: pares (track livre × det livre) com IoU ≥ limiar,
    // atribuídos do maior IoU pro menor. Determinístico (sort estável). `boxOf`
    // escolhe a HIPÓTESE de onde o track está: PREDITA (andou) ou CONGELADA (parou).
    const associate = (idxs: number[], boxOf: (ti: number) => NormBBox): void => {
      const pairs: { ti: number; di: number; iou: number }[] = [];
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
    const predBox = (ti: number): NormBBox => pred[ti];
    const frozenBox = (ti: number): NormBBox => tracks[ti].bbox;

    associate(high, predBox); // 1ª passada: score alto × todos os tracks
    associate(low, predBox); // 2ª passada: score baixo RECUPERA os tracks que sobraram
    // HIPÓTESE DE PARADA (F3): o que sobrou tenta casar com a última bbox OBSERVADA —
    // a predição envelhecida joga a caixa longe justamente de quem PAROU; a det em cima
    // da caixa congelada é a evidência de que ela está lá. Vale nas duas passadas (o
    // caso de campo é a pessoa SENTADA com score fraco — 2ª passada).
    associate(high, frozenBox);
    associate(low, frozenBox);

    // 2º ESTÁGIO — RE-ASSOCIAÇÃO POR DISTÂNCIA (salto de fonte/stall): quando o gap entre
    // rodadas analisadas cresce, a predição erra mais que o próprio bbox e o IoU zera — a
    // MESMA pessoa viraria id novo a cada salto. Det ALTA sem par tenta então o track sem
    // par (inclusive LOST) pela distância do centro da det ao centro PREVISTO; o raio
    // cresce com a incerteza da extrapolação (|v|·gap) + folga fixa (reassocDist). Gates:
    // gap ≤ reassocMaxGapMs (salto extremo/oclusão longa → id novo, aceito) e tamanho de
    // bbox compatível. ANTI-TROCA: só casa par INEQUÍVOCO — det com exatamente 1 track
    // plausível E track com exatamente 1 det plausível; ambiguidade → id novo, nunca troca
    // de pessoa (mesma classe de risco declarado do "sem re-ID por aparência").
    // ANTI-HIJACK (F3): track ESTACIONÁRIO fica FORA deste estágio. Ele NÃO se moveu —
    // det ALTA a até `reassocDist` dele é OUTRA pessoa (se fosse ele, o IoU com a caixa
    // congelada já teria casado). Deixá-lo aqui era o ímã de id-hijack: a pessoa NOVA no
    // raio herdaria o id do parado E arrastaria a caixa dele p/ cima dela — a caixa do
    // parado sumiria justamente por ele estar parado.
    if (reassocDist > 0) {
      const cand: { ti: number; di: number }[] = [];
      const perTrack = new Map<number, number>(); // ti → nº de dets plausíveis
      const perDet = new Map<number, number>(); // di → nº de tracks plausíveis
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
        const b = dets[c.di].bbox;
        applyObservation(tracks[c.ti], dets[c.di], now); // v vira o deslocamento REAL do gap (dt-aware)
        reassociations += 1;
        relocations.push({ cx: b[0] + b[2] / 2, cy: b[1] + b[3] / 2, owner: c.ti });
      }
    }

    // Nascimento: SÓ detecção de score alto sem par (baixa sem par é descartada).
    // GUARDA DE NASCIMENTO em DOIS eixos — a det sem par que é a MESMA pessoa de um
    // track existente NÃO vira track novo:
    //   • SOBREPOSIÇÃO (birthIouThr): IoU alto com a bbox OBSERVADA ou PREDITA;
    //   • CONTENÇÃO (birthContainment): caixa PARCIAL (cabeça/torso — a query duplicada
    //     típica do detector) DENTRO da caixa do track tem IoU BAIXO e passava — a
    //     contenção (interseção/área da menor) a pega. Vale nos dois sentidos: det
    //     GRANDE sobre track que nasceu parcial também acusa (e o recover corrige a caixa).
    // Track acusado LIVRE → recupera a associação (atualiza); ocupado (inclusive
    // recém-nascido nesta rodada) → duplicata, descarta.
    //
    // EXTENSÃO POR RODADA (bug de campo 2026-07-26, medido no m09 da bancada): em movimento o
    // detector FRAGMENTA a pessoa — hipótese LARGA (0.80, corpo+braço) + rosto (0.51) + MÃO
    // isolada (0.60, disjunta do rosto). Se o track está com a caixa do ROSTO, a larga é
    // descartada pela contenção, mas a MÃO não toca o rosto e NASCIA "2ª pessoa". A GEOMETRIA
    // da larga descartada é informação: "a pessoa plausivelmente se estende por aqui". Cada
    // descarte/pareamento AMPLIA a extensão do track NA RODADA (união de caixas), e os
    // nascimentos rodam em ordem de SCORE (a larga entra antes da mão) — a mão cai DENTRO da
    // extensão e morre na guarda. Custo declarado: pessoa REAL que surge inteiramente dentro
    // da hipótese larga de outra só nasce ao se separar (mesma classe de trade-off do
    // birthContainment; a extensão vive UMA rodada, nunca persiste).
    const extent = new Map<number, [number, number, number, number]>(); // ti → união desta RODADA
    const unionBox = (
      a: readonly [number, number, number, number],
      b: readonly [number, number, number, number],
    ): [number, number, number, number] => {
      const x0 = Math.min(a[0], b[0]);
      const y0 = Math.min(a[1], b[1]);
      const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
      const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
      return [x0, y0, x1 - x0, y1 - y0];
    };
    const highBirth = high.filter((di) => !detUsed.has(di)).sort((a, b) => dets[b].score - dets[a].score);
    for (const di of highBirth) {
      if (detUsed.has(di)) continue;
      const d = dets[di];
      let bestTi = -1;
      let bestV = 0;
      for (let ti = 0; ti < tracks.length; ti++) {
        const obs = tracks[ti].bbox;
        const pb = ti < pred.length ? pred[ti] : null;
        const iou = Math.max(iouOf(obs, d.bbox), pb ? iouOf(pb, d.bbox) : 0);
        // Eixo de CONTENÇÃO só contra track FRESCO (misses 0 = visto na última rodada
        // analisada): duplicata do detector é fenômeno de CENA FRESCA (as duas caixas
        // nascem da mesma pessoa em rodadas adjacentes). Track já em miss + det de escala
        // muito diferente é o caso do 2º estágio ("escala não muda tão rápido" → id novo)
        // — sem este gate a contenção o engoliria e re-identificaria o que não devia.
        const ext = extent.get(ti);
        const cont =
          birthContainment > 0 && tracks[ti].misses === 0
            ? Math.max(
                containmentOf(obs, d.bbox),
                pb ? containmentOf(pb, d.bbox) : 0,
                ext ? containmentOf(ext, d.bbox) : 0, // fragmento dentro da EXTENSÃO da rodada
              )
            : 0;
        // qualifica por QUALQUER eixo; o melhor candidato é o de maior evidência
        const v = Math.max(
          iou > birthIouThr ? iou : 0,
          cont >= birthContainment && birthContainment > 0 ? cont : 0,
        );
        if (v > bestV) {
          bestV = v;
          bestTi = ti;
        }
      }
      if (bestTi >= 0) {
        // A det acusada AMPLIA a extensão do track nesta rodada (fragmentos seguintes,
        // processados em ordem de score, caem dentro dela — ex.: a mão após a hipótese larga).
        extent.set(bestTi, unionBox(extent.get(bestTi) ?? tracks[bestTi].bbox, d.bbox));
        if (!trkUsed.has(bestTi)) {
          trkUsed.add(bestTi);
          applyObservation(tracks[bestTi], d, now);
        }
        continue; // track já pareado nesta rodada → detecção duplicada, descartada
      }
      tracks.push(newTrack(d, now));
      trkUsed.add(tracks.length - 1); // recém-nascido conta como "ocupado" p/ as próximas dets
      relocations.push({
        cx: d.bbox[0] + d.bbox[2] / 2,
        cy: d.bbox[1] + d.bbox[3] / 2,
        owner: tracks.length - 1,
      });
    }

    // ── REFUTAÇÃO POR REALOCAÇÃO — raio de explosão LOCAL, não global ────────────
    // O `ghosted` existe p/ matar o RASTRO: quando a det de uma pessoa reaparece em
    // OUTRO lugar (nasceu track novo / o 2º estágio re-associou), o track congelado no
    // lugar antigo É o rastro e não pode seguir emitido. O DEFEITO (bug de campo
    // 2026-07-26, "falha em reconhecer pessoas se movimentando") era o ALCANCE: um
    // booleano GLOBAL fazia UMA realocação refutar TODOS os sem-match da rodada — e
    // cena movimentada é EXATAMENTE onde nasce track quase toda rodada, então quem só
    // piscou (falha de recall do detector) sumia do desenho, com o flag PEGAJOSO até
    // re-associar. Somado a lostAfterMisses:1, a caixa de quem anda piscava.
    //
    // CRITÉRIO: refuta-se todo track SEM MATCH cuja posição (a MELHOR das duas hipóteses
    // — PREDITA ou OBSERVADA, as mesmas que a associação usa) esteja a até `refuteMaxDist`
    // da realocação. Fora desse raio, "a detecção dela reapareceu ali" deixa de ser
    // explicação. Dono do valor em produção: precision.js (knob 22b).
    //
    // POR QUE NÃO "SÓ O MAIS PRÓXIMO" (critério puramente relativo, tentado antes):
    // MEDIDO E REPROVADO no eval:counting — em teleporte REPETIDO acumulam VÁRIOS tracks
    // obsoletos e refutar só o mais próximo deixa os demais emitidos ("salto extremo 3×"
    // reprovou com 2 caixas simultâneas para 1 pessoa, teto 1). O rastro é propriedade de
    // CADA track obsoleto, não do ranking entre eles.
    //
    // refuteMaxDist = 0 desliga o raio e restaura o comportamento GLOBAL antigo.
    //
    // POR QUE NÃO O RAIO DO 2º ESTÁGIO (reassocDist + |v|·gap = 0.12 parado): MEDIDO —
    // as realocações dos cenários anti-rastro que o `ghosted` comprou estão a 0.35–0.50
    // do track (unit "salto EXTREMO": 0.2→0.7; eval:counting "salto extremo 3×": saltos
    // de 0.35–0.40), muito além da folga. Gate por raio de ASSOCIAÇÃO não refutaria
    // nenhum deles (o rastro volta e o eval quebra em maxSimultaneous:1); e um raio
    // grande o bastante (>0.5 = meio quadro) não é local coisa nenhuma — não conserta a
    // cena movimentada. Teleporte é artefato de FONTE, não caminhada: não tem escala
    // física estável, então a escala honesta é RELATIVA (quem está mais perto), não
    // absoluta. Custo declarado: com UM único track vivo, qualquer nascimento ainda o
    // refuta (não há vizinho mais próximo) — é o preço de "1 pessoa = 1 caixa" no
    // teleporte de fonte, e dura 1 rodada (a observação seguinte limpa o flag).
    const refuted = new Set<number>();
    if (relocations.length > 0) {
      // Distância do centro da realocação ao track ti, pela melhor das 2 hipóteses.
      const distTo = (ti: number, r: { cx: number; cy: number }): number => {
        const obs = tracks[ti].bbox;
        const pb = ti < pred.length ? pred[ti] : obs; // recém-nascido não tem predição
        return Math.min(
          Math.hypot(r.cx - (obs[0] + obs[2] / 2), r.cy - (obs[1] + obs[3] / 2)),
          Math.hypot(r.cx - (pb[0] + pb[2] / 2), r.cy - (pb[1] + pb[3] / 2)),
        );
      };
      for (const r of relocations) {
        for (let ti = 0; ti < tracks.length; ti++) {
          if (ti === r.owner || trkUsed.has(ti)) continue; // só sem-match é refutável
          if (refuteMaxDist > 0 && distTo(ti, r) > refuteMaxDist) continue;
          refuted.add(ti);
        }
      }
    }

    // Contabiliza rodadas ANALISADAS sem match (matcheado zera em applyObservation/
    // newTrack). Base em RODADAS, não tempo: robusto ao dt variável entre rodadas — e é
    // o que dá sentido à MORTE POR EVIDÊNCIA do estacionário ("não vi" ≠ "não estava").
    // Quem foi REFUTADO acima sai da emissão até re-associar (pegajoso — o estacionário
    // tem graça longa e a caixa congelada voltaria ao desenho na rodada seguinte).
    for (let ti = 0; ti < tracks.length; ti++) {
      if (trkUsed.has(ti)) continue;
      tracks[ti].misses += 1;
      if (refuted.has(ti)) tracks[ti].ghosted = true;
    }

    // MORTE — duas leis, uma por regime (spec-tracking-pessoa-parada §2 C2):
    //   • MÓVEL: por RELÓGIO (ttlMs desde o último match).
    //   • ESTACIONÁRIO: por EVIDÊNCIA **E** relógio mínimo — > M rodadas ANALISADAS sem
    //     match E ttlMs desde o último match. Cada um sozinho erra: só o RELÓGIO mata a
    //     pessoa parada numa rodada lenta/gap (o bug que a F3 conserta — rodada que não
    //     rodou não é evidência de ausência); só a EVIDÊNCIA mata quem foi ocluso por
    //     M rodadas seguidas numa cena movimentada. Somados: nunca mais cedo que o
    //     relógio de hoje, nunca sem evidência. Teto opcional (stationaryMaxMs).
    tracks = tracks.filter((t) => {
      if (!t.stationary) return now - t.lastSeen <= ttlMs;
      if (t.misses > stationaryMaxMisses && now - t.lastSeen > ttlMs) return false;
      return !(stationaryMaxMs > 0 && now - t.stationarySince > stationaryMaxMs);
    });
    // POLÍTICA DE EMISSÃO (anti-rastro):
    //   • LOST (misses > graça) fica FORA do retorno — vive internamente
    //     (tracks()/2º estágio) até morrer, sem alimentar desenho/ocupação/contagem.
    //   • GRAÇA (0 < misses ≤ graceOf): emitido p/ oclusão/miss não piscar overlay/
    //     presença (recall do detector é intermitente). Para o ESTACIONÁRIO a graça é a
    //     própria janela de vida: enquanto não for refutado, a caixa congelada É a
    //     evidência de presença (zona OCIOSA, nunca VAZIA).
    //   • …EXCETO se REFUTADO por realocação (`ghosted`) — ver acima. Custo declarado:
    //     pessoa A oclusa na exata rodada em que uma realocação aparece do lado DELA
    //     pisca até re-associar (barato perto do rastro; A mantém id/firstSeen, que é o
    //     que a permanência consome). Nascimento LONGE de A não a apaga mais.
    return tracks.filter(emitable);
  }

  return {
    update,
    tracks: () => tracks.slice(),
    reset: () => {
      tracks = [];
    },
    stats: () => ({
      reassociations,
      lost: tracks.reduce((n, t) => n + (emitable(t) ? 0 : 1), 0),
      stationary: tracks.reduce((n, t) => n + (t.stationary ? 1 : 0), 0),
      alive: tracks.length,
    }),
  };
}
