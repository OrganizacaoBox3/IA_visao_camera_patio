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
// Sem movimento suficiente, amostras de menos, ou correlação fraca → tag = null ("não sei").
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
};

type ResolvedConfig = Required<FusionConfig>;

const DEFAULTS: ResolvedConfig = {
  windowMs: 8000,
  minSamples: 5,
  minConfidence: 0.5,
  minMovement: 0.25, // variância (m²) — ~0,5 m de desvio-padrão de movimento
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
   * Atribuição corrente: 1 tag por pessoa e vice-versa. Casa por correlação (guloso determinístico
   * por maior score, desempate estável). Pares abaixo de minConfidence NÃO consomem tag e a pessoa
   * fica com tag=null. Uma Assignment por pista corrente (as presentes no último frame com pistas).
   */
  assign(now?: number): Assignment[] {
    const ref = now ?? this.latestTs();
    if (ref !== null) this.prune(ref);

    const currentTracks = this.currentTrackIds();
    if (currentTracks.length === 0) return [];

    // Séries por pista e por tag dentro da janela.
    const distByTrack = new Map<number, Sample[]>();
    const rssiByTag = new Map<string, Sample[]>();
    for (const id of currentTracks) distByTrack.set(id, []);
    for (const f of this.buffer) {
      for (const t of f.tracks) {
        const arr = distByTrack.get(t.trackId);
        if (arr) arr.push({ ts: f.ts, value: t.dist });
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

    // Matriz de scores → candidatos (só pares com score > 0).
    const tags = [...rssiByTag.keys()];
    type Cand = { trackId: number; tag: string; score: number };
    const cands: Cand[] = [];
    const bestByTrack = new Map<number, number>();
    for (const id of currentTracks) {
      const distSeries = distByTrack.get(id) ?? [];
      let best = 0;
      for (const tag of tags) {
        const score = this.pairScore(distSeries, rssiByTag.get(tag) ?? []);
        if (score > best) best = score;
        if (score > 0) cands.push({ trackId: id, tag, score });
      }
      bestByTrack.set(id, best);
    }

    // Guloso determinístico: maior score primeiro; desempate por trackId, depois por tag.
    cands.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.trackId !== b.trackId) return a.trackId - b.trackId;
      return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
    });

    const takenTrack = new Set<number>();
    const takenTag = new Set<string>();
    const assignedTag = new Map<number, string>();
    const { minConfidence } = this.cfg;
    for (const c of cands) {
      if (c.score < minConfidence) break; // ordenado desc → o resto é ainda mais fraco
      if (takenTrack.has(c.trackId) || takenTag.has(c.tag)) continue;
      takenTrack.add(c.trackId);
      takenTag.add(c.tag);
      assignedTag.set(c.trackId, c.tag);
    }

    // Uma Assignment por pista corrente, em ordem estável de trackId.
    return [...currentTracks].sort((a, b) => a - b).map((id) => {
      const tag = assignedTag.get(id);
      if (tag !== undefined) {
        const score = cands.find((c) => c.trackId === id && c.tag === tag)?.score ?? 0;
        return { trackId: id, tag, confidence: score };
      }
      // "não sei": reporta o melhor score que a pista alcançou (honesto — mostra o quão perto chegou).
      return { trackId: id, tag: null, confidence: bestByTrack.get(id) ?? 0 };
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
