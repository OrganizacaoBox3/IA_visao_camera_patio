// POLÍTICA DE ÂNCORA — a decisão de identidade de um OPERADOR a partir de VÁRIOS episódios.
//
// A TESE QUE ESTE MÓDULO TESTA (revisor externo, 2026-07-12):
//   A curva de precisão × n_eff medida em `receiver-at-destino.test.ts` (rampa de ~85% no piso 3 a
//   ~94% no piso 19, SEM joelho) é a precisão de UM episódio ISOLADO. Dela concluímos "95% é
//   inalcançável neste canal (teto ~94%)". O revisor aponta que esse é o teto de uma POLÍTICA —
//   a de FALAR NA PRIMEIRA OPORTUNIDADE — e não do canal: o portal é uma ÂNCORA DE TURNO, e o
//   operador entra, sai e volta. Duas decisões CONCORDANTES são muito mais fortes que uma.
//
// O QUE ESTE MÓDULO FAZ (responsabilidade única): agrega as decisões de N episódios do MESMO
// operador em UMA âncora, por duas políticas — e ABSTÉM na discordância (a invariante da casa:
// rótulo errado é pior que nenhum). Não simula, não recorta episódios (isso é visit-metrics.ts),
// não associa. Puro e determinístico.
//
//   (a) k-CONCORDÂNCIA: os PRIMEIROS k episódios DECIDIDOS (ordem cronológica) precisam apontar a
//       MESMA tag. Discordância entre eles → ABSTENÇÃO. Menos de k decididos → sem âncora.
//       k=1 reduz EXATAMENTE à política de hoje ("falar na primeira oportunidade") — por isso a
//       regra é "os PRIMEIROS k" e não "todos os decididos concordam": esta última mudaria também
//       o k=1 (abster-se-ia quando 3 episódios discordassem), e o k=1 tem de ser o baseline fiel.
//
//   (b) SOMA DE FISHER-Z: soma os z=atanh(r) dos episódios do operador, por TAG, com peso
//       w_i = n_eff_i − 3 (o inverso da variância de Fisher), e aplica o gate de significância
//       sobre o AGREGADO: |z̄| ≥ z_crit / √(Σ w_i). O "n_eff efetivo" do agregado é Σ w_i + 3 =
//       Σ n_eff_i − 3(m−1) — some as evidências, some os graus de liberdade (m = nº de episódios
//       contribuintes). É LEVEMENTE mais conservador que "n_eff efetivo = Σ n_eff_i" (perde 3 por
//       episódio extra); é o preço correto de estimar m médias/variâncias separadas em vez de uma.
//
// ⚠ INDEPENDÊNCIA — A CONDIÇÃO QUE FAZ A SOMA DE FISHER SER LEGÍTIMA (Regra 8, a inflação que já
//   nos pegou 2×). Somar z sobre janelas DESLIZANTES (event-metrics.ts) inflava porque ticks
//   vizinhos compartilham 15/16 da amostra. Aqui:
//     • DADO COMPARTILHADO: episódios de um operador são janelas CONTÍGUAS DISJUNTAS (buildEpisodes
//       fecha um episódio quando a pista some/troca de verdade). Amostras disjuntas ⇒ nenhuma
//       leitura entra em dois z. `sharedDataRisk()` MEDE isso (não confia): sobreposição temporal
//       entre episódios do mesmo operador = BUG (0 esperado), e "gap < Δt_tag" = o único vazamento
//       possível (a leitura CARREGADA no início do episódio seguinte pode ser o MESMO advertisement
//       que fechou o anterior — no máximo 1 leitura por par, e some se o gap ≥ Δt_tag).
//     • ERROS CORRELACIONADOS (o risco REAL, e ele NÃO é resolvido pela disjunção temporal): o viés
//       corporal, a geometria da sala e o offset regional são os MESMOS entre episódios do mesmo
//       operador. Se o erro é sistemático, dois episódios podem errar JUNTOS e na MESMA tag — e aí
//       a concordância não é evidência independente, é o mesmo erro duas vezes. Isso não se resolve
//       por argumento: mede-se (`agreementOnFailure`), e é o teste que decide se a política compra
//       precisão de verdade ou só correlaciona o próprio erro.
//
// ⚠ A UNIDADE MUDOU (ADR-015): a métrica NÃO é mais por episódio — é por OPERADOR (a ÂNCORA).
//   Cobertura de turno = fração de operadores ancorados; precisão = fração dos ancorados que
//   receberam a tag CERTA.
import { wilsonInterval } from "./visit-metrics";
import type { VisitCandidate, VisitEpisode } from "./visit-metrics";

const DEFAULT_Z_CRIT = 1.96;
/** Piso da FÓRMULA de Fisher: abaixo dele √(n_eff−3) é imaginário e o teste NÃO EXISTE. */
const FISHER_FLOOR = 3;

/** Um episódio já recortado, etiquetado com o OPERADOR a que pertence (a unidade da âncora). */
export type OperatorEpisode = { operator: string; episode: VisitEpisode };

/** A âncora de UM operador: a decisão única do turno, agregando todos os episódios dele. */
export type Anchor = {
  operator: string;
  /** Tag-verdade do operador (null = operador sem tag → qualquer âncora aqui é FALSA). */
  truthTag: string | null;
  /** Episódios do operador (todos, elegíveis ou não). */
  nEpisodes: number;
  /** Episódios que a política de fato CONSUMIU (decididos, em (a); contribuintes, em (b)). */
  nUsed: number;
  /** n_eff EFETIVO do agregado — em (a), a soma dos n_eff dos k concordantes; em (b), Σw+3. */
  nEffEffective: number;
  decisionTag: string | null;
  decided: boolean;
  /** true = havia evidência mas os episódios DISCORDARAM → abstenção (o comportamento que a
   *  invariante da casa quer). Só em (a). */
  abstainedByDisagreement: boolean;
  /** decisionTag === truthTag quando ancorado; null quando não ancorado. */
  correct: boolean | null;
};

export type AnchorMetrics = {
  /** Operadores COM tag (a população da âncora — o que o cliente compra). */
  operators: number;
  anchored: number;
  anchoredCorrect: number;
  abstained: number;
  abstainedByDisagreement: number;
  /** anchoredCorrect / anchored — a PRECISÃO DE TURNO. 1 se nada ancorado (abster é honesto). */
  precision: number;
  /** anchored / operators — a COBERTURA DE TURNO (fração de operadores ancorados). */
  turnCoverage: number;
  /** anchoredCorrect / operators — a cobertura ÚTIL (ancorado E certo): a leitura literal de
   *  "operadores ancorados ao menos 1× CORRETAMENTE". */
  correctTurnCoverage: number;
};

export type PolicyOpts = {
  /** Episódios concordantes (variante a) / contribuintes (variante b) exigidos. k=1 = política atual. */
  k: number;
  /** PISO DE n_eff POR EPISÓDIO (Regra 10). Nunca abaixo de 3 (o piso da fórmula). */
  minNEff: number;
  zCrit?: number;
};

/** Vencedor de um episódio = maior score (−r) entre os candidatos — a MESMA regra de decideEpisode
 *  (visit-metrics.ts): correlação POSITIVA é evidência CONTRA a identidade, não a favor. Empate →
 *  menor tag lex (candidates já vem ordenado). null se não há candidato. */
function winnerOf(ep: VisitEpisode): VisitCandidate | null {
  let w: VisitCandidate | null = null;
  for (const c of ep.candidates) if (w === null || c.score > w.score) w = c;
  return w;
}

/** Um candidato é significativo com o piso `minNEff`? Recomputa o gate do episódio SEM re-simular
 *  (r/z/n_eff do candidato NÃO dependem do piso — só o gate depende). É o que permite varrer
 *  pisos × k sobre UMA colheita de episódios. */
export function significantAt(c: VisitCandidate, minNEff: number, zCrit = DEFAULT_Z_CRIT): boolean {
  const floor = Math.max(FISHER_FLOOR, minNEff);
  return c.nEff > floor && Math.abs(c.z) >= zCrit * Math.sqrt(1 / (c.nEff - FISHER_FLOOR));
}

/** A decisão de UM episódio sob um piso: a tag decidida (null = abstenção) + o vencedor. */
export function episodeDecisionAt(
  ep: VisitEpisode,
  minNEff: number,
  zCrit = DEFAULT_Z_CRIT,
): { tag: string | null; winner: VisitCandidate | null } {
  const w = winnerOf(ep);
  if (w === null) return { tag: null, winner: null };
  const ok = w.score > 0 && significantAt(w, minNEff, zCrit);
  return { tag: ok ? w.tag : null, winner: w };
}

/** Agrupa episódios por operador, em ordem CRONOLÓGICA dentro do operador (a ordem importa: a
 *  política (a) consome os PRIMEIROS k decididos). Determinístico (empate de ts → trackId). */
export function groupByOperator(eps: readonly OperatorEpisode[]): Map<string, VisitEpisode[]> {
  const by = new Map<string, VisitEpisode[]>();
  for (const { operator, episode } of eps) {
    const list = by.get(operator);
    if (list) list.push(episode);
    else by.set(operator, [episode]);
  }
  for (const list of by.values()) {
    list.sort((a, b) => a.startTs - b.startTs || a.trackId - b.trackId);
  }
  return by;
}

/**
 * POLÍTICA (a) — k-CONCORDÂNCIA. Os PRIMEIROS k episódios DECIDIDOS do operador têm de apontar a
 * MESMA tag. Discordam → ABSTÉM (e marca `abstainedByDisagreement`). Menos de k decididos → sem
 * âncora. k=1 = a política de hoje (falar na primeira oportunidade), bit-a-bit.
 */
export function anchorByConcordance(
  operator: string,
  episodes: readonly VisitEpisode[],
  opts: PolicyOpts,
): Anchor {
  const zCrit = opts.zCrit ?? DEFAULT_Z_CRIT;
  const truthTag = episodes.find((e) => e.truthTag !== null)?.truthTag ?? null;
  const decisions: { tag: string; nEff: number }[] = [];
  for (const ep of episodes) {
    const d = episodeDecisionAt(ep, opts.minNEff, zCrit);
    if (d.tag !== null && d.winner) decisions.push({ tag: d.tag, nEff: d.winner.nEff });
  }
  const base = {
    operator,
    truthTag,
    nEpisodes: episodes.length,
    nUsed: 0,
    nEffEffective: 0,
    decisionTag: null,
    decided: false,
    abstainedByDisagreement: false,
    correct: null,
  } satisfies Anchor;

  if (decisions.length < opts.k) return base;
  const firstK = decisions.slice(0, opts.k);
  const agree = firstK.every((d) => d.tag === firstK[0].tag);
  const nEffEffective = firstK.reduce((s, d) => s + d.nEff, 0);
  if (!agree) return { ...base, nUsed: firstK.length, nEffEffective, abstainedByDisagreement: true };
  return {
    ...base,
    nUsed: firstK.length,
    nEffEffective,
    decisionTag: firstK[0].tag,
    decided: true,
    correct: firstK[0].tag === truthTag,
  };
}

/**
 * POLÍTICA (b) — SOMA DE FISHER-Z entre episódios. Por TAG candidata, soma os z dos episódios do
 * operador que passam o piso (n_eff_i > minNEff), com peso w_i = n_eff_i − 3 (inverso da variância
 * de Fisher). Exige ≥ k episódios CONTRIBUINTES para aquela tag. Gate sobre o AGREGADO:
 *
 *     z̄ = Σ w_i z_i / Σ w_i        significativo ⟺ |z̄| ≥ z_crit / √(Σ w_i)
 *
 * Vencedor = maior score agregado (−tanh(z̄), o mesmo casamento físico de sempre); decide se ele é
 * significativo E score > 0. LEGITIMIDADE: os z_i vêm de janelas DISJUNTAS (ver `sharedDataRisk`);
 * a hipótese que resta é a de erros independentes entre episódios (ver `agreementOnFailure`).
 */
export function anchorByFisherSum(
  operator: string,
  episodes: readonly VisitEpisode[],
  opts: PolicyOpts,
): Anchor {
  const zCrit = opts.zCrit ?? DEFAULT_Z_CRIT;
  const floor = Math.max(FISHER_FLOOR, opts.minNEff);
  const truthTag = episodes.find((e) => e.truthTag !== null)?.truthTag ?? null;

  // Por tag: soma ponderada de z, peso total, e nº de episódios contribuintes.
  const agg = new Map<string, { sumWZ: number; sumW: number; m: number; sumNEff: number }>();
  for (const ep of episodes) {
    for (const c of ep.candidates) {
      if (!(c.nEff > floor)) continue; // piso POR EPISÓDIO (e ≥ o da fórmula ⇒ w > 0)
      const w = c.nEff - FISHER_FLOOR;
      const a = agg.get(c.tag) ?? { sumWZ: 0, sumW: 0, m: 0, sumNEff: 0 };
      a.sumWZ += w * c.z;
      a.sumW += w;
      a.m += 1;
      a.sumNEff += c.nEff;
      agg.set(c.tag, a);
    }
  }

  let best: { tag: string; score: number; sig: boolean; m: number; nEffEff: number } | null = null;
  for (const tag of [...agg.keys()].sort()) {
    const a = agg.get(tag)!;
    if (a.m < opts.k || a.sumW <= 0) continue; // ≥ k episódios contribuintes para ESTA tag
    const zBar = a.sumWZ / a.sumW;
    const score = -Math.tanh(zBar); // casamento físico: RSSI cai com a distância ⇒ r<0 ⇒ score>0
    const sig = Math.abs(zBar) >= zCrit / Math.sqrt(a.sumW);
    const nEffEff = a.sumW + FISHER_FLOOR; // = Σ n_eff_i − 3(m−1)
    if (best === null || score > best.score) best = { tag, score, sig, m: a.m, nEffEff };
  }

  if (best === null) {
    return {
      operator,
      truthTag,
      nEpisodes: episodes.length,
      nUsed: 0,
      nEffEffective: 0,
      decisionTag: null,
      decided: false,
      abstainedByDisagreement: false,
      correct: null,
    };
  }
  const decided = best.sig && best.score > 0;
  return {
    operator,
    truthTag,
    nEpisodes: episodes.length,
    nUsed: best.m,
    nEffEffective: best.nEffEff,
    decisionTag: decided ? best.tag : null,
    decided,
    abstainedByDisagreement: false,
    correct: decided ? best.tag === truthTag : null,
  };
}

export type PolicyVariant = "concordance" | "fisher";

/** Aplica a política a TODOS os operadores. Ordem de saída = ordem lexicográfica do operador
 *  (determinística, independente da ordem de entrada). */
export function computeAnchors(
  eps: readonly OperatorEpisode[],
  variant: PolicyVariant,
  opts: PolicyOpts,
): Anchor[] {
  const by = groupByOperator(eps);
  const decide = variant === "concordance" ? anchorByConcordance : anchorByFisherSum;
  return [...by.keys()].sort().map((op) => decide(op, by.get(op)!, opts));
}

/** Métricas de TURNO sobre as âncoras dos operadores COM tag (os sem-tag saem — a rejeição de
 *  quem-não-tem-tag é OUTRO eixo, e a §2 já mediu que a agregação não o resolve; medi-lo aqui
 *  misturaria dois erros de naturezas diferentes. `falseAnchors` conta o eixo separado). */
export function computeAnchorMetrics(anchors: readonly Anchor[]): AnchorMetrics {
  const withTag = anchors.filter((a) => a.truthTag !== null);
  const anchored = withTag.filter((a) => a.decided);
  const correct = anchored.filter((a) => a.correct === true).length;
  const byDis = withTag.filter((a) => a.abstainedByDisagreement).length;
  return {
    operators: withTag.length,
    anchored: anchored.length,
    anchoredCorrect: correct,
    abstained: withTag.length - anchored.length,
    abstainedByDisagreement: byDis,
    precision: anchored.length === 0 ? 1 : correct / anchored.length,
    turnCoverage: withTag.length === 0 ? 0 : anchored.length / withTag.length,
    correctTurnCoverage: withTag.length === 0 ? 0 : correct / withTag.length,
  };
}

/** Âncoras produzidas sobre operadores SEM tag = FALSAS por construção (o eixo "rejeitar
 *  quem-não-tem-tag", reportado à parte). */
export function falseAnchors(anchors: readonly Anchor[]): { noTagOperators: number; anchored: number } {
  const noTag = anchors.filter((a) => a.truthTag === null);
  return { noTagOperators: noTag.length, anchored: noTag.filter((a) => a.decided).length };
}

// ─────────────────────── OS DOIS SENSORES DE INFLAÇÃO (Regra 8) ───────────────────────

/** O risco de DADO COMPARTILHADO entre episódios do MESMO operador — o que tornaria a soma de
 *  Fisher ilegítima (a inflação de event-metrics.ts, agora na unidade certa). */
export type SharedDataRisk = {
  /** Pares de episódios CONSECUTIVOS do mesmo operador avaliados. */
  pairs: number;
  /** Pares com sobreposição TEMPORAL (endTs do anterior > startTs do seguinte) — dado de fato
   *  compartilhado. É BUG: buildEpisodes recorta janelas disjuntas por trackId, e dois tracks
   *  simultâneos com a MESMA verdade seriam um fantasma do tracker. Esperado: 0. */
  overlapping: number;
  /** Pares cujo GAP entre episódios é MENOR que Δt_tag: a leitura "carregada" no 1º tick do
   *  episódio seguinte pode ser o MESMO advertisement que fechou o anterior — no máximo UMA
   *  leitura repetida por par (vazamento limitado, e nulo quando o gap ≥ Δt_tag). */
  tightGaps: number;
  /** Gap mediano (s) entre episódios consecutivos do mesmo operador. */
  medianGapS: number;
};

export function sharedDataRisk(eps: readonly OperatorEpisode[], dtTagS: number): SharedDataRisk {
  const by = groupByOperator(eps);
  let pairs = 0;
  let overlapping = 0;
  let tightGaps = 0;
  const gaps: number[] = [];
  for (const list of by.values()) {
    for (let i = 1; i < list.length; i++) {
      pairs++;
      const gapS = (list[i].startTs - list[i - 1].endTs) / 1000;
      if (gapS < 0) overlapping++;
      else if (gapS < dtTagS) tightGaps++;
      gaps.push(gapS);
    }
  }
  gaps.sort((a, b) => a - b);
  return {
    pairs,
    overlapping,
    tightGaps,
    medianGapS: gaps.length ? gaps[gaps.length >> 1] : 0,
  };
}

/** O risco de ERRO CORRELACIONADO: quando um episódio do operador ERRA, o seguinte erra JUNTO e na
 *  MESMA tag? Se sim, a "concordância" não é evidência independente — é o mesmo viés duas vezes, e
 *  a política de dupla-confirmação NÃO compra a precisão que promete. */
export type AgreementOnFailure = {
  /** Operadores com ≥2 episódios decididos (sob o piso) — a população deste teste. */
  operators: number;
  /** Pares (1º decidido, 2º decidido) avaliados. */
  pairs: number;
  /** Pares em que os dois concordam (mesma tag). */
  agree: number;
  /** Pares em que o 1º está ERRADO. */
  firstWrong: number;
  /** …e o 2º repete o MESMO erro (concordância ERRADA — o que a política deixaria passar). */
  firstWrongAndAgree: number;
  /** Pares em que o 1º está CERTO. */
  firstRight: number;
  /** …e o 2º concorda (concordância CERTA). */
  firstRightAndAgree: number;
};

export function agreementOnFailure(
  eps: readonly OperatorEpisode[],
  minNEff: number,
  zCrit = DEFAULT_Z_CRIT,
): AgreementOnFailure {
  const by = groupByOperator(eps);
  const out: AgreementOnFailure = {
    operators: 0,
    pairs: 0,
    agree: 0,
    firstWrong: 0,
    firstWrongAndAgree: 0,
    firstRight: 0,
    firstRightAndAgree: 0,
  };
  for (const list of by.values()) {
    const truth = list.find((e) => e.truthTag !== null)?.truthTag ?? null;
    if (truth === null) continue;
    const dec: string[] = [];
    for (const ep of list) {
      const d = episodeDecisionAt(ep, minNEff, zCrit);
      if (d.tag !== null) dec.push(d.tag);
    }
    if (dec.length < 2) continue;
    out.operators++;
    out.pairs++;
    const [a, b] = dec;
    const same = a === b;
    if (same) out.agree++;
    if (a !== truth) {
      out.firstWrong++;
      if (same) out.firstWrongAndAgree++;
    } else {
      out.firstRight++;
      if (same) out.firstRightAndAgree++;
    }
  }
  return out;
}

/** "62,5% [IC95 35,4–83,7], n=16" — reexporta a régua de Wilson do arco (Regra 10: nunca uma
 *  proporção sem n e IC). */
export function formatAnchorProportion(successes: number, n: number): string {
  if (n <= 0) return "— (n=0)";
  const { lo, hi } = wilsonInterval(successes, n);
  const pc = (x: number): string => (100 * x).toFixed(1);
  return `${pc(successes / n)}% [IC95 ${pc(lo)}–${pc(hi)}], n=${n}`;
}
