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
};

type ResolvedConfig = Required<FusionConfig>;

const DEFAULTS: ResolvedConfig = {
  windowMs: 8000,
  minSamples: 5,
  minConfidence: 0.5,
  minMovement: 0.25, // variância (m²) — ~0,5 m de desvio-padrão de movimento
  minMargin: 0.1, // guarda de ambiguidade LIGADA por default — decisão MEDIDA (ver cabeçalho)
  optimal: false, // Hungarian medido e não promovido (ver cabeçalho); knob disponível
  maxDistRatio: 0, // gate DESLIGADO — knob de pesquisa; a revisão adversarial provou circularidade (ver cabeçalho)
  distWeight: 0, // blend DESLIGADO — idem; ambos aguardam dados de campo p/ re-medição honesta
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
    const { minSamples, minMovement, minConfidence, maxDistRatio, distWeight } = this.cfg;
    if (distSeries.length < minSamples || rssiSeries.length < minSamples) return NO_EVIDENCE;
    const { rssi, dist, gaps, logGaps } = align(distSeries, rssiSeries);
    if (rssi.length < minSamples) return NO_EVIDENCE;
    const p = pearson(rssi, dist);
    if (p === null) return NO_EVIDENCE; // série constante
    if (p.varY < minMovement) return NO_EVIDENCE; // pessoa (quase) parada → ambíguo, "não sei"
    // -corr: casamento físico (RSSI cai com distância) → corr<0 → score>0.
    const base = Math.max(0, Math.min(1, -p.corr));
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

    const { minConfidence, minMargin, optimal } = this.cfg;
    const chosen = optimal
      ? chooseOptimal(score, minConfidence)
      : chooseGreedy(score, minConfidence);

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
