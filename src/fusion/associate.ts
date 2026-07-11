// Fusão PURA tag BLE ↔ pessoa rastreada (caminho C, 1 estação, sem IMU).
//
// FÍSICA (medida no spike — docs/analises/tags-bluetooth/01-spike-resultados.md):
// 1 estação + RSSI-only NÃO separa pessoas próximas (SNR≈1). O ÚNICO sinal que funciona sem IMU e
// com 1 antena é CORRELACIONAR, numa janela de tempo, a série de RSSI de cada tag com a série de
// DISTÂNCIA-à-estação de cada pessoa que a câmera rastreia (via homografia). Quem se move diferente
// fica distinguível; quem anda em bloco à mesma distância NÃO — e aí o honesto é dizer "não sei".
//
// FÍSICA DA CORRELAÇÃO: RSSI CAI quando a distância CRESCE → um par bem casado tem RSSI
// NEGATIVAMENTE correlacionado com a distância. Score do par = -corr (Pearson), em [0..1].
//
// INVARIANTE DE HONESTIDADE (pedido explícito do dono): rótulo errado é PIOR que rótulo nenhum.
// Sem movimento suficiente, amostras de menos, correlação fraca, ou EMPATE entre candidatos
// (guarda de ambiguidade top-2, `minMargin`) → tag = null ("não sei").
//
// DEFAULT MEDIDO (torneio de 2026-07-10 no harness replay-fusion.ts, 8 cenários, decisão a
// priori: wrong da suíte −30%+ mantendo correct ≥70% do baseline; entre os aprovados, maior
// precisão média): `minMargin: 0.1` LIGADO por default. Antes (guloso sem guarda) → depois:
//   suíte: wrong 612 → 344 (−43,8%) · correct 1014 → 734 (72,4%) · precisão média 70,0% → 73,4%
//   bloco (o caso ambíguo que violava a invariante): precisão 60,8% → 80,3%, id-switch 20 → 0
//   multidão: precisão 49,8% → 58,9% · id-switches da suíte 59 → 6 · falsos rótulos 235 → 148
// O preço (deliberado): cobertura cai (ex.: bloco 33,5% → 12,3%) — o trade-off certo pela
// invariante. Perdedores por cenário: grade-sem-station 49,2%→46,4% e sem-calibracao 71,8%→71,3%
// de precisão (aceitos — a regra do torneio é agregada e a priori). `optimal` (Hungarian)
// MEDIDO e NÃO promovido a default: sozinho piora o wrong da
// suíte (612 → 642) e, com a guarda, empata com o guloso (precisão média 73,3% vs 73,4%) — fica
// como knob desligado, à espera de cenários que o justifiquem.
//
// FIX DE OCLUSÃO da guarda (2026-07-10, pós-torneio): o scan de concorrentes passou a olhar a
// JANELA inteira, não só o último frame (ver docstring de assign()). Suíte re-medida: wrong
// 344 → 332 · correct 734 → 723 (71,3% do baseline 1014 — regra do torneio segue satisfeita) ·
// precisão média 73,4% → 73,8% · falsos rótulos 148 → 142.
//
// EVIDÊNCIA ABSOLUTA v4 — MEDIDA E RETIRADA DOS DEFAULTS (revisão adversarial de 2026-07-10):
// o torneio v4 tinha promovido gate+blend a default (na suíte com âncoras: wrong 546→411,
// precisão média 70,8%→75,4%). A revisão adversarial PROVOU dois vícios nessa evidência:
// 1. CIRCULARIDADE: o sim gera o RSSI com o MESMO modelo log-distância que o fit assume — o
//    torneio media o mecanismo no mundo onde ele é ótimo por construção. No experimento com
//    −6 dB de atenuação corporal SÓ nas tags de pessoa (viés que o campo real tem e o sim não
//    tinha), a v4 ligada DESPENCOU p/ 26% de precisão / 1,8% de cobertura — PIOR que desligada.
// 2. DECOMPOSIÇÃO DO GANHO: todo o ganho vinha de âncoras deixando de grudar em pessoas
//    (falsos rótulos de âncora 73→1 e 78→0 nos dois cenários com âncoras); o wrong
//    pessoa↔pessoa SUBIU +23% com gate/blend ligados.
// DECISÃO: gate (`maxDistRatio`) e blend (`distWeight`) DESLIGADOS por default — ficam como
// knobs de PESQUISA aguardando dados de CAMPO (viés corporal real, expoente n real do canal,
// n de amostras real). O ganho verdadeiro (âncoras fora do jogo) é capturado por um mecanismo
// simples e IMUNE a viés de RSSI: tags-âncora CADASTRADAS nunca são candidatas — excluídas das
// leituras ANTES da fusão (`excludeTags` em frame.ts). As sentinelas de viés do harness
// (cenários `ancoras-multidao-bias`/`ancoras-mismatch-n` em replay-fusion.ts) são o gate
// permanente: qualquer re-adoção futura do gate/blend terá que sobreviver a elas.
// Mesmo desligados, os knobs tiveram a semântica corrigida (achados da mesma revisão):
// (a) blend não resgata par abaixo de minConfidence; (b) par vetado pelo gate segue
// concorrendo na guarda top-2; (c) gate em LOG-espaço. Detalhes/residuais em pairScore().
//
// RECALIBRAÇÃO DOS GATES (2026-07-11, prescrição do especialista científico — knobs de PESQUISA,
// OFF por default; o TORNEIO no harness decide promoção, não esta entrega): minSamples +
// minMovement + minConfidence são três aproximações discretas do que a estatística resolve com
// UM teste — "a correlação observada é significativa dado o nº de pontos INDEPENDENTES da
// janela?". Os knobs: `useLogDistance` (correlação contra log10 d — o modelo físico do canal;
// para o par verdadeiro o r sobe de graça quando o span radial é grande), `minMovementDecades`
// (gate de movimento ADIMENSIONAL em décadas — invariante ao tamanho da sala; substitui
// minMovement no caminho log) e `significanceGate` (Fisher z com correção AR(1) de n_eff —
// substitui minConfidence como critério de fala; janela rica fala com r menor, janela pobre
// exige o −0,9). Torneio: src/fusion/gates-recalibration.test.ts. Com os três OFF (default) o
// comportamento é BYTE-IDÊNTICO aos pinos de replay-fusion.test.ts.
//
// Responsabilidade única: só a associação. Sem deps, sem UI, sem socket, sem DOM.

export type TagReading = {
  tag: string; // id da tag (MAC/rótulo)
  rssi: number; // RSSI dBm
  /** Estimativa ABSOLUTA da distância tag→estação (m), via modelo calibrado pelas âncoras
   *  (floor-plot.ts). OPCIONAL — ausente = comportamento pré-v4 intacto (retrocompat dura). */
  distM?: number;
};
export type TrackDist = {
  trackId: number; // pessoa rastreada
  dist: number; // distância-à-estação (m ou proxy monotônico)
  /** true = `dist` está em METROS reais (homografia calibrada), não no proxy 1/bh. A evidência
   *  absoluta (gate/blend) SÓ se aplica com metric=true — proxy não é comparável a distM. */
  metric?: boolean;
};
export type FusionFrame = { ts: number; readings: TagReading[]; tracks: TrackDist[] };
export type Assignment = {
  trackId: number;
  tag: string | null; // tag=null → "não sei"
  confidence: number;
  /** ADITIVO (instrumentação p/ reliability diagram — pedido do especialista científico):
   *  margem top-2 EFETIVA do par escolhido para esta pista — min(marginPista, marginTag), o
   *  MESMO valor que a guarda de ambiguidade (`minMargin`) usa pra decidir falar/abster (não é
   *  recalculado por fora; é a mesma matemática de assign() exposta). Dois casos sem par
   *  escolhido (nenhum candidato alcançou minConfidence): `margin: 0` — não houve concorrência
   *  a reportar, a abstenção é por FALTA de evidência, não por empate. Clampado para [0,1] só na
   *  leitura do reliability diagram (identity-metrics.ts); aqui o valor bruto pode, em teoria,
   *  sair ligeiramente negativo quando um fantasma da janela supera o par escolhido (guarda
   *  desligada — minMargin:0 — deixa o par falar mesmo perdendo a concorrência; ver teste de
   *  oclusão). */
  margin?: number;
  /** ADITIVO: true quando existiu ≥1 concorrente de verdade (score>0 no outro eixo pista OU tag,
   *  incluindo fantasmas da janela) E a margem ficou abaixo de CONFLICT_MARGIN_THRESHOLD — ver a
   *  constante abaixo. Limiar FIXO de instrumentação, independente do knob `minMargin` (o knob é
   *  configurável por deploy; o contador de conflito precisa de uma régua estável pra comparar
   *  cenários entre si). Sem par escolhido → false (não há vencedor pra disputar). */
  hadConflict?: boolean;
};

/** ADITIVO (funil de vetos instrumentado, 2026-07-11 — diagnóstico do 1º teste de campo que
 *  falhou em silêncio): qual gate da CADEIA DE VETOS matou um par (track, tag) — na ORDEM exata
 *  em que pairScore() e assign() os aplicam. "SPOKE" = o par falou (nenhum veto).
 *  NOTA (knobs de pesquisa): par vetado pelo gate de consistência (`maxDistRatio`, DESLIGADO por
 *  default) zera o score e aparece aqui como "belowMinConfidence" — declarado, não escondido
 *  (o gate não roda no campo hoje; se for religado, ganha verdict próprio ADITIVO). Mesmo
 *  tratamento p/ o `significanceGate` da recalibração (OFF por default): par insignificante
 *  zera em pairScore e aparece como "belowMinConfidence"; e com `useLogDistance`+
 *  `minMovementDecades` o "lowMovement" reflete o gate em DÉCADAS (movementVetoed é a fonte
 *  única). Promoção de knob → verdicts próprios ADITIVOS. */
export type FunnelVerdict =
  | "distSamples<minSamples" // a PISTA tem amostras de menos na janela
  | "rssiSamples<minSamples" // a TAG tem amostras de menos na janela
  | "aligned<minSamples" // pós-align sobrou menos que minSamples (defensivo — espelha pairScore)
  | "constantSeries" // pearson indefinida (RSSI ou distância constante)
  | "lowMovement" // varY < minMovement (pessoa quase parada → ambíguo)
  | "belowMinConfidence" // score não alcançou minConfidence (ou foi zerado pelo gate — ver nota)
  | "lostTieBreak" // elegível, mas perdeu a atribuição 1-1 p/ outro par (linha/coluna tomada)
  | "belowMinMargin" // escolhido na 1-1, mas a guarda de ambiguidade top-2 recusou
  | "SPOKE"; // falou: é exatamente o par que assign() reporta com tag não-null

/** Limiares vigentes no instante do diagnóstico (a régua de cada gate do funil). */
export type FunnelThresholds = {
  windowMs: number;
  minSamples: number;
  minConfidence: number;
  minMovement: number;
  minMargin: number;
};

/** Uma linha do funil: o estado de UM par (pista corrente, tag) em todos os elos da cadeia. */
export type PairFunnel = {
  trackId: number;
  tag: string;
  /** Amostras de distância da pista na janela. */
  distSamples: number;
  /** Amostras de RSSI da tag na janela. */
  rssiSamples: number;
  /** Amostras alinhadas (pós-align — a série que a correlação de fato consome). */
  alignedSamples: number;
  /** Span temporal (ms) coberto pelos samples alinhados (a série de distância é a guia). */
  spanMs: number;
  /** varY do pearson — a variância de distância que o minMovement corta. null = não chegou lá
   *  (amostras de menos) ou correlação indefinida (série constante). */
  movVar: number | null;
  /** r de Pearson (RSSI × distância). null = indefinida (série constante) ou não computável. */
  corr: number | null;
  /** Score EFETIVO do par — o MESMO pairScore().score do caminho real (0 = vetado nas guardas). */
  score: number;
  /** Margem top-2 (mesma matemática da guarda de assign()) quando o par foi ESCOLHIDO na 1-1;
   *  null quando nem chegou à escolha. */
  margin: number | null;
  verdict: FunnelVerdict;
  thresholds: FunnelThresholds;
};

/** Limiar FIXO (instrumentação, não é knob) pra `Assignment.hadConflict`: margem abaixo disto com
 *  concorrente real presente conta como "disputa competitiva" pelo mesmo track vencedor. Escolhido
 *  por ser 3× o default operacional de `minMargin` (0.1) — folga suficiente pra capturar "quase
 *  empatou" mesmo quando a guarda está mais permissiva que o default. Não afeta score/confiança;
 *  só rotula a instrumentação (reliability diagram / taxa de conflito em identity-metrics.ts). */
const CONFLICT_MARGIN_THRESHOLD = 0.3;

export type FusionConfig = {
  windowMs?: number; // janela de correlação
  minSamples?: number; // mínimo de amostras na janela p/ confiar
  minConfidence?: number; // abaixo disto → tag=null
  minMovement?: number; // variância mínima de distância p/ a correlação valer (parado = ambíguo)
  minMargin?: number; // guarda de ambiguidade top-2 (0 = desligada) — ver doc em assign()
  optimal?: boolean; // atribuição ótima global (Hungarian) no lugar do guloso — ver chooseOptimal()
  /** GATE de consistência física da evidência absoluta — knob de PESQUISA, DESLIGADO por
   *  default (0 = desligado; ativo só se > 1; ver cabeçalho — por que saiu dos defaults).
   *  FATOR multiplicativo máximo tolerado entre distM (RSSI calibrado) e dist (câmera): veta o
   *  par quando a mediana de |log10(distM/dist)| na janela excede log10(maxDistRatio).
   *  LOG-espaço porque o erro de RSSI é MULTIPLICATIVO em distância (ε dB → fator 10^(ε/(10·n)))
   *  — um limiar em metros absolutos apertava demais longe e afrouxava demais perto. */
  maxDistRatio?: number;
  /** BLEND da evidência absoluta — knob de PESQUISA, DESLIGADO por default (0 = desligado):
   *  score = (1−w)·(−corr) + w·exp(−gap/escala), SÓ quando a correlação sozinha já passa de
   *  minConfidence (jamais resgata par que a correlação recusaria). Ver pairScore(). */
  distWeight?: number;
  /** PESQUISA (recalibração dos gates 2026-07-11 — ver cabeçalho; DESLIGADO por default):
   *  correlaciona RSSI contra log10(max(d, 0,1)) no lugar de d. É o modelo FÍSICO do canal
   *  (RSSI ≈ A − 10·n·log10 d): para o par verdadeiro o r sobe de graça quando o span radial é
   *  grande. Aplica-se IGUAL ao proxy 1/bh sem H (deliberado, documentado): o proxy é
   *  monotônico na distância, logo log10(proxy) é igualmente monotônico — a correlação segue
   *  medindo a mesma tendência, só em escala log. Piso de 0,1 m (GATE_MIN_DIST_M) antes do log
   *  — abaixo disso nem câmera nem RSSI discriminam. */
  useLogDistance?: boolean;
  /** PESQUISA (só no caminho useLogDistance; 0 = desligado): gate de movimento ADIMENSIONAL —
   *  std(log10 d) ≥ minMovementDecades (em DÉCADAS de distância) SUBSTITUI o minMovement
   *  (variância em m²) para o par. Mudança dupla de régua, deliberada: variância→desvio-padrão
   *  e m²→décadas. É invariante ao tamanho da sala e o limiar deriva do ruído medido
   *  (k·σ_RSSI/(10·n): σ=5,6 dB, n=2,2 → ~0,25 década p/ SNR=1; na prática 0,12–0,18 com os
   *  demais filtros). IGNORADO quando useLogDistance=false (décadas só fazem sentido na
   *  variável log). */
  minMovementDecades?: number;
  /** PESQUISA (AUSENTE = desligado): teste de significância (Fisher z) SUBSTITUI minConfidence
   *  como critério de fala. n_eff = n·(1−ρ)/(1+ρ) — correção AR(1): a mineração mediu
   *  autocorrelação 0,49–0,94@2s (inter-arrival ~2,06 s), leituras consecutivas são altamente
   *  dependentes; n = nº de amostras ALINHADAS DISTINTAS de RSSI na janela (dedup por valor
   *  consecutivo repetido — o snapshot repete o último batch entre atualizações reais, então
   *  transições de valor contam leituras FRESCAS, não cópias; ver distinctConsecutive()).
   *  Falar exige n_eff ≥ minNeff E |atanh(r)| ≥ zCrit·√(1/(n_eff−3)); n_eff ≤ 3 → não fala
   *  (a variância de Fisher é indefinida). Escala-aware por construção: janela rica fala com r
   *  menor; janela pobre exige o −0,9. O score/confidence reportado segue −corr (semântica
   *  intacta — o teste decide FALAR, não o valor). NOTA: o blend (`distWeight`, outro knob de
   *  pesquisa) segue referenciando minConfidence internamente — a combinação dos dois não foi
   *  medida e não é suportada. */
  significanceGate?: { zCrit: number; rho: number; minNeff: number };
};

// significanceGate fica OPCIONAL mesmo na config resolvida: "ausente" É o estado desligado
// (não há valor neutro honesto p/ um objeto {zCrit, rho, minNeff}).
type ResolvedConfig = Required<Omit<FusionConfig, "significanceGate">> &
  Pick<FusionConfig, "significanceGate">;

const DEFAULTS: ResolvedConfig = {
  windowMs: 8000,
  minSamples: 5,
  minConfidence: 0.5,
  // 0,25 → 0,15 (2026-07-11, PRIMEIRO dado de campo real): o funil de diagnóstico (diagnoseFunnel)
  // provou que 0,25 era FISICAMENTE IMPASSÁVEL numa sala real de ~4×5m (movVar máximo de caminhada
  // real ampla: 0,228 — zero falas em 4.195 avaliações), enquanto o replay contrafactual da MESMA
  // caminhada com 0,15 falou 28× com corr até -0,91 (a física validada em campo pela 1ª vez).
  // Torneio sintético (12 cenários): 0,15 é NEUTRO no agregado (73,0% = 73,0%); `parado` segue
  // 100% abstenção (variância de gente parada é ~0, bem abaixo do gate — o caso que o knob protege
  // continua protegido); custo localizado: bloco 82,0→80,0% de precisão. Evidência dupla
  // (campo + torneio) — o rito da casa pra mudança de default. Espelho: session-recorder.js.
  minMovement: 0.15, // variância (m²) — ~0,39 m de desvio-padrão de movimento
  minMargin: 0.1, // guarda de ambiguidade LIGADA por default — decisão MEDIDA (ver cabeçalho)
  optimal: false, // Hungarian medido e não promovido (ver cabeçalho); knob disponível
  maxDistRatio: 0, // gate DESLIGADO — knob de pesquisa; a revisão adversarial provou circularidade (ver cabeçalho)
  distWeight: 0, // blend DESLIGADO — idem; ambos aguardam dados de campo p/ re-medição honesta
  // Recalibração dos gates (2026-07-11) — knobs de PESQUISA, OFF por default (byte-compat com
  // os pinos): o torneio em gates-recalibration.test.ts decide promoção, não esta entrega.
  useLogDistance: false,
  minMovementDecades: 0,
  // significanceGate: AUSENTE por default (desligado) — ver ResolvedConfig.
};

// Escala do blend (m): exp(−gap/escala). 1,5 m ≈ erro mediano de distância que 4 dB de ruído de
// RSSI induzem no modelo log-distância (n=2,2) na faixa de operação (2–6 m) — gap dessa ordem é
// "consistente com o ruído", muito acima disso a consistência decai rápido.
const DIST_BLEND_SCALE_M = 1.5;

// Piso do log-ratio do gate (mesmo piso DIST_MIN_M do floor-plot): abaixo de 0,1 m nem câmera
// nem RSSI discriminam distância — sem o piso, dist→0 explodiria o ratio de qualquer par.
const GATE_MIN_DIST_M = 0.1;

const EPS = 1e-9;

/** Média aritmética (assume xs não-vazio). */
function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/**
 * Correlação de Pearson de duas séries pareadas. Retorna null quando alguma série é (quase)
 * constante — variância ~0 → correlação indefinida (nunca NaN silencioso). Também devolve a
 * variância de `ys` (a série de distância) p/ o guarda de movimento, evitando recomputar.
 */
function pearson(
  xs: readonly number[],
  ys: readonly number[],
): { corr: number; varY: number } | null {
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
  const varY = syy / n;
  const denom = Math.sqrt(sxx * syy);
  if (denom < EPS) return null; // alguma série constante → correlação indefinida
  return { corr: sxy / denom, varY };
}

/** Variância POPULACIONAL (assume xs não-vazio) — a MESMA matemática do varY de pearson()
 *  (syy/n, mesmo mean(), mesma ordem de acumulação: bitwise-igual no caminho default). Existe
 *  separada porque a recalibração dos gates (useLogDistance) precisa da variância da série CRUA
 *  mesmo quando a correlação roda sobre a série log. */
function variance(xs: readonly number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return s / xs.length;
}

/** log10 da série de distância com o MESMO piso do gate (GATE_MIN_DIST_M = 0,1 m — abaixo disso
 *  nem câmera nem RSSI discriminam; sem o piso, d→0 explodiria o log). Serve METROS e PROXY
 *  igualmente (ver FusionConfig.useLogDistance — o log de um proxy monotônico segue monotônico). */
function log10Dist(dist: readonly number[]): number[] {
  return dist.map((d) => Math.log10(Math.max(d, GATE_MIN_DIST_M)));
}

/** Nº de valores DISTINTOS CONSECUTIVOS de uma série (dedup de vizinhos repetidos): conta 1 +
 *  transições de valor. ESCOLHA documentada (significanceGate): o snapshot de leituras repete o
 *  último batch entre atualizações reais da estação — valores iguais CONSECUTIVOS são, com
 *  altíssima probabilidade, a MESMA leitura física copiada, não evidência nova; uma transição é
 *  uma leitura fresca. (Dedup global seria errado: a mesma leitura re-visitada mais tarde É
 *  evidência nova; só a repetição adjacente é cópia.) */
function distinctConsecutive(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let n = 1;
  for (let i = 1; i < xs.length; i++) if (xs[i] !== xs[i - 1]) n++;
  return n;
}

/** Teste de significância da correlação (significanceGate — ver FusionConfig): Fisher
 *  z = atanh(r) com n_eff = n·(1−ρ)/(1+ρ) (correção AR(1); n = amostras alinhadas DISTINTAS de
 *  RSSI, ver distinctConsecutive). Fala exige n_eff ≥ minNeff E |z| ≥ zCrit·√(1/(n_eff−3)).
 *  Proteções: n_eff ≤ 3 → false (variância de Fisher 1/(n_eff−3) indefinida/negativa);
 *  r clampado a [−1,1] antes do atanh (erro de ponto flutuante do pearson pode passar de 1 por
 *  ~1e-16; atanh(±1) = ±Infinity, que passa qualquer limiar — correto: correlação perfeita É
 *  significativa quando o n_eff basta). */
function passesSignificance(
  corr: number,
  alignedRssi: readonly number[],
  gate: { zCrit: number; rho: number; minNeff: number },
): boolean {
  const n = distinctConsecutive(alignedRssi);
  const nEff = (n * (1 - gate.rho)) / (1 + gate.rho);
  if (nEff <= 3 || nEff < gate.minNeff) return false;
  const z = Math.abs(Math.atanh(Math.max(-1, Math.min(1, corr))));
  return z >= gate.zCrit * Math.sqrt(1 / (nEff - 3));
}

/** Amostra alinhada de uma pista: distância no instante ts (+ se está em metros REAIS). */
type DistSample = { ts: number; value: number; metric: boolean };
/** Amostra de uma tag: RSSI no instante ts (+ distM calibrado, quando existe). */
type RssiSample = { ts: number; value: number; distM?: number };

/** Mediana (assume xs não-vazio) — robusta a outliers de RSSI, ao contrário da média. */
function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Casa cada amostra de distância com o RSSI da tag MAIS PRÓXIMO no tempo (a câmera é a série guia).
 * Também coleta os resíduos da evidência absoluta nos pares onde a pista está em metros REAIS
 * (metric) E a tag tem distM calibrado — pares proxy/sem-calibração ficam de fora (proxy não é
 * comparável a metro; gate/blend nunca se aplicam a eles):
 *  - gaps: |dist_pista − distM_tag| em METROS (consumido pelo blend);
 *  - logGaps: |log10(distM/dist)| em DÉCADAS, com piso de 0,1 m nos dois lados (consumido pelo
 *    gate — o erro de RSSI é multiplicativo, ver FusionConfig.maxDistRatio).
 */
function align(
  distSeries: readonly DistSample[],
  rssiSeries: readonly RssiSample[],
): { rssi: number[]; dist: number[]; gaps: number[]; logGaps: number[] } {
  const rssi: number[] = [];
  const dist: number[] = [];
  const gaps: number[] = [];
  const logGaps: number[] = [];
  if (rssiSeries.length === 0) return { rssi, dist, gaps, logGaps };
  for (const d of distSeries) {
    let best = rssiSeries[0];
    let bestDt = Math.abs(rssiSeries[0].ts - d.ts);
    for (let i = 1; i < rssiSeries.length; i++) {
      const dt = Math.abs(rssiSeries[i].ts - d.ts);
      if (dt < bestDt) {
        bestDt = dt;
        best = rssiSeries[i];
      }
    }
    dist.push(d.value);
    rssi.push(best.value);
    if (d.metric && best.distM !== undefined && Number.isFinite(best.distM)) {
      gaps.push(Math.abs(d.value - best.distM));
      logGaps.push(
        Math.abs(
          Math.log10(Math.max(best.distM, GATE_MIN_DIST_M) / Math.max(d.value, GATE_MIN_DIST_M)),
        ),
      );
    }
  }
  return { rssi, dist, gaps, logGaps };
}

/** Par escolhido pela atribuição 1-1, como índices na matriz de scores [linha=pista, coluna=tag]. */
type Pair = { i: number; j: number };

/**
 * Evidência de um par (track, tag):
 *  - `score`: efetivo — decide a escolha 1-1 e vira a confiança reportada (0 = par vetado/recusado);
 *  - `guard`: o score PRÉ-GATE, usado como CONCORRENTE na guarda de margem top-2. Par vetado pelo
 *    gate marca score 0 mas SEGUE concorrendo na guarda com o valor que tinha — vetar um par não
 *    pode LIBERAR a tag p/ o vizinho com margem cheia (achado medido na revisão adversarial de
 *    2026-07-10: wrong pessoa↔pessoa +62% no gate-só, por des-veto). guard === score sempre que
 *    não há veto (knobs desligados ⇒ idênticos por construção).
 */
type PairEvidence = { score: number; guard: number };
const NO_EVIDENCE: PairEvidence = { score: 0, guard: 0 };

/** Elegível p/ FALAR: score positivo e ≥ minConfidence (mesma regra do guloso original). */
function eligible(score: number, minConfidence: number): boolean {
  return score > 0 && score >= minConfidence;
}

/**
 * Guloso determinístico (comportamento original): maior score primeiro; desempate por linha
 * (pista em ordem de trackId), depois coluna (tag em ordem lexicográfica). 1 pista ↔ 1 tag.
 */
function chooseGreedy(score: number[][], minConfidence: number): Pair[] {
  type Cand = Pair & { s: number };
  const cands: Cand[] = [];
  for (let i = 0; i < score.length; i++) {
    for (let j = 0; j < score[i].length; j++) {
      if (score[i][j] > 0) cands.push({ i, j, s: score[i][j] });
    }
  }
  cands.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    if (a.i !== b.i) return a.i - b.i;
    return a.j - b.j;
  });
  const takenRow = new Set<number>();
  const takenCol = new Set<number>();
  const out: Pair[] = [];
  for (const c of cands) {
    if (!eligible(c.s, minConfidence)) break; // ordenado desc → o resto é ainda mais fraco
    if (takenRow.has(c.i) || takenCol.has(c.j)) continue;
    takenRow.add(c.i);
    takenCol.add(c.j);
    out.push({ i: c.i, j: c.j });
  }
  return out;
}

/**
 * Método húngaro (minimização) p/ matriz de custos n×m com n ≤ m — variante com potenciais
 * (algoritmo clássico O(n²·m), "e-maxx"). Retorna, por linha, a coluna atribuída (matching
 * perfeito nas linhas). Exato e determinístico: mesma matriz → mesma resposta. Índices internos
 * 1-based (convenção do algoritmo; a coluna 0 é o sentinela do caminho aumentante).
 */
function hungarianMin(cost: number[][]): number[] {
  const n = cost.length;
  const m = n > 0 ? cost[0].length : 0;
  const u = new Array<number>(n + 1).fill(0); // potencial das linhas
  const v = new Array<number>(m + 1).fill(0); // potencial das colunas
  const p = new Array<number>(m + 1).fill(0); // p[j] = linha dona da coluna j (0 = livre)
  const way = new Array<number>(m + 1).fill(0); // predecessor no caminho aumentante
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }
  const colOfRow = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j] > 0) colOfRow[p[j] - 1] = j - 1;
  return colOfRow;
}

/**
 * ATRIBUIÇÃO ÓTIMA GLOBAL (knob `optimal`): maximiza a SOMA dos scores sujeita a 1-1, via
 * Hungarian — exato, determinístico, sem dependência (n aqui é ≤ ~10). Pares inelegíveis
 * (score 0 ou < minConfidence) entram com peso 0 = "ficar sem tag"; colunas-fantasma de peso 0
 * completam a matriz quadrada quando há mais pistas que tags. Depois do matching, par com peso 0
 * é descartado (equivale a não-atribuído) — o resultado é o matching de peso máximo restrito
 * aos pares elegíveis. Corrige o vício do guloso: o par global-máximo pode "roubar" a tag da
 * pista errada e afundar o resto; o ótimo considera o conjunto.
 * dev.md/base.md apontam TRANSPORTE ÓTIMO (Sinkhorn) como evolução da associação — Hungarian é
 * o degrau clássico ANTES do Sinkhorn: mesmo problema, solução exata e discreta p/ n pequeno.
 */
function chooseOptimal(score: number[][], minConfidence: number): Pair[] {
  const n = score.length;
  const mReal = n > 0 ? score[0].length : 0;
  if (n === 0 || mReal === 0) return [];
  const m = Math.max(n, mReal); // n ≤ m exigido pelo hungarianMin → completa com colunas de peso 0
  const weight: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(m).fill(0);
    for (let j = 0; j < mReal; j++) if (eligible(score[i][j], minConfidence)) row[j] = score[i][j];
    weight.push(row);
  }
  const cost = weight.map((row) => row.map((w) => -w)); // maximizar peso = minimizar -peso
  const colOfRow = hungarianMin(cost);
  const out: Pair[] = [];
  for (let i = 0; i < n; i++) {
    const j = colOfRow[i];
    if (j >= 0 && j < mReal && weight[i][j] > 0) out.push({ i, j });
  }
  return out;
}

export class TagTrackAssociator {
  private cfg: ResolvedConfig;
  private buffer: FusionFrame[] = [];

  constructor(cfg?: FusionConfig) {
    this.cfg = { ...DEFAULTS, ...(cfg ?? {}) };
  }

  /** Acumula um frame e poda o que saiu da janela (relativo ao ts do próprio frame). */
  push(frame: FusionFrame): void {
    this.buffer.push(frame);
    this.prune(frame.ts);
  }

  reset(): void {
    this.buffer = [];
  }

  /** Remove frames fora de [now - windowMs, now]. */
  private prune(now: number): void {
    const lo = now - this.cfg.windowMs;
    this.buffer = this.buffer.filter((f) => f.ts >= lo && f.ts <= now);
  }

  /**
   * Evidência de um par (track, tag) na janela: score = -corr(RSSI, distância), em [0..1].
   * Devolve NO_EVIDENCE quando qualquer guarda de honestidade falha:
   *  - amostras de menos (pista OU tag) → não dá pra confiar;
   *  - distância quase parada (variância < minMovement) → ambíguo;
   *  - RSSI constante → correlação indefinida.
   *
   * EVIDÊNCIA ABSOLUTA (knobs de PESQUISA `maxDistRatio`/`distWeight`, DESLIGADOS por default —
   * ver cabeçalho: a revisão adversarial provou circularidade sim↔fit e ganho decomposto): além
   * da TENDÊNCIA (correlação), o VALOR da distância vira evidência quando o modelo RSSI→distância
   * está calibrado pelas âncoras. Só se aplica com ≥minSamples pares métricos alinhados (pista em
   * METROS reais — metric:true — E tag com distM); ausente distM ou modo proxy → correlação pura.
   * Semântica CORRIGIDA pelos achados da mesma revisão (vale mesmo com os knobs desligados):
   *  - BLEND (`distWeight` w): score = (1−w)·(−corr) + w·exp(−mediana_gap/1,5 m), aplicado SÓ
   *    quando base ≥ minConfidence — JAMAIS resgata par que a correlação recusaria (achado: com
   *    gap≈0 a barra efetiva caía de 0,5 p/ 0,286, e gap≈0 é condição de ANEL — mesma distância
   *    — não de identidade). RESIDUAL declarado: o blend ainda pode DERRUBAR abaixo da barra um
   *    par aprovado (reponderar p/ baixo é o propósito) e segue reponderando ENTRE candidatos
   *    válidos — sob viés de RSSI ele repondera na direção errada; por isso está desligado.
   *  - GATE (`maxDistRatio` r): veto quando a mediana de |log10(distM/dist)| > log10(r) —
   *    LOG-espaço porque o erro de RSSI é multiplicativo em distância (limiar em metros absolutos
   *    apertava longe e afrouxava perto). Par vetado devolve {score:0, guard:pré-gate}: veta sem
   *    liberar a tag p/ o vizinho (ver PairEvidence). RESIDUAL declarado: sob viés corporal real
   *    o gate veta o DONO verdadeiro — vira abstenção (não erro), mas derruba a cobertura; por
   *    isso está desligado até haver medição de campo do viés.
   * DECISÃO DE HONESTIDADE preservada: gate e blend NUNCA resgatam par que as guardas de
   * correlação já recusaram. Com 1 estação a distância absoluta é um ANEL (simétrica) — sozinha
   * não desambigua mesma-distância; só VETA inconsistência ou REPONDERA candidato já validado.
   */
  private pairScore(distSeries: DistSample[], rssiSeries: RssiSample[]): PairEvidence {
    const { minSamples, minConfidence, maxDistRatio, distWeight, useLogDistance, significanceGate } =
      this.cfg;
    if (distSeries.length < minSamples || rssiSeries.length < minSamples) return NO_EVIDENCE;
    const { rssi, dist, gaps, logGaps } = align(distSeries, rssiSeries);
    if (rssi.length < minSamples) return NO_EVIDENCE;
    // PESQUISA useLogDistance (OFF por default): a variável de correlação vira log10(d) — o
    // modelo físico do canal (ver FusionConfig). OFF → ys === dist, caminho byte-idêntico.
    const ys = useLogDistance ? log10Dist(dist) : dist;
    const p = pearson(rssi, ys);
    if (p === null) return NO_EVIDENCE; // série constante
    if (this.movementVetoed(dist)) return NO_EVIDENCE; // pessoa (quase) parada → ambíguo, "não sei"
    // -corr: casamento físico (RSSI cai com distância) → corr<0 → score>0.
    const base = Math.max(0, Math.min(1, -p.corr));
    // PESQUISA significanceGate (AUSENTE por default): a correlação só FALA se for
    // estatisticamente significativa dado o nº de pontos independentes (Fisher z + n_eff AR(1),
    // ver passesSignificance). Par insignificante devolve NO_EVIDENCE — mesma semântica dos
    // demais vetos de honestidade (não concorre na guarda; abstenção por falta de evidência).
    // Quando o gate está presente, minConfidence SAI do critério de fala (ver speakBar()).
    if (significanceGate !== undefined && !passesSignificance(p.corr, rssi, significanceGate))
      return NO_EVIDENCE;
    const gateOn = maxDistRatio > 1; // fator ≤ 1 não é limiar físico plausível → desligado
    // Evidência absoluta: exige série métrica suficiente (mesma régua minSamples da correlação).
    if ((gateOn || distWeight > 0) && gaps.length >= minSamples) {
      // Blend só repondera quem a correlação sozinha já aprovaria (nunca resgata — ver docstring).
      const blended =
        distWeight > 0 && base >= minConfidence
          ? Math.max(
              0,
              Math.min(
                1,
                (1 - distWeight) * base +
                  distWeight * Math.exp(-median(gaps) / DIST_BLEND_SCALE_M),
              ),
            )
          : base;
      // Gate em log-espaço: par fisicamente inconsistente é vetado, mas mantém o guard pré-gate.
      if (gateOn && median(logGaps) > Math.log10(maxDistRatio))
        return { score: 0, guard: blended };
      return { score: blended, guard: blended };
    }
    return { score: base, guard: base };
  }

  /** Veto de MOVIMENTO sobre a série ALINHADA de distância CRUA (m ou proxy) — fonte única
   *  (pairScore E diagnoseFunnel usam ESTA função; nunca recalcule por fora):
   *  - default (useLogDistance OFF): variância < minMovement (m²) — variance() é bitwise-igual
   *    ao p.varY histórico do pearson;
   *  - useLogDistance + minMovementDecades>0: std(log10 d) < minMovementDecades — o gate
   *    ADIMENSIONAL em DÉCADAS substitui minMovement para o par (ver FusionConfig);
   *  - useLogDistance SEM decades: minMovement segue valendo sobre a série CRUA em m²
   *    (deliberado: o log é só a variável de CORRELAÇÃO; comparar minMovement em m² contra
   *    variância em décadas² seria régua desonesta). */
  private movementVetoed(dist: readonly number[]): boolean {
    const { useLogDistance, minMovementDecades, minMovement } = this.cfg;
    if (useLogDistance && minMovementDecades > 0)
      return Math.sqrt(variance(log10Dist(dist))) < minMovementDecades;
    return variance(dist) < minMovement;
  }

  /** Barra de elegibilidade p/ FALAR (consumida por chooseGreedy/chooseOptimal e pelo funil):
   *  minConfidence no caminho default; 0 quando significanceGate está presente — o teste de
   *  significância (já aplicado DENTRO de pairScore: par insignificante tem score 0) SUBSTITUI
   *  minConfidence como critério de fala (prescrição da recalibração — ver FusionConfig).
   *  eligible(score, 0) ≡ score > 0, ou seja: sobrou evidência significativa → pode falar. */
  private speakBar(): number {
    return this.cfg.significanceGate !== undefined ? 0 : this.cfg.minConfidence;
  }

  /**
   * Atribuição corrente: 1 tag por pessoa e vice-versa, por correlação. Duas etapas:
   *
   * 1. ESCOLHA 1-1 — guloso determinístico (original) ou ótimo global (knob `optimal`, Hungarian).
   *    Pares abaixo de minConfidence NÃO consomem tag e a pessoa fica com tag=null.
   *
   * 2. GUARDA DE AMBIGUIDADE TOP-2 (knob `minMargin`; 0 = desligada). Formulação exata
   *    (decisão deliberada, documentada de propósito): a guarda é POR PAR ESCOLHIDO, contra o
   *    melhor concorrente na matriz de GUARDA (scores PRÉ-GATE, antes da 1-1 — par vetado pelo
   *    gate segue concorrendo com o valor que tinha, ver PairEvidence; sem gate/blend as duas
   *    matrizes são idênticas), nos DOIS eixos:
   *      marginPista = score(pista,tag) − melhor score da MESMA pista com OUTRA tag;
   *      marginTag   = score(pista,tag) − melhor score da MESMA tag com OUTRA pista.
   *    O par só fala se min(marginPista, marginTag) ≥ minMargin. Quando o par escolhido é o
   *    argmax da linha E da coluna, isso é o clássico "top-1 − top-2" (por pista E por tag —
   *    escolhemos AMBOS os eixos: duas tags que explicam igualmente a pista OU duas pistas que
   *    explicam igualmente a tag são o MESMO empate físico de "andar em bloco"). Quando o par
   *    NÃO é o argmax (a atribuição ótima pode preferir um par localmente 2º p/ maximizar o
   *    total), a margem sai negativa e o par é recusado — escolha conservadora: se OUTRA tag
   *    explica o movimento da pista tão bem ou melhor, falar é apostar; rótulo errado é pior
   *    que nenhum. Par recusado NÃO libera a tag p/ outra pista (a ambiguidade é do empate
   *    físico, não some com o descarte).
   *
   *    CONCORRENTES DA GUARDA (fix de 2026-07-10): o scan de "melhor OUTRA pista p/ a MESMA
   *    tag" considera TODAS as pistas com amostras suficientes na JANELA (≥minSamples, imposto
   *    pelo próprio pairScore) — não só as do último frame. Sem isso, o dono verdadeiro que
   *    pisca (dropout de detecção/oclusão de 1 frame — o próprio sim tem dropoutP) saía da
   *    matriz e a tag "sobrava" p/ o vizinho de bloco com margem cheia: rótulo ERRADO com
   *    confiança ~1. Pistas-fantasma só VETAM — não recebem Assignment nem participam da
   *    escolha 1-1.
   *
   * Uma Assignment por pista corrente (as presentes no último frame com pistas) — a saída segue
   * restrita a elas mesmo com o buffer inteiro alimentando a guarda.
   */
  assign(now?: number): Assignment[] {
    const ref = now ?? this.latestTs();
    if (ref !== null) this.prune(ref);

    const currentTracks = this.currentTrackIds().sort((a, b) => a - b);
    if (currentTracks.length === 0) return [];

    // Séries por pista e por tag dentro da janela. TODAS as pistas do buffer entram (não só as
    // correntes): as ausentes do último frame ainda concorrem no scan da guarda (ver docstring).
    const distByTrack = new Map<number, DistSample[]>();
    const rssiByTag = new Map<string, RssiSample[]>();
    for (const f of this.buffer) {
      for (const t of f.tracks) {
        let arr = distByTrack.get(t.trackId);
        if (!arr) {
          arr = [];
          distByTrack.set(t.trackId, arr);
        }
        arr.push({ ts: f.ts, value: t.dist, metric: t.metric === true });
      }
      for (const r of f.readings) {
        let arr = rssiByTag.get(r.tag);
        if (!arr) {
          arr = [];
          rssiByTag.set(r.tag, arr);
        }
        const s: RssiSample = { ts: f.ts, value: r.rssi };
        if (r.distM !== undefined) s.distM = r.distM;
        arr.push(s);
      }
    }

    // Matrizes COMPLETAS (linha=pista em ordem de trackId, coluna=tag em ordem lex; zeros
    // incluídos): `score` (efetivo — escolha 1-1, confiança, "quão perto chegou" do null) e
    // `guard` (pré-gate — só os concorrentes da guarda de margem; idênticas sem gate/blend).
    const tags = [...rssiByTag.keys()].sort();
    const evidence: PairEvidence[][] = currentTracks.map((id) => {
      const distSeries = distByTrack.get(id) ?? [];
      return tags.map((tag) => this.pairScore(distSeries, rssiByTag.get(tag) ?? []));
    });
    const score: number[][] = evidence.map((row) => row.map((e) => e.score));
    const guard: number[][] = evidence.map((row) => row.map((e) => e.guard));

    const { minMargin, optimal } = this.cfg;
    const speakBar = this.speakBar(); // minConfidence — ou 0 com significanceGate (ver speakBar)
    const chosen = optimal ? chooseOptimal(score, speakBar) : chooseGreedy(score, speakBar);

    // Melhor concorrente FANTASMA por tag: pistas com amostras na janela mas fora do último
    // frame (flicker/oclusão). Só alimentam o scan da guarda — nunca a escolha 1-1 nem a saída
    // (e concorrem pelo guard pré-gate: veto não silencia concorrente, ver PairEvidence).
    // Computado sempre que há `chosen` (não só com minMargin>0): a instrumentação de margin/
    // hadConflict precisa dos concorrentes mesmo com a guarda desligada (minMargin:0) — o gate
    // continua decidindo falar/abster igual antes (accepted abaixo não muda), só a MEDIÇÃO passou
    // a existir também nesse caso.
    const currentSet = new Set(currentTracks);
    const ghostBestByTag = new Array<number>(tags.length).fill(0);
    if (chosen.length > 0) {
      for (const [id, distSeries] of distByTrack) {
        if (currentSet.has(id)) continue;
        for (let j = 0; j < tags.length; j++) {
          const e = this.pairScore(distSeries, rssiByTag.get(tags[j]) ?? []);
          if (e.guard > ghostBestByTag[j]) ghostBestByTag[j] = e.guard;
        }
      }
    }

    // Diagnóstico por par ESCOLHIDO (antes da guarda de margem decidir aceitar/recusar): a MESMA
    // matemática da guarda (margem top-2 nos dois eixos, concorrentes da matriz de GUARDA +
    // fantasmas), exposta como instrumentação (Assignment.margin/hadConflict) — fonte única, sem
    // recálculo paralelo. `margin` = min(marginPista, marginTag); a condição de aceite da guarda
    // abaixo é EXATAMENTE `margin >= minMargin` (refatorado sem mudar o resultado).
    const rowDiag = new Map<number, { margin: number; hadConflict: boolean }>();
    for (const { i, j } of chosen) {
      const s = score[i][j];
      let bestOtherTag = 0;
      for (let jj = 0; jj < tags.length; jj++) {
        if (jj !== j && guard[i][jj] > bestOtherTag) bestOtherTag = guard[i][jj];
      }
      let bestOtherTrack = ghostBestByTag[j]; // fantasmas da janela também concorrem (fix)
      for (let ii = 0; ii < currentTracks.length; ii++) {
        if (ii !== i && guard[ii][j] > bestOtherTrack) bestOtherTrack = guard[ii][j];
      }
      const margin = Math.min(s - bestOtherTag, s - bestOtherTrack);
      const bestOther = Math.max(bestOtherTag, bestOtherTrack);
      rowDiag.set(i, { margin, hadConflict: bestOther > 0 && margin < CONFLICT_MARGIN_THRESHOLD });
    }

    // Guarda de ambiguidade top-2 (formulação documentada acima): o par só fala se a margem
    // (já calculada em rowDiag) alcançar minMargin. Guarda desligada (minMargin<=0) → fala sempre
    // que chosen escolheu (comportamento pré-instrumentação, intacto).
    const accepted =
      minMargin <= 0 ? chosen : chosen.filter(({ i }) => rowDiag.get(i)!.margin >= minMargin);

    const assigned = new Map<number, { tag: string; score: number }>();
    for (const { i, j } of accepted) {
      assigned.set(currentTracks[i], { tag: tags[j], score: score[i][j] });
    }

    // Uma Assignment por pista corrente, em ordem estável de trackId.
    return currentTracks.map((id, i) => {
      const a = assigned.get(id);
      const diag = rowDiag.get(i);
      if (a !== undefined) {
        // diag sempre existe aqui: `a` só existe p/ i que veio de `accepted`, subconjunto de `chosen`.
        return { trackId: id, tag: a.tag, confidence: a.score, margin: diag!.margin, hadConflict: diag!.hadConflict };
      }
      // "não sei": reporta o melhor score que a pista alcançou (honesto — mostra o quão perto chegou).
      const confidence = score[i].length > 0 ? Math.max(...score[i]) : 0;
      if (diag !== undefined) {
        // chosen mas recusado pela guarda de margem: abstenção AMBÍGUA — margin real, hadConflict
        // real (foi a concorrência que barrou a fala).
        return { trackId: id, tag: null, confidence, margin: diag.margin, hadConflict: diag.hadConflict };
      }
      // nenhum candidato alcançou minConfidence: abstenção por FALTA de evidência, não por empate.
      return { trackId: id, tag: null, confidence, margin: 0, hadConflict: false };
    });
  }

  /**
   * FUNIL DE VETOS INSTRUMENTADO (ADITIVO, 2026-07-11 — pedido do especialista científico após o
   * 1º teste de campo falhar em silêncio): "a decisão final é o fim de uma CADEIA DE VETOS, e o
   * silêncio pode morrer em qualquer elo". Devolve, por par (pista corrente, tag na janela), o
   * estado em CADA elo — n amostras → span → movVar → corr → score → margem → verdict do gate que
   * matou (ou "SPOKE").
   *
   * FONTE ÚNICA, SEM RECÁLCULO PARALELO: usa as MESMAS funções do caminho real — align/pearson
   * p/ os intermediários, pairScore() p/ o score efetivo, chooseGreedy/chooseOptimal + a mesma
   * matemática de margem (concorrentes de guarda + fantasmas da janela) p/ os verdicts pós-score.
   * Um par com verdict "SPOKE" é EXATAMENTE o par que assign(now) reportaria com tag não-null.
   *
   * SÓ LEITURA: não poda o buffer nem muda estado algum — chamar diagnoseFunnel(now) antes de
   * assign(now) não altera o resultado de assign (a janela é filtrada localmente com o MESMO
   * predicado do prune).
   */
  diagnoseFunnel(now?: number): PairFunnel[] {
    const ref = now ?? this.latestTs();
    if (ref === null) return [];
    const lo = ref - this.cfg.windowMs;
    const frames = this.buffer.filter((f) => f.ts >= lo && f.ts <= ref);

    // Pistas correntes: as do frame mais recente com pistas (mesma regra de currentTrackIds()).
    let latest: FusionFrame | null = null;
    for (const f of frames) {
      if (f.tracks.length === 0) continue;
      if (latest === null || f.ts > latest.ts) latest = f;
    }
    if (latest === null) return [];
    const idSet = new Set<number>();
    for (const t of latest.tracks) idSet.add(t.trackId);
    const currentTracks = [...idSet].sort((a, b) => a - b);

    // Séries por pista/tag na janela — MESMA construção do assign() (fantasmas incluídos).
    const distByTrack = new Map<number, DistSample[]>();
    const rssiByTag = new Map<string, RssiSample[]>();
    for (const f of frames) {
      for (const t of f.tracks) {
        let arr = distByTrack.get(t.trackId);
        if (!arr) {
          arr = [];
          distByTrack.set(t.trackId, arr);
        }
        arr.push({ ts: f.ts, value: t.dist, metric: t.metric === true });
      }
      for (const r of f.readings) {
        let arr = rssiByTag.get(r.tag);
        if (!arr) {
          arr = [];
          rssiByTag.set(r.tag, arr);
        }
        const s: RssiSample = { ts: f.ts, value: r.rssi };
        if (r.distM !== undefined) s.distM = r.distM;
        arr.push(s);
      }
    }
    const tags = [...rssiByTag.keys()].sort();
    if (tags.length === 0) return [];

    // Matrizes de evidência + escolha 1-1 + fantasmas + margens: o MESMO caminho do assign().
    const evidence: PairEvidence[][] = currentTracks.map((id) => {
      const distSeries = distByTrack.get(id) ?? [];
      return tags.map((tag) => this.pairScore(distSeries, rssiByTag.get(tag) ?? []));
    });
    const score: number[][] = evidence.map((row) => row.map((e) => e.score));
    const guard: number[][] = evidence.map((row) => row.map((e) => e.guard));

    const { windowMs, minSamples, minConfidence, minMovement, minMargin, optimal } = this.cfg;
    const speakBar = this.speakBar(); // mesma barra do assign() — fonte única
    const chosen = optimal ? chooseOptimal(score, speakBar) : chooseGreedy(score, speakBar);

    const currentSet = new Set(currentTracks);
    const ghostBestByTag = new Array<number>(tags.length).fill(0);
    if (chosen.length > 0) {
      for (const [id, distSeries] of distByTrack) {
        if (currentSet.has(id)) continue;
        for (let j = 0; j < tags.length; j++) {
          const e = this.pairScore(distSeries, rssiByTag.get(tags[j]) ?? []);
          if (e.guard > ghostBestByTag[j]) ghostBestByTag[j] = e.guard;
        }
      }
    }

    const chosenByKey = new Map<string, { margin: number; accepted: boolean }>();
    for (const { i, j } of chosen) {
      const s = score[i][j];
      let bestOtherTag = 0;
      for (let jj = 0; jj < tags.length; jj++) {
        if (jj !== j && guard[i][jj] > bestOtherTag) bestOtherTag = guard[i][jj];
      }
      let bestOtherTrack = ghostBestByTag[j];
      for (let ii = 0; ii < currentTracks.length; ii++) {
        if (ii !== i && guard[ii][j] > bestOtherTrack) bestOtherTrack = guard[ii][j];
      }
      const margin = Math.min(s - bestOtherTag, s - bestOtherTrack);
      chosenByKey.set(`${i}:${j}`, { margin, accepted: minMargin <= 0 || margin >= minMargin });
    }

    const thresholds: FunnelThresholds = {
      windowMs,
      minSamples,
      minConfidence,
      minMovement,
      minMargin,
    };
    const out: PairFunnel[] = [];
    for (let i = 0; i < currentTracks.length; i++) {
      const distSeries = distByTrack.get(currentTracks[i]) ?? [];
      for (let j = 0; j < tags.length; j++) {
        const rssiSeries = rssiByTag.get(tags[j]) ?? [];
        const aligned = align(distSeries, rssiSeries);
        const alignedSamples = aligned.rssi.length;
        let spanMs = 0;
        if (alignedSamples > 0) {
          let tsMin = Infinity;
          let tsMax = -Infinity;
          for (const d of distSeries) {
            if (d.ts < tsMin) tsMin = d.ts;
            if (d.ts > tsMax) tsMax = d.ts;
          }
          spanMs = tsMax - tsMin;
        }
        const p = alignedSamples >= 2 ? pearson(aligned.rssi, aligned.dist) : null;
        const s = score[i][j];
        const ck = chosenByKey.get(`${i}:${j}`);
        // A cadeia de vetos, na ORDEM exata de pairScore() → chooseGreedy/Optimal → guarda:
        let verdict: FunnelVerdict;
        if (distSeries.length < minSamples) verdict = "distSamples<minSamples";
        else if (rssiSeries.length < minSamples) verdict = "rssiSamples<minSamples";
        else if (alignedSamples < minSamples) verdict = "aligned<minSamples";
        else if (p === null) verdict = "constantSeries";
        // Veto de movimento: MESMA função do pairScore (movementVetoed — cobre também os knobs
        // de pesquisa useLogDistance/minMovementDecades; default = p.varY < minMovement, igual).
        else if (this.movementVetoed(aligned.dist)) verdict = "lowMovement";
        else if (ck !== undefined) verdict = ck.accepted ? "SPOKE" : "belowMinMargin";
        else verdict = eligible(s, speakBar) ? "lostTieBreak" : "belowMinConfidence";
        out.push({
          trackId: currentTracks[i],
          tag: tags[j],
          distSamples: distSeries.length,
          rssiSamples: rssiSeries.length,
          alignedSamples,
          spanMs,
          movVar: p === null ? null : p.varY,
          corr: p === null ? null : p.corr,
          score: s,
          margin: ck === undefined ? null : ck.margin,
          verdict,
          thresholds,
        });
      }
    }
    return out;
  }

  /** Maior ts no buffer (null se vazio). */
  private latestTs(): number | null {
    let max: number | null = null;
    for (const f of this.buffer) if (max === null || f.ts > max) max = f.ts;
    return max;
  }

  /** Pistas "correntes": as do frame mais recente (≤ ref) que contém pistas. */
  private currentTrackIds(): number[] {
    let latest: FusionFrame | null = null;
    for (const f of this.buffer) {
      if (f.tracks.length === 0) continue;
      if (latest === null || f.ts > latest.ts) latest = f;
    }
    if (latest === null) return [];
    const ids = new Set<number>();
    for (const t of latest.tracks) ids.add(t.trackId);
    return [...ids];
  }
}
