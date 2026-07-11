import { describe, expect, it } from "vitest";
import { LabelMemoryPolicy } from "./label-memory";
import type { ConfirmPolicy } from "./label-memory";
import { FINE_BIN_EDGES } from "./regime-reliability";
import type { RegimeReliabilityCurve } from "./regime-reliability";
import type { Assignment } from "./associate";

// Fábrica de Assignment mínima — cada teste só varia o que importa pra ele.
function a(overrides: Partial<Assignment> & { trackId: number }): Assignment {
  return { tag: null, confidence: 0, margin: 0, hadConflict: false, ...overrides };
}

const TICK_MS = 500;

describe("LabelMemoryPolicy — candidata → confirmada", () => {
  it("confirma após N ticks consecutivos de fala qualificada com a mesma tag", () => {
    const p = new LabelMemoryPolicy();
    let ts = 0;
    let last = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    expect(last[0].state).toBe("candidata");
    ts += TICK_MS;
    last = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    expect(last[0].state).toBe("candidata"); // default confirmTicks=3, só 2 até aqui
    ts += TICK_MS;
    last = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    expect(last[0].state).toBe("confirmada");
    expect(last[0].label).toBe("T1");
    expect(last[0].isFresh).toBe(true);
  });

  it("NÃO confirma com margem abaixo do bar de confirmação (mais estrito que o minMargin de fala)", () => {
    const p = new LabelMemoryPolicy();
    let ts = 0;
    for (let i = 0; i < 5; i++) {
      const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.2 })]); // fala, mas margem < 0.4
      expect(out[0].state).toBe("candidata");
      ts += TICK_MS;
    }
  });

  it("MORDIDA 1 — não confirma quando hadConflict:true, mesmo com margem alta e tag falada", () => {
    const p = new LabelMemoryPolicy();
    let ts = 0;
    for (let i = 0; i < 5; i++) {
      const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.9, hadConflict: true })]);
      expect(out[0].state).toBe("candidata");
      ts += TICK_MS;
    }
  });

  it("streak quebra (reinicia) se a tag falada mudar antes de completar N ticks", () => {
    const p = new LabelMemoryPolicy();
    let ts = 0;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.6 })]); // muda de tag — streak reinicia em T2
    ts += TICK_MS;
    const out = p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.6 })]);
    expect(out[0].state).toBe("candidata"); // só 2 ticks consecutivos de T2 até aqui
  });

  it("streak quebra com abstenção (tag:null) no meio da sequência", () => {
    const p = new LabelMemoryPolicy();
    let ts = 0;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: null })]);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    ts += TICK_MS;
    const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    expect(out[0].state).toBe("candidata"); // só 2 consecutivos após a interrupção
  });
});

function confirm(p: LabelMemoryPolicy, trackId: number, tag: string, startTs: number): number {
  let ts = startTs;
  for (let i = 0; i < 3; i++) {
    p.step(ts, [a({ trackId, tag, margin: 0.6 })]);
    ts += TICK_MS;
  }
  return ts;
}

describe("LabelMemoryPolicy — confirmada → memória → confirmada (reentrada)", () => {
  it("vira memória quando a evidência fresca some (abstenção)", () => {
    const p = new LabelMemoryPolicy();
    const ts = confirm(p, 1, "T1", 0);
    const out = p.step(ts, [a({ trackId: 1, tag: null })]);
    expect(out[0].state).toBe("memoria");
    expect(out[0].label).toBe("T1"); // rótulo segue exibido — só deixa de ser fresco
    expect(out[0].isFresh).toBe(false);
  });

  it("continua fresca (confirmada) com fala fraca da MESMA tag — não precisa relimpar a barra", () => {
    const p = new LabelMemoryPolicy();
    const ts = confirm(p, 1, "T1", 0);
    const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.05 })]); // fraca, mas é a mesma tag
    expect(out[0].state).toBe("confirmada");
    expect(out[0].isFresh).toBe(true);
  });

  it("reentra em confirmada quando a mesma tag volta a falar qualificada", () => {
    const p = new LabelMemoryPolicy();
    let ts = confirm(p, 1, "T1", 0);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: null })]); // entra em memória
    ts += TICK_MS;
    const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]); // mesmo bar de entrada
    expect(out[0].state).toBe("confirmada");
    expect(out[0].isFresh).toBe(true);
  });

  it("NÃO reentra com fala fraca (mesma barra de confirmação vale pra reentrada)", () => {
    const p = new LabelMemoryPolicy();
    let ts = confirm(p, 1, "T1", 0);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: null })]);
    ts += TICK_MS;
    const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.2 })]); // abaixo de 0.4
    expect(out[0].state).toBe("memoria");
  });
});

describe("LabelMemoryPolicy — quebra por timeout (backstop v1)", () => {
  it("quebra pra candidata após memoryTimeoutMs sem reentrada", () => {
    const p = new LabelMemoryPolicy({ memoryTimeoutMs: 5000 });
    let ts = confirm(p, 1, "T1", 0);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: null })]); // entra em memória em ts
    const enteredMemoriaTs = ts;
    ts = enteredMemoriaTs + 4000;
    let out = p.step(ts, [a({ trackId: 1, tag: null })]);
    expect(out[0].state).toBe("memoria"); // ainda dentro do timeout
    ts = enteredMemoriaTs + 6000;
    out = p.step(ts, [a({ trackId: 1, tag: null })]);
    expect(out[0].state).toBe("candidata");
    expect(out[0].label).toBeNull();
  });

  it("contradição FRACA (não qualificada) não derruba ativamente — só o timeout quebra (v1)", () => {
    const p = new LabelMemoryPolicy({ memoryTimeoutMs: 5000 });
    let ts = confirm(p, 1, "T1", 0);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: null })]); // memória
    const enteredMemoriaTs = ts;
    // várias ticks de contradição fraca (margem baixa) — não deveria quebrar antes do timeout
    for (let i = 0; i < 5; i++) {
      ts += TICK_MS;
      const out = p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.1 })]);
      expect(out[0].state).toBe("memoria");
      expect(out[0].label).toBe("T1"); // segue lembrando T1, contradição fraca não muda nada
    }
    ts = enteredMemoriaTs + 6000;
    const out = p.step(ts, [a({ trackId: 1, tag: null })]);
    expect(out[0].state).toBe("candidata"); // agora sim, pelo timeout
  });
});

describe("LabelMemoryPolicy — quebra por contradição sustentada", () => {
  it("quebra (confirmada) quando outra tag ganha com margem alta por N ticks consecutivos", () => {
    const p = new LabelMemoryPolicy();
    let ts = confirm(p, 1, "T1", 0);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.6 })]);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.6 })]);
    ts += TICK_MS;
    // 3º tick de contradição consecutiva bate contradictTicks(3) E confirmTicks(3) no mesmo passo —
    // comportamento intencional documentado (advanceContradiction já credita o streak da nova tag).
    const out = p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.6 })]);
    expect(out[0].state).toBe("confirmada");
    expect(out[0].label).toBe("T2");
  });

  it("contradição não-sustentada (intercalada) não quebra", () => {
    const p = new LabelMemoryPolicy();
    let ts = confirm(p, 1, "T1", 0);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.6 })]);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]); // volta a concordar — reseta contradictStreak
    ts += TICK_MS;
    const out = p.step(ts, [a({ trackId: 1, tag: "T2", margin: 0.6 })]);
    expect(out[0].state).toBe("confirmada");
    expect(out[0].label).toBe("T1"); // não quebrou — contradição não foi consecutiva
  });
});

// ── RETUNING v2 (confirmPolicy): barra condicionada ao regime — ver header de label-memory.ts. ──

/** Curva sintética de teste: no regime DENSO, margem ≥0,2 historicamente entrega 93%; no ESPARSO,
 *  só margem ≥0,4 entrega ≥90% (o desenho que motiva o retuning: 0,22 confirma em multidão). */
function testCurve(): RegimeReliabilityCurve {
  const mk = (precisions: number[]) =>
    FINE_BIN_EDGES.slice(0, -1).map((lo, k) => ({
      marginMin: lo,
      marginMax: FINE_BIN_EDGES[k + 1],
      correct: Math.round(precisions[k] * 100),
      wrong: 100 - Math.round(precisions[k] * 100),
      precision: precisions[k],
    }));
  return {
    denseMinCandidates: 4,
    binEdges: FINE_BIN_EDGES,
    //         [0,.05) [.05,.1) [.1,.15) [.15,.2) [.2,.3) [.3,.4) [.4,1]
    bins: {
      denso: mk([0.3, 0.5, 0.7, 0.85, 0.93, 0.96, 0.99]),
      esparso: mk([0.2, 0.4, 0.5, 0.6, 0.7, 0.8, 0.95]),
    },
  };
}

function policyV2(over?: Partial<ConfirmPolicy>): LabelMemoryPolicy {
  return new LabelMemoryPolicy({
    confirmPolicy: { curve: testCurve(), pStar: 0.9, k: 2, cleanWindow: true, ...over },
  });
}

describe("LabelMemoryPolicy — confirmPolicy (v2, barra condicionada ao regime)", () => {
  const DENSE = { candidates: 5 };

  it("margem 0,22 confirma em regime DENSO (precisão-implicada 0,93 ≥ pStar 0,9) após K ticks", () => {
    const p = policyV2();
    let out = p.step(0, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    expect(out[0].state).toBe("candidata");
    out = p.step(TICK_MS, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    expect(out[0].state).toBe("confirmada"); // k=2 — a adaptatividade EMERGE da condicionalização
    expect(out[0].label).toBe("T1");
  });

  it("a MESMA margem 0,22 NÃO confirma em regime esparso (precisão-implicada 0,7 < 0,9)", () => {
    const p = policyV2();
    for (let i = 0; i < 5; i++) {
      const out = p.step(i * TICK_MS, [a({ trackId: 1, tag: "T1", margin: 0.22 })], {
        candidates: 2,
      });
      expect(out[0].state).toBe("candidata");
    }
  });

  it("context AUSENTE = regime esparso (chamador sem instrumentação não ganha o caminho denso)", () => {
    const p = policyV2();
    for (let i = 0; i < 5; i++) {
      const out = p.step(i * TICK_MS, [a({ trackId: 1, tag: "T1", margin: 0.22 })]);
      expect(out[0].state).toBe("candidata");
    }
  });

  it("emenda v2 (cleanWindow): tick com hadConflict quebra a janela — os K ticks têm de ser limpos", () => {
    const p = policyV2({ k: 3 });
    let ts = 0;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22, hadConflict: true })], DENSE); // suja
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    ts += TICK_MS;
    let out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    expect(out[0].state).toBe("candidata"); // só 2 limpos consecutivos após a janela suja
    ts += TICK_MS;
    out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    expect(out[0].state).toBe("confirmada"); // 3º limpo consecutivo fecha
  });

  it("sem cleanWindow, hadConflict NÃO bloqueia a qualificação (a emenda é opt-in)", () => {
    const p = policyV2({ cleanWindow: false });
    p.step(0, [a({ trackId: 1, tag: "T1", margin: 0.22, hadConflict: true })], DENSE);
    const out = p.step(TICK_MS, [a({ trackId: 1, tag: "T1", margin: 0.22, hadConflict: true })], DENSE);
    expect(out[0].state).toBe("confirmada");
  });

  it("reentrada memória→confirmada usa a MESMA barra condicionada (sem assimetria)", () => {
    const p = policyV2();
    let ts = 0;
    // confirma no denso com margem 0,22
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    ts += TICK_MS;
    p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    ts += TICK_MS;
    let out = p.step(ts, [a({ trackId: 1, tag: null })], DENSE); // evidência some → memória
    expect(out[0].state).toBe("memoria");
    ts += TICK_MS;
    // fala da mesma tag com precisão-implicada ABAIXO de pStar no regime do tick (esparso: 0,7) — não reentra
    out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], { candidates: 2 });
    expect(out[0].state).toBe("memoria");
    ts += TICK_MS;
    // mesma margem no regime denso (0,93 ≥ 0,9) — reentra em 1 tick (mesma regra do v1)
    out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
    expect(out[0].state).toBe("confirmada");
  });

  it("bin sem amostra → precisão-implicada 0 → nunca qualifica (conservador)", () => {
    const curve = testCurve();
    for (const b of curve.bins.denso) {
      b.correct = 0;
      b.wrong = 0;
      b.precision = 0;
    }
    const p = new LabelMemoryPolicy({
      confirmPolicy: { curve, pStar: 0.9, k: 2, cleanWindow: true },
    });
    for (let i = 0; i < 5; i++) {
      const out = p.step(i * TICK_MS, [a({ trackId: 1, tag: "T1", margin: 0.9 })], DENSE);
      expect(out[0].state).toBe("candidata");
    }
  });

  it("sem confirmPolicy, context é ignorado — comportamento v1 intacto", () => {
    const p = new LabelMemoryPolicy();
    let ts = 0;
    for (let i = 0; i < 5; i++) {
      const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.22 })], DENSE);
      expect(out[0].state).toBe("candidata"); // v1: margem 0,22 < confirmMargin 0,4 — nunca confirma
      ts += TICK_MS;
    }
  });
});

describe("LabelMemoryPolicy — morte de track", () => {
  it("remove a crença quando o trackId some do array de assignments", () => {
    const p = new LabelMemoryPolicy();
    let ts = confirm(p, 1, "T1", 0);
    ts += TICK_MS;
    p.step(ts, []); // track 1 ausente — morreu
    ts += TICK_MS;
    // mesmo trackId reaparecendo é tratado como candidata NOVA (memória não sobrevive à morte)
    const out = p.step(ts, [a({ trackId: 1, tag: "T1", margin: 0.6 })]);
    expect(out[0].state).toBe("candidata");
  });

  it("tracks independentes não interferem entre si", () => {
    const p = new LabelMemoryPolicy();
    let ts = 0;
    for (let i = 0; i < 3; i++) {
      p.step(ts, [
        a({ trackId: 1, tag: "T1", margin: 0.6 }),
        a({ trackId: 2, tag: "T2", margin: 0.6, hadConflict: i === 1 }), // conflito local só no track 2, só 1 tick
      ]);
      ts += TICK_MS;
    }
    const out = p.step(ts, [
      a({ trackId: 1, tag: "T1", margin: 0.6 }),
      a({ trackId: 2, tag: "T2", margin: 0.6 }),
    ]);
    const t1 = out.find((o) => o.trackId === 1)!;
    const t2 = out.find((o) => o.trackId === 2)!;
    expect(t1.state).toBe("confirmada"); // nunca teve conflito — confirma no 3º tick já
    expect(t2.state).toBe("candidata"); // teve 1 conflito no meio — streak reiniciou, ainda não confirmou
  });
});
