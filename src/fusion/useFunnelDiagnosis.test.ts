// O SEAM do diagnóstico (bug B8): o que este teste PINA são as duas contas que a UI NÃO pode errar.
//
//  1. REGRA 8 — leitura DISTINTA ≠ leitura RECEBIDA. O app do celular faz sample-and-hold: 81,2% do
//     que o hub recebe é CÓPIA do valor anterior (laudo 2026-07-13, B1). Se a aba "Por quê" mostrar
//     `rssiSamples` como "leituras", ela mente ~4× para cima — e o operador conclui que o rádio está
//     ótimo quando a informação real é 1/4 disso. É CONTAGEM, não modelo.
//  2. pickBest — a pessoa tem N tags candidatas e a UI mostra UMA. Mostrar a errada (ex.: a tag que
//     morreu no 1º elo, quando outra chegou até a margem) faz o operador agir sobre o gate errado.
//     A régua é a ORDEM DA CADEIA de vetos (a mesma de diagnoseFunnel), com o score só no empate.
//
// Sem React aqui (o hook é timing/estado; a matemática é pura e é o que precisa de gate).
import { describe, expect, it } from "vitest";
import { distinctReadings, pickBest } from "./useFunnelDiagnosis";
import type { FunnelVerdict, PairFunnel } from "./associate";

const pair = (tag: string, verdict: FunnelVerdict, score = 0): PairFunnel => ({
  trackId: 1,
  tag,
  distSamples: 16,
  rssiSamples: 16,
  alignedSamples: 16,
  spanMs: 8000,
  movVar: 0.003,
  corr: -0.2,
  score,
  margin: null,
  verdict,
  thresholds: {
    windowMs: 8000,
    minSamples: 5,
    minConfidence: 0.5,
    minMovement: 0.15,
    minMargin: 0,
  },
});

describe("distinctReadings — Regra 8 (deduplique ANTES de qualquer estatística)", () => {
  it("conta TRANSIÇÕES de valor, não amostras: o sample-and-hold não cria evidência", () => {
    // 16 amostras "recebidas" com a cadência real de campo (Δt distinto ~2,2 s numa janela de 8 s):
    // o motor CRÊ ter 16; a informação distinta é 4. É exatamente o bug B3 (minSamples conta cópias).
    const heldSeries = [-55, -55, -55, -55, -57, -57, -57, -57, -56, -56, -56, -56, -58, -58, -58, -58]; // prettier-ignore
    expect(heldSeries.length).toBe(16);
    expect(distinctReadings(heldSeries)).toBe(4);
  });

  it("série constante (bloco A do laudo: 31,0% do silêncio) → 1 leitura distinta, nunca 0", () => {
    expect(distinctReadings([-60, -60, -60, -60, -60, -60])).toBe(1);
    expect(distinctReadings([])).toBe(0);
    expect(distinctReadings([-60])).toBe(1);
  });

  it("valor que volta ao anterior NÃO consecutivo conta como leitura nova (é medição fresca)", () => {
    // -55 → -57 → -55: três medições DISTINTAS no tempo (a 3ª não é cópia da 2ª). O dedup é
    // CONSECUTIVO (o que o sample-and-hold produz), não um Set de valores — um Set diria 2 e
    // jogaria fora uma medição real do rádio.
    expect(distinctReadings([-55, -57, -55])).toBe(3);
    expect(new Set([-55, -57, -55]).size).toBe(2); // o que NÃO fazemos, e por quê
  });
});

describe("pickBest — a UI mostra a candidata que chegou MAIS LONGE na cadeia", () => {
  it("ordena pelos ELOS da cadeia (não pelo score): sobrevive quem passou por mais gates", () => {
    const best = pickBest([
      pair("A", "rssiSamples<minSamples", 0.9), // score alto, mas morreu no 1º elo
      pair("B", "lowMovement", 0),
      pair("C", "belowMinMargin", 0.6),
    ]);
    expect(best?.tag).toBe("C");
  });

  it("empate no MESMO elo → maior score (a mais próxima de falar)", () => {
    const best = pickBest([pair("A", "lowMovement", 0.2), pair("B", "lowMovement", 0.7)]);
    expect(best?.tag).toBe("B");
  });

  it("SPOKE ganha de tudo; lista vazia → null (não há candidata: o rádio é o veredito)", () => {
    expect(pickBest([pair("A", "belowMinMargin", 0.99), pair("B", "SPOKE", 0.51)])?.tag).toBe("B");
    expect(pickBest([])).toBeNull();
  });
});
