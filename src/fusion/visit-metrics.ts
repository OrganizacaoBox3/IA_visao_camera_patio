// Métricas de VISITA da fusão tag↔pessoa — a CORREÇÃO da unidade de medição pedida pelo parecer
// final do especialista (ADR-014, 2026-07-11). SUPERA conceitualmente a agregação de event-metrics.ts.
//
// O QUE ESTE ARQUIVO CORRIGE (a tese do especialista, provada no próprio repo):
//   event-metrics.ts decide um EPISÓDIO agregando as falas do motor por SOMA DE FISHER-Z sobre os
//   TICKS. Cada tick sai de uma janela DESLIZANTE de 8 s; a 500 ms/tick, ticks consecutivos
//   compartilham 15/16 da amostra. NÃO são 9 evidências independentes — é ~1 evidência repetida.
//   Somar z sobre ticks quase-idênticos INFLA a magnitude do agregado (o próprio cabeçalho de
//   event-metrics.ts admite isso e por isso não deixa z_comb cortar; mas a COBERTURA/decisão ainda
//   herda o otimismo da contagem inflada de ticks). A medição CORRETA de identidade-por-visita é:
//     • UMA correlação de Pearson sobre a janela do EPISÓDIO INTEIRO (a série concatenada — não a
//       soma de z sobre ticks sobrepostos);
//     • n_eff calculado do ρ real (autocorrelação AR(1) medida em campo, ~0,7): n_eff = n·(1−ρ)/(1+ρ);
//     • UMA decisão por visita, com significância honesta (Fisher-z contra n_eff, não contra n bruto).
//
// HIPÓTESE H1 (o que este arquivo decide): "o episódio de aproximação contém informação suficiente
// para a identidade". Testável hoje, sem hardware.
//
// ROTA DE COLETA ESCOLHIDA (documentada — o prompt oferecia três):
//   Repliquei a coleta MÍNIMA de série bruta, NÃO reusei diagnoseFunnel (que só expõe corr POR TICK
//   e perderia os pontos brutos ao reconcatenar). Este módulo é PURO: consome `VisitTick[]` já com
//   (dist da pista, rssi por tag) por tick — a produção/os testes montam isso via buildFusionFrame
//   (frame.ts), o MESMO cálculo de distância (homografia/proxy) do motor. Ao fim do episódio, UMA
//   correlação sobre a série concatenada (dist × rssi de todos os ticks do episódio). A correlação
//   usa a série ALINHADA COMPLETA (rssi repetido do snapshot incluído — igual ao pearson do motor,
//   p/ que r_episódio seja comparável ao corr por tick do funil); só o n de n_eff DEDUPLICA os rssi
//   repetidos (distinctConsecutive — o snapshot repete o último batch entre atualizações reais; só
//   uma TRANSIÇÃO de valor é leitura fresca).
//
// DECISÃO DE VISITA (ranqueamento vs significância — a MESMA decomposição do motor):
//   - QUEM: a tag de maior SCORE de identidade s = −r (casamento físico: RSSI cai com a distância →
//     r<0 → s>0). Ranquear por s (não por |z| cru) é deliberado e documentado: uma correlação
//     fortemente POSITIVA é evidência CONTRA a identidade daquela tag, não a favor — |z| a premiaria
//     por engano. Para a carregadora verdadeira r≪0, então s e |z| concordam.
//   - SE VALE FALAR: o vencedor precisa ser SIGNIFICATIVO — |z| ≥ z_crit·√(1/(n_eff−3)), com
//     z = atanh(r) e n_eff do ρ real; n_eff ≤ 3 → variância de Fisher indefinida → nunca fala.
//   Nenhum vencedor significativo com s>0 → visita INCONCLUSIVA (abstenção honesta; o invariante do
//   dono: rótulo errado é pior que nenhum).
//
// Responsabilidade única: só medir/decidir por visita. Não simula, não associa, não alimenta o
// motor. Puro e determinístico. Nenhum NaN (séries vazias/constantes → candidato não entra).
//
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A LEI COMPLETA DO n_eff (2026-07-12 — a correção de CONTAGEM, achada por revisão externa)
//
//     n_eff = (T/Δt) · tanh(Δt / 2τ)   ≤   min( T/Δt_tag , T/(2τ) )
//                                             └─ CONTAGEM ─┘  └─ AUTOCORRELAÇÃO ─┘
//   (a forma exata do 1º termo, com a borda da grade de advertising: ⌈T/Δt_tag⌉+1 — ver
//    `maxDistinctReadings`. O min acima é a LEI; a função é o teto com as bordas certas.)
//
// O gate das Ondas 0/1 só tinha o SEGUNDO termo (o desconto AR(1)) e ignorava o PRIMEIRO — e o
// primeiro é uma verdade de CONTAGEM, não um modelo: **não pode existir mais evidência independente
// do que medições DISTINTAS**. A tag anuncia a cada Δt_tag (medido em campo: ~2,5 s); um episódio de
// T segundos NÃO PODE conter mais que ⌊T/Δt_tag⌋+1 leituras frescas, e n_eff ≤ isso, sempre.
//
// QUEM MORDE, em cada regime:
//   • Tag PARADA / τ longo → morde o 2º termo (autocorrelação). Foi o regime que o gate assumiu.
//   • Tag MÓVEL / τ curto (o resíduo é BRANCO na escala observável — residual-autocorr.ts) → o 2º
//     termo EXPLODE (τ→0 ⇒ T/2τ → ∞) e quem morde é o **1º**: a TAXA DE ATUALIZAÇÃO DA TAG.
// CONSEQUÊNCIA (inverte a leitura do laudo anterior): com τ pequeno NÃO há saturação em 1–2 Hz. A
// cadência volta a ser alavanca LINEAR — não para vencer autocorrelação (não há), mas para ter
// PONTOS SUFICIENTES para ajustar a reta. E o teto de pontos é físico: a tag.
//
// O BUG QUE ISTO MATA (confirmado, 2026-07-12): o SIMULADOR emitia RSSI fresco a cada 1 s
// (`rssiPeriodTicks=2` × 500 ms), mas a tag REAL anuncia a cada ~2,5 s. O sim entregava 2,5× mais
// leituras genuinamente distintas do que a física permite ⇒ n_eff inflado 2,5× ⇒ cobertura inflada.
// O n_eff máx de 39 que reportamos exigiria um episódio de ~97 s com a tag real. Ver REAL_TAG_PERIOD_TICKS
// em sim.ts. A MÉTRICA aqui estava certa (distinctConsecutive deduplica); a FÍSICA da fonte é que
// mentia. Este cabeçalho + `maxDistinctReadings` + o clamp de `nEff` fecham a porta para sempre.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REGRA 10 — O PISO DA FÓRMULA ≠ O PISO OPERACIONAL (2026-07-12, achado de revisão externa)
//
// O gate `nEff > 3` que este módulo usava é o piso da FÓRMULA de Fisher: abaixo dele √(n_eff−3) é
// imaginário e o teste NÃO EXISTE. Nós o tratamos como se fosse o piso onde o teste FUNCIONA. Não é.
// A distribuição amostral de r é fortemente ASSIMÉTRICA para n pequeno; a transformação atanh só
// corrige em parte; o nível de significância NOMINAL (95%) é FANTASIA abaixo de ~8–10 amostras
// efetivas — o teste "passa" com |r| que é ruído, e a decisão sai errada.
//
// MEDIDO (não postulado), na bancada — curva precisão × n_eff, ver receiver-at-destino.test.ts:
// a precisão de decisão é ~0% na faixa n_eff∈[3,5), ~15% em [6,7), e só ESTABILIZA em ~100% a partir
// de n_eff ≈ 10. O piso OPERACIONAL é EMPÍRICO, e é onde a curva satura — não onde a fórmula existe.
//
// `minNEff` (VisitOpts) torna esse piso um PARÂMETRO EXPLÍCITO. Default 3 = comportamento histórico
// (aditivo, nada muda sem passá-lo). Toda medição que dimensiona hardware DEVE passá-lo.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** O que um tick sabe de UMA pista: a verdade daquele trackId (MAC ou null=sem tag; para dado real
 *  sem anotação, sempre null → só span/consistência, não precisão) e sua DISTÂNCIA à estação no
 *  tick (metros calibrados ou proxy monotônico — o `dist` de TrackDist, montado por buildFusionFrame). */
export type VisitTrackObs = { trackId: number; truthTag: string | null; dist: number };

/** Um tick avaliável: instante + pistas correntes + o RSSI de CADA tag lida no tick (snapshot do
 *  bt-readings — uma leitura por tag; ausência de uma tag = não observada naquele tick). */
export type VisitTick = {
  ts: number;
  tracks: readonly VisitTrackObs[];
  rssiByTag: Readonly<Record<string, number>>;
};

/** Diagnóstico de UMA tag candidata sobre a janela do EPISÓDIO INTEIRO (uma correlação, não por tick). */
export type VisitCandidate = {
  tag: string;
  /** r de Pearson (rssi × distância) sobre a série concatenada do episódio; casamento físico → r<0. */
  r: number;
  /** Amostras alinhadas (pontos da série que entraram na correlação — rssi repetido incluído). */
  n: number;
  /** Amostras de RSSI DISTINTAS (dedup consecutivo do snapshot) — o n de n_eff. */
  nDistinct: number;
  /** n_eff = min( nDistinct·(1−ρ)/(1+ρ) , nDistinct ) — desconto AR(1), TRAVADO pelo teto de
   *  CONTAGEM (não existe mais evidência independente do que medição distinta). Ver "A LEI COMPLETA
   *  DO n_eff" no cabeçalho. O clamp só é ativo para ρ<0 (a fórmula já o respeita para ρ≥0), mas é
   *  explícito de propósito: é o invariante, não uma consequência que alguém pode reintroduzir. */
  nEff: number;
  /** z = atanh(r) (Fisher). */
  z: number;
  /** score de IDENTIDADE = −r (o casamento físico; >0 = RSSI cai com distância). */
  score: number;
  /** |z| ≥ z_crit·√(1/(n_eff−3)) E n_eff > minNEff — o teste de significância da correlação do
   *  episódio. ATENÇÃO: o `3` de √(1/(n_eff−3)) é a FÓRMULA (onde o teste EXISTE); o piso que decide
   *  se ele é CONFIÁVEL é `minNEff` (Regra 10 — medido, não postulado; ver o cabeçalho). */
  significant: boolean;
};

/** Uma visita (episódio) já decidida: a janela contígua + a decisão ÚNICA + o span radial. */
export type VisitEpisode = {
  trackId: number;
  truthTag: string | null;
  startTs: number;
  endTs: number;
  nTicks: number;
  /** Span radial em DÉCADAS: std populacional de log10(dist) sobre o episódio — a métrica de
   *  IDENTIFICABILIDADE. ATENÇÃO À MÉTRICA (correção 2026-07-12): este é o STD, não o range. Os
   *  limiares "~0,42/~0,9 década" do ADR-014 são RANGE (log10(8/3)=0,426 numa aproximação 8→3 m;
   *  log10(8/1)=0,903 numa 8→1 m), NÃO std — o teto de std de uma aproximação reta idealizada é
   *  ~0,33 déc. Comparar spanDecades(std) com aqueles limiares(range) é maçã×laranja; use
   *  `rangeDecades` para comparar com o ADR. (A decisão de visita NÃO usa o span — usa a
   *  significância Fisher-z/n_eff; o span é descritivo.) 0 quando <2 amostras de distância. */
  spanDecades: number;
  /** Range radial em DÉCADAS: max−min de log10(dist) sobre o episódio — a métrica COMPARÁVEL aos
   *  limiares do ADR-014 (0,42/0,9 são range). 0 quando <2 amostras. */
  rangeDecades: number;
  candidates: VisitCandidate[];
  /** A tag decidida para a visita (null = inconclusiva — nenhum candidato significativo com s>0). */
  decisionTag: string | null;
  decided: boolean;
  /** decisionTag === truthTag quando decidida; null quando inconclusiva ou sem verdade anotada. */
  correct: boolean | null;
};

export type VisitMetrics = {
  episodes: number; // episódios totais (inclusive de pista SEM tag)
  episodesWithTag: number; // episódios cuja tag-verdade ≠ null (as visitas que o cliente compra)
  decided: number; // visitas DECIDIDAS (vencedor significativo com s>0)
  decidedWithTag: number; // desses, de pista COM tag (o resto = falso-evento)
  decidedCorrect: number; // decididos com decisionTag == tag-verdade
  falseVisits: number; // decided − decidedWithTag: visita decidida sobre pista SEM tag
  inconclusive: number; // episodesWithTag NÃO decididos (abstenção honesta sobre quem tinha tag)
  /** decidedCorrect/decided — inclui falso-evento como erro; 1 se nada decidido (abster é honesto). */
  visitPrecision: number;
  /** decidedCorrect/decidedWithTag — precisão de IDENTIDADE isolada do eixo "rejeitar sem-tag". */
  visitPrecisionTagged: number;
  /** decidedWithTag/episodesWithTag — cobertura na unidade do cliente. */
  visitCoverage: number;
  /** Mediana do span radial STD (décadas) sobre os episódios com span definido — identificabilidade. */
  medianSpanDecades: number;
  /** Mediana do RANGE radial (décadas) — comparável aos limiares 0,42/0,9 do ADR-014 (que são range). */
  medianRangeDecades: number;
};

const DEFAULT_WARMUP_MS = 8000; // idem event-metrics/identity: a janela de 8 s do motor enchendo
const DEFAULT_RHO = 0.7; // autocorrelação AR(1) do RSSI MEDIDA em campo (mineração das 6 h)
const DEFAULT_Z_CRIT = 1.96; // 95% bicaudal
const DEFAULT_MIN_SAMPLES = 5; // mesma régua de amostras alinhadas do motor (minSamples)
/**
 * PISO DE n_eff (Regra 10) — o default 3 é o da FÓRMULA (onde √(n_eff−3) deixa de ser imaginário),
 * NÃO o piso operacional (onde o teste é CONFIÁVEL). São coisas diferentes e nós as confundimos:
 * a distribuição amostral de r é fortemente assimétrica para n pequeno, atanh só corrige em parte, e
 * o nível nominal de 95% é FANTASIA abaixo de ~8–10 amostras efetivas. Medido na bancada
 * (receiver-at-destino.test.ts, "CURVA precisão × n_eff"): a precisão de decisão sobe de ~0% na
 * faixa n_eff∈[3,5) para ~100% a partir de n_eff≈10 — o piso OPERACIONAL é EMPÍRICO.
 * Mantido em 3 como DEFAULT por ser aditivo (comportamento histórico intacto); quem decide compra de
 * hardware deve passar `minNEff` explicitamente com o piso medido.
 */
const DEFAULT_MIN_NEFF = 3;
const FISHER_R_CLAMP = 1 - 1e-12; // atanh(±1)=±∞ (mesma constante/razão do motor)
const DIST_FLOOR_M = 0.1; // piso de log10(dist) (mesmo GATE_MIN_DIST_M do motor)

/**
 * ρ EFETIVO de um par (tau, dtS) — a CORREÇÃO FÍSICA do n_eff (especialista, 2026-07-12).
 *
 * O ρ FIXO (DEFAULT_RHO=0,7) é um erro de categoria: ρ NÃO é uma constante do RSSI, é uma função da
 * CADÊNCIA. A lei é ρ(Δt) = e^(−Δt/τ), com τ = tempo de correlação do resíduo. Duas consequências
 * que o ρ fixo escondia:
 *   1. n_eff SATURA. Com n = T/Δt e ρ = e^(−Δt/τ):
 *          n_eff = n·(1−ρ)/(1+ρ) = (T/Δt)·tanh(Δt/2τ)  →  T/(2τ)  quando Δt→0.
 *      Com ρ FIXO, dobrar a cadência DOBRA o n_eff (n dobra, ρ não muda) — uma alavanca de hardware
 *      que NÃO EXISTE. Com a lei, dobrar a cadência quase não move o n_eff (ρ SOBE junto).
 *   2. O τ que vale é o da TAG MÓVEL, não o da ÂNCORA PARADA. Medido em campo (residual-autocorr.ts,
 *      gravação de 2026-07-11_20): τ_móvel ≤ 1,68 s — o resíduo é BRANCO na escala observável —
 *      contra os 2,8–32 s minerados das âncoras que geraram o ρ=0,7. Aplicar o τ de âncora à tag
 *      móvel SUBESTIMA o n_eff (a barra de significância fica alta demais e a visita se cala).
 *
 * ADITIVO E OPT-IN: sem `tau`, o comportamento é o de sempre (ρ fixo). Ver VisitOpts.
 */
export function effectiveRho(rhoFixed: number, tau?: number, dtS?: number): number {
  if (tau === undefined || !Number.isFinite(tau) || tau <= 0) return rhoFixed;
  if (dtS === undefined || !Number.isFinite(dtS) || dtS <= 0) return rhoFixed;
  return Math.exp(-dtS / tau);
}

/**
 * TETO FÍSICO DE CONTAGEM — quantas leituras DISTINTAS de RSSI um episódio de `spanMs` pode conter,
 * dada uma tag que anuncia a cada `dtTagS` segundos. É ARITMÉTICA, não estatística:
 *
 *     nDistinct ≤ ⌈ span / Δt_tag ⌉ + 1
 *
 * DERIVAÇÃO (os dois termos, ambos apertados — medido, não chutado):
 *   • ⌈span/Δt⌉ = o nº MÁXIMO de advertisements que caem DENTRO da janela (t0, t0+span]. É ⌈⌉ e não
 *     ⌊⌋ porque a grade de advertising não está alinhada com o início do episódio: uma janela de
 *     7,5 s pode conter 8 refreshes de 1 s se cair "atravessada" na grade.
 *   • "+1" = a leitura CARREGADA: no instante t0 o snapshot já segura um valor, vindo de um
 *     advertisement ANTERIOR ao episódio. É evidência legítima (a leitura existiu), mas é UMA só.
 *
 * `span` = endTs − startTs do episódio (tempo de PAREDE coberto — não nTicks, não nº de amostras).
 * Amostrar/POSTar mais rápido que a tag anuncia NÃO cria leituras distintas (o snapshot repete o
 * último batch — sample-and-hold; `distinctConsecutive` deduplica). Qualquer nDistinct acima deste
 * teto é BUG DE CONTAGEM NA FONTE do dado, e infla o n_eff — e a cobertura — linearmente.
 * Devolve 0 para span negativo/não-finito ou Δt_tag ≤ 0 (entrada inválida, nunca NaN mudo).
 */
export function maxDistinctReadings(spanMs: number, dtTagS: number): number {
  if (!Number.isFinite(spanMs) || spanMs < 0) return 0;
  if (!Number.isFinite(dtTagS) || dtTagS <= 0) return 0;
  return Math.ceil(spanMs / 1000 / dtTagS) + 1;
}

/** Uma violação do invariante de contagem: episódio cujo nDistinct excedeu o teto físico da tag. */
export type CountingViolation = {
  trackId: number;
  tag: string;
  spanMs: number;
  nDistinct: number;
  ceiling: number;
};

/**
 * REGRA 8 (o assert permanente): varre episódios já decididos e devolve TODA violação do invariante
 * de contagem — `nDistinct > ⌊span/Δt_tag⌋+1` (mais leituras frescas do que a tag pode ter emitido)
 * ou `nEff > nDistinct` (mais evidência independente do que medição distinta). Lista VAZIA = são.
 *
 * Não lança: é um SENSOR, e quem o consome (teste/CI) decide o que fazer. É contagem, não modelo —
 * um assert barato que trava no CI para sempre contra reintrodução de contagem de duplicatas ou de
 * uma fonte de dados que anuncia mais rápido do que a tag real.
 */
export function countingViolations(
  episodes: readonly VisitEpisode[],
  dtTagS: number,
): CountingViolation[] {
  const out: CountingViolation[] = [];
  for (const ep of episodes) {
    const spanMs = ep.endTs - ep.startTs;
    const ceiling = maxDistinctReadings(spanMs, dtTagS);
    for (const c of ep.candidates) {
      if (c.nDistinct > ceiling || c.nEff > c.nDistinct) {
        out.push({ trackId: ep.trackId, tag: c.tag, spanMs, nDistinct: c.nDistinct, ceiling });
      }
    }
  }
  return out;
}

type VisitOpts = {
  warmupMs?: number;
  /** ρ AR(1) FIXO (default 0,7). Ignorado quando `tau` E `dtS` são fornecidos — ver `effectiveRho`. */
  rho?: number;
  /** Tempo de correlação do RESÍDUO de RSSI, em SEGUNDOS (opcional). Presente (com `dtS`) → o ρ passa
   *  a ser CALCULADO por ρ=e^(−dtS/tau) em vez do fixo, e o n_eff SATURA como a física manda.
   *  AUSENTE → comportamento 100% intacto (ρ fixo). Medir com `residual-autocorr.ts`. */
  tau?: number;
  /** Intervalo REAL entre leituras DISTINTAS de RSSI, em SEGUNDOS (a cadência de advertising
   *  efetiva). Só tem efeito junto de `tau`. */
  dtS?: number;
  zCrit?: number;
  minSamples?: number;
  /** PISO OPERACIONAL de n_eff (Regra 10). Um candidato só pode ser `significant` com
   *  n_eff > minNEff. Default 3 = o piso da FÓRMULA (onde o teste EXISTE) — ADITIVO, comportamento
   *  histórico intacto. O piso onde o teste é CONFIÁVEL é MEDIDO (curva precisão×n_eff), não
   *  postulado: valores <3 são elevados a 3 (abaixo disso √(n_eff−3) nem existe). */
  minNEff?: number;
};

/**
 * INTERVALO DE WILSON (95% por default) para uma proporção k/n — a honestidade estatística
 * OBRIGATÓRIA de toda precisão/cobertura reportada por este módulo (Regra 10).
 *
 * POR QUE WILSON E NÃO "k/n": 13/13 NÃO é 100% — é "a melhor estimativa é 100%, e o dado é
 * compatível com qualquer coisa acima de ~77%". O intervalo normal (Wald) COLAPSA para largura zero
 * em p̂=0 ou p̂=1 (afirma certeza absoluta a partir de 13 amostras — absurdo); Wilson não colapsa,
 * porque resolve a desigualdade no p VERDADEIRO, não no estimado. n=0 → [0,1] (nada se sabe).
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = DEFAULT_Z_CRIT,
): { lo: number; hi: number } {
  if (!Number.isFinite(n) || n <= 0) return { lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lo: Math.max(0, (center - half) / denom),
    hi: Math.min(1, (center + half) / denom),
  };
}

/** "62,5% [IC95 35,4–83,7], n=16" — o formato ÚNICO de reporte de proporção deste arco. Nunca se
 *  reporta precisão sem o IC e sem o n (Regra 10). */
export function formatProportion(successes: number, n: number): string {
  if (n <= 0) return "— (n=0)";
  const { lo, hi } = wilsonInterval(successes, n);
  const pc = (x: number): string => (100 * x).toFixed(1);
  return `${pc(successes / n)}% [IC95 ${pc(lo)}–${pc(hi)}], n=${n}`;
}

/** Média (assume não-vazio). */
function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Pearson de duas séries pareadas; null se alguma é (quase) constante. MESMA fórmula do motor. */
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

/** Nº de valores DISTINTOS CONSECUTIVOS (dedup de vizinhos repetidos) — o n de n_eff. MESMA lógica
 *  do distinctConsecutive do motor: o snapshot repete o último batch entre atualizações reais, então
 *  só uma TRANSIÇÃO de valor conta leitura fresca. */
function distinctConsecutive(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let n = 1;
  for (let i = 1; i < xs.length; i++) if (xs[i] !== xs[i - 1]) n++;
  return n;
}

/** std populacional de log10(max(dist, piso)) — o span radial em décadas. 0 se <2 amostras. */
function spanDecades(dists: readonly number[]): number {
  if (dists.length < 2) return 0;
  const logs = dists.map((d) => Math.log10(Math.max(d, DIST_FLOOR_M)));
  const m = mean(logs);
  let s = 0;
  for (const x of logs) s += (x - m) * (x - m);
  return Math.sqrt(s / logs.length);
}

/** range de log10(max(dist, piso)) — max−min em décadas; a métrica comparável aos limiares do
 *  ADR-014 (0,42/0,9 são range, não std). 0 se <2 amostras. */
function rangeDecades(dists: readonly number[]): number {
  if (dists.length < 2) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of dists) {
    const l = Math.log10(Math.max(d, DIST_FLOOR_M));
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  return hi - lo;
}

/** Um episódio recortado (antes de decidir): a série de amostras contíguas. */
type RawEpisode = {
  trackId: number;
  truthTag: string | null;
  samples: { dist: number; rssiByTag: Readonly<Record<string, number>> }[];
  startTs: number;
  endTs: number;
};

/**
 * Recorta os ticks em episódios de VISITA: janela contígua de um trackId em que a pista esteve
 * presente E a tag-verdade foi estável. Quebra em ausência da pista OU troca de verdade (id-switch
 * do tracker → dois episódios). MESMA definição de episódio do event-metrics.ts (a MÉTRICA é que
 * difere). Ticks com ts < warmupMs são ignorados (janela do motor enchendo).
 */
function buildEpisodes(ticks: readonly VisitTick[], warmupMs: number): RawEpisode[] {
  const sorted = [...ticks].filter((t) => t.ts >= warmupMs).sort((a, b) => a.ts - b.ts);
  const open = new Map<number, RawEpisode>();
  const done: RawEpisode[] = [];

  for (const tick of sorted) {
    const seen = new Set<number>();
    for (const o of tick.tracks) {
      seen.add(o.trackId);
      const cur = open.get(o.trackId);
      const sample = { dist: o.dist, rssiByTag: tick.rssiByTag };
      if (cur && cur.truthTag === o.truthTag) {
        cur.samples.push(sample);
        cur.endTs = tick.ts;
      } else {
        if (cur) done.push(cur); // troca de verdade → fecha o anterior e abre um novo
        open.set(o.trackId, {
          trackId: o.trackId,
          truthTag: o.truthTag,
          samples: [sample],
          startTs: tick.ts,
          endTs: tick.ts,
        });
      }
    }
    for (const id of [...open.keys()]) if (!seen.has(id)) {
      done.push(open.get(id)!);
      open.delete(id);
    }
  }
  for (const ep of open.values()) done.push(ep);
  return done;
}

/**
 * Decide UMA visita a partir do episódio recortado: UMA correlação por tag candidata sobre a série
 * INTEIRA, n_eff do ρ real, e a decisão única (ver cabeçalho). Determinístico; ordem lexicográfica
 * de tag no empate.
 */
function decideEpisode(
  ep: RawEpisode,
  rho: number,
  zCrit: number,
  minSamples: number,
  minNEff: number,
): VisitEpisode {
  // Universo de tags candidatas: toda tag lida em ALGUM tick do episódio.
  const tagUniverse = new Set<string>();
  for (const s of ep.samples) for (const tag of Object.keys(s.rssiByTag)) tagUniverse.add(tag);

  const candidates: VisitCandidate[] = [];
  for (const tag of [...tagUniverse].sort()) {
    const rssi: number[] = [];
    const dist: number[] = [];
    for (const s of ep.samples) {
      const r = s.rssiByTag[tag];
      if (r === undefined || !Number.isFinite(r) || !Number.isFinite(s.dist)) continue;
      rssi.push(r);
      dist.push(s.dist);
    }
    if (rssi.length < minSamples) continue;
    const r = pearson(rssi, dist);
    if (r === null) continue; // série constante → tag não é candidata
    const nDistinct = distinctConsecutive(rssi);
    // INVARIANTE DE CONTAGEM (trava explícita — ver "A LEI COMPLETA DO n_eff" no cabeçalho):
    // n_eff NUNCA excede o nº de medições DISTINTAS. Segue da fórmula para ρ≥0; o Math.min torna
    // impossível violá-lo mesmo se alguém passar ρ<0 ou trocar a fórmula do desconto.
    const nEff = Math.min((nDistinct * (1 - rho)) / (1 + rho), nDistinct);
    const rc = Math.max(-FISHER_R_CLAMP, Math.min(FISHER_R_CLAMP, r));
    const z = Math.atanh(rc);
    // DOIS pisos, e eles NÃO são a mesma coisa (Regra 10):
    //   • o `3` dentro de √(1/(nEff−3)) é a FÓRMULA de Fisher (abaixo dele o teste nem existe);
    //   • `minNEff` é o piso OPERACIONAL (abaixo dele o teste existe mas MENTE — o nível nominal de
    //     95% não se sustenta com r assimétrico e n pequeno). Default = 3 (aditivo).
    const significant = nEff > minNEff && Math.abs(z) >= zCrit * Math.sqrt(1 / (nEff - 3));
    candidates.push({ tag, r, n: rssi.length, nDistinct, nEff, z, score: -r, significant });
  }

  // QUEM: maior score de identidade (−r); empate → menor tag lex (candidates já ordenado).
  let winner: VisitCandidate | null = null;
  for (const c of candidates) if (winner === null || c.score > winner.score) winner = c;
  // SE: vencedor significativo E casamento físico (s>0).
  const decided = winner !== null && winner.significant && winner.score > 0;
  const decisionTag = decided ? winner!.tag : null;

  const dists = ep.samples.map((s) => s.dist).filter((d) => Number.isFinite(d));
  return {
    trackId: ep.trackId,
    truthTag: ep.truthTag,
    startTs: ep.startTs,
    endTs: ep.endTs,
    nTicks: ep.samples.length,
    spanDecades: spanDecades(dists),
    rangeDecades: rangeDecades(dists),
    candidates,
    decisionTag,
    decided,
    correct: decided ? decisionTag === ep.truthTag : null,
  };
}

/**
 * Recorta os ticks em episódios de visita e decide cada um (uma correlação sobre a janela inteira).
 * Base de computeVisitMetrics E do relato sem-verdade (gravação de campo: truthTag null em toda
 * pista → só span/candidatos, precisão não se aplica).
 */
export function computeVisitEpisodes(
  ticks: readonly VisitTick[],
  opts?: VisitOpts,
): VisitEpisode[] {
  const warmupMs = opts?.warmupMs ?? DEFAULT_WARMUP_MS;
  // ρ do par (tau, dtS) quando fornecidos — senão o ρ fixo de sempre (ADITIVO, ver effectiveRho).
  const rho = effectiveRho(opts?.rho ?? DEFAULT_RHO, opts?.tau, opts?.dtS);
  const zCrit = opts?.zCrit ?? DEFAULT_Z_CRIT;
  const minSamples = opts?.minSamples ?? DEFAULT_MIN_SAMPLES;
  // O piso NUNCA pode ser menor que o da fórmula (√(nEff−3) imaginário) — clamp explícito.
  const minNEff = Math.max(DEFAULT_MIN_NEFF, opts?.minNEff ?? DEFAULT_MIN_NEFF);
  return buildEpisodes(ticks, warmupMs).map((ep) =>
    decideEpisode(ep, rho, zCrit, minSamples, minNEff),
  );
}

/** Mediana (mediana inferior) de uma lista; 0 se vazia. */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Métricas de VISITA (a régua na unidade da decisão do cliente — ADR-014). Uma decisão por
 * episódio, precisão/cobertura/span. Ver cabeçalho para a correção conceitual sobre event-metrics.ts.
 */
export function computeVisitMetrics(ticks: readonly VisitTick[], opts?: VisitOpts): VisitMetrics {
  const episodes = computeVisitEpisodes(ticks, opts);

  let episodesWithTag = 0;
  let decided = 0;
  let decidedWithTag = 0;
  let decidedCorrect = 0;
  const spans: number[] = [];
  const ranges: number[] = [];

  for (const ep of episodes) {
    const withTag = ep.truthTag !== null;
    if (withTag) episodesWithTag++;
    if (ep.nTicks >= 2) {
      spans.push(ep.spanDecades);
      ranges.push(ep.rangeDecades);
    }
    if (ep.decided) {
      decided++;
      if (withTag) decidedWithTag++;
      if (ep.correct === true) decidedCorrect++;
    }
  }

  return {
    episodes: episodes.length,
    episodesWithTag,
    decided,
    decidedWithTag,
    decidedCorrect,
    falseVisits: decided - decidedWithTag,
    inconclusive: episodesWithTag - decidedWithTag,
    visitPrecision: decided === 0 ? 1 : decidedCorrect / decided,
    visitPrecisionTagged: decidedWithTag === 0 ? 1 : decidedCorrect / decidedWithTag,
    visitCoverage: episodesWithTag === 0 ? 0 : decidedWithTag / episodesWithTag,
    medianSpanDecades: median(spans),
    medianRangeDecades: median(ranges),
  };
}

/** Tabela texto alinhada (estilo formatEventTable) — visita (janela única) por cenário. */
export function formatVisitTable(rows: { scenario: string; m: VisitMetrics }[]): string {
  const header = [
    "cenário",
    "eps",
    "c/tag",
    "decid",
    "falso-v",
    "VISIT-prec%",
    "VISIT-prec(c/tag)%",
    "VISIT-cob%",
    "span-med(déc)",
  ];
  const body = rows.map(({ scenario, m }) => [
    scenario,
    String(m.episodes),
    String(m.episodesWithTag),
    String(m.decided),
    String(m.falseVisits),
    (m.visitPrecision * 100).toFixed(1),
    (m.visitPrecisionTagged * 100).toFixed(1),
    (m.visitCoverage * 100).toFixed(1),
    m.medianSpanDecades.toFixed(3),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
}

// ——— CONTROLE NEGATIVO: surrogate por DESLOCAMENTO TEMPORAL CIRCULAR (regra institucionalizada nº4) ———
//
// POR QUE NÃO "embaralhar identidade das tags": o próprio repo provou (shuffle-baseline.ts) que
// renomear QUAL tag é dona de qual série é ESTRUTURALMENTE CEGO — a série de RSSI ainda corresponde
// ao movimento real de alguém, só o rótulo mudou; a correspondência física RSSI↔trajetória sobrevive.
// Não ataca a pergunta que importa: "r_episódio alto é SINAL físico ou ARTEFATO da autocorrelação
// das duas séries?".
//
// O SURROGATE CORRETO: rotacionar CIRCULARMENTE a série de RSSI de cada tag por um offset fixo
// grande. Preserva EXATAMENTE os valores, a distribuição E a autocorrelação de cada série (o que
// alimenta n_eff), mas DESTRÓI o alinhamento temporal com a trajetória da câmera. Com o casamento
// físico dissolvido, a precisão de visita TEM de desabar ao nível de chute — controle positivo
// embutido: se NÃO desabar, o r alto vinha da autocorrelação (artefato), não do casamento, e o
// número de H1 não vale.

/**
 * Devolve os MESMOS ticks com a série de RSSI de CADA tag rotacionada circularmente no tempo. Por
 * tag: extrai a sequência de valores nos ticks em que ela aparece (ordem temporal), rotaciona por
 * `shiftTicks` posições (default = metade do comprimento da série da tag → decorrelação máxima,
 * determinístico) e reatribui aos MESMOS instantes. Tracks/ts intactos — só o RSSI viaja no tempo.
 * Puro/determinístico. Tags com <2 leituras não rotacionam (nada a deslocar).
 */
export function circularShiftTicks(ticks: readonly VisitTick[], shiftTicks?: number): VisitTick[] {
  const sorted = [...ticks].sort((a, b) => a.ts - b.ts);
  const posByTag = new Map<string, number[]>(); // índices (em sorted) onde a tag foi lida
  const valByTag = new Map<string, number[]>(); // valores de RSSI na mesma ordem
  for (let i = 0; i < sorted.length; i++) {
    for (const [tag, rssi] of Object.entries(sorted[i].rssiByTag)) {
      if (!Number.isFinite(rssi)) continue;
      let ps = posByTag.get(tag);
      if (!ps) {
        ps = [];
        posByTag.set(tag, ps);
      }
      let vs = valByTag.get(tag);
      if (!vs) {
        vs = [];
        valByTag.set(tag, vs);
      }
      ps.push(i);
      vs.push(rssi);
    }
  }
  const newRssi: Record<string, number>[] = sorted.map(() => ({}));
  for (const [tag, ps] of posByTag) {
    const vs = valByTag.get(tag)!;
    const k = vs.length;
    const o = k < 2 ? 0 : shiftTicks !== undefined ? ((shiftTicks % k) + k) % k : Math.floor(k / 2);
    for (let j = 0; j < k; j++) newRssi[ps[j]][tag] = vs[(j + o) % k];
  }
  return sorted.map((t, i) => ({ ts: t.ts, tracks: t.tracks, rssiByTag: newRssi[i] }));
}
