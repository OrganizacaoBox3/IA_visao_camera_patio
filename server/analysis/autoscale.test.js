// Testes da DECISÃO PURA de auto-dimensionamento (Onda 5). Provam o contrato de segurança:
//   • afogado por N janelas consecutivas → DOWNGRADE (histerese forte); <N → segura.
//   • folga sustentada + orçamento comporta → UPGRADE conservador; teto → mantém.
//   • cooldown pós-troca desliga a decisão (anti-flap).
//   • NUNCA desce abaixo do PISO N (nunca cego).
//   • pick de startup escolhe o melhor tier que o hardware sustenta.
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { pickStartupTier, budgetTier, initState, decideRuntime } = require("./autoscale");

// cfg com janelas curtas p/ os testes de histerese não precisarem de 20 iterações.
const CFG = { downWindows: 3, upWindows: 3, cooldownMs: 120_000 };

// Base de tempo REALISTA (como Date.now()): com lastSwitchAt=0 inicial, `now - 0` fica muito
// acima do cooldown — em produção o timestamp é enorme, então o motor nunca nasce "em cooldown".
const T0 = 10_000_000;
const at = (i) => T0 + i * 30_000; // uma janela por passo

// Amostra "afogada": cadência muito abaixo do alvo E CPU sustentada alta.
const choked = (tier, now) => ({
  now,
  tier,
  cpuPct: 190,
  achievedFps: 3,
  targetFps: 8,
  cameras: 8,
  cores: 4,
});
// Amostra "folgada": batendo o alvo com CPU baixa (muita folga).
const idle = (tier, now, cameras = 2, cores = 8) => ({
  now,
  tier,
  cpuPct: 30,
  achievedFps: cameras,
  targetFps: cameras,
  cameras,
  cores,
});

describe("pickStartupTier — melhor tier sustentável", () => {
  it("poucas câmeras + muitos cores → melhor tier (M)", () => {
    expect(pickStartupTier({ cores: 8, cameras: 4 })).toBe("m");
  });
  it("carga média → S", () => {
    // 40 câmeras / 8 cores: M (4×8=32) não cabe c/ folga; S (7×8=56) cabe → "s".
    expect(pickStartupTier({ cores: 8, cameras: 40 })).toBe("s");
  });
  it("muitas câmeras / poucos cores → PISO N", () => {
    expect(pickStartupTier({ cores: 2, cameras: 60 })).toBe("n");
  });
  it("sem câmeras conhecidas → melhor plausível (não trava)", () => {
    expect(["s", "m"]).toContain(pickStartupTier({ cores: 4, cameras: 0 }));
  });
  it("budgetTier nunca devolve vazio (piso n)", () => {
    expect(budgetTier({ cores: 1, cameras: 10_000 })).toBe("n");
  });
});

describe("decideRuntime — DOWNGRADE com histerese forte", () => {
  it("afogado por downWindows consecutivas → desce um tier (s→n)", () => {
    let st = initState("s");
    let d;
    for (let i = 0; i < CFG.downWindows; i++) {
      d = decideRuntime(st, choked("s", at(i)), CFG);
      st = d.state;
    }
    expect(d.action).toBe("downgrade");
    expect(d.from).toBe("s");
    expect(d.to).toBe("n");
    expect(st.lastSwitchAt).toBeGreaterThan(0);
  });

  it("afogado por MENOS que downWindows → segura (não desce)", () => {
    let st = initState("s");
    let d;
    for (let i = 0; i < CFG.downWindows - 1; i++) {
      d = decideRuntime(st, choked("s", at(i)), CFG);
      st = d.state;
    }
    expect(d.action).toBe("hold");
    expect(st.choked).toBe(CFG.downWindows - 1);
  });

  it("uma janela NÃO-afogada zera o contador (histerese por consecutivas)", () => {
    let st = initState("s");
    // 2 afogadas…
    st = decideRuntime(st, choked("s", at(0)), CFG).state;
    st = decideRuntime(st, choked("s", at(1)), CFG).state;
    expect(st.choked).toBe(2);
    // …1 estável zera…
    st = decideRuntime(st, { now: at(2), tier: "s", cpuPct: 40, achievedFps: 8, targetFps: 8, cameras: 8, cores: 8 }, CFG).state;
    expect(st.choked).toBe(0);
    // …e a próxima afogada recomeça do 1 (não dispara).
    const d = decideRuntime(st, choked("s", at(3)), CFG);
    expect(d.action).toBe("hold");
    expect(d.state.choked).toBe(1);
  });

  it("desce só UM tier por vez (m→s, não m→n)", () => {
    let st = initState("m");
    let d;
    for (let i = 0; i < CFG.downWindows; i++) {
      d = decideRuntime(st, choked("m", at(i)), CFG);
      st = d.state;
    }
    expect(d.to).toBe("s");
  });

  it("NUNCA desce abaixo do PISO N — no N, afogado só segura (nunca cego)", () => {
    let st = initState("n");
    let d;
    for (let i = 0; i < CFG.downWindows + 2; i++) {
      d = decideRuntime(st, choked("n", at(i)), CFG);
      st = d.state;
    }
    expect(d.action).toBe("hold");
    expect(st.tier).toBe("n");
  });

  it("fps baixo mas CPU BAIXA (falta de frame, não de CPU) → NÃO desce", () => {
    let st = initState("s");
    let d;
    for (let i = 0; i < CFG.downWindows + 1; i++) {
      d = decideRuntime(st, { now: at(i), tier: "s", cpuPct: 20, achievedFps: 1, targetFps: 8, cameras: 8, cores: 4 }, CFG);
      st = d.state;
    }
    expect(d.action).toBe("hold");
    expect(st.choked).toBe(0);
  });
});

describe("decideRuntime — UPGRADE conservador", () => {
  it("folga sustentada por upWindows + orçamento comporta → sobe um tier (n→s)", () => {
    let st = initState("n");
    let d;
    for (let i = 0; i < CFG.upWindows; i++) {
      d = decideRuntime(st, idle("n", at(i)), CFG);
      st = d.state;
    }
    expect(d.action).toBe("upgrade");
    expect(d.to).toBe("s");
  });

  it("folga mas orçamento no TETO (M não cabe) → mantém em S", () => {
    let st = initState("s");
    let d;
    for (let i = 0; i < CFG.upWindows + 1; i++) {
      // 60 câmeras / 4 cores: M (4×4=16) não comporta → não sobe.
      d = decideRuntime(st, idle("s", at(i), 60, 4), CFG);
      st = d.state;
    }
    expect(d.action).toBe("hold");
    expect(st.tier).toBe("s");
  });

  it("no topo (M) folga não sobe mais", () => {
    let st = initState("m");
    const d = decideRuntime(st, idle("m", at(0), 2, 16), CFG);
    expect(d.action).toBe("hold");
  });
});

describe("autoscale CIENTE DO POOL — capacidade ≈ N workers × por-worker", () => {
  // THREADS_PER_WORKER=2 (default): cores_efetivos = min(cores, workers×2).
  it("budgetTier: 1 worker NÃO superestima (cap por min(cores, 2))", () => {
    // 8 cores mas 1 worker só usa ~2 cores → 30 câmeras não cabem em S (7×2=14) → PISO N.
    expect(budgetTier({ cores: 8, cameras: 30, workers: 1 })).toBe("n");
  });

  it("budgetTier: o POOL destrava o tier maior nas MESMAS câmeras", () => {
    // 4 workers → cores_efetivos = min(8, 8) = 8 → 30 câmeras cabem em M (4×8=32).
    expect(budgetTier({ cores: 8, cameras: 30, workers: 4 })).toBe("m");
    // 2 workers → efetivos min(8,4)=4 → M 4×4=16<30, S 7×4=28<30, N 17×4=68 → "n"? não: S=28<30 → n.
    expect(budgetTier({ cores: 8, cameras: 30, workers: 2 })).toBe("n");
    expect(budgetTier({ cores: 8, cameras: 20, workers: 2 })).toBe("s"); // efetivos 4: S 28≥20 → s
  });

  it("budgetTier sem `workers` mantém o comportamento pré-pool (cores × cap)", () => {
    expect(budgetTier({ cores: 8, cameras: 30 })).toBe("m"); // efetivos = 8 cores → M 32≥30
    expect(budgetTier({ cores: 8, cameras: 40 })).toBe("s"); // M 32<40, S 56≥40 → s
  });

  it("pickStartupTier com pool grande escolhe tier melhor que com 1 worker", () => {
    expect(pickStartupTier({ cores: 8, cameras: 24, workers: 1 })).toBe("n"); // 1 worker afogaria em S/M
    expect(pickStartupTier({ cores: 8, cameras: 24, workers: 4 })).toBe("m"); // pool sustenta M
  });

  it("decideRuntime NÃO rebaixa quando o pool tem folga de CPU (teto escala por N)", () => {
    // 4 workers a ~1 core cada = 400% agregado, MAS o teto de 'afogado' escala: 150×4=600.
    // 400 < 600 → não é afogado, mesmo com fps atrás → HOLD (não mascara o teto rebaixando).
    let st = initState("m");
    let d;
    for (let i = 0; i < CFG.downWindows + 1; i++) {
      d = decideRuntime(st, { now: at(i), tier: "m", cpuPct: 400, achievedFps: 4, targetFps: 8, cameras: 12, cores: 8, workers: 4 }, CFG);
      st = d.state;
    }
    expect(d.action).toBe("hold");
    expect(st.choked).toBe(0);
  });

  it("decideRuntime AINDA rebaixa quando o pool está de fato afogado (CPU acima do teto escalado)", () => {
    // 4 workers, agregado 650% > 600 (teto 150×4) E fps 4/8=0,5 ≤ 0,6 → afogado de verdade.
    let st = initState("m");
    let d;
    for (let i = 0; i < CFG.downWindows; i++) {
      d = decideRuntime(st, { now: at(i), tier: "m", cpuPct: 650, achievedFps: 4, targetFps: 8, cameras: 12, cores: 8, workers: 4 }, CFG);
      st = d.state;
    }
    expect(d.action).toBe("downgrade");
    expect(d.to).toBe("s");
  });

  it("upgrade usa o orçamento do POOL (folga sobe de tier quando o pool comporta)", () => {
    // n→s: pool de 4 workers, 24 câmeras, folga sustentada. Orçamento (efetivos 8) comporta S.
    let st = initState("n");
    let d;
    for (let i = 0; i < CFG.upWindows; i++) {
      d = decideRuntime(st, { now: at(i), tier: "n", cpuPct: 100, achievedFps: 24, targetFps: 24, cameras: 24, cores: 8, workers: 4 }, CFG);
      st = d.state;
    }
    expect(d.action).toBe("upgrade");
    expect(d.to).toBe("s");
  });
});

describe("decideRuntime — cooldown e sem-carga", () => {
  it("dentro do cooldown pós-troca → hold e zera contadores", () => {
    const st = { tier: "s", choked: 2, idle: 0, lastSwitchAt: 5000 };
    const d = decideRuntime(st, choked("s", 5000 + 1000), { ...CFG, cooldownMs: 120_000 });
    expect(d.action).toBe("hold");
    expect(d.reason).toBe("cooldown");
    expect(d.state.choked).toBe(0);
  });

  it("sem câmeras → hold sem tocar tier", () => {
    const st = initState("s");
    const d = decideRuntime(st, { now: 200_000, tier: "s", cpuPct: 0, achievedFps: 0, targetFps: 0, cameras: 0, cores: 4 }, CFG);
    expect(d.action).toBe("hold");
    expect(d.to).toBe("s");
  });
});
