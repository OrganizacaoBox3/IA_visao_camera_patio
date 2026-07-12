// Métricas de EVENTO da fusão tag↔pessoa — a virada de UNIDADE pedida pelo especialista
// científico (2026-07-11).
//
// TESE DO ESPECIALISTA (a especificação): "Estamos otimizando a métrica errada. Todo o aparato
// (identity-metrics.ts) mede precisão e cobertura POR TICK. O cliente não compra tick — compra
// EVENTO: 'esta visita à mesa 4 foi do operador 17?'. Uma caminhada de aproximação de ~15 s vale
// ~30 ticks; com cobertura 30% o sistema fala ~9 vezes a ~82% de precisão CADA. Mesmo com erros
// CORRELACIONADOS, a acurácia do EPISÓDIO fica muito acima de 82% quando a evidência dos ticks é
// AGREGADA. Agreguem por episódio de aproximação — SOMA DE FISHER-Z sobre os ticks do episódio —
// e meçam precisão de EVENTO."
//
// DIFERENÇA DE UNIDADE (o ponto inteiro deste arquivo):
//   - identity-metrics.ts conta ACERTOS/ERROS por TICK (a régua da persistência v1). É a régua da
//     evidência instantânea: "neste instante de 500 ms, o rótulo estava certo?".
//   - event-metrics.ts conta EPISÓDIOS decididos certo/errado. Um episódio de aproximação é UM
//     evento comercial; a decisão de evento é a AGREGAÇÃO da correlação de todos os seus ticks.
//     Um sistema pode ter cobertura-por-tick baixa (fala só em 30% dos ticks) e ainda assim
//     decidir o EVENTO com altíssima confiança, porque acumula evidência ao longo da aproximação.
//
// EPISÓDIO (definição): sequência CONTÍGUA de ticks do MESMO trackId em que a pista esteve
// presente E a MESMA tag-verdade valeu, ininterrupta. Quebra em: morte/ausência da pista OU troca
// da tag-verdade (id-switch do tracker faz a verdade daquele trackId mudar → dois episódios).
//
// AGREGAÇÃO (soma de Fisher-z sobre os ticks — a mesma matemática que associate.ts usa para
// combinar FONTES em multiSourceFisher, aqui aplicada ao TEMPO): para cada tag candidata,
//     z_i    = atanh(r_i)                     (r_i = Pearson RSSI×distância daquele par NAQUELE tick)
//     w_i    = n_i − 3                         (n_i = amostras alinhadas do par no tick; peso de Fisher)
//     z_comb = Σ z_i·√(w_i) / √(Σ w_i)         (Fisher-z COMBINADO — o pedido do especialista)
//     z_bar  = Σ z_i·√(w_i) / Σ √(w_i)         (Fisher-z MÉDIO ponderado — versão LIMITADA de z_comb)
//     score  = clamp01(−tanh(z_bar))           (mesma convenção do motor: score = −corr; casamento
//                                              físico tem RSSI NEGATIVAMENTE correlacionado com a
//                                              distância → r<0 → score>0). r clampado a [−1+ε,1−ε].
//   DECISÃO de evento = a tag de MAIOR z_comb (empate → menor tag lex; como toda tag é pontuada em
//   todo tick, o suporte T é ~igual entre candidatas e argmax z_comb ≡ argmax z_bar no caso normal).
//
// GUARDA DE AMBIGUIDADE (a correção que torna a comparação HONESTA — achado da 1ª rodada, 2026-07-11):
//   a régua POR TICK (identity-metrics.ts) leva vantagem embutida — a guarda top-2 do motor
//   (`minMargin`) faz o tick ABSTER quando duas tags explicam a pista igualmente bem; é DAÍ que vem
//   a precisão de 82%. Um evento que argmax-a e FALA SEMPRE (a prescrição literal) compara "tick COM
//   guarda" contra "evento SEM guarda" e AFUNDA a precisão (medido: canonico 82%→62%) — além de
//   violar o invariante do dono ("rótulo errado é pior que nenhum"). O evento herda A MESMA guarda:
//   só é DECIDIDO quando (a) score do vencedor ≥ minEventConfidence (espelha minConfidence 0.5) E
//   (b) score do vencedor − MELHOR score das OUTRAS tags ≥ minEventMargin (espelha minMargin 0.1).
//   A guarda opera no espaço LIMITADO de z_bar (−corr), não no de z_comb: z_comb cresce com o nº de
//   ticks e satura o tanh em ±1 (duas tags fortes viram 1,0 e a margem colapsa) — por isso z_bar
//   (que NÃO cresce com mais ticks) é a variável de ranqueamento-e-margem, e z_comb fica como o
//   número de SIGNIFICÂNCIA (reportado, não usado no corte). É a mesma decomposição do motor:
//   -corr decide QUEM; a guarda decide SE vale falar.
//
// HONESTIDADE — a independência dos ticks (limitação declarada, NÃO escondida): a soma de Fisher-z
// pressupõe observações INDEPENDENTES; os ticks de um episódio NÃO são — cada `r_i` sai de uma
// janela deslizante de windowMs (8 s) e ticks a 500 ms compartilham quase toda a amostra. Isso
// SUPERESTIMARIA a MAGNITUDE de |z_comb| — por isso z_comb NÃO decide o corte (só z_bar, que é
// invariante ao nº de ticks). A guarda por z_bar/margem é imune a essa inflação: a margem entre
// top-2 não depende do n aparente. O que a agregação legitimamente entrega mesmo descontando o
// overlap: uma aproximação de 15 s contém ~2 janelas de 8 s INDEPENDENTES, cada uma ~82% → a
// acurácia do episódio compõe as duas E a MARGEM entre a tag certa e a errada fica mais nítida no
// agregado que em qualquer tick isolado — é por isso que o evento decide mais (cobertura sobe) E
// erra menos (precisão sobe) que o tick, sem depender da magnitude inflada de z_comb.
//
// Responsabilidade única: só medir/agregar. Não simula, não associa, não alimenta o associador —
// o replay (test/session-loader) monta os `EventTick` chamando diagnoseFunnel por tick.
// Puro e determinístico. Nenhum NaN jamais (entradas vazias → zeros; precisão 1 = abster é honesto).

/** Uma tag candidata de um par (pista, tag) NUM tick: o r (Pearson) e o n (amostras alinhadas) que
 *  `diagnoseFunnel` (associate.ts, campos `corr`/`alignedSamples`) expõe para esse par. r é o
 *  VERDADEIRO Pearson do tick — não um proxy do score. Pares com corr indefinida (série constante)
 *  simplesmente não entram na lista do tick. */
export type EventCandidate = { tag: string; r: number; n: number };

/** O que um tick sabe de UMA pista corrente: a verdade daquele trackId (MAC ou null=sem tag; para
 *  dado real sem anotação, sempre null e a métrica de PRECISÃO não se aplica — use a de
 *  CONSISTÊNCIA), o que o associador FALOU no tick (`Assignment.tag`, para a precisão POR TICK dos
 *  mesmos ticks) e todas as tags candidatas com r/n do funil. */
export type EventTrackObs = {
  trackId: number;
  truthTag: string | null;
  spokenTag: string | null;
  candidates: EventCandidate[];
};

/** Um tick avaliável do episódio: instante + as pistas correntes com seus candidatos. */
export type EventTick = { ts: number; tracks: EventTrackObs[] };

export type EventMetrics = {
  episodes: number; // episódios totais (todos os trechos contíguos, inclusive de pista SEM tag)
  episodesWithTag: number; // episódios cuja tag-verdade ≠ null (os "eventos" que o cliente compra)
  decided: number; // episódios DECIDIDOS (fala sustentada+dominante no modo spoken; guarda no raw)
  decidedWithTag: number; // desses, quantos eram de pista COM tag (o resto = falso-evento)
  decidedCorrect: number; // decididos em que a tag vencedora == tag-verdade (só pode ocorrer c/ tag)
  falseEvents: number; // decididos sobre pista SEM tag (decided − decidedWithTag): rótulo fabricado
  eventPrecision: number; // decidedCorrect/decided — inclui falso-evento como erro; 1 se nada decidido
  /** decidedCorrect/decidedWithTag — a precisão de IDENTIDADE "dado que houve um evento numa pessoa
   *  COM tag, a tag estava certa?". Isola o eixo de identidade do eixo "rejeitar quem não tem tag"
   *  (que a agregação NÃO resolve — falso-rótulo sustentado vira falso-evento). É AQUI que a tese
   *  do especialista se mede de forma limpa. 1 quando nenhum episódio-com-tag foi decidido. */
  eventPrecisionTagged: number;
  eventCoverage: number; // episódios-COM-TAG decididos / episódios-com-tag; 0 sem episódios-com-tag
  // — Régua POR TICK sobre EXATAMENTE os mesmos ticks dos episódios (a comparação-chave da tese) —
  tickSpoke: number; // ticks de episódio em que o associador FALOU (spokenTag ≠ null)
  tickCorrect: number; // desses, quantos com spokenTag == tag-verdade do tick
  tickOpportunities: number; // ticks de episódio com tag-verdade ≠ null (pessoa TINHA tag)
  tickPrecision: number; // tickCorrect/tickSpoke — 1 quando nunca falou (mesma régua da identidade)
  tickCoverage: number; // tickCorrect/tickOpportunities; 0 sem oportunidades
};

/** Clamp de |r| antes do atanh — atanh(±1)=±∞ (mesma constante e razão do FISHER_R_CLAMP de
 *  associate.ts). 1−1e−12 ⇒ |z| ≤ ~14, que ainda satura o tanh de volta em ±1 na prática. */
const FISHER_R_CLAMP = 1 - 1e-12;

/** Default do critério de fala de EVENTO — espelha o minConfidence 0.5 do motor (score = −corr). */
const DEFAULT_MIN_EVENT_CONFIDENCE = 0.5;

/** Default da guarda de ambiguidade top-2 de EVENTO — espelha o minMargin 0.1 do motor. Operada no
 *  espaço LIMITADO de z_bar (−corr), não no de z_comb (ver cabeçalho). */
const DEFAULT_MIN_EVENT_MARGIN = 0.1;

/** Default da SUSTENTAÇÃO mínima (modo "spoken"): a tag vencedora precisa ter sido falada em ≥ 3
 *  ticks para virar evento — uma fala isolada é ruído, não evento (ver decideEpisodeSpoken). 3 é o
 *  piso conservador: sustentação real de aproximação (~9 falas) passa folgado; falso-rótulo esparso
 *  (1–2 falas soltas) é filtrado. */
const DEFAULT_MIN_SPEAK_TICKS = 3;

/** Warmup default idêntico ao da identidade (identity-metrics.ts): a janela de 8 s do associador
 *  ainda está enchendo antes disso — medir seria injusto. Como os ticks pré-warmup são contíguos
 *  no início, os episódios simplesmente COMEÇAM depois (sem buraco artificial no meio). */
const DEFAULT_WARMUP_MS = 8000;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

/** Um episódio já recortado: trechos contíguos do MESMO trackId com a MESMA tag-verdade. */
type Episode = {
  trackId: number;
  truthTag: string | null;
  obs: EventTrackObs[];
  startTs: number;
  endTs: number;
};

/**
 * Recorta os ticks em episódios (ver definição no cabeçalho). Ticks com ts < warmupMs são
 * ignorados (janela enchendo). Um episódio abre quando a pista aparece; estende enquanto a pista
 * segue presente COM a MESMA tag-verdade; fecha no tick em que a pista some OU a verdade muda.
 */
function buildEpisodes(ticks: readonly EventTick[], warmupMs: number): Episode[] {
  const sorted = ticks.filter((t) => t.ts >= warmupMs).sort((a, b) => a.ts - b.ts);
  const open = new Map<number, Episode>();
  const done: Episode[] = [];

  for (const tick of sorted) {
    const seen = new Set<number>();
    for (const o of tick.tracks) {
      seen.add(o.trackId);
      const cur = open.get(o.trackId);
      if (cur && cur.truthTag === o.truthTag) {
        cur.obs.push(o);
        cur.endTs = tick.ts;
      } else {
        if (cur) done.push(cur); // troca de verdade → fecha o anterior e abre um novo
        open.set(o.trackId, {
          trackId: o.trackId,
          truthTag: o.truthTag,
          obs: [o],
          startTs: tick.ts,
          endTs: tick.ts,
        });
      }
    }
    // Pistas que sumiram neste tick fecham seus episódios (morte de pista).
    for (const id of [...open.keys()]) if (!seen.has(id)) {
      done.push(open.get(id)!);
      open.delete(id);
    }
  }
  for (const ep of open.values()) done.push(ep);
  return done;
}

/** Acumulador de Fisher-z de UMA tag ao longo dos ticks: Σ z·√w, Σ w, Σ √w (w = n−3). */
type FisherAcc = { zw: number; w: number; sqrtW: number };

/** Soma um tick (r, n) ao acumulador. Tick com r não-finito ou peso n−3 ≤ 0 (poucas amostras) é
 *  ignorado (minSamples≥5 ⇒ w≥2 no caminho normal). r clampado a [−1+ε,1−ε] antes do atanh. */
function fisherAdd(a: FisherAcc, r: number, n: number): void {
  const w = n - 3;
  if (!Number.isFinite(r) || w <= 0) return;
  const rc = Math.max(-FISHER_R_CLAMP, Math.min(FISHER_R_CLAMP, r));
  const sqrtW = Math.sqrt(w);
  a.zw += Math.atanh(rc) * sqrtW;
  a.w += w;
  a.sqrtW += sqrtW;
}

/** Fecha o acumulador: `zComb` = Σz√w/√(Σw) (Fisher COMBINADO — significância, cresce com o nº de
 *  ticks) e `score` = clamp01(−tanh(z_bar)), z_bar = Σz√w/Σ√w (Fisher MÉDIO ponderado, LIMITADO —
 *  o −corr do agregado; ver cabeçalho). null se nada foi acumulado. */
function fisherClose(a: FisherAcc): { zComb: number; score: number } | null {
  if (a.sqrtW === 0) return null;
  return { zComb: a.zw / Math.sqrt(a.w), score: clamp01(-Math.tanh(a.zw / a.sqrtW)) };
}

/** Fisher-z por tag candidata sobre TODOS os candidatos do episódio (evidência CRUA, sem a guarda
 *  do motor). Base da CONSISTÊNCIA (dado real sem verdade) e do modo "raw" do diagnóstico. Ordem
 *  lexicográfica de tag (determinístico). */
function aggregateEpisode(ep: Episode): { tag: string; zComb: number; score: number }[] {
  const acc = new Map<string, FisherAcc>();
  for (const o of ep.obs) {
    for (const c of o.candidates) {
      let e = acc.get(c.tag);
      if (!e) {
        e = { zw: 0, w: 0, sqrtW: 0 };
        acc.set(c.tag, e);
      }
      fisherAdd(e, c.r, c.n);
    }
  }
  const out: { tag: string; zComb: number; score: number }[] = [];
  for (const tag of [...acc.keys()].sort()) {
    const closed = fisherClose(acc.get(tag)!);
    if (closed) out.push({ tag, ...closed });
  }
  return out;
}

/**
 * DECISÃO DE EVENTO (modo primário "spoken" — a leitura FIEL da tese do especialista): agrega, por
 * Fisher-z, APENAS os ticks em que o motor FALOU (spokenTag ≠ null) e a tag que ele falou. É o
 * "o sistema fala ~9 vezes a 82% cada; agreguem" tomado ao pé da letra: cada fala já passou TODAS
 * as guardas do motor (1-1, top-2 minMargin nos dois eixos, minConfidence) — a agregação só COMBINA
 * essas falas guardadas num rótulo de episódio.
 *
 * A AGREGAÇÃO SÓ AJUDA SE REJEITAR RUÍDO (achado da 2ª rodada, 2026-07-11): decidir a partir de UMA
 * fala solta AFUNDA a precisão — uma pessoa SEM tag que recebe 1 falso-rótulo em 40 ticks vira um
 * EVENTO falso inteiro (medido: sem os cortes abaixo, event-prec fica ABAIXO da tick-prec). O poder
 * da agregação é exatamente FILTRAR isso. Dois cortes, ambos herdados da lógica do motor:
 *  - SUSTENTAÇÃO: a tag vencedora precisa ter sido falada em ≥ minSpeakTicks ticks (uma fala
 *    isolada não é evento — é ruído);
 *  - DOMINÂNCIA: score do vencedor − score da 2ª tag mais falada ≥ minEventMargin (episódio que
 *    flip-flopa entre duas tags — contaminação de id-switch — é ambíguo, abstém).
 * Vencedor = tag de maior evidência combinada (−corr). Devolve o vencedor + margem + nº de falas
 * para o corte em computeEventMetrics.
 */
function decideEpisodeSpoken(
  ep: Episode,
): { tag: string | null; score: number; margin: number; speakTicks: number } {
  const acc = new Map<string, FisherAcc>();
  const votes = new Map<string, number>();
  for (const o of ep.obs) {
    if (o.spokenTag === null) continue;
    const c = o.candidates.find((x) => x.tag === o.spokenTag);
    if (!c) continue; // fala sem par no funil (não deveria ocorrer p/ pista corrente) → ignora
    let e = acc.get(o.spokenTag);
    if (!e) {
      e = { zw: 0, w: 0, sqrtW: 0 };
      acc.set(o.spokenTag, e);
    }
    fisherAdd(e, c.r, c.n);
    votes.set(o.spokenTag, (votes.get(o.spokenTag) ?? 0) + 1);
  }
  const scored: { tag: string; score: number }[] = [];
  for (const tag of [...acc.keys()].sort()) {
    const closed = fisherClose(acc.get(tag)!);
    if (closed) scored.push({ tag, score: closed.score });
  }
  if (scored.length === 0) return { tag: null, score: 0, margin: 0, speakTicks: 0 };
  let best = scored[0];
  for (const s of scored) if (s.score > best.score) best = s;
  let bestOther = 0;
  for (const s of scored) if (s.tag !== best.tag && s.score > bestOther) bestOther = s.score;
  return {
    tag: best.tag,
    score: best.score,
    margin: best.score - bestOther,
    speakTicks: votes.get(best.tag) ?? 0,
  };
}

/** Decisão do modo "raw" (contraste do diagnóstico): argmax evidência sobre TODOS os candidatos +
 *  a MESMA guarda top-2 do motor (score ≥ minConfidence E margem sobre a 2ª tag ≥ minMargin), no
 *  espaço LIMITADO de z_bar (ver cabeçalho). */
function decideEpisodeRaw(
  ep: Episode,
  minEventConfidence: number,
  minEventMargin: number,
): { tag: string | null; score: number; confident: boolean } {
  const scored = aggregateEpisode(ep);
  if (scored.length === 0) return { tag: null, score: 0, confident: false };
  let best = scored[0];
  for (const s of scored) if (s.score > best.score) best = s;
  let bestOther = 0;
  for (const s of scored) if (s.tag !== best.tag && s.score > bestOther) bestOther = s.score;
  const confident = best.score >= minEventConfidence && best.score - bestOther >= minEventMargin;
  return { tag: best.tag, score: best.score, confident };
}

/**
 * Métricas de EVENTO sobre a série de ticks (ver cabeçalho). Compara, sobre EXATAMENTE os mesmos
 * ticks, a precisão de EVENTO (episódio decidido certo) com a precisão POR TICK (rótulo do tick
 * certo) — a comparação que testa a tese do especialista.
 *
 * `mode` (default "spoken"): "spoken" agrega as FALAS guardadas do motor (a leitura fiel da tese);
 * "raw" re-deriva da correlação crua de todos os candidatos + guarda top-2 própria (o contraste
 * que MEDE por que a guarda importa — ver decideEpisodeSpoken/decideEpisodeRaw). As guardas
 * `minEventConfidence`/`minEventMargin` só se aplicam ao modo "raw" (no "spoken" a fala já é
 * guardada pelo motor tick-a-tick).
 */
export function computeEventMetrics(
  ticks: readonly EventTick[],
  opts?: {
    warmupMs?: number;
    minEventConfidence?: number;
    minEventMargin?: number;
    minSpeakTicks?: number;
    mode?: "spoken" | "raw";
  },
): EventMetrics {
  const warmupMs = opts?.warmupMs ?? DEFAULT_WARMUP_MS;
  const minEventConfidence = opts?.minEventConfidence ?? DEFAULT_MIN_EVENT_CONFIDENCE;
  const minEventMargin = opts?.minEventMargin ?? DEFAULT_MIN_EVENT_MARGIN;
  const minSpeakTicks = opts?.minSpeakTicks ?? DEFAULT_MIN_SPEAK_TICKS;
  const mode = opts?.mode ?? "spoken";
  const episodes = buildEpisodes(ticks, warmupMs);

  let episodesWithTag = 0;
  let decided = 0;
  let decidedWithTag = 0;
  let decidedCorrect = 0;
  let tickSpoke = 0;
  let tickCorrect = 0;
  let tickOpportunities = 0;

  for (const ep of episodes) {
    const withTag = ep.truthTag !== null;
    if (withTag) episodesWithTag++;

    let dec: { tag: string | null };
    let isDecided: boolean;
    if (mode === "raw") {
      const r = decideEpisodeRaw(ep, minEventConfidence, minEventMargin);
      dec = r;
      isDecided = r.confident;
    } else {
      const s = decideEpisodeSpoken(ep);
      dec = s;
      // Sustentação (≥ minSpeakTicks) E dominância (margem ≥ minEventMargin) — ver decideEpisodeSpoken.
      isDecided = s.tag !== null && s.speakTicks >= minSpeakTicks && s.margin >= minEventMargin;
    }
    if (isDecided) {
      decided++;
      if (withTag) decidedWithTag++;
      if (dec.tag === ep.truthTag) decidedCorrect++; // tag-verdade null nunca casa decisão ≠ null
    }

    // Régua por tick sobre os MESMOS ticks (a verdade do episódio é constante por construção).
    for (const o of ep.obs) {
      if (withTag) tickOpportunities++;
      if (o.spokenTag !== null) {
        tickSpoke++;
        if (o.spokenTag === ep.truthTag) tickCorrect++;
      }
    }
  }

  return {
    episodes: episodes.length,
    episodesWithTag,
    decided,
    decidedWithTag,
    decidedCorrect,
    falseEvents: decided - decidedWithTag,
    eventPrecision: decided === 0 ? 1 : decidedCorrect / decided,
    eventPrecisionTagged: decidedWithTag === 0 ? 1 : decidedCorrect / decidedWithTag,
    eventCoverage: episodesWithTag === 0 ? 0 : decidedWithTag / episodesWithTag,
    tickSpoke,
    tickCorrect,
    tickOpportunities,
    tickPrecision: tickSpoke === 0 ? 1 : tickCorrect / tickSpoke,
    tickCoverage: tickOpportunities === 0 ? 0 : tickCorrect / tickOpportunities,
  };
}

// ——— CONSISTÊNCIA de evento SEM verdade (bonus — gravação de campo real) ———
//
// Sem anotação de verdade não há como medir PRECISÃO; o que dá pra medir honestamente é a
// CONSISTÊNCIA: dentro de um episódio (aqui, presença contígua da pista — sem verdade não há
// quebra por troca de verdade), o z_comb aponta uma tag DOMINANTE estável? `tickAgreement` é a
// fração de ticks do episódio cujo melhor par isolado (menor r, o mais negativamente correlacionado)
// concorda com a tag dominante do agregado. Alta concordância = o episódio "aponta" uma tag
// coerente; baixa = o campo é ambíguo tick-a-tick (o silêncio honesto do associador faz sentido).

export type EventConsistency = {
  trackId: number;
  startTs: number;
  endTs: number;
  nTicks: number;
  dominantTag: string | null; // vencedor do Fisher-z agregado do episódio
  dominantScore: number; // score (−corr combinado) do vencedor
  tickAgreement: number; // fração de ticks cujo melhor par isolado == dominantTag (0 se nTicks=0)
};

/** Melhor tag ISOLADA de um tick (menor r finito com n≥4; empate → menor tag lexicográfica). */
function bestTagOfTick(o: EventTrackObs): string | null {
  let best: { tag: string; r: number } | null = null;
  for (const c of [...o.candidates].sort((a, b) => a.tag.localeCompare(b.tag))) {
    if (!Number.isFinite(c.r) || c.n - 3 <= 0) continue;
    if (best === null || c.r < best.r) best = { tag: c.tag, r: c.r };
  }
  return best === null ? null : best.tag;
}

/**
 * Consistência de evento por pista sobre ticks de campo SEM verdade. Episódio = presença contígua
 * da pista (o campo `truthTag` dos ticks é ignorado aqui — passe null). Devolve, por episódio, a
 * tag dominante do Fisher-z agregado e a concordância tick-a-tick com ela.
 */
export function computeEventConsistency(
  ticks: readonly EventTick[],
  opts?: { warmupMs?: number },
): EventConsistency[] {
  const warmupMs = opts?.warmupMs ?? DEFAULT_WARMUP_MS;
  // Verdade neutralizada (null em todos) → buildEpisodes só quebra por ausência da pista.
  const neutral = ticks.map((t) => ({
    ts: t.ts,
    tracks: t.tracks.map((o) => ({ ...o, truthTag: null })),
  }));
  const episodes = buildEpisodes(neutral, warmupMs);

  return episodes.map((ep) => {
    // Sem verdade a consistência olha a evidência CRUA de todos os candidatos (aggregateEpisode) —
    // o campo real quase não FALA (o "silêncio do campo"), então "spoken" não teria o que agregar.
    const scored = aggregateEpisode(ep);
    let dominant: { tag: string; score: number } | null = null;
    for (const s of scored) if (dominant === null || s.score > dominant.score) dominant = s;
    let agree = 0;
    let counted = 0;
    for (const o of ep.obs) {
      const bt = bestTagOfTick(o);
      if (bt === null) continue;
      counted++;
      if (bt === dominant?.tag) agree++;
    }
    return {
      trackId: ep.trackId,
      startTs: ep.startTs,
      endTs: ep.endTs,
      nTicks: ep.obs.length,
      dominantTag: dominant?.tag ?? null,
      dominantScore: dominant?.score ?? 0,
      tickAgreement: counted === 0 ? 0 : agree / counted,
    };
  });
}

/** Tabela texto alinhada (mesmo estilo de formatIdentityTable) — tick × evento por cenário, para
 *  leitura humana. Deixa o número-chave lado a lado: precisão POR TICK vs precisão de EVENTO. */
export function formatEventTable(rows: { scenario: string; m: EventMetrics }[]): string {
  const header = [
    "cenário",
    "eps",
    "c/tag",
    "tick-prec%",
    "EVENT-prec%",
    "EVENT-prec(c/tag)%",
    "tick-cob%",
    "EVENT-cob%",
    "decid",
    "falso-ev",
  ];
  const body = rows.map(({ scenario, m }) => [
    scenario,
    String(m.episodes),
    String(m.episodesWithTag),
    (m.tickPrecision * 100).toFixed(1),
    (m.eventPrecision * 100).toFixed(1),
    (m.eventPrecisionTagged * 100).toFixed(1),
    (m.tickCoverage * 100).toFixed(1),
    (m.eventCoverage * 100).toFixed(1),
    String(m.decided),
    String(m.falseEvents),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => row[i].length)));
  const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
}
