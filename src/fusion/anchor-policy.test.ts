// Testes de UNIDADE da política de âncora (anchor-policy.ts) — o comportamento puro, com episódios
// SINTÉTICOS montados à mão (nada de simulador aqui: a medição de campo/bancada mora em
// receiver-at-destino.test.ts). O que se prova aqui é a MECÂNICA:
//   • k=1 (concordância) reproduz EXATAMENTE a política de hoje (falar na primeira oportunidade);
//   • k=2 ABSTÉM na discordância (a invariante da casa: rótulo errado é pior que nenhum);
//   • a soma de Fisher-z SOMA informação (dois episódios fracos passam onde um sozinho não passa);
//   • os sensores de inflação (sharedDataRisk / agreementOnFailure) acusam o que têm de acusar.
import { describe, expect, it } from "vitest";
import {
  agreementBySeparation,
  agreementOnFailure,
  anchorByConcordance,
  anchorByFisherSum,
  computeAnchorMetrics,
  computeAnchors,
  episodeDecisionAt,
  sharedDataRisk,
  significantAt,
} from "./anchor-policy";
import type { OperatorEpisode } from "./anchor-policy";
import type { VisitCandidate, VisitEpisode } from "./visit-metrics";

/** Candidato sintético: r e n_eff cravados (z = atanh(r), score = −r — as MESMAS definições do
 *  visit-metrics.ts, montadas à mão para poder plantar exatamente o regime que se quer testar). */
function cand(tag: string, r: number, nEff: number): VisitCandidate {
  return {
    tag,
    r,
    n: Math.round(nEff),
    nDistinct: Math.round(nEff),
    nEff,
    z: Math.atanh(r),
    score: -r,
    significant: false, // irrelevante: a política recomputa o gate no piso pedido (significantAt)
  };
}

/** Episódio sintético: só o que a política consome (candidatos + verdade + janela temporal). */
function ep(
  trackId: number,
  truthTag: string | null,
  startTs: number,
  endTs: number,
  candidates: VisitCandidate[],
): VisitEpisode {
  return {
    trackId,
    truthTag,
    startTs,
    endTs,
    nTicks: candidates[0]?.n ?? 0,
    spanDecades: 0.3,
    rangeDecades: 0.8,
    candidates,
    decisionTag: null,
    decided: false,
    correct: null,
  };
}

const A = "AA:AA";
const B = "BB:BB";

describe("anchor-policy — o gate por episódio, recomputado sem re-simular", () => {
  it("significantAt: o piso da FÓRMULA (3) é intransponível — piso pedido < 3 é elevado a 3", () => {
    expect(significantAt(cand(A, -0.99, 3), 0)).toBe(false); // n_eff = 3 ⇒ Fisher indefinido
    // n_eff=3,5: o teste EXISTE, mas a barra é |z| ≥ 1,96·√(1/0,5) = 2,77 ⇒ nem |r|=0,99 (z=2,65)
    // a cruza. É a Regra 10 em miniatura: existir ≠ decidir.
    expect(significantAt(cand(A, -0.99, 3.5), 0)).toBe(false);
    expect(significantAt(cand(A, -0.99, 4), 0)).toBe(true); // barra 1,96 ⇒ passa
  });

  it("significantAt: subir o piso SÓ remove decisões (monotônico) — é o que faz a varredura valer", () => {
    const c = cand(A, -0.8, 12);
    expect(significantAt(c, 3)).toBe(true);
    expect(significantAt(c, 10)).toBe(true);
    expect(significantAt(c, 14)).toBe(false); // n_eff 12 < piso 14 ⇒ calado
  });

  it("episodeDecisionAt: correlação POSITIVA nunca decide (score ≤ 0 = evidência CONTRA a tag)", () => {
    const e = ep(1, A, 0, 20000, [cand(A, +0.95, 20)]);
    expect(episodeDecisionAt(e, 3).tag).toBeNull();
  });
});

describe("anchor-policy (a) k-CONCORDÂNCIA — k=1 é a política de hoje; k=2 abstém na discordância", () => {
  const e1 = ep(1, A, 0, 20000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]);
  const e2 = ep(2, A, 30000, 50000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]);
  const e2wrong = ep(2, A, 30000, 50000, [cand(A, -0.1, 10), cand(B, -0.9, 10)]); // aponta B (ERRADO)

  it("k=1 = falar na primeira oportunidade (o baseline fiel): o 1º decidido ancora", () => {
    const a = anchorByConcordance("op", [e1, e2wrong], { k: 1, minNEff: 3 });
    expect(a.decided).toBe(true);
    expect(a.decisionTag).toBe(A);
    expect(a.correct).toBe(true);
    expect(a.nUsed).toBe(1);
  });

  it("k=1 NÃO abstém por discordância posterior — se abstivesse, não seria o baseline", () => {
    const a = anchorByConcordance("op", [e2wrong, e1], { k: 1, minNEff: 3 });
    expect(a.decided).toBe(true);
    expect(a.decisionTag).toBe(B); // o PRIMEIRO cronológico manda (e aqui está errado)
    expect(a.correct).toBe(false);
    expect(a.abstainedByDisagreement).toBe(false);
  });

  it("k=2 CONCORDANTE decide, e o n_eff efetivo é a SOMA (10+10=20 — a barra |r| despenca)", () => {
    const a = anchorByConcordance("op", [e1, e2], { k: 2, minNEff: 3 });
    expect(a.decided).toBe(true);
    expect(a.correct).toBe(true);
    expect(a.nEffEffective).toBeCloseTo(20, 6);
  });

  it("k=2 DISCORDANTE → ABSTÉM (o mecanismo que converte erro em silêncio)", () => {
    const a = anchorByConcordance("op", [e1, e2wrong], { k: 2, minNEff: 3 });
    expect(a.decided).toBe(false);
    expect(a.decisionTag).toBeNull();
    expect(a.abstainedByDisagreement).toBe(true);
    expect(a.correct).toBeNull(); // não ancorou ⇒ não há certo/errado (abstenção não é erro)
  });

  it("k=2 com só 1 episódio decidido → sem âncora (não é discordância, é falta de evidência)", () => {
    const fraco = ep(2, A, 30000, 40000, [cand(A, -0.2, 8)]); // |r| baixo ⇒ não decide sozinho
    const a = anchorByConcordance("op", [e1, fraco], { k: 2, minNEff: 3 });
    expect(a.decided).toBe(false);
    expect(a.abstainedByDisagreement).toBe(false);
  });

  it("a ordem CRONOLÓGICA manda (não a ordem de entrada): o k=1 ancora no episódio mais ANTIGO", () => {
    const cedoErrado = ep(9, A, 0, 20000, [cand(A, -0.1, 10), cand(B, -0.9, 10)]); // 1º no TEMPO
    const tardeCerto = ep(1, A, 30000, 50000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]);
    // Entrada FORA de ordem de propósito: o mais recente vem primeiro na lista.
    const eps: OperatorEpisode[] = [
      { operator: "op", episode: tardeCerto },
      { operator: "op", episode: cedoErrado },
    ];
    const [a] = computeAnchors(eps, "concordance", { k: 1, minNEff: 3 });
    expect(a.decisionTag).toBe(B); // o mais ANTIGO (e errado) — groupByOperator reordenou por startTs
    // …e é exatamente esse erro que o k=2 converte em SILÊNCIO:
    const [b] = computeAnchors(eps, "concordance", { k: 2, minNEff: 3 });
    expect(b.decided).toBe(false);
    expect(b.abstainedByDisagreement).toBe(true);
  });
});

describe("anchor-policy (b) SOMA DE FISHER-Z — dois episódios fracos somam informação REAL", () => {
  // |r|=0,55 com n_eff=8 NÃO passa sozinho (barra = tanh(1,96/√5) = 0,72), mas DOIS episódios
  // somam w=5+5=10 ⇒ barra cai para tanh(1,96/√10) = 0,55 — e passa. É a tese do revisor, isolada.
  const fraco1 = ep(1, A, 0, 20000, [cand(A, -0.6, 8)]);
  const fraco2 = ep(2, A, 30000, 50000, [cand(A, -0.6, 8)]);

  it("um episódio fraco sozinho NÃO decide", () => {
    expect(anchorByFisherSum("op", [fraco1], { k: 1, minNEff: 3 }).decided).toBe(false);
  });

  it("DOIS episódios fracos, somados, DECIDEM (e o n_eff efetivo é Σw+3 = 13)", () => {
    const a = anchorByFisherSum("op", [fraco1, fraco2], { k: 2, minNEff: 3 });
    expect(a.decided).toBe(true);
    expect(a.correct).toBe(true);
    expect(a.nEffEffective).toBeCloseTo(13, 6); // (8−3)+(8−3)+3 — some evidência, some graus de liberdade
    expect(a.nUsed).toBe(2);
  });

  it("k=2 exige DOIS contribuintes PARA A MESMA TAG (uma tag vista uma vez só não ancora)", () => {
    const soUm = ep(3, A, 60000, 80000, [cand(B, -0.99, 20)]); // B forte, mas em UM episódio só
    const a = anchorByFisherSum("op", [fraco1, fraco2, soUm], { k: 2, minNEff: 3 });
    expect(a.decisionTag).toBe(A); // B tem m=1 < k ⇒ nem entra no páreo
  });

  it("z de sinais OPOSTOS se CANCELAM (a discordância vira abstenção também na soma)", () => {
    const contra = ep(2, A, 30000, 50000, [cand(A, +0.6, 8)]); // r POSITIVO = evidência contra
    const a = anchorByFisherSum("op", [fraco1, contra], { k: 2, minNEff: 3 });
    expect(a.decided).toBe(false); // z̄ ≈ 0 ⇒ nem significativo nem score>0
  });

  it("o PISO por episódio filtra ANTES de somar (episódio abaixo do piso não contribui)", () => {
    const a = anchorByFisherSum("op", [fraco1, fraco2], { k: 2, minNEff: 10 });
    expect(a.decided).toBe(false); // n_eff 8 < piso 10 ⇒ nenhum contribuinte
    expect(a.nUsed).toBe(0);
  });
});

describe("anchor-policy — métricas de TURNO e os sensores de inflação (Regra 8)", () => {
  const opA: OperatorEpisode[] = [
    { operator: "s1|AA", episode: ep(1, A, 0, 20000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]) },
    { operator: "s1|AA", episode: ep(1, A, 30000, 50000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]) },
    { operator: "s1|BB", episode: ep(2, B, 0, 20000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]) }, // ERRA
    { operator: "s1|BB", episode: ep(2, B, 30000, 50000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]) },
  ];

  it("precisão/cobertura de TURNO saem por OPERADOR, não por episódio (ADR-015)", () => {
    const m = computeAnchorMetrics(computeAnchors(opA, "concordance", { k: 2, minNEff: 3 }));
    expect(m.operators).toBe(2); // DOIS operadores, não quatro episódios
    expect(m.anchored).toBe(2);
    expect(m.anchoredCorrect).toBe(1); // o operador BB foi rotulado A nos dois episódios
    expect(m.precision).toBeCloseTo(0.5, 6);
    expect(m.turnCoverage).toBeCloseTo(1, 6);
  });

  it("sharedDataRisk: episódios disjuntos ⇒ 0 sobreposições; gap curto ⇒ tightGap acusado", () => {
    const r = sharedDataRisk(opA, 2.5);
    expect(r.overlapping).toBe(0); // 20 s → 30 s: janelas DISJUNTAS
    expect(r.tightGaps).toBe(0); // gap = 10 s ≫ Δt_tag 2,5 s ⇒ nem a leitura carregada vaza
    expect(r.medianGapS).toBeCloseTo(10, 6);

    const colado: OperatorEpisode[] = [
      { operator: "x", episode: ep(1, A, 0, 20000, [cand(A, -0.9, 10)]) },
      { operator: "x", episode: ep(1, A, 21000, 40000, [cand(A, -0.9, 10)]) }, // gap 1 s < 2,5 s
    ];
    expect(sharedDataRisk(colado, 2.5).tightGaps).toBe(1);

    const sobreposto: OperatorEpisode[] = [
      { operator: "y", episode: ep(1, A, 0, 20000, [cand(A, -0.9, 10)]) },
      { operator: "y", episode: ep(2, A, 10000, 30000, [cand(A, -0.9, 10)]) }, // BUG: se sobrepõem
    ];
    expect(sharedDataRisk(sobreposto, 2.5).overlapping).toBe(1);
  });

  it("agreementOnFailure: o ERRO SISTEMÁTICO aparece como concordância ERRADA (o que mata a tese)", () => {
    const f = agreementOnFailure(opA, 3);
    expect(f.operators).toBe(2);
    expect(f.agree).toBe(2); // os dois operadores concordam consigo mesmos nos 2 episódios
    expect(f.firstWrong).toBe(1); // o operador BB erra…
    expect(f.firstWrongAndAgree).toBe(1); // …e REPETE o mesmo erro ⇒ a dupla-confirmação NÃO salva
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// DIVERSIDADE DE CONTEXTO (Regra 13) — a MECÂNICA da restrição de separação temporal, isolada do
// simulador. O que ela COMPRA (concordância-no-erro cai) é medido em receiver-at-destino.test.ts;
// o que ela FAZ (quais episódios a política consome) se prova aqui, à mão.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("anchor-policy — DIVERSIDADE DE CONTEXTO (minSeparationMs)", () => {
  // Três episódios do MESMO operador: dois FRAGMENTOS colados (gap 1 s — o caso do tracker, onde os
  // erros são correlacionados) e um TERCEIRO separado por 60 s (o "outro contexto").
  const frag1 = ep(1, A, 0, 20000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]); // decide A (CERTO)
  const frag2 = ep(2, A, 21000, 40000, [cand(A, -0.1, 10), cand(B, -0.9, 10)]); // decide B (ERRADO)
  const tarde = ep(3, A, 100000, 120000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]); // decide A, +60 s

  it("ADITIVO: sem minSeparationMs, a política é BIT-A-BIT a de antes (o pino da Regra 13)", () => {
    const opts = { k: 2, minNEff: 3 };
    expect(anchorByConcordance("op", [frag1, frag2, tarde], opts)).toEqual(
      anchorByConcordance("op", [frag1, frag2, tarde], { ...opts, minSeparationMs: 0 }),
    );
    expect(anchorByFisherSum("op", [frag1, frag2, tarde], opts)).toEqual(
      anchorByFisherSum("op", [frag1, frag2, tarde], { ...opts, minSeparationMs: 0 }),
    );
  });

  it("SEM diversidade, o k=2 consome os dois FRAGMENTOS colados (1 s) — e abstém por discordância", () => {
    const a = anchorByConcordance("op", [frag1, frag2, tarde], { k: 2, minNEff: 3 });
    expect(a.nUsed).toBe(2);
    expect(a.abstainedByDisagreement).toBe(true);
    expect(a.decided).toBe(false); // o 3º episódio (CERTO) nem é olhado — os 2 primeiros já brigaram
  });

  it("COM diversidade (≥30 s), o k=2 PULA o fragmento colado e ancora em DOIS CONTEXTOS", () => {
    const a = anchorByConcordance("op", [frag1, frag2, tarde], {
      k: 2,
      minNEff: 3,
      minSeparationMs: 30000,
    });
    expect(a.nUsed).toBe(2);
    expect(a.decided).toBe(true);
    expect(a.decisionTag).toBe(A); // frag1 (t=0) + tarde (t=100 s): frag2 foi DESCARTADO (gap 1 s)
    expect(a.correct).toBe(true);
    expect(a.abstainedByDisagreement).toBe(false);
  });

  it("a cadeia é GULOSA e CRONOLÓGICA (política ONLINE — não escolhe o melhor par a posteriori)", () => {
    // Separação exigida MAIOR que qualquer gap disponível ⇒ só o 1º episódio entra ⇒ sem âncora com k=2.
    const a = anchorByConcordance("op", [frag1, frag2, tarde], {
      k: 2,
      minNEff: 3,
      minSeparationMs: 200000,
    });
    expect(a.nUsed).toBe(0); // < k decididos na cadeia diversa ⇒ falta de evidência, não discordância
    expect(a.decided).toBe(false);
    expect(a.abstainedByDisagreement).toBe(false);
  });

  it("a diversidade também governa a SOMA DE FISHER-Z (o fragmento colado não entra na soma)", () => {
    const a = anchorByFisherSum("op", [frag1, frag2, tarde], {
      k: 2,
      minNEff: 3,
      minSeparationMs: 30000,
    });
    expect(a.nUsed).toBe(2); // frag1 + tarde (frag2 fora da cadeia)
    expect(a.decisionTag).toBe(A);
    expect(a.nEffEffective).toBeCloseTo(17, 6); // (10−3)+(10−3)+3
  });
});

describe("anchor-policy — agreementBySeparation: a CURVA (concordância-no-erro × separação)", () => {
  const EDGES = [0, 2000, 10000, 30000] as const; // 0-2 s, 2-10 s, 10-30 s, ≥30 s

  it("classifica o par pelo GAP (start do 2º − end do 1º), e cada bin traz o PRÓPRIO teto", () => {
    // Operador que ERRA (verdade B) nos dois fragmentos colados e ACERTA no episódio distante.
    const eps: OperatorEpisode[] = [
      { operator: "op", episode: ep(1, B, 0, 20000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]) }, // →A ERRADO
      { operator: "op", episode: ep(2, B, 21000, 40000, [cand(A, -0.9, 10), cand(B, -0.1, 10)]) }, // →A ERRADO (repete)
      { operator: "op", episode: ep(3, B, 100000, 120000, [cand(A, -0.1, 10), cand(B, -0.9, 10)]) }, // →B CERTO
    ];
    const bins = agreementBySeparation(eps, 3, EDGES);
    expect(bins.map((b) => b.label)).toEqual(["0s–2s", "2s–10s", "10s–30s", "30s–∞"]);

    const b02 = bins[0]; // par (1,2): gap = 21000−20000 = 1 s
    expect(b02.pairs).toBe(1);
    expect(b02.firstWrong).toBe(1);
    expect(b02.firstWrongAndAgree).toBe(1); // REPETE o mesmo erro — a correlação do fragmento
    expect(b02.secondWrong).toBe(1); // teto de independência DESTE bin = 1/1

    const bLong = bins[3]; // pares (1,3) gap 80 s e (2,3) gap 60 s
    expect(bLong.pairs).toBe(2);
    expect(bLong.firstWrong).toBe(2);
    expect(bLong.firstWrongAndAgree).toBe(0); // o contexto distante NÃO repete o erro
    expect(bLong.secondWrong).toBe(0);
    expect(bins[1].pairs + bins[2].pairs).toBe(0); // bins vazios existem (ausência de dado é dado)
  });

  it("onePairPerOperator: o modo CONSERVADOR contra pseudo-replicação (≤1 par por operador por bin)", () => {
    const eps: OperatorEpisode[] = [1, 2, 3, 4].map((i) => ({
      operator: "op",
      episode: ep(i, A, (i - 1) * 100000, (i - 1) * 100000 + 20000, [cand(A, -0.9, 10)]),
    }));
    const all = agreementBySeparation(eps, 3, EDGES);
    const one = agreementBySeparation(eps, 3, EDGES, { onePairPerOperator: true });
    expect(all[3].pairs).toBe(6); // C(4,2) — pares que COMPARTILHAM episódios (IC otimista)
    expect(one[3].pairs).toBe(1); // um só par do operador ⇒ n honesto
    expect(one[3].operators).toBe(1);
  });
});
