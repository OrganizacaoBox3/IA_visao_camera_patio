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
// Responsabilidade única: só a associação. Sem deps, sem UI, sem socket, sem DOM.

export type TagReading = { tag: string; rssi: number }; // id da tag (MAC/rótulo) + RSSI dBm
export type TrackDist = { trackId: number; dist: number }; // pessoa rastreada + distância-à-estação (m ou proxy monotônico)
export type FusionFrame = { ts: number; readings: TagReading[]; tracks: TrackDist[] };
export type Assignment = { trackId: number; tag: string | null; confidence: number }; // tag=null → "não sei"

export type FusionConfig = {
  windowMs?: number; // janela de correlação
  minSamples?: number; // mínimo de amostras na janela p/ confiar
  minConfidence?: number; // abaixo disto → tag=null
  minMovement?: number; // variância mínima de distância p/ a correlação valer (parado = ambíguo)
  minMargin?: number; // guarda de ambiguidade top-2 (0 = desligada) — ver doc em assign()
  optimal?: boolean; // atribuição ótima global (Hungarian) no lugar do guloso — ver chooseOptimal()
};

type ResolvedConfig = Required<FusionConfig>;

const DEFAULTS: ResolvedConfig = {
  windowMs: 8000,
  minSamples: 5,
  minConfidence: 0.5,
  minMovement: 0.25, // variância (m²) — ~0,5 m de desvio-padrão de movimento
  minMargin: 0.1, // guarda de ambiguidade LIGADA por default — decisão MEDIDA (ver cabeçalho)
  optimal: false, // Hungarian medido e não promovido (ver cabeçalho); knob disponível
};

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

/** Amostra alinhada de uma pista: distância no instante ts. */
type Sample = { ts: number; value: number };

/** Casa cada amostra de distância com o RSSI da tag MAIS PRÓXIMO no tempo (a câmera é a série guia). */
function align(
  distSeries: readonly Sample[],
  rssiSeries: readonly Sample[],
): { rssi: number[]; dist: number[] } {
  const rssi: number[] = [];
  const dist: number[] = [];
  if (rssiSeries.length === 0) return { rssi, dist };
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
  }
  return { rssi, dist };
}

/** Par escolhido pela atribuição 1-1, como índices na matriz de scores [linha=pista, coluna=tag]. */
type Pair = { i: number; j: number };

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
   * Score de um par (track, tag) na janela: -corr(RSSI, distância), em [0..1].
   * Devolve 0 (não casa) quando qualquer guarda de honestidade falha:
   *  - amostras de menos (pista OU tag) → não dá pra confiar;
   *  - distância quase parada (variância < minMovement) → ambíguo;
   *  - RSSI constante → correlação indefinida.
   */
  private pairScore(distSeries: Sample[], rssiSeries: Sample[]): number {
    const { minSamples, minMovement } = this.cfg;
    if (distSeries.length < minSamples || rssiSeries.length < minSamples) return 0;
    const { rssi, dist } = align(distSeries, rssiSeries);
    if (rssi.length < minSamples) return 0;
    const p = pearson(rssi, dist);
    if (p === null) return 0; // série constante
    if (p.varY < minMovement) return 0; // pessoa (quase) parada → ambíguo, "não sei"
    // -corr: casamento físico (RSSI cai com distância) → corr<0 → score>0.
    return Math.max(0, Math.min(1, -p.corr));
  }

  /**
   * Atribuição corrente: 1 tag por pessoa e vice-versa, por correlação. Duas etapas:
   *
   * 1. ESCOLHA 1-1 — guloso determinístico (original) ou ótimo global (knob `optimal`, Hungarian).
   *    Pares abaixo de minConfidence NÃO consomem tag e a pessoa fica com tag=null.
   *
   * 2. GUARDA DE AMBIGUIDADE TOP-2 (knob `minMargin`; 0 = desligada). Formulação exata
   *    (decisão deliberada, documentada de propósito): a guarda é POR PAR ESCOLHIDO, contra o
   *    melhor concorrente na matriz CRUA de scores (antes da 1-1), nos DOIS eixos:
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
    const distByTrack = new Map<number, Sample[]>();
    const rssiByTag = new Map<string, Sample[]>();
    for (const f of this.buffer) {
      for (const t of f.tracks) {
        let arr = distByTrack.get(t.trackId);
        if (!arr) {
          arr = [];
          distByTrack.set(t.trackId, arr);
        }
        arr.push({ ts: f.ts, value: t.dist });
      }
      for (const r of f.readings) {
        let arr = rssiByTag.get(r.tag);
        if (!arr) {
          arr = [];
          rssiByTag.set(r.tag, arr);
        }
        arr.push({ ts: f.ts, value: r.rssi });
      }
    }

    // Matriz COMPLETA de scores (linha=pista em ordem de trackId, coluna=tag em ordem lex; zeros
    // incluídos) — base única p/ a escolha 1-1, a guarda de margem e o "quão perto chegou" do null.
    const tags = [...rssiByTag.keys()].sort();
    const score: number[][] = currentTracks.map((id) => {
      const distSeries = distByTrack.get(id) ?? [];
      return tags.map((tag) => this.pairScore(distSeries, rssiByTag.get(tag) ?? []));
    });

    const { minConfidence, minMargin, optimal } = this.cfg;
    const chosen = optimal
      ? chooseOptimal(score, minConfidence)
      : chooseGreedy(score, minConfidence);

    // Melhor concorrente FANTASMA por tag: pistas com amostras na janela mas fora do último
    // frame (flicker/oclusão). Só alimentam o scan da guarda — nunca a escolha 1-1 nem a saída.
    const currentSet = new Set(currentTracks);
    const ghostBestByTag = new Array<number>(tags.length).fill(0);
    if (minMargin > 0 && chosen.length > 0) {
      for (const [id, distSeries] of distByTrack) {
        if (currentSet.has(id)) continue;
        for (let j = 0; j < tags.length; j++) {
          const s = this.pairScore(distSeries, rssiByTag.get(tags[j]) ?? []);
          if (s > ghostBestByTag[j]) ghostBestByTag[j] = s;
        }
      }
    }

    // Guarda de ambiguidade top-2 (formulação documentada acima). Máximo sobre conjunto vazio = 0
    // (sem concorrente algum, a margem é o próprio score).
    const accepted =
      minMargin <= 0
        ? chosen
        : chosen.filter(({ i, j }) => {
            const s = score[i][j];
            let bestOtherTag = 0;
            for (let jj = 0; jj < tags.length; jj++) {
              if (jj !== j && score[i][jj] > bestOtherTag) bestOtherTag = score[i][jj];
            }
            let bestOtherTrack = ghostBestByTag[j]; // fantasmas da janela também concorrem (fix)
            for (let ii = 0; ii < currentTracks.length; ii++) {
              if (ii !== i && score[ii][j] > bestOtherTrack) bestOtherTrack = score[ii][j];
            }
            return s - bestOtherTag >= minMargin && s - bestOtherTrack >= minMargin;
          });

    const assigned = new Map<number, { tag: string; score: number }>();
    for (const { i, j } of accepted) {
      assigned.set(currentTracks[i], { tag: tags[j], score: score[i][j] });
    }

    // Uma Assignment por pista corrente, em ordem estável de trackId.
    return currentTracks.map((id, i) => {
      const a = assigned.get(id);
      if (a !== undefined) return { trackId: id, tag: a.tag, confidence: a.score };
      // "não sei": reporta o melhor score que a pista alcançou (honesto — mostra o quão perto chegou).
      return { trackId: id, tag: null, confidence: score[i].length > 0 ? Math.max(...score[i]) : 0 };
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
