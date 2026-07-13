// EVIDÊNCIA ABSOLUTA de distância — a 2ª evidência, INDEPENDENTE DE MOVIMENTO.
//
// POR QUE ESTE MÓDULO EXISTE (laudo 2026-07-13, medido na gravação real): o associador de hoje
// correlaciona RSSI × distância. Pessoa PARADA ⇒ distância constante ⇒ correlação
// MATEMATICAMENTE INDEFINIDA. Não é limiar mal calibrado: é o método não ter o que medir. E o caso
// DOMINANTE do produto (41,9% dos episódios do corpus ouro; IC 33,7–50,5%) é exatamente esse — a
// mesa de trabalho, o operador que chega e fica. A correlação segue valendo para quem ANDA (o
// corredor, a empilhadeira); ela não é jogada fora, ela deixa de ser a ÚNICA.
//
// O MECANISMO: RSSI de −55 dBm + modelo de path-loss calibrado pelas ÂNCORAS (tags fixas em posição
// conhecida) ⇒ "a tag está a ~2 m da estação". A câmera diz "esta pessoa está a 2,1 m da estação".
// Isso é evidência SEM exigir um passo sequer. O fit e a inversão do modelo já existem
// (floor-plot.ts) — este módulo NÃO os reimplementa: ele os usa, e acrescenta as três coisas que
// faltavam para a evidência ser HONESTA:
//
//  1. DEDUPLICAÇÃO ANTES da estatística (Regra 8). O celular faz sample-and-hold: 81,2% do que o
//     hub recebe é CÓPIA do valor anterior (B1 do laudo). Uma cópia carrega informação ZERO. Aqui
//     `nDistinct` é CONTAGEM de medições distintas, não de POSTs — e nada estatístico roda antes
//     dela. Sem isso, o motor acredita ter 16 amostras quando tem 3,6.
//  2. ERRO MULTIPLICATIVO ⇒ espaço-LOG. O erro do RSSI é aditivo em dB, e dB é logaritmo de
//     distância: ±6 dB não é "±1 m", é um FATOR. Limiar em metros absolutos aperta longe e afrouxa
//     perto. Toda a régua aqui é em DÉCADAS de log10(d) — a única escala em que o erro é homogêneo.
//  3. O σ NÃO É CHUTE: sai medido do próprio dado, por VALIDAÇÃO CRUZADA leave-one-out nas âncoras
//     (`looResiduals`) — calibra com k−1 âncoras, prevê a k-ésima, compara com a geometria que ela
//     JÁ SABE. É o único juiz não-circular disponível em campo (a âncora é a única verdade-terreno
//     que a gravação tem: MAC conhecido em posição conhecida).
//
// REGRA 9 (o ponto cego, DECLARADO): antes de estimar, verifique se o pipeline RESOLVE o parâmetro.
// `resolutionFloorM(σ, d)` responde: com o σ MEDIDO, qual a menor separação entre duas pessoas que
// esta régua consegue distinguir a d metros da estação? Se o piso de resolução for MAIOR que a
// distância entre duas mesas, o método está morto ANTES do torneio — e isso é achado, não fracasso.
//
// Responsabilidade única: produzir a EVIDÊNCIA absoluta de um par (pista, tag) e a régua que diz
// quando ela pode falar. NÃO decide assignment (isso é do associate.ts) e não tem estado.
import { distFromRssi, fitPathLoss, type AnchorObs, type PathLossModel } from "./floor-plot";
import type { Vec2 } from "../vision/homography";

/** Piso de distância nas contas em log — mesmo do gate v4 do associate.ts (log10(0) = −∞). */
const MIN_DIST_M = 0.1;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Mediana de uma série NÃO-VAZIA (cópia; não muta a entrada). Série vazia → null. */
export function median(xs: readonly number[]): number | null {
  const s = [...xs].filter(isFiniteNum).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * REGRA 8 — deduplicação ANTES de qualquer estatística. Remove repetições CONSECUTIVAS (o
 * sample-and-hold do app: o mesmo valor reenviado a cada POST até a tag anunciar de novo). É
 * CONTAGEM, não modelo: `dedupeConsecutive(xs).length` é o teto de evidência independente que a
 * série pode carregar. Valor que VOLTA depois de mudar (−60, −65, −60) conta de novo — são duas
 * medições distintas de verdade, e colapsá-las seria perder informação real.
 */
export function dedupeConsecutive(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (const x of xs) {
    if (!isFiniteNum(x)) continue;
    if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
  }
  return out;
}

/** A distância que o RÁDIO afirma, com a contagem honesta de quanta medição a sustenta. */
export type TagDistanceEstimate = {
  /** Distância tag→estação (m), do modelo invertido sobre a MEDIANA das leituras DISTINTAS. */
  distM: number;
  /** Nº de leituras DISTINTAS (Regra 8) — NÃO o nº de POSTs. É o teto da evidência. */
  nDistinct: number;
  /** Mediana do RSSI (dBm) sobre as distintas — o que de fato entrou no modelo. */
  rssiMedian: number;
};

/**
 * RSSI → distância, robusto: mediana das leituras DISTINTAS (Regra 8) invertida pelo modelo.
 * MEDIANA (não média): o RSSI indoor tem outlier assimétrico (o −93 dBm no meio de −66 dBm é
 * obstrução momentânea, medida na gravação real) — a média o segue, a mediana não.
 * Série vazia (ou toda não-finita) → null: sem leitura não há evidência, e inventar teto (100 m)
 * aqui seria oferecer "muito longe" como se fosse medição.
 */
export function estimateTagDistM(
  model: PathLossModel,
  rssis: readonly number[],
): TagDistanceEstimate | null {
  const distinct = dedupeConsecutive(rssis);
  const m = median(distinct);
  if (m === null) return null;
  return { distM: distFromRssi(model, m), nDistinct: distinct.length, rssiMedian: m };
}

/**
 * Score da evidência absoluta em [0..1]: verossimilhança gaussiana do GAP em DÉCADAS.
 *   z = log10(dTag / dCam) / σ      →      score = exp(−z²/2)
 * Espaço-LOG porque o erro do RSSI é MULTIPLICATIVO em distância (ver cabeçalho). σ vem MEDIDO
 * (looResiduals/sigmaDecades) — não é knob de gosto. σ ≤ 0 ou entradas inválidas → 0 (abstenção:
 * sem régua não há evidência).
 */
export function absoluteScore(dCamM: number, dTagM: number, sigmaDecades: number): number {
  if (!isFiniteNum(dCamM) || !isFiniteNum(dTagM) || !isFiniteNum(sigmaDecades)) return 0;
  if (sigmaDecades <= 0) return 0;
  const z =
    Math.log10(Math.max(dTagM, MIN_DIST_M) / Math.max(dCamM, MIN_DIST_M)) / sigmaDecades;
  return Math.exp(-0.5 * z * z);
}

/** A evidência absoluta de UM par (pista, tag) numa janela. `null` = abstenção declarada. */
export type AbsoluteEvidence = {
  /** Distância da PISTA à estação (m, da homografia — só vale com dist métrica). */
  dCamM: number;
  /** Distância da TAG à estação (m, do rádio pelo modelo calibrado). */
  dTagM: number;
  /** |log10(dTag/dCam)| — o gap na escala em que o erro é homogêneo. */
  gapDecades: number;
  /** exp(−z²/2) ∈ [0..1]. */
  score: number;
  /** Leituras DISTINTAS que sustentam o dTagM (Regra 8). */
  nDistinct: number;
};

export type AbsoluteEvidenceOpts = {
  /** Mínimo de leituras DISTINTAS (Regra 8) para a evidência falar. Default 1: a distância
   *  absoluta NÃO precisa de série — 1 medição já é uma distância. É o oposto da correlação, que
   *  precisa de ≥ minSamples pontos E de variação; é exatamente por isso que ela enxerga a pessoa
   *  parada. Subir isto TROCA cobertura por robustez ao outlier (a mediana de 3 é bem mais dura
   *  que a de 1) — é a curva que o torneio de campo mede, não um default para adivinhar. */
  minDistinct?: number;
};

/**
 * A evidência absoluta do par. `dCamMetric` DEVE vir da homografia (metros reais): o proxy de
 * caixa (1/altura) NÃO é comparável a metros — misturar réguas produziria um gap sem sentido
 * físico e um score com cara de medição. Sem métrica, sem evidência: devolve null (abstenção
 * declarada), NUNCA um score fabricado.
 * NÃO exige movimento algum — é este o ponto do módulo inteiro.
 */
export function absoluteEvidence(
  dCamMetric: number | null,
  rssis: readonly number[],
  model: PathLossModel,
  sigmaDecades: number,
  opts?: AbsoluteEvidenceOpts,
): AbsoluteEvidence | null {
  if (dCamMetric === null || !isFiniteNum(dCamMetric)) return null; // proxy/sem H → sem régua métrica
  const minDistinct = opts?.minDistinct !== undefined ? opts.minDistinct : 1;
  const est = estimateTagDistM(model, rssis);
  if (!est || est.nDistinct < minDistinct) return null; // Regra 8: cópia não é medição
  const gapDecades = Math.abs(
    Math.log10(Math.max(est.distM, MIN_DIST_M) / Math.max(dCamMetric, MIN_DIST_M)),
  );
  return {
    dCamM: dCamMetric,
    dTagM: est.distM,
    gapDecades,
    score: absoluteScore(dCamMetric, est.distM, sigmaDecades),
    nDistinct: est.nDistinct,
  };
}

// ——— CALIBRAÇÃO E O σ QUE SAI DO PRÓPRIO DADO (o juiz não-circular) ———

/** Resíduo leave-one-out de UMA âncora: o modelo NUNCA a viu, e ela sabe onde está. */
export type LooResidual = {
  mac: string;
  /** Distância VERDADEIRA âncora→estação (m) — geometria pura, zero RSSI. */
  dTrueM: number;
  /** Distância PREVISTA pelo modelo ajustado SEM esta âncora (m). */
  dPredM: number;
  /** |dPred − dTrue| em metros (a régua que o operador entende). */
  errM: number;
  /** |log10(dPred/dTrue)| em décadas (a régua em que o erro é homogêneo — é esta que vira σ). */
  errDecades: number;
  /** Regime do fit que a previu (o gate de identificabilidade do floor-plot.ts). */
  source: PathLossModel["source"];
};

/**
 * VALIDAÇÃO CRUZADA leave-one-out nas âncoras — o único juiz NÃO-CIRCULAR de campo.
 * Para cada âncora: ajusta o path-loss com TODAS AS OUTRAS, prevê a distância dela pelo RSSI dela,
 * e compara com a distância que a GEOMETRIA já sabe (posição-mundo cadastrada × posição da
 * estação). É exatamente o que a produção faz com a tag de uma PESSOA: o modelo nunca viu aquela
 * tag. Fitar e testar na MESMA âncora seria circular — mediria o mínimo quadrado, não o rádio.
 * Precisa de ≥ 3 âncoras (2 sobram para o fit); com menos, devolve [].
 */
export function looResiduals(anchors: readonly AnchorObs[], stationWorld: Vec2): LooResidual[] {
  const valid = anchors.filter((a) => a && isFiniteNum(a.rssi) && a.world && isFiniteNum(a.world.x));
  if (valid.length < 3) return [];
  const out: LooResidual[] = [];
  for (let i = 0; i < valid.length; i++) {
    const held = valid[i];
    const rest = valid.filter((_, j) => j !== i);
    const model = fitPathLoss(rest, stationWorld);
    const dTrueM = Math.hypot(held.world.x - stationWorld.x, held.world.y - stationWorld.y);
    const dPredM = distFromRssi(model, held.rssi);
    if (!Number.isFinite(dTrueM) || dTrueM <= 0) continue;
    out.push({
      mac: held.mac,
      dTrueM,
      dPredM,
      errM: Math.abs(dPredM - dTrueM),
      errDecades: Math.abs(Math.log10(Math.max(dPredM, MIN_DIST_M) / Math.max(dTrueM, MIN_DIST_M))),
      source: model.source,
    });
  }
  return out;
}

/**
 * O σ do INSTRUMENTO (décadas), medido: RMS dos resíduos LOO em log10. É o que entra no
 * `absoluteScore` — a régua sai do dado, não do gosto. Sem resíduos → null (e quem chama NÃO deve
 * inventar um default: sem σ medido, a evidência absoluta não tem direito de falar).
 */
export function sigmaDecadesFromResiduals(res: readonly LooResidual[]): number | null {
  const xs = res.map((r) => r.errDecades).filter(isFiniteNum);
  if (xs.length === 0) return null;
  const ss = xs.reduce((a, x) => a + x * x, 0);
  const s = Math.sqrt(ss / xs.length);
  return s > 0 ? s : null;
}

/**
 * REGRA 9 — O PONTO CEGO, EM METROS. Com σ décadas de erro, a menor separação RADIAL entre duas
 * pessoas que esta régua distingue (a 1σ) a `dRefM` da estação:
 *      piso = dRef · (10^σ − 1)
 * Se o piso for MAIOR que a distância entre duas mesas vizinhas, a distância absoluta NÃO RESOLVE
 * a identidade dessas duas pessoas — e nenhum torneio, limiar ou peso conserta isso. Declarar o
 * piso é obrigatório ANTES de reportar qualquer precisão: abaixo dele, o que se mede é o
 * instrumento, não o mundo.
 */
export function resolutionFloorM(sigmaDecades: number, dRefM: number): number | null {
  if (!isFiniteNum(sigmaDecades) || sigmaDecades <= 0 || !isFiniteNum(dRefM) || dRefM <= 0)
    return null;
  return dRefM * (Math.pow(10, sigmaDecades) - 1);
}
