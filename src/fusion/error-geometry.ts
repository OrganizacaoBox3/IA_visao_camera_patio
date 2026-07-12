// GEOMETRIA DO ERRO — o erro correlacionado (Regra 13) tem CAUSA FÍSICA? E, se tem, ela deixa
// rastro OBSERVÁVEL PELA CÂMERA (⇒ vetável ANTES de falar)?
//
// O ACHADO QUE ORIGINA ESTE MÓDULO (Regra 13, medido em anchor-policy.ts/`agreementOnFailure`):
//   quando o 1º episódio de um operador ERRA, o 2º repete o MESMO erro em 41,2% — contra um teto
//   model-free de independência de 8,8%. 4,7× acima. O reframe do revisor externo: esse número não é
//   ruído, é ASSINATURA — erro que se repete tem MECANISMO ESTÁVEL, e mecanismo estável é PREVISÍVEL.
//   O que é previsível é VETÁVEL: abster nos episódios cuja GEOMETRIA cai na região tóxica ataca os
//   41,2% na CAUSA, e não na média (que é o que subir o piso de n_eff faz — compra precisão CEGANDO
//   o sistema em todo lugar, inclusive onde ele acertava).
//
// RESPONSABILIDADE ÚNICA: extrair a GEOMETRIA de um episódio (features de TRAJETÓRIA, nunca de RSSI)
// e medir se os erros se CONCENTRAM nela. Não simula, não decide identidade (isso é visit-metrics.ts),
// não agrega operador (isso é anchor-policy.ts). Puro e determinístico. Nenhum NaN mudo.
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ A ARMADILHA DE CIRCULARIDADE (declarada ANTES de medir, não depois — doutrina §5)
//
// O `sim.ts` GERA o RSSI a partir da distância à estação, e tem um viés corporal DIRECIONAL
// (`bodyBias`) com modelo conhecido (sombra gaussiana no ângulo tag→estação). Se este módulo
// "descobrisse" exatamente esse modelo, isso NÃO seria achado — seria ler o código-fonte do gerador
// com passos extras. Duas defesas, ambas estruturais:
//
//   (1) TODA feature aqui é de TRAJETÓRIA — posição do pé no mundo (o que a câmera JÁ entrega,
//       via H⁻¹) e a posição CADASTRADA da estação. Nenhuma consome RSSI, r, z ou n_eff. Um veto
//       construído sobre elas é computável em campo, com a câmera que já existe, ANTES de o motor
//       falar. Ver `OBSERVABILIDADE` em cada feature: [CÂMERA] = observável em campo;
//       [SEMI-CIRCULAR] = observável, MAS é o argumento direto do gerador do sim → o achado sobre
//       ela vale menos e é reportado à parte.
//   (2) A suíte padrão (FUSION_SCENARIOS) NÃO LIGA `bodyBias` — nenhum cenário o usa. Logo, no
//       experimento principal o viés corporal direcional NEM EXISTE no gerador: qualquer
//       concentração de erro encontrada ali é GEOMETRIA PURA (trajetória × vizinho × estação), e é
//       IMPOSSÍVEL que seja o modelo de sombra do sim de volta. O teste corre um segundo braço COM
//       `bodyBias` ligado só para checar se o veto SOBREVIVE a uma física mais suja — não para
//       derivá-lo.
//
// A hipótese física que resta (e que NÃO é do simulador, é do canal): RSSI cai monotonicamente com a
// distância. É a premissa do produto inteiro. Um veto que se apoie só nela é honesto.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// AS DUAS CAUSAS CANDIDATAS (a previsão, registrada ANTES do número) — E O VEREDITO MEDIDO:
//   A. GRADIENTE RADIAL ~0 (trajetória TANGENCIAL à estação): se a distância à estação mal muda ao
//      longo do episódio, o r de Pearson (rssi × dist) não tem eixo para medir — o que sobra é
//      RUÍDO, e o vencedor sai por sorteio. É o modo de falha silencioso registrado no ADR-014, e
//      era a 1ª suspeita do revisor.
//      ⇒ ‼ REFUTADA como causa principal. Medido (673 decisões, 40 erros): AUC(erro>acerto) = 0,49
//        — a tangencialidade NÃO SABE DE NADA sobre o erro (0,5 = moeda). Vetar por ela sozinha
//        remove só 12,5% dos erros. A suspeita natural estava ERRADA, e o número disse.
//   B. RIVAL RADIALMENTE CONFUNDÍVEL: o RSSI da tag do VIZINHO cai com a distância DELE. Se o perfil
//      radial dele espelha o meu (`rivalDistCorr` alto), a tag dele correlaciona com a MINHA
//      distância tão bem quanto a minha — e o ranqueamento por −r escolhe qualquer uma das duas. É
//      o par espúrio, e ele é 100% VISÍVEL NA CÂMERA (duas pessoas andando em paralelo ao redor do
//      mesmo raio), sem tocar em rádio nenhum.
//      ⇒ ‼ CONFIRMADA, e é a causa DOMINANTE. AUC = 0,92 — e 0,97 restrita aos erros REPETIDOS (a
//        subpopulação da assinatura). A precisão desaba MONOTONICAMENTE com ela: 99,7% [98,4–99,9]
//        em rival-corr < 0,5 → 38,5% [17,7–64,5] em rival-corr > 0,95. A REGIÃO TÓXICA EXISTE, e é
//        esta. B é também a única que EXPLICA erro repetido: o vizinho de trabalho é o MESMO o
//        turno inteiro — mesma dupla, mesmo par espúrio, mesmo erro. O mecanismo é estável porque
//        a EQUIPE é estável.
import { wilsonInterval } from "./visit-metrics";
import type { Pt } from "./receiver-geometry";

/** Uma pista vista num tick, já em coordenadas de MUNDO (metros) — o pé projetado por H⁻¹. É
 *  exatamente o que a câmera calibrada entrega hoje em produção. */
export type GeomObs = { trackId: number; pos: Pt };
/** Um tick de geometria: instante + todas as pistas presentes (a MINHA e as dos vizinhos). */
export type GeomTick = { ts: number; obs: readonly GeomObs[] };

/**
 * A geometria de UM episódio — só trajetória, estação e vizinhos. NENHUMA feature de rádio.
 * `[CÂMERA]` = observável em campo. `[SEMI-CIRCULAR]` = observável, mas é argumento direto do
 * gerador de viés do sim (ver cabeçalho) — reportada à parte, nunca sozinha num veto.
 */
export type EpisodeGeometry = {
  /** Pontos de trajetória usados (ticks em que a pista existia na janela do episódio). */
  nPts: number;
  /** Duração de PAREDE do episódio (s). [CÂMERA] */
  durationS: number;
  /** Comprimento do caminho percorrido (m) — Σ|Δpos|. [CÂMERA] */
  pathLenM: number;
  /** Velocidade média (m/s) = pathLen/duração. [CÂMERA] */
  speedMs: number;
  distStartM: number;
  distEndM: number;
  distMinM: number;
  distMaxM: number;
  /** Distância média à estação (m). [CÂMERA] */
  distMeanM: number;
  /** Range radial em DÉCADAS (max−min de log10 d) — a métrica comparável ao ADR-014. [CÂMERA] */
  rangeDecades: number;
  /**
   * TANGENCIALIDADE ∈ [0,1] — a suspeita nº1. 0 = movimento puramente RADIAL (cada passo muda a
   * distância à estação); 1 = puramente TANGENCIAL (anda em círculo ao redor da estação; a
   * distância nunca muda ⇒ o gradiente radial é 0 ⇒ a correlação rssi×dist não tem eixo).
   *     tangentiality = 1 − Σ|Δd| / Σ|Δpos|
   * [CÂMERA] — trajetória + posição cadastrada da estação. Zero rádio.
   */
  tangentiality: number;
  /** Fração RADIAL LÍQUIDA = |d_fim − d_início| / pathLen ∈ [0,1]. 1 = aproximação monotônica
   *  (o caso ideal do ADR-014); ~0 = vai-e-volta que não sai do lugar radialmente. [CÂMERA] */
  netRadialFrac: number;
  /** Bearing MÉDIO estação→pessoa (graus, [0,360)) — a faixa angular da aproximação. [CÂMERA] */
  bearingMeanDeg: number;
  /** VARIAÇÃO do bearing no episódio (graus, [0,180]) — quanto o ângulo varreu. Bearing que varre
   *  muito com distância parada É a assinatura da trajetória tangencial. [CÂMERA] */
  bearingSpreadDeg: number;
  /**
   * Ângulo MÉDIO entre o heading (direção de marcha — proxy da orientação do CORPO) e a direção à
   * estação, em [0,180]. 0° = andando de frente para a estação; 180° = de costas (o corpo entre a
   * tag e a estação = a sombra).
   * ⚠ [SEMI-CIRCULAR] — é OBSERVÁVEL pela câmera (heading vem da trajetória; a estação é
   * cadastrada), mas é literalmente o argumento de `bodyBiasDb` no sim. Achado sobre ela em cenário
   * com `bodyBias` LIGADO é suspeito de circularidade; nos FUSION_SCENARIOS (que NÃO ligam
   * bodyBias) ela é uma feature geométrica como outra qualquer. Nunca entra sozinha no veto.
   */
  headingToStationDeg: number;
  /** Menor distância a QUALQUER outra pista, ao longo do episódio (m). Infinity se ninguém mais
   *  estava em cena — a confusão com o vizinho precisa de vizinho. [CÂMERA] */
  neighborMinM: number;
  /** Distância MEDIANA ao vizinho mais próximo (m) — a proximidade típica, não o mínimo pontual
   *  (que um único cruzamento infla). Infinity sem vizinho. [CÂMERA] */
  neighborMedianM: number;
  /**
   * CONFUNDIBILIDADE RADIAL DO RIVAL ∈ [−1,1] — a suspeita nº2, e a que explica erro REPETIDO.
   * max sobre as outras pistas de pearson(d_eu(t), d_ele(t)) na janela comum. Alto ⇒ o perfil
   * radial do vizinho ESPELHA o meu ⇒ o RSSI da tag DELE (que cai com a distância DELE) correlaciona
   * com a MINHA distância tão bem quanto a minha própria tag ⇒ o ranqueamento por −r não os separa.
   * −1 quando não há rival com série suficiente (nunca NaN).
   * [CÂMERA] — duas trajetórias e uma estação. A única física assumida é "RSSI cai com a distância"
   * (a premissa do produto), NÃO o modelo do simulador.
   */
  rivalDistCorr: number;
};

/** Chaves NUMÉRICAS de EpisodeGeometry — o eixo de qualquer contraste/veto. */
export type GeomFeature = keyof EpisodeGeometry;

/** Um episódio DECIDIDO pelo motor, com sua geometria e o desfecho — a linha da análise. */
export type DecidedGeom = {
  operator: string;
  trackId: number;
  startTs: number;
  geom: EpisodeGeometry;
  /** A decisão bateu com a verdade. */
  correct: boolean;
  /** ERRO REPETIDO (Regra 13): este episódio errou E outro episódio decidido do MESMO operador
   *  cometeu o MESMO erro (mesma tag errada). É a subpopulação que a assinatura de 41,2% pegou. */
  repeatedError: boolean;
};

const DIST_FLOOR_M = 0.1; // mesmo piso de log10 do visit-metrics (nunca log de 0)

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Pearson; null se alguma série é (quase) constante. Mesma fórmula/guarda do visit-metrics. */
function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  if (denom < 1e-9) return null;
  return sxy / denom;
}

/** Ângulo não-orientado entre dois vetores, em graus [0,180]. Vetor nulo → 0 (sem informação). */
function angleBetweenDeg(a: Pt, b: Pt): number {
  const ma = Math.hypot(a.x, a.y);
  const mb = Math.hypot(b.x, b.y);
  if (ma < 1e-9 || mb < 1e-9) return 0;
  const cos = Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y) / (ma * mb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Média CIRCULAR de ângulos em graus (a média aritmética de 350° e 10° daria 180°, que é o lado
 *  oposto do círculo — erro clássico). Devolve [0,360). */
function circularMeanDeg(degs: readonly number[]): number {
  let sx = 0;
  let sy = 0;
  for (const d of degs) {
    const r = (d * Math.PI) / 180;
    sx += Math.cos(r);
    sy += Math.sin(r);
  }
  if (Math.hypot(sx, sy) < 1e-12) return 0; // direções que se cancelam — média indefinida
  const a = (Math.atan2(sy, sx) * 180) / Math.PI;
  return (a + 360) % 360;
}

/** VARREDURA angular de uma série de bearings: o maior arco NÃO coberto, subtraído de 360 — a
 *  medida correta de "quanto o ângulo variou" num círculo (o max−min ingênuo dá 359° para uma
 *  série que só oscila em torno de 0°). Devolve [0,360); saturamos em 180 no consumo. */
function angularSpreadDeg(degs: readonly number[]): number {
  if (degs.length < 2) return 0;
  const s = [...degs].map((d) => ((d % 360) + 360) % 360).sort((a, b) => a - b);
  let biggestGap = 360 - s[s.length - 1] + s[0]; // o arco que "dá a volta"
  for (let i = 1; i < s.length; i++) {
    const gap = s[i] - s[i - 1];
    if (gap > biggestGap) biggestGap = gap;
  }
  return 360 - biggestGap;
}

/**
 * A GEOMETRIA de um episódio: recorta a trajetória de `trackId` na janela [startTs, endTs] dos
 * `ticks` (o mesmo recorte que buildEpisodes fez sobre os VisitTick — as janelas são as mesmas
 * porque vêm dos mesmos instantes), e mede as features de trajetória contra a estação.
 * Devolve null se a janela tem <2 pontos (não há trajetória — nada a medir; nunca NaN mudo).
 */
export function episodeGeometry(
  ticks: readonly GeomTick[],
  trackId: number,
  startTs: number,
  endTs: number,
  station: Pt,
): EpisodeGeometry | null {
  const self: { ts: number; pos: Pt }[] = [];
  const others = new Map<number, { ts: number; pos: Pt }[]>();
  for (const t of ticks) {
    if (t.ts < startTs || t.ts > endTs) continue;
    let mine: Pt | null = null;
    for (const o of t.obs) if (o.trackId === trackId) mine = o.pos;
    if (mine === null) continue; // a pista não estava neste tick — não é ponto do episódio
    self.push({ ts: t.ts, pos: mine });
    for (const o of t.obs) {
      if (o.trackId === trackId) continue;
      const list = others.get(o.trackId) ?? [];
      list.push({ ts: t.ts, pos: o.pos });
      others.set(o.trackId, list);
    }
  }
  if (self.length < 2) return null;

  const dist = self.map((s) => Math.hypot(s.pos.x - station.x, s.pos.y - station.y));
  const bearings = self.map((s) => {
    const a = (Math.atan2(s.pos.y - station.y, s.pos.x - station.x) * 180) / Math.PI;
    return (a + 360) % 360;
  });

  let pathLenM = 0;
  let radialAbs = 0; // Σ|Δd| — quanto do caminho foi GASTO mudando a distância à estação
  for (let i = 1; i < self.length; i++) {
    pathLenM += Math.hypot(self[i].pos.x - self[i - 1].pos.x, self[i].pos.y - self[i - 1].pos.y);
    radialAbs += Math.abs(dist[i] - dist[i - 1]);
  }
  // Caminho degenerado (pessoa PARADA): tangencialidade/netRadial são indefinidas por 0/0. A
  // convenção honesta é 0 (sem movimento não há componente tangencial ALGUMA) — e não 1, que
  // marcaria o parado como "tóxico" por um artefato de divisão. Quem estiver parado é filtrado
  // pelo próprio motor (série de dist constante ⇒ pearson null ⇒ nem candidato).
  const tangentiality = pathLenM < 1e-6 ? 0 : Math.max(0, 1 - radialAbs / pathLenM);
  const netRadialFrac =
    pathLenM < 1e-6 ? 0 : Math.min(1, Math.abs(dist[dist.length - 1] - dist[0]) / pathLenM);

  // Heading por tick (deslocamento desde o ponto anterior) × direção à estação — o ângulo do corpo.
  const bodyAngles: number[] = [];
  for (let i = 1; i < self.length; i++) {
    const heading = { x: self[i].pos.x - self[i - 1].pos.x, y: self[i].pos.y - self[i - 1].pos.y };
    if (Math.hypot(heading.x, heading.y) < 1e-6) continue; // parado neste passo — sem heading real
    bodyAngles.push(
      angleBetweenDeg(heading, { x: station.x - self[i].pos.x, y: station.y - self[i].pos.y }),
    );
  }

  // Vizinhos: a série de distância AO vizinho (proximidade) e a CORRELAÇÃO RADIAL com ele.
  const selfTs = new Map(self.map((s, i) => [s.ts, i]));
  let neighborMinM = Infinity;
  const nearestPerTick: number[] = new Array(self.length).fill(Infinity);
  let rivalDistCorr = -1;
  for (const list of others.values()) {
    const mineD: number[] = [];
    const theirD: number[] = [];
    for (const o of list) {
      const i = selfTs.get(o.ts);
      if (i === undefined) continue;
      const sep = Math.hypot(o.pos.x - self[i].pos.x, o.pos.y - self[i].pos.y);
      if (sep < neighborMinM) neighborMinM = sep;
      if (sep < nearestPerTick[i]) nearestPerTick[i] = sep;
      mineD.push(dist[i]);
      theirD.push(Math.hypot(o.pos.x - station.x, o.pos.y - station.y));
    }
    // O rival só é confundível se compartilhou tempo suficiente para uma correlação existir.
    if (mineD.length >= 3) {
      const r = pearson(mineD, theirD);
      if (r !== null && r > rivalDistCorr) rivalDistCorr = r;
    }
  }
  const nearestSeen = nearestPerTick.filter((d) => Number.isFinite(d));
  const neighborMedianM = nearestSeen.length ? median(nearestSeen) : Infinity;

  const durationS = (endTs - startTs) / 1000;
  const logs = dist.map((d) => Math.log10(Math.max(d, DIST_FLOOR_M)));
  return {
    nPts: self.length,
    durationS,
    pathLenM,
    speedMs: durationS > 0 ? pathLenM / durationS : 0,
    distStartM: dist[0],
    distEndM: dist[dist.length - 1],
    distMinM: Math.min(...dist),
    distMaxM: Math.max(...dist),
    distMeanM: mean(dist),
    rangeDecades: Math.max(...logs) - Math.min(...logs),
    tangentiality,
    netRadialFrac,
    bearingMeanDeg: circularMeanDeg(bearings),
    bearingSpreadDeg: Math.min(180, angularSpreadDeg(bearings)),
    headingToStationDeg: bodyAngles.length ? mean(bodyAngles) : 0,
    neighborMinM,
    neighborMedianM,
    rivalDistCorr,
  };
}

// ─────────────────────────── OS ERROS SE CONCENTRAM? (o teste da previsão) ───────────────────────

/** O contraste de UMA feature entre episódios CERTOS e ERRADOS. Estatística SIMPLES e defensável:
 *  medianas + AUC de Mann-Whitney (a probabilidade de um episódio ERRADO sorteado ao acaso ter a
 *  feature MAIOR que a de um CERTO sorteado ao acaso; 0,5 = sem separação, 1 = separação total).
 *  Nada exótico: é a estatística U, equivalente ao teste de postos de Wilcoxon, sem assumir
 *  normalidade — o que importa aqui, já que nenhuma dessas features é gaussiana. */
export type FeatureContrast = {
  feature: GeomFeature;
  nCorrect: number;
  nWrong: number;
  medianCorrect: number;
  medianWrong: number;
  /** AUC ∈ [0,1] — >0,5 = a feature é MAIOR nos erros; <0,5 = maior nos acertos. 0,5 = nada. */
  auc: number;
  /** |auc − 0,5| × 2 ∈ [0,1] — a força de separação, independente do sinal. */
  separation: number;
};

/** AUC (Mann-Whitney U / (n1·n2)) de `wrong` sobre `correct`, com empates valendo 0,5. O(n log n)
 *  via ranks. n=0 de um lado → 0,5 (nada a dizer; nunca NaN). */
function auc(wrong: readonly number[], correct: readonly number[]): number {
  const n1 = wrong.length;
  const n2 = correct.length;
  if (n1 === 0 || n2 === 0) return 0.5;
  const all = [
    ...wrong.map((v) => ({ v, w: 1 })),
    ...correct.map((v) => ({ v, w: 0 })),
  ].sort((a, b) => a.v - b.v);
  // Ranks médios (empates compartilham o rank médio — a correção clássica de U com ties).
  let i = 0;
  let sumRankWrong = 0;
  while (i < all.length) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // ranks 1-based
    for (let k = i; k <= j; k++) if (all[k].w === 1) sumRankWrong += avgRank;
    i = j + 1;
  }
  const u = sumRankWrong - (n1 * (n1 + 1)) / 2;
  return u / (n1 * n2);
}

/** Filtra os valores finitos de uma feature (Infinity de `neighbor*` sem vizinho é AUSÊNCIA de
 *  dado, não um valor grande — incluí-lo como +∞ enviesaria o rank). */
function finiteValues(eps: readonly DecidedGeom[], f: GeomFeature): number[] {
  const out: number[] = [];
  for (const e of eps) {
    const v = e.geom[f];
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

/** Contraste CERTO × ERRADO de uma feature. `onlyRepeated` restringe os ERRADOS à subpopulação de
 *  erro REPETIDO (a assinatura da Regra 13) — é onde a causa estável deve aparecer mais forte. */
export function featureContrast(
  eps: readonly DecidedGeom[],
  feature: GeomFeature,
  onlyRepeated = false,
): FeatureContrast {
  const wrongEps = eps.filter((e) => !e.correct && (!onlyRepeated || e.repeatedError));
  const correctEps = eps.filter((e) => e.correct);
  const w = finiteValues(wrongEps, feature);
  const c = finiteValues(correctEps, feature);
  const a = auc(w, c);
  return {
    feature,
    nCorrect: c.length,
    nWrong: w.length,
    medianCorrect: median(c),
    medianWrong: median(w),
    auc: a,
    separation: Math.abs(a - 0.5) * 2,
  };
}

/** Um bin de uma feature: quantos episódios caíram nele e com que PRECISÃO — com n e IC95 de
 *  Wilson (Regra 10: nunca uma proporção sem os dois). É a leitura de "onde fica a região tóxica". */
export type FeatureBin = {
  lo: number;
  hi: number;
  n: number;
  correct: number;
  precision: number;
  lo95: number;
  hi95: number;
};

/** Precisão por faixa de uma feature (bins semi-abertos [lo, hi)). Bins vazios saem da lista. */
export function binnedPrecision(
  eps: readonly DecidedGeom[],
  feature: GeomFeature,
  edges: readonly number[],
): FeatureBin[] {
  const out: FeatureBin[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const lo = edges[i];
    const hi = edges[i + 1];
    const inBin = eps.filter((e) => {
      const v = e.geom[feature];
      return Number.isFinite(v) && v >= lo && v < hi;
    });
    if (inBin.length === 0) continue;
    const correct = inBin.filter((e) => e.correct).length;
    const ci = wilsonInterval(correct, inBin.length);
    out.push({
      lo,
      hi,
      n: inBin.length,
      correct,
      precision: correct / inBin.length,
      lo95: ci.lo,
      hi95: ci.hi,
    });
  }
  return out;
}

// ─────────────────────────────────── O VETO (e o seu preço) ──────────────────────────────────────

/** Predicado de VETO: recebe a geometria de um episódio e diz se ele cai na REGIÃO TÓXICA (⇒ o
 *  motor se ABSTÉM ali, mesmo que a significância de Fisher passasse). Puro. */
export type VetoFn = (g: EpisodeGeometry) => boolean;

/** O trade-off do veto, medido — o delta do MECANISMO (Regra 11), não o agregado. */
export type VetoOutcome = {
  /** Episódios COM TAG na população (o denominador da cobertura). */
  episodesWithTag: number;
  decidedBefore: number;
  correctBefore: number;
  errorsBefore: number;
  precisionBefore: number;
  precisionBeforeLo95: number;
  precisionBeforeHi95: number;
  coverageBefore: number;
  /** Decisões que o veto ABATEU (o preço). */
  vetoed: number;
  /** …das quais eram ERRO (o prêmio). */
  errorsVetoed: number;
  /** …e das quais eram ACERTO (o dano colateral). */
  correctVetoed: number;
  decidedAfter: number;
  correctAfter: number;
  errorsAfter: number;
  precisionAfter: number;
  precisionAfterLo95: number;
  precisionAfterHi95: number;
  coverageAfter: number;
  /** Fração dos ERROS eliminada (errorsVetoed / errorsBefore) — o poder do veto. */
  errorRecall: number;
  /** Fração dos ACERTOS sacrificada (correctVetoed / correctBefore) — a cegueira que ele custa. */
  correctLoss: number;
};

/**
 * MEDE o trade-off de um veto geométrico sobre uma população de episódios DECIDIDOS.
 * `episodesWithTag` é o denominador de COBERTURA (todos os episódios com tag da colheita, decididos
 * ou não) — sem ele a "cobertura" seria sobre a população já filtrada, que é a armadilha clássica.
 */
export function evaluateVeto(
  decided: readonly DecidedGeom[],
  episodesWithTag: number,
  veto: VetoFn,
): VetoOutcome {
  const vetoedEps = decided.filter((e) => veto(e.geom));
  const kept = decided.filter((e) => !veto(e.geom));
  const correctBefore = decided.filter((e) => e.correct).length;
  const correctAfter = kept.filter((e) => e.correct).length;
  const correctVetoed = vetoedEps.filter((e) => e.correct).length;
  const errorsVetoed = vetoedEps.length - correctVetoed;
  const errorsBefore = decided.length - correctBefore;
  const before = wilsonInterval(correctBefore, decided.length);
  const after = wilsonInterval(correctAfter, kept.length);
  const cov = (k: number): number => (episodesWithTag === 0 ? 0 : k / episodesWithTag);
  return {
    episodesWithTag,
    decidedBefore: decided.length,
    correctBefore,
    errorsBefore,
    precisionBefore: decided.length === 0 ? 1 : correctBefore / decided.length,
    precisionBeforeLo95: before.lo,
    precisionBeforeHi95: before.hi,
    coverageBefore: cov(decided.length),
    vetoed: vetoedEps.length,
    errorsVetoed,
    correctVetoed,
    decidedAfter: kept.length,
    correctAfter,
    errorsAfter: kept.length - correctAfter,
    precisionAfter: kept.length === 0 ? 1 : correctAfter / kept.length,
    precisionAfterLo95: after.lo,
    precisionAfterHi95: after.hi,
    coverageAfter: cov(kept.length),
    errorRecall: errorsBefore === 0 ? 0 : errorsVetoed / errorsBefore,
    correctLoss: correctBefore === 0 ? 0 : correctVetoed / correctBefore,
  };
}

/**
 * OS LIMIARES DO VETO GEOMÉTRICO — MEDIDOS na bancada (error-geometry.test.ts), não postulados.
 * Ambos os eixos são [CÂMERA]: computáveis em campo com a câmera calibrada + a posição cadastrada
 * da estação, ANTES de o motor falar. NENHUM usa RSSI, r, z ou n_eff.
 *
 * O TRADE-OFF MEDIDO (673 decisões, receptor no destino, 1 Hz, piso n_eff=10):
 *   precisão 94,1% [92,0–95,6] → 98,1% [96,6–98,9]  |  cobertura 32,7% → 27,9%
 *   elimina 72,5% dos ERROS ao custo de 11,2% dos ACERTOS  |  a concordância-no-erro (Regra 13)
 *   cai de 41,2% [21,6–64,0] para 0,0% [0,0–39,0] — o veto ataca o MECANISMO, não a média.
 * E DOMINA subir o piso nas DUAS pontas: pela MESMA precisão (98,1%) o piso teria de ir a 19 e
 * pagaria 10,3% de cobertura (o veto fala 2,7× mais); pela MESMA cobertura (~26%) o piso 12
 * entrega 95,3% (o veto acerta ~3pp mais).
 *
 * O PESO ESTÁ EM `maxRivalDistCorr` (causa B). `maxTangentiality` (causa A, a suspeita do revisor)
 * é MARGINAL — sozinha remove só 12,5% dos erros (AUC 0,49). Fica no veto porque ainda é melhor que
 * aleatório (12,5% de erro por 1,9% de acerto) e é barata, mas NÃO é o mecanismo.
 *
 * NÃO SÃO CONSTANTES DA NATUREZA — são o ponto de operação medido nesta suíte (SIMULADOR ⇒ os
 * absolutos são INDICATIVOS; o que é robusto é a ESTRUTURA). Quem levar a campo re-mede (a mesma
 * disciplina do piso de n_eff, Regra 10).
 */
export const DEFAULT_VETO = {
  /** Trajetória TANGENCIAL: o gradiente radial é ~0 e a correlação não tem eixo (causa A — MARGINAL). */
  maxTangentiality: 0.5,
  /** RIVAL radialmente confundível: o vizinho espelha meu perfil radial (causa B — A DOMINANTE). */
  maxRivalDistCorr: 0.8,
} as const;

/** O veto geométrico: abstém quando a trajetória é TANGENCIAL demais OU quando existe um rival
 *  radialmente confundível. Disjunção (OU) de propósito: são DUAS causas independentes de o
 *  ranqueamento por −r não ter o que separar — basta uma para o episódio ser tóxico. */
export function geometricVeto(
  g: EpisodeGeometry,
  opts: { maxTangentiality?: number; maxRivalDistCorr?: number } = {},
): boolean {
  const maxTan = opts.maxTangentiality ?? DEFAULT_VETO.maxTangentiality;
  const maxRival = opts.maxRivalDistCorr ?? DEFAULT_VETO.maxRivalDistCorr;
  return g.tangentiality > maxTan || g.rivalDistCorr > maxRival;
}

/** A CONCORDÂNCIA-NO-ERRO (Regra 13) de uma população — recomputada AQUI sobre os episódios que
 *  SOBREVIVEM ao veto, para responder à pergunta que importa: o veto derruba os 41,2%, ou só remove
 *  erros isolados e deixa a ASSINATURA intacta? Pares = (1º, 2º) episódios decididos do operador,
 *  a MESMA definição de `agreementOnFailure` (anchor-policy.ts) — reimplementada sobre DecidedGeom
 *  porque a população aqui já passou pelo veto (não há como pedir aquilo a anchor-policy sem lhe
 *  ensinar geometria, o que quebraria a responsabilidade única dela). */
export type ErrorAgreement = {
  operators: number;
  firstWrong: number;
  firstWrongAndAgree: number;
  /** firstWrongAndAgree / firstWrong — o 41,2% da Regra 13. */
  agreementOnFailure: number;
  lo95: number;
  hi95: number;
};

/** `decisionOf` devolve a TAG que o episódio decidiu (para comparar "o MESMO erro"); `truthOf`, a
 *  verdade do operador. Passados de fora: este módulo não conhece tags, só geometria. */
export function errorAgreement(
  decided: readonly DecidedGeom[],
  decisionOf: (e: DecidedGeom) => string,
): ErrorAgreement {
  const by = new Map<string, DecidedGeom[]>();
  for (const e of decided) {
    const l = by.get(e.operator) ?? [];
    l.push(e);
    by.set(e.operator, l);
  }
  let operators = 0;
  let firstWrong = 0;
  let firstWrongAndAgree = 0;
  for (const list of by.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.startTs - b.startTs || a.trackId - b.trackId);
    operators++;
    const [a, b] = sorted;
    if (a.correct) continue;
    firstWrong++;
    if (!b.correct && decisionOf(a) === decisionOf(b)) firstWrongAndAgree++;
  }
  const ci = wilsonInterval(firstWrongAndAgree, firstWrong);
  return {
    operators,
    firstWrong,
    firstWrongAndAgree,
    agreementOnFailure: firstWrong === 0 ? 0 : firstWrongAndAgree / firstWrong,
    lo95: ci.lo,
    hi95: ci.hi,
  };
}
