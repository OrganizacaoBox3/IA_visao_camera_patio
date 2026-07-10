import { describe, expect, it } from "vitest";
import { LabelMemoryPolicy } from "./label-memory";
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
