// Métricas de IDENTIDADE do harness de associação tag↔pessoa (avalia a saída do
// TagTrackAssociator contra uma verdade-terreno conhecida, tick a tick).
//
// INVARIANTE DO DONO (mesma do associador): rótulo ERRADO é PIOR que rótulo NENHUM.
// Por isso as métricas separam o "não sei" honesto (abstained/trueAbstain) do erro de fato
// (wrong/falseLabels) — e rotular quem NÃO tem tag conta como erro grave (falseLabels E wrong).
//
// Responsabilidade única: só medir. Não simula, não associa, não formata além da tabela texto.
// Puro e determinístico — mesma entrada, mesma tabela. Nenhum NaN jamais (entradas vazias →
// zeros, precision 1 — abster-se sempre é honesto — e coverage 0).

import type { Assignment } from "./associate";

/** Um tick avaliável: o instante, o que o associador disse e a verdade (trackId → MAC ou null = sem tag). */
export type IdentityTick = {
  ts: number;
  assignments: Assignment[];
  truthTagByTrack: Record<number, string | null>;
};

export type IdentityMetrics = {
  ticksEvaluated: number; // ticks pós-warmup considerados
  opportunities: number; // decisões onde a pessoa TINHA tag (correct+wrong+abstained)
  correct: number; // acertou o MAC
  wrong: number; // falou um rótulo e era outro — OU rotulou quem não tinha tag
  abstained: number; // tinha tag mas disse "não sei" (honesto, não é erro)
  trueAbstain: number; // não tinha tag e disse "não sei" (o comportamento certo)
  falseLabels: number; // rotulou quem NÃO tinha tag (erro grave; também conta em wrong)
  /** ADITIVO (revisão adversarial v4): rótulo de tag-ÂNCORA colado numa pessoa — o modo de erro
   *  que a exclusão de âncoras (frame.ts/excludeTags) zera por construção. SUBCONJUNTO de wrong
   *  (wrong segue sendo o total); 0 quando opts.anchorMacs não é passado. A decomposição existe
   *  porque foi ela que revelou que TODO o ganho do gate/blend era este contador caindo. */
  wrongAnchor: number;
  precision: number; // correct/(correct+wrong); 1 quando nunca falou
  coverage: number; // correct/opportunities; 0 sem oportunidades
  wrongRate: number; // wrong / TODAS as decisões avaliadas (opportunities+trueAbstain+falseLabels)
  idSwitches: number; // trocas de rótulo não-null → OUTRO não-null em aparições consecutivas do track
};

/**
 * Computa as métricas de identidade sobre os ticks. Ignora ticks com ts < warmupMs (a janela do
 * associador ainda não encheu — medir antes seria injusto). Assignment cujo trackId NÃO tem
 * entrada na verdade do tick é track fantasma: fora do escopo desta métrica (nem contadores,
 * nem sequência de id-switch).
 * `anchorMacs` (ADITIVO): chaves de tag-âncora — a MESMA chave do Assignment.tag (no harness,
 * o MAC; a comparação é literal, sem normalização) — p/ decompor o wrongAnchor do wrong total.
 */
export function computeIdentityMetrics(
  ticks: IdentityTick[],
  opts?: { warmupMs?: number; anchorMacs?: ReadonlySet<string> },
): IdentityMetrics {
  const warmupMs = opts?.warmupMs ?? 8000;
  const anchorMacs = opts?.anchorMacs;

  let ticksEvaluated = 0;
  let opportunities = 0;
  let correct = 0;
  let wrong = 0;
  let abstained = 0;
  let trueAbstain = 0;
  let falseLabels = 0;
  let wrongAnchor = 0;
  let idSwitches = 0;

  // Rótulo do track na sua ÚLTIMA aparição avaliada (para detectar a troca não-null → não-null).
  const lastLabel = new Map<number, string | null>();

  for (const tick of ticks) {
    if (tick.ts < warmupMs) continue; // janela ainda enchendo → não avalia
    ticksEvaluated++;

    for (const a of tick.assignments) {
      if (!(a.trackId in tick.truthTagByTrack)) continue; // track fantasma → ignora
      const truth = tick.truthTagByTrack[a.trackId];

      if (truth !== null) {
        // Pessoa COM tag: acertar, errar ou abster — as três são "oportunidades".
        opportunities++;
        if (a.tag === truth) correct++;
        else if (a.tag !== null) wrong++;
        else abstained++;
      } else if (a.tag === null) {
        // Pessoa SEM tag e o associador se absteve: exatamente o comportamento certo.
        trueAbstain++;
      } else {
        // Pessoa SEM tag recebeu rótulo: erro grave (conta nos dois contadores).
        falseLabels++;
        wrong++;
      }

      // Decomposição: rótulo de ÂNCORA numa pessoa (sempre errado — âncora é ferragem fixa).
      // Cobre os dois ramos de wrong acima (truth ≠ tag e falso-rótulo); subconjunto de wrong.
      if (a.tag !== null && a.tag !== truth && anchorMacs?.has(a.tag)) wrongAnchor++;

      // id-switch: só não-null → OUTRO não-null entre aparições consecutivas do track.
      // rótulo→null e null→rótulo não contam (logo rótulo→null→mesmo rótulo = 0 trocas).
      const prev = lastLabel.get(a.trackId);
      if (prev !== undefined && prev !== null && a.tag !== null && a.tag !== prev) idSwitches++;
      lastLabel.set(a.trackId, a.tag);
    }
  }

  const spoke = correct + wrong; // vezes em que o associador FALOU um rótulo avaliável
  const decisions = opportunities + trueAbstain + falseLabels; // todas as decisões avaliadas
  return {
    ticksEvaluated,
    opportunities,
    correct,
    wrong,
    abstained,
    trueAbstain,
    falseLabels,
    wrongAnchor,
    precision: spoke === 0 ? 1 : correct / spoke, // nunca falou → honesto, não é erro
    coverage: opportunities === 0 ? 0 : correct / opportunities,
    wrongRate: decisions === 0 ? 0 : wrong / decisions,
    idSwitches,
  };
}

/** Tabela texto alinhada (estilo formatTable de src/localizacao/scenarios.ts) — só p/ diagnóstico humano. */
export function formatIdentityTable(rows: { scenario: string; m: IdentityMetrics }[]): string {
  const header = [
    "cenário",
    "opp",
    "certo",
    "errado",
    "absteve",
    "falso-rótulo",
    "âncora-errada",
    "precisão %",
    "cobertura %",
    "id-switch",
  ];
  const body = rows.map(({ scenario, m }) => [
    scenario,
    String(m.opportunities),
    String(m.correct),
    String(m.wrong),
    String(m.abstained),
    String(m.falseLabels),
    String(m.wrongAnchor),
    (m.precision * 100).toFixed(1),
    (m.coverage * 100).toFixed(1),
    String(m.idSwitches),
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i].length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  return [fmt(header), fmt(widths.map((w) => "-".repeat(w))), ...body.map(fmt)].join("\n");
}
