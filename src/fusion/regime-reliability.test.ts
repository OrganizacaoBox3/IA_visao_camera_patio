import { describe, expect, it } from "vitest";
import {
  buildRegimeReliabilityCurve,
  DEFAULT_DENSE_MIN_CANDIDATES,
  FINE_BIN_EDGES,
  formatRegimeCurve,
  impliedPrecision,
  tickRegime,
} from "./regime-reliability";
import type { RegimeReliabilityCurve } from "./regime-reliability";
import type { IdentityTick } from "./identity-metrics";
import type { Assignment } from "./associate";

function a(overrides: Partial<Assignment> & { trackId: number }): Assignment {
  return { tag: null, confidence: 0, margin: 0, hadConflict: false, ...overrides };
}

/** Tick com N assignments — regime vem do TAMANHO do array (estratificador observável). */
function tick(ts: number, assignments: Assignment[], truth: Record<number, string | null>): IdentityTick {
  return { ts, assignments, truthTagByTrack: truth };
}

describe("tickRegime — estratificador binário denso/esparso", () => {
  it("denso quando candidates ≥ N (default 4), esparso abaixo", () => {
    expect(tickRegime(4)).toBe("denso");
    expect(tickRegime(6)).toBe("denso");
    expect(tickRegime(3)).toBe("esparso");
    expect(tickRegime(0)).toBe("esparso");
    expect(DEFAULT_DENSE_MIN_CANDIDATES).toBe(4);
  });

  it("N configurável", () => {
    expect(tickRegime(2, 2)).toBe("denso");
    expect(tickRegime(1, 2)).toBe("esparso");
  });
});

describe("buildRegimeReliabilityCurve", () => {
  it("estratifica por regime: mesma margem cai em bins de regimes diferentes", () => {
    // Tick DENSO (4 assignments): 3 acertos + 1 erro na margem 0,22 (bin [0.2,0.3)).
    const denso = tick(
      0,
      [
        a({ trackId: 1, tag: "T1", margin: 0.22 }),
        a({ trackId: 2, tag: "T2", margin: 0.22 }),
        a({ trackId: 3, tag: "T3", margin: 0.22 }),
        a({ trackId: 4, tag: "T9", margin: 0.22 }), // errado (verdade é T4)
      ],
      { 1: "T1", 2: "T2", 3: "T3", 4: "T4" },
    );
    // Tick ESPARSO (2 assignments): 1 erro na mesma margem.
    const esparso = tick(500, [a({ trackId: 1, tag: "T2", margin: 0.22 }), a({ trackId: 2 })], {
      1: "T1",
      2: "T2",
    });
    const curve = buildRegimeReliabilityCurve([denso, esparso]);

    expect(impliedPrecision(curve, "denso", 0.22)).toBeCloseTo(3 / 4, 10);
    expect(impliedPrecision(curve, "esparso", 0.22)).toBe(0); // 0/1 — só erro naquele bin
  });

  it("abstenção (tag null) e track fantasma ficam fora da curva", () => {
    const t = tick(
      0,
      [
        a({ trackId: 1, tag: null, margin: 0.5 }), // abstenção — fora
        a({ trackId: 99, tag: "T1", margin: 0.5 }), // fantasma (sem verdade) — fora
        a({ trackId: 2, tag: "T2", margin: 0.5 }), // única decisão avaliável
      ],
      { 1: "T1", 2: "T2" },
    );
    const curve = buildRegimeReliabilityCurve([t]);
    const bin = curve.bins.esparso.find((b) => b.marginMin === 0.4)!;
    expect(bin.correct + bin.wrong).toBe(1);
  });

  it("falso-rótulo (pessoa sem tag recebeu rótulo) conta como wrong — mesma régua de identity-metrics", () => {
    const t = tick(0, [a({ trackId: 1, tag: "T1", margin: 0.5 })], { 1: null });
    const curve = buildRegimeReliabilityCurve([t]);
    expect(impliedPrecision(curve, "esparso", 0.5)).toBe(0);
  });

  it("warmupMs default 0 — ticks iniciais ENTRAM (a política também os vê); warmup opcional exclui", () => {
    const early = tick(0, [a({ trackId: 1, tag: "T1", margin: 0.5 })], { 1: "T1" });
    const late = tick(9000, [a({ trackId: 1, tag: "T9", margin: 0.5 })], { 1: "T1" });
    const all = buildRegimeReliabilityCurve([early, late]);
    expect(impliedPrecision(all, "esparso", 0.5)).toBeCloseTo(0.5, 10); // 1 certo + 1 errado
    const warm = buildRegimeReliabilityCurve([early, late], { warmupMs: 8000 });
    expect(impliedPrecision(warm, "esparso", 0.5)).toBe(0); // só o tardio (errado) sobra
  });
});

describe("impliedPrecision — interpolação degrau", () => {
  const curve: RegimeReliabilityCurve = {
    denseMinCandidates: 4,
    binEdges: FINE_BIN_EDGES,
    bins: {
      denso: FINE_BIN_EDGES.slice(0, -1).map((lo, k) => ({
        marginMin: lo,
        marginMax: FINE_BIN_EDGES[k + 1],
        correct: k, // bin k tem precisão k/(k+1): 0, 1/2, 2/3, ...
        wrong: 1,
        precision: k / (k + 1),
      })),
      esparso: FINE_BIN_EDGES.slice(0, -1).map((lo, k) => ({
        marginMin: lo,
        marginMax: FINE_BIN_EDGES[k + 1],
        correct: 0,
        wrong: 0,
        precision: 0, // regime inteiro sem amostra
      })),
    },
  };

  it("degrau: a margem cai no bin [lo,hi) — borda inferior inclusiva", () => {
    expect(impliedPrecision(curve, "denso", 0)).toBe(0); // bin 0
    expect(impliedPrecision(curve, "denso", 0.05)).toBe(1 / 2); // borda → bin 1
    expect(impliedPrecision(curve, "denso", 0.29)).toBe(4 / 5); // bin [0.2,0.3)
    expect(impliedPrecision(curve, "denso", 0.4)).toBe(6 / 7); // último bin [0.4,1]
  });

  it("margem = última borda cai no ÚLTIMO bin (inclusivo); fora do range é clampada", () => {
    expect(impliedPrecision(curve, "denso", 1)).toBe(6 / 7);
    expect(impliedPrecision(curve, "denso", 1.5)).toBe(6 / 7); // clamp superior
    expect(impliedPrecision(curve, "denso", -0.1)).toBe(0); // clamp inferior (bin 0)
  });

  it("bin sem amostra → 0 (conservador, nunca NaN)", () => {
    expect(impliedPrecision(curve, "esparso", 0.9)).toBe(0);
    expect(Number.isNaN(impliedPrecision(curve, "esparso", 0.22))).toBe(false);
  });
});

describe("formatRegimeCurve", () => {
  it("não explode e menciona os dois regimes", () => {
    const curve = buildRegimeReliabilityCurve([]);
    const txt = formatRegimeCurve(curve);
    expect(txt).toContain("denso");
    expect(txt).toContain("esparso");
  });
});
