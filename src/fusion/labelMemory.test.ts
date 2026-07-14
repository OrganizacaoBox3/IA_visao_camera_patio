// Gate da MEMÓRIA de rótulo (labelMemory.ts): cada transição da máquina de estados, com ÊNFASE nas
// travas de honestidade (rótulo errado é PIOR que rótulo nenhum). Os controles negativos têm dente:
// não só "confirmado sobrevive", mas "candidato de 1 tick SOME" e "crença velha decai / cai no
// conflito". Puro e determinístico — o tempo entra por `now`, nada de relógio.
import { describe, expect, it } from "vitest";
import { LabelMemory, type FreshObservation } from "./labelMemory";

const T = 500; // um tick de 500ms (mesmo do useTagFusion)
const spoke = (tag: string, confidence = 0.9, hadConflict = false): FreshObservation => ({
  tag,
  confidence,
  hadConflict,
});
const silent: FreshObservation = { tag: null, confidence: 0 };

/** Açúcar: fresh de UM track. */
function one(id: number, obs: FreshObservation): Map<number, FreshObservation> {
  return new Map([[id, obs]]);
}

describe("LabelMemory — confirmação (trava nº1: só confirmado persiste)", () => {
  it("candidato de 1 tick NÃO é exibido e SOME no tick seguinte se não reconfirmar", () => {
    const m = new LabelMemory(); // confirmThreshold 2
    const live = new Set([1]);

    // 1ª fala confiante: vira candidata, NÃO exibida (não é palpite exibível).
    expect(m.update(one(1, spoke("AA")), live, 0).get(1)).toBeUndefined();
    // Tick seguinte sem reconfirmação (silêncio): o candidato SOME — zero persistência de palpite.
    expect(m.update(one(1, silent), live, T).size).toBe(0);
    // E não ressuscita: nada segurado.
    expect(m.update(one(1, silent), live, 2 * T).size).toBe(0);
  });

  it("duas falas confiantes CONSECUTIVAS da mesma tag → confirma e exibe", () => {
    const m = new LabelMemory();
    const live = new Set([1]);
    expect(m.update(one(1, spoke("AA")), live, 0).get(1)).toBeUndefined(); // candidata
    expect(m.update(one(1, spoke("AA")), live, T).get(1)).toBe("AA"); // confirmada, exibida
  });

  it("fala COM conflito local (hadConflict) NÃO conta para confirmar (Mordida 1)", () => {
    const m = new LabelMemory();
    const live = new Set([1]);
    // Duas falas, mas conflitadas: nunca confirma.
    m.update(one(1, spoke("AA", 0.9, true)), live, 0);
    expect(m.update(one(1, spoke("AA", 0.9, true)), live, T).size).toBe(0);
  });

  it("fala fraca (< confirmConfidence) NÃO conta para confirmar", () => {
    const m = new LabelMemory({ confirmConfidence: 0.7 });
    const live = new Set([1]);
    m.update(one(1, spoke("AA", 0.6)), live, 0);
    expect(m.update(one(1, spoke("AA", 0.6)), live, T).size).toBe(0);
  });

  it("confirmThreshold:1 → confirma na primeira fala (knob plugável)", () => {
    const m = new LabelMemory({ confirmThreshold: 1 });
    expect(m.update(one(1, spoke("AA")), new Set([1]), 0).get(1)).toBe("AA");
  });
});

describe("LabelMemory — o caso central: confirmado SOBREVIVE ao operador parado", () => {
  it("confirmada sobrevive a fresh=null enquanto o track vive (dentro do TTL)", () => {
    const m = new LabelMemory({ holdMs: 12000 });
    const live = new Set([1]);
    m.update(one(1, spoke("AA")), live, 0);
    expect(m.update(one(1, spoke("AA")), live, T).get(1)).toBe("AA"); // confirmada

    // Operador PAROU: o assign devolve null tick após tick. O nome FICA (é o objetivo).
    for (let t = 2; t <= 20; t++)
      expect(m.update(one(1, silent), live, t * T).get(1), `tick ${t}`).toBe("AA");
    // 20 ticks = 10s < 12s de holdMs → ainda segurando.
  });

  it("reconfirmação durante a memória RENOVA o TTL (não decai enquanto anda de novo)", () => {
    const m = new LabelMemory({ holdMs: 6000 });
    const live = new Set([1]);
    m.update(one(1, spoke("AA")), live, 0);
    m.update(one(1, spoke("AA")), live, T); // confirmada em t=500

    // Silêncio até quase o TTL, depois RE-fala: o relógio zera.
    m.update(one(1, silent), live, 6000);
    expect(m.update(one(1, spoke("AA")), live, 6400).get(1)).toBe("AA"); // renovou em 6400
    // Agora aguenta mais ~6s a partir de 6400.
    expect(m.update(one(1, silent), live, 12000).get(1)).toBe("AA");
  });
});

describe("LabelMemory — queda por MORTE do track (trava nº2a)", () => {
  it("track some dos vivos → rótulo cai IMEDIATAMENTE", () => {
    const m = new LabelMemory();
    m.update(one(1, spoke("AA")), new Set([1]), 0);
    expect(m.update(one(1, spoke("AA")), new Set([1]), T).get(1)).toBe("AA");
    // Track 1 morre (não está mais nos vivos) — mesmo com o assign ainda tentando falar dele.
    expect(m.update(one(1, spoke("AA")), new Set([2]), 2 * T).get(1)).toBeUndefined();
  });
});

describe("LabelMemory — queda por CONFLITO de tag no mesmo track (trava nº2b)", () => {
  it("tag DIFERENTE confiante no mesmo track troca/derruba — não fica o velho", () => {
    const m = new LabelMemory();
    const live = new Set([1]);
    m.update(one(1, spoke("AA")), live, 0);
    expect(m.update(one(1, spoke("AA")), live, T).get(1)).toBe("AA"); // AA confirmada

    // Chega BB confiante no MESMO track: AA cai na hora; BB entra como candidato (não exibido ainda).
    expect(m.update(one(1, spoke("BB")), live, 2 * T).get(1)).toBeUndefined();
    // BB só aparece depois de reconfirmar (não herda a confirmação de AA).
    expect(m.update(one(1, spoke("BB")), live, 3 * T).get(1)).toBe("BB");
  });
});

describe("LabelMemory — id-switch guard: mesma tag confirmada em 2 tracks (trava nº2c)", () => {
  it("só UM track segura a tag — o mais recente vence, o outro cai", () => {
    const m = new LabelMemory();
    const live = new Set([1, 2]);
    // Track 1 confirma AA primeiro (t=0,500).
    m.update(one(1, spoke("AA")), live, 0);
    m.update(one(1, spoke("AA")), live, T);
    expect(m.update(one(1, silent), live, 2 * T).get(1)).toBe("AA");

    // Track 2 passa a confirmar AA também (t=1000,1500) — id-switch. O mais RECENTE (track 2) vence.
    const f = (a: FreshObservation, b: FreshObservation) =>
      new Map([
        [1, a],
        [2, b],
      ]);
    m.update(f(silent, spoke("AA")), live, 2 * T);
    const out = m.update(f(silent, spoke("AA")), live, 3 * T);
    expect(out.get(2)).toBe("AA"); // track 2 (recente) segura
    expect(out.get(1)).toBeUndefined(); // track 1 (velho) cai — a tag não se duplica
  });
});

describe("LabelMemory — TTL de memória (trava nº3: crença velha decai)", () => {
  it("sem reconfirmação por holdMs → decai (evita cavalgar id-switch silencioso)", () => {
    const m = new LabelMemory({ holdMs: 3000 });
    const live = new Set([1]);
    m.update(one(1, spoke("AA")), live, 0);
    m.update(one(1, spoke("AA")), live, T); // confirmada em t=500

    // Silêncio: segura até 500+3000=3500; em 3600 já passou → cai.
    expect(m.update(one(1, silent), live, 3000).get(1)).toBe("AA"); // ainda dentro
    expect(m.update(one(1, silent), live, 3600).get(1)).toBeUndefined(); // decaiu
  });
});

describe("LabelMemory — reset e higiene", () => {
  it("reset zera a crença (mesma vida do associador)", () => {
    const m = new LabelMemory();
    const live = new Set([1]);
    m.update(one(1, spoke("AA")), live, 0);
    m.update(one(1, spoke("AA")), live, T);
    m.reset();
    // Depois do reset, uma fala isolada volta a ser candidata (não exibida).
    expect(m.update(one(1, spoke("AA")), live, 2 * T).size).toBe(0);
  });

  it("assign de track já morto é ignorado (não cria crença fantasma)", () => {
    const m = new LabelMemory({ confirmThreshold: 1 });
    // Track 9 fala confiante mas NÃO está vivo → nada é criado nem exibido.
    expect(m.update(one(9, spoke("AA")), new Set([1]), 0).size).toBe(0);
  });

  it("track silencioso não reportado no fresh: candidato some, confirmado segura", () => {
    const m = new LabelMemory();
    const live = new Set([1, 2]);
    // Track 1 confirma; track 2 é um candidato de 1 tick.
    m.update(
      new Map([
        [1, spoke("AA")],
        [2, spoke("BB")],
      ]),
      live,
      0,
    );
    m.update(one(1, spoke("AA")), live, T); // só track 1 reportado; track 2 (candidato) some
    const out = m.update(new Map(), live, 2 * T); // ninguém reportado
    expect(out.get(1)).toBe("AA"); // confirmado segurado
    expect(out.get(2)).toBeUndefined(); // candidato sumiu
  });
});
