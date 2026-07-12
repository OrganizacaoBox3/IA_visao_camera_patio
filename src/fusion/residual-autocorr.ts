// τ_MÓVEL — a autocorrelação do RESÍDUO de RSSI (o que sobra depois de tirar a tendência de
// path-loss). É o INSUMO que faltava para o n_eff honesto da visita (visit-metrics.ts).
//
// ═══ POR QUE ESTE MÓDULO EXISTE (a física, revisada pelo especialista em 2026-07-12) ═══
// A significância da identidade tag↔pessoa usa n_eff = n·(1−ρ)/(1+ρ), com ρ = autocorrelação AR(1)
// do RSSI. Até aqui o repo usava ρ=0,7 FIXO (DEFAULT_RHO de visit-metrics.ts) — um número minerado
// das ÂNCORAS (tags PARADAS no chão: ρ=0,49–0,94 num lag de 2 s ⇒ τ≈2,8–32 s). Mas o ρ certo não é
// uma constante: com ρ(Δt)=e^(−Δt/τ) e n=T/Δt, a lei é
//     n_eff = (T/Δt)·tanh(Δt/2τ)  →  T/(2τ)  quando Δt→0
// ou seja o n_eff SATURA em T/(2τ): passado Δt≪τ, aumentar a cadência não cria informação nenhuma.
// E o τ que governa uma VISITA é o da TAG MÓVEL (o operador andando), não o da âncora parada:
//   • Âncora PARADA: o fading é estático; o que muda é o ambiente (gente passando, portas) → τ longo.
//   • Tag MÓVEL a ~1,2 m/s: a coerência ESPACIAL do fading a 2,4 GHz é ~λ/2 ≈ 6 cm → a tag atravessa
//     um fade a cada ~50 ms; o fading multipercurso vira quase BRANCO, e o que resta de memória é a
//     orientação corporal/marcha → τ curto (previsão registrada do especialista: ~1–2 s).
// Aplicar o τ de âncora parada a uma tag móvel SUBESTIMA o n_eff. Este módulo MEDE o τ móvel.
//
// ═══ CAVEAT DE HARDWARE — o τ medido aqui é um LIMITE INFERIOR ═══
// O scanner (Android/TC22, `ScanResult.getRssi()`) NÃO expõe o CANAL do advertisement (37/38/39 =
// 2402/2426/2480 MHz) — a gravação só tem {mac, rssi}. Leituras consecutivas podem ter chegado por
// canais DIFERENTES, separados por 24/54 MHz — muito além da banda de coerência indoor (~1–4 MHz) —
// logo com fading essencialmente INDEPENDENTE. O salto de canal injeta uma componente BRANCA no
// resíduo, que (1) ENCURTA o τ aparente e (2) INFLA a variância do resíduo (derrubando |r|). Os dois
// efeitos se opõem: mais amostras "independentes", cada uma mais ruidosa. Por isso o τ é INSUMO, não
// veredito — quem decide é a métrica-fim (a visita passa a DECIDIR?). Um receptor que separasse os
// canais (ESP32/NimBLE) veria τ por-canal MAIS LONGO, porém com 3 olhares quase-independentes.
// Para dimensionar esse teto, `estimateTau` devolve `whiteFraction`: a fração da variância do
// resíduo que NÃO tem memória (o patamar da ACF extrapolado a lag→0⁺) — o piso de ruído
// branco (canal + medição/quantização) contra o fading/marcha correlacionado.
//
// Responsabilidade única: dada uma série (ts, dist, rssi), tirar a tendência de path-loss e medir a
// autocorrelação do resíduo. Não carrega arquivo, não decide identidade, não conhece episódios.
// Puro/determinístico. Nunca NaN (série degenerada → null).

/** Uma leitura pareada: instante (ms), distância pessoa→estação (m/proxy) e o RSSI (dBm). */
export type RssiSample = { ts: number; dist: number; rssi: number };

/** Ajuste de path-loss: RSSI ≈ beta + theta·(−log10 d). `theta` = 10·n (n = expoente de path-loss);
 *  `r` = Pearson entre (−log10 d) e RSSI — o mesmo |r| que decide a identidade na visita. */
export type PathLossFit = { beta: number; theta: number; r: number; n: number };

/** Um ponto da ACF empírica em TEMPO (não em índice): correlação média entre resíduos separados por
 *  `lagS` segundos, sobre `pairs` pares. Robusto à amostragem IRREGULAR (o refresh real do RSSI
 *  varia de 0,5 s a vários segundos). `lagS` é a MÉDIA dos lags reais do bin — NÃO o centro do bin:
 *  com amostragem irregular os pares se acumulam numa borda do bin, e usar o centro enviesaria o
 *  ajuste exponencial (medido: τ saía ~65% alto). */
export type AcfPoint = { lagS: number; rho: number; pairs: number };

export type TauEstimate = {
  /** Amostras DISTINTAS usadas (dedup consecutivo — ver `dedupeConsecutiveRssi`). */
  nSamples: number;
  /** Δt entre leituras DISTINTAS (mediana dos intervalos), em segundos — o Δt da lei ρ=e^(−Δt/τ). */
  dtS: number;
  /** Fit de path-loss cuja tendência foi REMOVIDA antes de medir a autocorrelação. */
  fit: PathLossFit;
  /** Desvio-padrão do resíduo (dBm) — o ruído que sobra depois da tendência de distância. */
  residualStd: number;
  /** MÉTODO (a): ρ de 1 lag (índice) do resíduo — o estimador AR(1) clássico. */
  rho1: number;
  /** MÉTODO (a): τ = −Δt/ln(ρ1). 0 quando ρ1≤0 (resíduo já BRANCO no primeiro lag: τ < Δt). */
  tauLag1S: number;
  /** MÉTODO (b): τ do ajuste exponencial ρ(Δ)=A·e^(−Δ/τ) sobre a ACF em tempo. 0 se não ajustável. */
  tauFitS: number;
  /** MÉTODO (b): A do mesmo ajuste — a fração CORRELACIONADA (com memória) da variância do resíduo. */
  correlatedFraction: number;
  /** 1 − A: a fração BRANCA (sem memória) — canal misturado + medição/quantização. Ver caveat. */
  whiteFraction: number;
  /** Pontos da ACF que entraram no ajuste (b). */
  fitPoints: number;
  /** ACF empírica em tempo (para relato/inspeção). */
  acf: AcfPoint[];
};

const DIST_FLOOR_M = 0.1; // mesmo piso de log10(dist) do motor/visit-metrics (GATE_MIN_DIST_M)
const DEFAULT_BIN_S = 1; // largura do bin de lag da ACF em tempo
const DEFAULT_MAX_LAG_S = 20; // horizonte da ACF (τ esperado é de segundos; 20 s cobre com folga)
const DEFAULT_MIN_PAIRS = 20; // bin com menos pares que isso não entra no ajuste (ruidoso demais)
// O ajuste usa o PREFIXO CONTÍGUO de bins com ρ acima deste piso — e PARA no primeiro bin abaixo.
// Por que prefixo e não "todos os bins com ρ>0": na cauda a ACF verdadeira → 0 e o que sobra é
// ruído; filtrar por ρ>0 SELECIONA as flutuações POSITIVAS da cauda, o que achata a reta de ln ρ e
// INFLA o τ (medido: τ saía 3,3 s num AR(1) plantado de 2,0 s). O prefixo não cherry-picka a cauda.
const MIN_RHO_FOR_FIT = 0.05;

function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pearson (mesma fórmula do motor); null se alguma série é (quase) constante. */
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

/**
 * Só as leituras FRESCAS: o snapshot do bt-readings REPETE o último batch entre atualizações reais
 * (a app posta a ~2 Hz, mas a tag só anuncia a ~0,5 Hz), então uma leitura repetida NÃO é amostra
 * nova. MESMA regra do `distinctConsecutive` do motor/visit-metrics: só uma TRANSIÇÃO de valor conta.
 *
 * CAVEAT (declarado, não escondido): dedup POR VALOR funde duas leituras frescas que por acaso deram
 * o MESMO inteiro de RSSI (quantização a 1 dBm). Isso ALONGA levemente o Δt estimado e, por
 * consequência, o τ — viés para CIMA, oposto ao viés para baixo do canal misturado.
 */
export function dedupeConsecutiveRssi(samples: readonly RssiSample[]): RssiSample[] {
  const sorted = [...samples]
    .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.dist) && Number.isFinite(s.rssi))
    .sort((a, b) => a.ts - b.ts);
  const out: RssiSample[] = [];
  for (const s of sorted) {
    if (out.length === 0 || s.rssi !== out[out.length - 1].rssi) out.push(s);
  }
  return out;
}

/**
 * Regressão linear RSSI = β + θ·(−log10 d) — a TENDÊNCIA de path-loss que a identidade explora.
 * Devolve null se <2 amostras ou se (−log10 d) é constante (pessoa parada → nada a ajustar).
 */
export function fitPathLoss(samples: readonly RssiSample[]): PathLossFit | null {
  if (samples.length < 2) return null;
  const x = samples.map((s) => -Math.log10(Math.max(s.dist, DIST_FLOOR_M)));
  const y = samples.map((s) => s.rssi);
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
  }
  if (sxx < 1e-12) return null; // distância constante → sem tendência a remover
  const theta = sxy / sxx;
  const beta = my - theta * mx;
  const r = pearson(x, y);
  if (r === null) return null; // RSSI constante → resíduo nulo, autocorrelação indefinida
  return { beta, theta, r, n: samples.length };
}

/** Resíduo = RSSI_obs − (β + θ·(−log10 d)): o RSSI com a tendência de distância REMOVIDA — só o
 *  fading/marcha/ruído sobra. É sobre ISTO que a autocorrelação tem de ser medida (a tendência de
 *  path-loss é, ela mesma, fortemente autocorrelacionada — medir a ACF do RSSI CRU confundiria o
 *  movimento lento da pessoa com a memória do canal e inflaria o τ). */
export function residualsOf(samples: readonly RssiSample[], fit: PathLossFit): number[] {
  return samples.map(
    (s) => s.rssi - (fit.beta + fit.theta * -Math.log10(Math.max(s.dist, DIST_FLOOR_M))),
  );
}

/**
 * ACF empírica em TEMPO (não em índice): para todo par (i,j), o produto dos resíduos centrados entra
 * no bin do |Δt| que os separa; ρ(bin) = ⟨e_i·e_j⟩_bin / ⟨e²⟩. Escolha deliberada: a série de
 * leituras frescas é IRREGULAR (0,5 s a vários segundos entre advertisements captados), e a ACF por
 * ÍNDICE assumiria um Δt uniforme que não existe. O bin 0 (Δt<binS) inclui o par consigo mesmo? NÃO:
 * só pares i<j — o bin 0 mede correlação de leituras MUITO próximas, não a variância.
 * O(n²) por construção (n = leituras frescas de UM episódio: centenas/poucos milhares — barato).
 */
export function timeBinnedAcf(
  ts: readonly number[],
  e: readonly number[],
  binS = DEFAULT_BIN_S,
  maxLagS = DEFAULT_MAX_LAG_S,
): AcfPoint[] {
  const n = e.length;
  if (n < 2) return [];
  const m = mean(e);
  const c = e.map((v) => v - m);
  let varSum = 0;
  for (const v of c) varSum += v * v;
  const variance = varSum / n;
  if (variance < 1e-12) return [];

  const nBins = Math.max(1, Math.ceil(maxLagS / binS));
  const sums = new Array<number>(nBins).fill(0);
  const lagSums = new Array<number>(nBins).fill(0);
  const counts = new Array<number>(nBins).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const lag = (ts[j] - ts[i]) / 1000;
      if (lag >= maxLagS) break; // ts ordenado → o resto do j só afasta
      const b = Math.floor(lag / binS);
      sums[b] += c[i] * c[j];
      lagSums[b] += lag;
      counts[b]++;
    }
  }
  const out: AcfPoint[] = [];
  for (let b = 0; b < nBins; b++) {
    if (counts[b] === 0) continue;
    out.push({
      lagS: lagSums[b] / counts[b], // lag MÉDIO real do bin (ver AcfPoint) — não o centro do bin
      rho: sums[b] / counts[b] / variance,
      pairs: counts[b],
    });
  }
  return out;
}

/**
 * Duração de cada BLOCO de retenção (s): o snapshot SEGURA um valor de RSSI até o próximo
 * advertisement capturado, então a série crua é uma escada. Cada degrau (run de valores iguais
 * consecutivos) dura do seu 1º ts até o 1º ts do degrau SEGUINTE — ou seja, são exatamente os
 * intervalos entre leituras FRESCAS (os gaps da série deduplicada). O último degrau não tem
 * sucessor → não entra.
 */
export function rssiBlockDurationsS(samples: readonly RssiSample[]): number[] {
  const fresh = dedupeConsecutiveRssi(samples);
  const out: number[] = [];
  for (let i = 1; i < fresh.length; i++) out.push((fresh[i].ts - fresh[i - 1].ts) / 1000);
  return out;
}

/**
 * A HIPÓTESE NULA DO SAMPLE-AND-HOLD — a peça que faltava para não se enganar com o próprio dado.
 *
 * Se as leituras frescas fossem IID (RUÍDO BRANCO, memória ZERO), a série CRUA do snapshot AINDA
 * mostraria uma ACF que decai suavemente — porque dois posts separados por Δ têm probabilidade
 * P(Δ) de caírem no MESMO degrau, e aí são literalmente a MESMA medição (correlação 1). Para um
 * processo de renovação com degraus de duração L:
 *      P(Δ) = E[(L − Δ)⁺] / E[L]
 * Esta função devolve esse P(Δ) — a ACF que o hold SOZINHO fabrica. É a régua contra a qual a ACF
 * crua observada tem de ser comparada ANTES de se falar em "memória do canal": ACF_crua ≈ P(Δ)
 * significa resíduo BRANCO, τ abaixo da resolução (o intervalo de advertising), e QUALQUER τ lido
 * daquela curva é ARTEFATO DE AMOSTRAGEM, não física.
 */
export function holdOnlyAcf(blockDurationsS: readonly number[], lagsS: readonly number[]): number[] {
  if (blockDurationsS.length === 0) return lagsS.map(() => 0);
  const eL = mean(blockDurationsS);
  if (!(eL > 0)) return lagsS.map(() => 0);
  return lagsS.map((lag) => {
    let s = 0;
    for (const L of blockDurationsS) s += Math.max(0, L - lag);
    return s / blockDurationsS.length / eL;
  });
}

/**
 * ACF crua CORRIGIDA do hold — o estimador honesto da autocorrelação do processo FRESCO.
 * Decomposição: ρ_crua(Δ) ≈ P(Δ)·1 + (1 − P(Δ))·ρ_fresca(Δ)  [mesmo degrau → correlação 1]
 *          ⇒    ρ_fresca(Δ) = (ρ_crua(Δ) − P(Δ)) / (1 − P(Δ))
 * Bins com P(Δ) ≈ 1 (lag muito abaixo da duração do degrau) são DESCARTADOS: ali a série crua não
 * carrega informação nenhuma sobre o processo fresco (é a mesma medição repetida), e a divisão
 * explodiria. Este é o número que responde "há memória de verdade?" — e é imune tanto ao platô do
 * hold (que INFLA a ACF crua) quanto ao viés de alternância da dedup (que a DEPRIME).
 */
export function holdCorrectedAcf(
  rawAcf: readonly AcfPoint[],
  blockDurationsS: readonly number[],
  maxSameBlockProb = 0.9,
): AcfPoint[] {
  const p = holdOnlyAcf(blockDurationsS, rawAcf.map((a) => a.lagS));
  const out: AcfPoint[] = [];
  for (let i = 0; i < rawAcf.length; i++) {
    if (p[i] >= maxSameBlockProb) continue;
    out.push({
      lagS: rawAcf[i].lagS,
      rho: (rawAcf[i].rho - p[i]) / (1 - p[i]),
      pairs: rawAcf[i].pairs,
    });
  }
  return out;
}

export type TauOpts = {
  binS?: number;
  maxLagS?: number;
  minPairs?: number;
  /**
   * `false` = NÃO deduplicar; mede sobre a série CRUA do snapshot (valores repetidos incluídos).
   * Default `true` (só leituras frescas).
   *
   * A série CRUA é um DIAGNÓSTICO, não a verdade: ela sofre o platô de sample-and-hold (dois posts
   * dentro do mesmo degrau são a MESMA medição → correlação 1), que fabrica uma ACF suavemente
   * decrescente MESMO com resíduo perfeitamente BRANCO. Para ler física dela é OBRIGATÓRIO passar a
   * ACF por `holdCorrectedAcf` (ou comparar com `holdOnlyAcf`). Serve para EXIBIR o artefato — e
   * para checar se um τ publicado veio dele.
   */
  dedupe?: boolean;
  /** Lag mínimo (s) que entra no AJUSTE exponencial — os bins abaixo dele ainda são REPORTADOS em
   *  `acf`, só não pesam no τ. Default 0. */
  fitMinLagS?: number;
};

/** Resultado do ajuste ρ(Δ)=A·e^(−Δ/τ) sobre uma ACF já pronta. τ=0 = sem decaimento ajustável. */
export type AcfFit = { tauS: number; correlatedFraction: number; points: number };

/**
 * Ajusta ρ(Δ) = A·e^(−Δ/τ) a uma ACF (regressão PONDERADA de ln ρ em Δ). Exportado para poder
 * rodar sobre a ACF CORRIGIDA do hold (`holdCorrectedAcf`), não só sobre a crua.
 *
 * Duas decisões que vieram de erro medido na bancada:
 *  • PREFIXO CONTÍGUO a partir de `fitMinLagS` (para no 1º bin com ρ≤MIN_RHO_FOR_FIT): filtrar TODOS
 *    os bins com ρ>0 selecionaria as flutuações POSITIVAS da cauda (onde ρ_verdadeiro→0), achatando
 *    a reta e INFLANDO o τ — medido: 3,3 s num AR(1) plantado de 2,0 s.
 *  • PESO w=ρ²: var(ln ρ̂) ≈ var(ρ̂)/ρ̂², então o log de um ρ pequeno é muito mais ruidoso; sem peso,
 *    os bins da cauda dominam a reta.
 */
export function fitTauToAcf(
  acf: readonly AcfPoint[],
  opts?: { minPairs?: number; fitMinLagS?: number },
): AcfFit {
  const minPairs = opts?.minPairs ?? DEFAULT_MIN_PAIRS;
  const fitMinLagS = opts?.fitMinLagS ?? 0;
  const usable: AcfPoint[] = [];
  for (const p of acf) {
    if (p.lagS < fitMinLagS) continue;
    if (p.pairs < minPairs || p.rho <= MIN_RHO_FOR_FIT) break;
    usable.push(p);
  }
  if (usable.length < 2) return { tauS: 0, correlatedFraction: 0, points: usable.length };

  const xs = usable.map((p) => p.lagS);
  const ys = usable.map((p) => Math.log(p.rho));
  const ws = usable.map((p) => p.rho * p.rho);
  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (let i = 0; i < xs.length; i++) {
    sw += ws[i];
    swx += ws[i] * xs[i];
    swy += ws[i] * ys[i];
  }
  const mx = swx / sw;
  const my = swy / sw;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += ws[i] * (xs[i] - mx) * (ys[i] - my);
    sxx += ws[i] * (xs[i] - mx) * (xs[i] - mx);
  }
  if (sxx <= 1e-12) return { tauS: 0, correlatedFraction: 0, points: usable.length };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  return {
    tauS: slope < 0 ? -1 / slope : 0, // slope≥0 = ACF que não decai → não há τ a reportar
    correlatedFraction: Math.min(1, Math.max(0, Math.exp(intercept))),
    points: usable.length,
  };
}

/**
 * τ do RESÍDUO por DOIS métodos independentes (ver o cabeçalho do arquivo):
 *  (a) ρ de 1 lag (índice) + a inversão da lei: τ = −Δt/ln(ρ1), com Δt = MEDIANA do intervalo entre
 *      leituras DISTINTAS. Simples e o que a fórmula do n_eff literalmente usa. Frágil quando o
 *      resíduo já é quase branco (ρ1 pequeno → τ despenca) — por isso o método (b).
 *  (b) ajuste exponencial ρ(Δ) = A·e^(−Δ/τ) sobre a ACF em TEMPO (regressão de ln ρ em Δ nos bins
 *      com ρ>0 e pares suficientes). O A separa a variância CORRELACIONADA (memória: fading lento,
 *      marcha, orientação corporal) da BRANCA (canal misturado + quantização): whiteFraction = 1−A.
 * Devolve null se a série não sustenta a medição (<4 leituras frescas, distância constante, RSSI
 * constante). Nunca NaN.
 */
export function estimateTau(
  samples: readonly RssiSample[],
  opts?: TauOpts,
): TauEstimate | null {
  const fresh =
    opts?.dedupe === false
      ? [...samples]
          .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.dist) && Number.isFinite(s.rssi))
          .sort((a, b) => a.ts - b.ts)
      : dedupeConsecutiveRssi(samples);
  if (fresh.length < 4) return null;
  const fit = fitPathLoss(fresh);
  if (!fit) return null;
  const e = residualsOf(fresh, fit);
  const ts = fresh.map((s) => s.ts);

  const gaps: number[] = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
  const dtS = median(gaps);

  const m = mean(e);
  let s2 = 0;
  let lag1 = 0;
  for (let i = 0; i < e.length; i++) s2 += (e[i] - m) * (e[i] - m);
  for (let i = 1; i < e.length; i++) lag1 += (e[i] - m) * (e[i - 1] - m);
  if (s2 < 1e-12) return null; // resíduo nulo (ajuste perfeito) — autocorrelação indefinida
  const residualStd = Math.sqrt(s2 / e.length);
  const rho1 = lag1 / s2;
  // ρ1≤0 ⇒ o resíduo já perdeu a memória DENTRO de um Δt: τ < Δt, e a inversão −Δt/ln ρ não existe.
  // Reportamos 0 (limite inferior honesto), não NaN nem um τ inventado.
  const tauLag1S = rho1 > 0 && dtS > 0 ? -dtS / Math.log(rho1) : 0;

  const acf = timeBinnedAcf(ts, e, opts?.binS ?? DEFAULT_BIN_S, opts?.maxLagS ?? DEFAULT_MAX_LAG_S);
  const { tauS: tauFitS, correlatedFraction, points: usablePoints } = fitTauToAcf(acf, {
    minPairs: opts?.minPairs,
    fitMinLagS: opts?.fitMinLagS,
  });

  return {
    nSamples: fresh.length,
    dtS,
    fit,
    residualStd,
    rho1,
    tauLag1S,
    tauFitS,
    correlatedFraction,
    whiteFraction: 1 - correlatedFraction,
    fitPoints: usablePoints,
    acf,
  };
}

/**
 * O MAIOR τ ainda compatível com uma ACF — o LIMITE SUPERIOR honesto.
 *
 * POR QUE NÃO BASTA O AJUSTE: quando o resíduo é (quase) branco, a ACF corrigida fica indistinguível
 * de ZERO em todo lag e o ajuste exponencial devolve τ=0. Mas τ=0 AFIRMA independência PERFEITA — e
 * o dado não prova isso: ele só prova que τ está ABAIXO da resolução de amostragem (o intervalo de
 * advertising). Publicar τ=0 seria o mesmo pecado (na direção oposta) de publicar o τ do hold.
 *
 * Este estimador inverte a lei bin a bin (τ_i = −Δ_i/ln ρ_i) e devolve o MAIOR τ que algum bin
 * sustenta. Como τ maior ⇒ ρ maior ⇒ n_eff MENOR ⇒ barra de significância MAIS ALTA, este é o número
 * CONSERVADOR: usá-lo nunca infla o resultado a nosso favor. Bins com ρ≤0 (ruído em torno de zero)
 * não sustentam τ nenhum e são ignorados; nenhum bin válido → 0 (branco até onde se enxerga).
 */
export function tauUpperBoundS(
  acf: readonly AcfPoint[],
  opts?: { maxLagS?: number; minPairs?: number },
): number {
  const maxLagS = opts?.maxLagS ?? DEFAULT_MAX_LAG_S;
  const minPairs = opts?.minPairs ?? DEFAULT_MIN_PAIRS;
  let tau = 0;
  for (const p of acf) {
    if (p.lagS > maxLagS || p.pairs < minPairs) continue;
    if (!(p.rho > 0) || p.rho >= 1) continue;
    const t = -p.lagS / Math.log(p.rho);
    if (t > tau) tau = t;
  }
  return tau;
}

/** ρ AR(1) implicado por um τ e um Δt: ρ = e^(−Δt/τ). É o que `visit-metrics` passa a usar quando
 *  recebe `tau`/`dtS` (em vez do ρ fixo) — e é a fonte da SATURAÇÃO do n_eff. τ≤0 → ρ=0 (branco). */
export function rhoFromTau(dtS: number, tauS: number): number {
  if (!(tauS > 0) || !(dtS > 0)) return 0;
  return Math.exp(-dtS / tauS);
}

/** A LEI do especialista, em código: n_eff = (T/Δt)·tanh(Δt/2τ) → T/(2τ) quando Δt→0 (SATURA).
 *  Serve para PREVER o teto de n_eff de um episódio de duração T antes de gastar hardware em
 *  cadência. Idêntico, algebricamente, a n·(1−ρ)/(1+ρ) com n=T/Δt e ρ=e^(−Δt/τ):
 *      (1−e^(−x))/(1+e^(−x)) = tanh(x/2). */
export function nEffFromTau(durationS: number, dtS: number, tauS: number): number {
  if (!(durationS > 0) || !(dtS > 0)) return 0;
  const n = durationS / dtS;
  if (!(tauS > 0)) return n; // τ=0 → resíduo branco → toda amostra é independente
  return n * Math.tanh(dtS / (2 * tauS));
}
