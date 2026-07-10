// Métricas NOVAS da persistência de rótulo (docs/cientifica/escopo-persistencia-rotulo.md, "Métricas
// novas") — as métricas atuais (identity-metrics.ts) são por TICK; a persistência muda a unidade
// pra TEMPO (uma pessoa parada por 10s não devia precisar ser re-provada 20 vezes). Consomem a
// saída de `LabelMemoryPolicy.step()` (label-memory.ts) + verdade-terreno, tick a tick — mesma
// convenção de "oportunidade" do identity-metrics.ts (só conta tempo de pessoa QUE TEM tag), só que
// PESADO pelo intervalo real entre ticks (`ts` deltas), não por contagem de ticks.
//
// Responsabilidade única: só medir. Não simula, não associa, não decide política de memória.

export type MemoryMetricTick = {
  ts: number;
  beliefs: readonly { trackId: number; label: string | null; isFresh: boolean }[];
  truthTagByTrack: Readonly<Record<number, string | null>>;
};

export type MemoryMetrics = {
  totalMs: number; // tempo total de OPORTUNIDADE (pessoa com tag) coberto pelos ticks avaliados
  correctMs: number; // tempo com rótulo CORRETO visível (fresco ou memória)
  wrongMs: number; // tempo com rótulo ERRADO visível (correctMs+wrongMs+abstainedMs = totalMs)
  /** ADITIVO (decomposição obrigatória, Mordida 2): subconjunto de wrongMs por ESTADO DE ORIGEM —
   *  a pergunta adversarial é se o erro que sobrevive vem desproporcionalmente da memória. */
  wrongMsFresh: number;
  wrongMsMemoria: number;
  abstainedMs: number; // tempo sem rótulo exibido (candidata) — nem certo nem errado, honesto
  /** correctMs/totalMs — a métrica central do escopo; 0 quando totalMs=0 (nunca NaN). */
  coverageExperience: number;
};

/**
 * Acumula por INTERVALO entre ticks consecutivos (peso = ts[i+1]-ts[i], não contagem de ticks) —
 * "integral no tempo", não por tick (a diferença que motiva toda a rodada). Intervalo com dt≤0
 * (ts não-monotônico/duplicado) é ignorado — nunca soma duração negativa. Track sem entrada em
 * `truthTagByTrack` (fantasma) ou com `truth:null` (pessoa sem tag) fica FORA da cobertura de
 * experiência — mesma convenção de `opportunities` em identity-metrics.ts.
 */
export function computeMemoryMetrics(ticks: readonly MemoryMetricTick[]): MemoryMetrics {
  let totalMs = 0;
  let correctMs = 0;
  let wrongMs = 0;
  let wrongMsFresh = 0;
  let wrongMsMemoria = 0;

  for (let i = 0; i < ticks.length - 1; i++) {
    const dt = ticks[i + 1].ts - ticks[i].ts;
    if (dt <= 0) continue;
    for (const b of ticks[i].beliefs) {
      const truth = ticks[i].truthTagByTrack[b.trackId];
      if (truth === undefined || truth === null) continue; // fantasma ou pessoa sem tag
      totalMs += dt;
      if (b.label === null) continue; // abstenção — nem certo nem errado
      if (b.label === truth) correctMs += dt;
      else {
        wrongMs += dt;
        if (b.isFresh) wrongMsFresh += dt;
        else wrongMsMemoria += dt;
      }
    }
  }

  return {
    totalMs,
    correctMs,
    wrongMs,
    wrongMsFresh,
    wrongMsMemoria,
    abstainedMs: totalMs - correctMs - wrongMs,
    coverageExperience: totalMs === 0 ? 0 : correctMs / totalMs,
  };
}

export type WrongLabelEpisode = {
  trackId: number;
  fromTs: number;
  toTs: number;
  latencyMs: number;
};

/**
 * Episódios contíguos de "rótulo errado visível" — cada um termina quando a crença volta a
 * concordar com a verdade (correção) OU volta a "não sei" (candidata — abster também para a
 * mentira, honestamente). `latencyMs` é "da quebra real até a tela parar de mentir" (escopo,
 * Latência de correção): o tempo entre a crença passar a discordar da verdade e o fim do episódio.
 * Não pressupõe QUANDO a verdade mudou — só mede quanto tempo o DESACORDO (crença × verdade) dura,
 * o que é observável e suficiente (a verdade mudar sem a crença notar é exatamente o desacordo
 * começando).
 */
export function computeCorrectionLatencies(
  ticks: readonly MemoryMetricTick[],
): WrongLabelEpisode[] {
  const lyingSince = new Map<number, number>();
  const out: WrongLabelEpisode[] = [];
  for (const tick of ticks) {
    for (const b of tick.beliefs) {
      const truth = tick.truthTagByTrack[b.trackId];
      if (truth === undefined) continue;
      const wrong = b.label !== null && b.label !== truth;
      const since = lyingSince.get(b.trackId);
      if (wrong && since === undefined) {
        lyingSince.set(b.trackId, tick.ts);
      } else if (!wrong && since !== undefined) {
        out.push({ trackId: b.trackId, fromTs: since, toTs: tick.ts, latencyMs: tick.ts - since });
        lyingSince.delete(b.trackId);
      }
    }
  }
  return out;
}
