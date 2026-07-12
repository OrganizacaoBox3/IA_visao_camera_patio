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
  /** n_eff = nDistinct·(1−ρ)/(1+ρ) — correção AR(1) da autocorrelação do RSSI. */
  nEff: number;
  /** z = atanh(r) (Fisher). */
  z: number;
  /** score de IDENTIDADE = −r (o casamento físico; >0 = RSSI cai com distância). */
  score: number;
  /** |z| ≥ z_crit·√(1/(n_eff−3)) E n_eff>3 — o teste de significância da correlação do episódio. */
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
const FISHER_R_CLAMP = 1 - 1e-12; // atanh(±1)=±∞ (mesma constante/razão do motor)
const DIST_FLOOR_M = 0.1; // piso de log10(dist) (mesmo GATE_MIN_DIST_M do motor)

type VisitOpts = {
  warmupMs?: number;
  rho?: number;
  zCrit?: number;
  minSamples?: number;
};

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
function decideEpisode(ep: RawEpisode, rho: number, zCrit: number, minSamples: number): VisitEpisode {
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
    const nEff = (nDistinct * (1 - rho)) / (1 + rho);
    const rc = Math.max(-FISHER_R_CLAMP, Math.min(FISHER_R_CLAMP, r));
    const z = Math.atanh(rc);
    const significant = nEff > 3 && Math.abs(z) >= zCrit * Math.sqrt(1 / (nEff - 3));
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
  const rho = opts?.rho ?? DEFAULT_RHO;
  const zCrit = opts?.zCrit ?? DEFAULT_Z_CRIT;
  const minSamples = opts?.minSamples ?? DEFAULT_MIN_SAMPLES;
  return buildEpisodes(ticks, warmupMs).map((ep) => decideEpisode(ep, rho, zCrit, minSamples));
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
