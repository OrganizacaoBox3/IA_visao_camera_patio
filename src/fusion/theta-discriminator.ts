// Discriminador θ (inclinação da regressão RSSI↔distância) — Δ2 do parecer do especialista
// (ADR-014 item 9). A identidade tag↔pessoa se decide HOJE (visit-metrics.ts) pelo ranking da
// CORRELAÇÃO de Pearson r entre RSSI e distância câmera→pessoa durante a aproximação. r é
// INVARIANTE AFIM: não enxerga a escala (θ) nem o offset (β) da reta. A regressão linear
//
//     RSSI = β + θ·(−log10 d) + ε
//
// libera um 2º discriminador GRÁTIS: a INCLINAÇÃO θ (dB/década). θ tem significado FÍSICO — para o
// par VERDADEIRO, θ ≈ 10·n (o expoente de path-loss do canal; ≈22 dB/década com n≈2,2) —, enquanto
// um par ESPÚRIO de |r| alto por acaso não tem razão para cair perto desse valor.
//
// RESSALVA ANTI-v4 (a razão de este módulo EXISTIR como experimento falseável, não como fé): o v4
// morreu por confiar em teoria de RSSI ABSOLUTO. NÃO fixamos θ≈22 por teoria — o viés corporal
// DIRECIONAL infla a inclinação aparente e o próprio canal varia (o cenário ancoras-mismatch-n usa
// n=3,0 → θ_verdadeiro ≈30, não 22). A prescrição do especialista é MEDIR a distribuição empírica de
// θ dos pares verdadeiros (via truthTagByTrack do sim) e só então decidir se θ separa. Se a
// distribuição sair larga/instável, θ é REFUTADO como filtro — achado negativo vale igual ao
// positivo (doutrina de honestidade). Este módulo entrega SÓ os primitivos puros; o veredito é
// medido no teste ao lado, e um veredito POSITIVO no sim ainda exige validação na caminhada real
// (o sim compartilha o modelo de RSSI com a hipótese — funil de hipótese, a mesma lição do v4).
//
// Responsabilidade única: ajustar a regressão ponderada e recortar as séries (dist, rssi) por par
// candidato. Não simula, não associa, não decide identidade. Puro e determinístico. Nenhum NaN.

import type { VisitTick } from "./visit-metrics";

/** Piso de distância para o log (mesmo GATE_MIN_DIST_M/DIST_FLOOR_M do motor e de visit-metrics). */
const DIST_FLOOR_M = 0.1;
const DEFAULT_WARMUP_MS = 8000; // idem visit-metrics/event-metrics: a janela de 8 s do motor enchendo
const DEFAULT_MIN_SAMPLES = 5; // idem visit-metrics: régua de amostras alinhadas do motor

/** −log10(max(d, piso)): a variável independente da regressão. Cresce quando a pessoa se APROXIMA
 *  (d↓ → x↑), então θ>0 = RSSI sobe ao aproximar = casamento físico (a mesma direção de −r). */
function negLog10(d: number): number {
  return -Math.log10(Math.max(d, DIST_FLOOR_M));
}

/** Ajuste da regressão ponderada RSSI = β + θ·x por PAR (tag, track) sobre a série do episódio. */
export type ThetaFit = {
  /** Inclinação θ em dB/década (coeficiente de x = −log10 d). Par verdadeiro → θ ≈ 10·n. */
  theta: number;
  /** Intercepto β (dB). Sem uso discriminante — a régua é θ; exposto por completude/depuração. */
  beta: number;
  /** r de Pearson (ponderado) SINALIZADO entre x e y — o 1º discriminador (|r|). Casamento → r>0. */
  r: number;
  /** Coeficiente de determinação r² ∈ [0,1] (= r² da correlação ponderada). */
  r2: number;
  /** Amostras alinhadas que entraram no ajuste. */
  n: number;
  /** false quando n<2 OU variância (ponderada) de x ou y ≈ 0 (θ indefinido) — nunca produz NaN. */
  ok: boolean;
};

const ZERO_FIT: ThetaFit = { theta: 0, beta: 0, r: 0, r2: 0, n: 0, ok: false };

/**
 * Regressão linear ponderada de mínimos quadrados de `rssi` (y) sobre `x = −log10(dist)`.
 * `weights` (default: todos 1 = OLS) pondera cada ponto — usado pela variante heterocedástica
 * (pontos distantes, onde a homografia é menos confiável, pesam menos; ver `distanceWeights`).
 * Função PURA. Guardas: n<2 → não-ok; variância ponderada de x ou y ≈ 0 → não-ok (θ indefinido,
 * NUNCA NaN). Mesma matemática de mínimos quadrados ponderados: θ = Sxy/Sxx, β = ȳ − θ·x̄,
 * r = Sxy/√(Sxx·Syy), tudo com médias/somas ponderadas por w.
 */
export function fitTheta(
  dist: readonly number[],
  rssi: readonly number[],
  weights?: readonly number[],
): ThetaFit {
  const n = Math.min(dist.length, rssi.length);
  if (n < 2) return { ...ZERO_FIT, n };

  let sw = 0;
  let swx = 0;
  let swy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    if (!Number.isFinite(w) || w <= 0) continue;
    const x = negLog10(dist[i]);
    const y = rssi[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sw += w;
    swx += w * x;
    swy += w * y;
  }
  if (sw <= 0) return { ...ZERO_FIT, n };
  const mx = swx / sw;
  const my = swy / sw;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    if (!Number.isFinite(w) || w <= 0) continue;
    const x = negLog10(dist[i]);
    const y = rssi[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x - mx;
    const dy = y - my;
    sxx += w * dx * dx;
    syy += w * dy * dy;
    sxy += w * dx * dy;
  }
  // Variância (ponderada) de x ou y ≈ 0 → reta indefinida (série constante em x — parado sem span
  // radial — ou em y). Abstém-se (não-ok), como o pearson de visit-metrics devolve null.
  if (sxx < 1e-12 || syy < 1e-12) return { ...ZERO_FIT, n };

  const theta = sxy / sxx;
  const beta = my - theta * mx;
  const r = sxy / Math.sqrt(sxx * syy);
  const rClamped = Math.max(-1, Math.min(1, r));
  return { theta, beta, r: rClamped, r2: rClamped * rClamped, n, ok: true };
}

/**
 * Pesos heterocedásticos 1/σ² para a regressão ponderada. σ cresce com a distância porque a
 * homografia (pé da caixa → metros) amplifica o erro de pixel longe da câmera — pontos distantes
 * são menos confiáveis e devem pesar menos.
 *  - "inv-sq" (default): σ ∝ d ⇒ w = 1/max(d, piso)². O modelo mais forte (o esperado da projeção
 *    perspectiva: erro de mundo ~ linear na profundidade).
 *  - "inv": σ ∝ √d ⇒ w = 1/max(d, piso). Downweight mais brando.
 * PURA. Para dist = proxy 1/bh (cenário não-calibrado) a monotonia se mantém (caixa menor = mais
 * longe = menos peso), então o sinal do peso continua correto mesmo sem metros reais.
 */
export function distanceWeights(
  dist: readonly number[],
  mode: "inv-sq" | "inv" = "inv-sq",
): number[] {
  return dist.map((d) => {
    const dd = Math.max(d, DIST_FLOOR_M);
    return mode === "inv-sq" ? 1 / (dd * dd) : 1 / dd;
  });
}

/** Série (dist, rssi) de UM par candidato (tag) sobre a janela de UM episódio de visita. */
export type PairSeries = {
  trackId: number;
  /** Tag-verdade do track no episódio (MAC ou null se pista sem tag / dado real sem anotação). */
  truthTag: string | null;
  /** Tag candidata (a que gerou esta série de RSSI). */
  tag: string;
  /** tag === truthTag: par VERDADEIRO (a tag É a carregadora do track). null-truth → sempre false. */
  isTrue: boolean;
  /** Distância câmera→pessoa por amostra (metros calibrados ou proxy 1/bh). */
  dist: number[];
  /** RSSI da tag candidata por amostra (alinhado a `dist`). */
  rssi: number[];
  /** Span radial em décadas: std populacional de log10(dist) — a identificabilidade do episódio. */
  spanDecades: number;
};

type RawEpisode = {
  trackId: number;
  truthTag: string | null;
  samples: { dist: number; rssiByTag: Readonly<Record<string, number>> }[];
};

/** Recorta os ticks em episódios contíguos por trackId com tag-verdade estável (MESMA definição de
 *  episódio de visit-metrics.ts — reimplementada aqui por precisar da série BRUTA (dist, rssi), que
 *  VisitEpisode não expõe; a mesma razão pela qual visit-metrics não reusa diagnoseFunnel). Quebra
 *  em ausência da pista ou troca de verdade (id-switch → dois episódios). ts < warmup ignorado. */
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
      } else {
        if (cur) done.push(cur);
        open.set(o.trackId, { trackId: o.trackId, truthTag: o.truthTag, samples: [sample] });
      }
    }
    for (const id of [...open.keys()])
      if (!seen.has(id)) {
        done.push(open.get(id)!);
        open.delete(id);
      }
  }
  for (const ep of open.values()) done.push(ep);
  return done;
}

/** std populacional de log10(max(dist, piso)) — o span radial em décadas; 0 se <2 amostras. */
function spanDecades(dist: readonly number[]): number {
  if (dist.length < 2) return 0;
  const logs = dist.map((d) => Math.log10(Math.max(d, DIST_FLOOR_M)));
  const m = logs.reduce((s, x) => s + x, 0) / logs.length;
  let s = 0;
  for (const x of logs) s += (x - m) * (x - m);
  return Math.sqrt(s / logs.length);
}

export type ExtractOpts = { warmupMs?: number; minSamples?: number };

/**
 * Extrai as séries (dist, rssi) de TODO par candidato (tag lida em algum tick × track do episódio)
 * a partir dos ticks de visita. Uma série por (episódio, tag). Filtra séries com < minSamples
 * amostras alinhadas (mesma régua de visit-metrics). PURA. É o feed do experimento de θ: cada
 * PairSeries vira um ThetaFit (OLS e ponderado) no teste ao lado.
 */
export function extractPairSeries(ticks: readonly VisitTick[], opts?: ExtractOpts): PairSeries[] {
  const warmupMs = opts?.warmupMs ?? DEFAULT_WARMUP_MS;
  const minSamples = opts?.minSamples ?? DEFAULT_MIN_SAMPLES;
  const out: PairSeries[] = [];
  for (const ep of buildEpisodes(ticks, warmupMs)) {
    const tagUniverse = new Set<string>();
    for (const s of ep.samples) for (const tag of Object.keys(s.rssiByTag)) tagUniverse.add(tag);
    for (const tag of [...tagUniverse].sort()) {
      const dist: number[] = [];
      const rssi: number[] = [];
      for (const s of ep.samples) {
        const r = s.rssiByTag[tag];
        if (r === undefined || !Number.isFinite(r) || !Number.isFinite(s.dist)) continue;
        dist.push(s.dist);
        rssi.push(r);
      }
      if (dist.length < minSamples) continue;
      out.push({
        trackId: ep.trackId,
        truthTag: ep.truthTag,
        tag,
        isTrue: ep.truthTag !== null && tag === ep.truthTag,
        dist,
        rssi,
        spanDecades: spanDecades(dist),
      });
    }
  }
  return out;
}

/** Mediana (interpolada) de uma lista; NaN se vazia. Utilitário puro exposto para o laudo/teste. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Quantil (interpolação linear, tipo-7 do R/NumPy) de uma lista; NaN se vazia. q ∈ [0,1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = Math.min(Math.max(q, 0), 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (pos - lo) * (s[hi] - s[lo]);
}
