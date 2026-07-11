// Curva de RELIABILITY ESTRATIFICADA por regime de densidade (retuning da persistência de rótulo,
// prescrição do especialista pós-torneio v1 — ver persistence-tournament.test.ts, "ACHADO HONESTO"):
// a margem top-2 ABSOLUTA é um proxy cuja taxa de câmbio VARIA com o regime da cena — em multidão
// as margens são comprimidas (mais candidatos disputando), então "margem ≥ 0,4" que é razoável em
// cena esparsa NUNCA fecha em cena densa. Este módulo muda a VARIÁVEL: em vez de perguntar "a
// margem é ≥ X?", pergunta "qual PRECISÃO essa margem historicamente ENTREGOU neste regime?" —
// se margem 0,22 em multidão entrega 93% de acerto, ela vale 0,93, não 0,22. A adaptatividade
// EMERGE da condicionalização; nenhum knob "modo multidão" é inventado.
//
// ESTRATIFICADOR (o mais barato que serve): nº de CANDIDATOS AVALIÁVEIS no tick = nº de
// Assignments que o associador devolveu (um por track corrente — ver docstring de assign() em
// associate.ts). É observável em PRODUÇÃO sem verdade-terreno (é só o tamanho do array), que é o
// requisito pra política de memória poder consumir o regime em runtime. Binário denso/esparso:
// denso quando o tick tem ≥ N assignments avaliáveis (default N=4 — o menor cenário de "multidão"
// da suíte tem 6 pessoas/4 tags, e os cenários esparsos têm 2-3 tracks; 4 separa as duas famílias
// sem célula vazia). N é configurável e VIAJA DENTRO da curva (denseMinCandidates) — quem consome
// a curva usa o MESMO N que a construiu, por construção.
//
// BINS: mais finos que os do reliability diagram de identity-metrics (5×0,2) — o retuning precisa
// de RESOLUÇÃO exatamente nas margens BAIXAS (onde a multidão vive); bordas default
// [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 1]. Interpolação DEGRAU (o bin onde a margem cai), não
// linear: com poucas amostras por bin, interpolar inventaria precisão entre pontos não medidos.
// Bin SEM AMOSTRA → precisão 0 (conservador: sem histórico, não confirma — nunca NaN).
//
// QUAIS DECISÕES ENTRAM NA CURVA: toda decisão que FALOU (tag !== null) e cujo track tem entrada
// na verdade do tick (fantasma fora — não dá pra julgar; mesma convenção de identity-metrics).
// Inclui falso-rótulo (truth null → wrong) e inclui decisões com hadConflict:true — a curva fica
// CONSERVADORA pro uso com cleanWindow (que só conta ticks sem conflito, uma sub-população
// historicamente MELHOR que a média do bin), nunca otimista.
//
// CALIBRAÇÃO SINTÉTICA (ressalva declarada, instrução do especialista): a curva construída a
// partir do replay da suíte fixa é EXPLORAÇÃO DE FORMA — serve pra decidir se o desenho fecha os
// dois eixos no sintético. NENHUM default é promovido até a curva ter âncora REAL (dados de campo).
//
// Responsabilidade única: só a curva (construir + consultar). Não decide política (label-memory.ts
// consome), não simula, não formata UI.

import type { IdentityTick } from "./identity-metrics";

export type Regime = "denso" | "esparso";

/** Default do estratificador binário: tick com ≥4 assignments avaliáveis é DENSO — ver header. */
export const DEFAULT_DENSE_MIN_CANDIDATES = 4;

/** Bordas default — finas nas margens baixas (onde multidão vive), ver header. */
export const FINE_BIN_EDGES: readonly number[] = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 1];

export type ReliabilityBin = {
  marginMin: number;
  marginMax: number;
  correct: number;
  wrong: number;
  /** correct/(correct+wrong); 0 quando o bin não tem amostra (conservador — nunca NaN). */
  precision: number;
};

export type RegimeReliabilityCurve = {
  /** O N do estratificador que CONSTRUIU esta curva — quem consulta usa o mesmo, por construção. */
  denseMinCandidates: number;
  binEdges: readonly number[];
  bins: Record<Regime, ReliabilityBin[]>;
};

/** Classifica o regime de UM tick pelo nº de candidatos avaliáveis (= assignments do tick). */
export function tickRegime(
  candidates: number,
  denseMinCandidates: number = DEFAULT_DENSE_MIN_CANDIDATES,
): Regime {
  return candidates >= denseMinCandidates ? "denso" : "esparso";
}

/** Índice do bin (degrau) onde a margem cai: edges[i] ≤ m < edges[i+1]; m ≥ última borda → último
 *  bin. Margem clampada a [primeira, última] borda (mesma defesa do identity-metrics: o valor
 *  bruto pode sair ligeiramente negativo com a guarda desligada). */
function binIndex(edges: readonly number[], margin: number): number {
  const m = Math.max(edges[0], Math.min(edges[edges.length - 1], margin));
  for (let i = edges.length - 2; i >= 0; i--) {
    if (m >= edges[i]) return i;
  }
  return 0;
}

/**
 * Constrói a curva estratificada a partir de ticks avaliáveis (decisões do associador + verdade).
 * `warmupMs` default 0 — DIFERENTE do default de identity-metrics (8000), de propósito: a política
 * de memória roda desde o tick 0 (inclusive durante a janela enchendo), então calibrar sobre a
 * MESMA distribuição que ela vai consultar é o casamento honesto; excluir o warmup calibraria uma
 * população que a política não vê.
 */
export function buildRegimeReliabilityCurve(
  ticks: readonly IdentityTick[],
  opts?: { denseMinCandidates?: number; binEdges?: readonly number[]; warmupMs?: number },
): RegimeReliabilityCurve {
  const denseMinCandidates = opts?.denseMinCandidates ?? DEFAULT_DENSE_MIN_CANDIDATES;
  const binEdges = opts?.binEdges ?? FINE_BIN_EDGES;
  const warmupMs = opts?.warmupMs ?? 0;

  const mkBins = (): ReliabilityBin[] =>
    binEdges.slice(0, -1).map((lo, k) => ({
      marginMin: lo,
      marginMax: binEdges[k + 1],
      correct: 0,
      wrong: 0,
      precision: 0,
    }));
  const bins: Record<Regime, ReliabilityBin[]> = { denso: mkBins(), esparso: mkBins() };

  for (const tick of ticks) {
    if (tick.ts < warmupMs) continue;
    // Estratificador OBSERVÁVEL: nº de assignments do tick (não depende de verdade) — ver header.
    const regime = tickRegime(tick.assignments.length, denseMinCandidates);
    for (const a of tick.assignments) {
      if (a.tag === null) continue; // só decisões que FALARAM entram na curva
      if (!(a.trackId in tick.truthTagByTrack)) continue; // fantasma → não dá pra julgar
      const truth = tick.truthTagByTrack[a.trackId];
      const bin = bins[regime][binIndex(binEdges, a.margin ?? 0)];
      if (a.tag === truth) bin.correct++;
      else bin.wrong++; // inclui falso-rótulo (truth null) — mesma régua de identity-metrics
    }
  }

  for (const regime of ["denso", "esparso"] as const) {
    for (const b of bins[regime]) {
      const n = b.correct + b.wrong;
      b.precision = n === 0 ? 0 : b.correct / n;
    }
  }
  return { denseMinCandidates, binEdges, bins };
}

/**
 * Precisão IMPLICADA por (regime, margem): a precisão empírica do bin (degrau) onde a margem cai.
 * Bin sem amostra → 0 (conservador — sem histórico naquele regime/margem, não dá pra confiar).
 */
export function impliedPrecision(
  curve: RegimeReliabilityCurve,
  regime: Regime,
  margin: number,
): number {
  return curve.bins[regime][binIndex(curve.binEdges, margin)].precision;
}

/** Tabela texto da curva (2 regimes × bins) — só p/ diagnóstico humano, praxe da casa. */
export function formatRegimeCurve(curve: RegimeReliabilityCurve): string {
  const lines: string[] = [];
  for (const regime of ["denso", "esparso"] as const) {
    const cells = curve.bins[regime].map(
      (b) =>
        `[${b.marginMin},${b.marginMax}) ${(b.precision * 100).toFixed(0)}% (${b.correct}/${
          b.correct + b.wrong
        })`,
    );
    lines.push(`${regime.padEnd(7)}: ${cells.join("  ")}`);
  }
  return lines.join("\n");
}
