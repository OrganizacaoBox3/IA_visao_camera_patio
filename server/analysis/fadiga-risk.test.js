// Gates do motor de risco de fadiga SERVER-SIDE (port do cliente — F1a da spec-fadiga-no-hub).
// Cenários numéricos derivados da semântica do cliente: janelas de confirmação, graça de
// recuperação, anti-flicker entre alertas, contadores e recorder 1s/5s.
import { describe, it, expect } from "vitest";
import { FadigaRisk, calcEar, calcMar, DEFAULTS } from "./fadiga-risk";

// Malha sintética: só os índices usados precisam existir. Olho ABERTO tem razão vertical/
// horizontal alta; FECHADO, baixa. Boca idem para bocejo.
function mesh({ eyeOpen = 0.3, mouthOpen = 0.05 }) {
  const lm = [];
  const put = (i, x, y) => (lm[i] = { x, y });
  // olho esquerdo [p1..p6] = [33,160,158,133,153,144]: horizontal |p1-p4|=0.1
  put(33, 0.3, 0.5);
  put(133, 0.4, 0.5);
  put(160, 0.33, 0.5 - (eyeOpen * 0.1) / 2);
  put(144, 0.33, 0.5 + (eyeOpen * 0.1) / 2);
  put(158, 0.37, 0.5 - (eyeOpen * 0.1) / 2);
  put(153, 0.37, 0.5 + (eyeOpen * 0.1) / 2);
  // olho direito [362,385,387,263,373,380]
  put(362, 0.6, 0.5);
  put(263, 0.7, 0.5);
  put(385, 0.63, 0.5 - (eyeOpen * 0.1) / 2);
  put(380, 0.63, 0.5 + (eyeOpen * 0.1) / 2);
  put(387, 0.67, 0.5 - (eyeOpen * 0.1) / 2);
  put(373, 0.67, 0.5 + (eyeOpen * 0.1) / 2);
  // boca: largura [78,308]=0.2; abertura [13,14]
  put(78, 0.4, 0.7);
  put(308, 0.6, 0.7);
  put(13, 0.5, 0.7 - (mouthOpen * 0.2) / 2);
  put(14, 0.5, 0.7 + (mouthOpen * 0.2) / 2);
  return lm;
}

describe("calcEar/calcMar (port 1:1)", () => {
  it("EAR reflete a abertura sintética; MAR a da boca", () => {
    expect(calcEar(mesh({ eyeOpen: 0.3 }))).toBeCloseTo(0.3, 5);
    expect(calcEar(mesh({ eyeOpen: 0.1 }))).toBeCloseTo(0.1, 5);
    expect(calcMar(mesh({ mouthOpen: 0.05 }))).toBeCloseTo(0.05, 5);
    expect(calcMar(mesh({ mouthOpen: 0.4 }))).toBeCloseTo(0.4, 5);
  });
  it("malha incompleta → null (nunca NaN)", () => {
    expect(calcEar([])).toBeNull();
    expect(calcMar([])).toBeNull();
  });
});

// Alimenta a instância com EAR CRU já estabilizado (repete o valor até a EMA convergir antes
// de contar tempo de janela) — os cenários testam as JANELAS, não a EMA.
function feed(rk, { ear, mar = 0.05, phone = false, fromMs, toMs, stepMs = 100 }) {
  let out = { events: [], alertRisk: null, risk: rk.risk };
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const r = rk.update({ ear, mar, phone, now: t, wallTs: t });
    out = { events: [...out.events, ...r.events], alertRisk: r.alertRisk ?? out.alertRisk, risk: r.risk };
  }
  return out;
}

describe("FadigaRisk — janelas e transições (semântica do cliente)", () => {
  it("olhos fechados ≥ fatigueConfirmationMs → ALERTA_FADIGA (evento + contador)", () => {
    const rk = new FadigaRisk();
    feed(rk, { ear: 0.3, fromMs: 0, toMs: 1000 }); // baseline aberto
    const r = feed(rk, { ear: 0.1, fromMs: 1100, toMs: 3200 }); // fechado > 1500ms (+ tempo de EMA)
    expect(r.risk).toBe("ALERTA_FADIGA");
    expect(rk.counters.fadiga).toBe(1);
    expect(r.events.some((e) => e.type === "fadiga")).toBe(true);
  });

  it("piscada curta (< janela) NÃO alerta", () => {
    const rk = new FadigaRisk();
    feed(rk, { ear: 0.3, fromMs: 0, toMs: 1000 });
    const r = feed(rk, { ear: 0.05, fromMs: 1100, toMs: 1500 }); // 400ms fechado
    expect(r.risk).toBe("OK");
    const r2 = feed(rk, { ear: 0.3, fromMs: 1600, toMs: 2600 });
    expect(r2.risk).toBe("OK");
    expect(rk.counters.fadiga).toBe(0);
  });

  it("bocejo confirmado conta 1× por episódio (histerese do yawnActive)", () => {
    const rk = new FadigaRisk();
    const r = feed(rk, { ear: 0.3, mar: 0.4, fromMs: 0, toMs: 2500 }); // boca aberta longa
    expect(rk.counters.bocejo).toBe(1);
    expect(r.events.filter((e) => e.type === "bocejo")).toHaveLength(1);
    // bocejo confirmado por yawnConfirmationMs também é FADIGA (fatigue = eyes OU yawn)
    expect(r.risk).toBe("ALERTA_FADIGA");
  });

  it("celular ≥ phoneConfirmationMs → ALERTA_CELULAR; com fadiga junto vira DUPLO", () => {
    const rk = new FadigaRisk();
    feed(rk, { ear: 0.3, fromMs: 0, toMs: 500 });
    const r = feed(rk, { ear: 0.3, phone: true, fromMs: 600, toMs: 2000 });
    expect(r.risk).toBe("ALERTA_CELULAR");
    // segue com celular E fecha os olhos → duplo (após min hold desde a última troca)
    const r2 = feed(rk, { ear: 0.05, phone: true, fromMs: 2100, toMs: 5600 });
    expect(r2.risk).toBe("ALERTA_DUPLO");
    expect(rk.counters.duplo).toBe(1);
  });

  it("recuperação exige recoveryGraceMs contínuos de OK", () => {
    const rk = new FadigaRisk();
    feed(rk, { ear: 0.3, fromMs: 0, toMs: 500 });
    feed(rk, { ear: 0.05, fromMs: 600, toMs: 3000 }); // entra em fadiga
    expect(rk.risk).toBe("ALERTA_FADIGA");
    // abre os olhos por só 300ms → ainda em alerta (graça de 600ms não cumprida)
    const r1 = feed(rk, { ear: 0.35, fromMs: 3100, toMs: 3400 });
    expect(r1.risk).toBe("ALERTA_FADIGA");
    // completa a graça → OK
    const r2 = feed(rk, { ear: 0.35, fromMs: 3500, toMs: 4400 });
    expect(r2.risk).toBe("OK");
  });

  it("recorder: 1 amostra/s, emite a cada 5s e zera; earSum acompanha a EMA", () => {
    const rk = new FadigaRisk();
    let sample = null;
    for (let t = 0; t <= 6200; t += 100) {
      rk.update({ ear: 0.3, mar: 0.05, phone: false, now: t, wallTs: t });
      const s = rk.sampleTick(t);
      if (s) sample = s;
    }
    expect(sample).not.toBeNull();
    expect(sample.samples).toBeGreaterThanOrEqual(4);
    expect(sample.ok).toBe(sample.samples); // risco OK o tempo todo
    expect(sample.earSamples).toBe(sample.samples);
    expect(sample.earSum / sample.earSamples).toBeCloseTo(0.3, 2);
  });

  it("DEFAULTS expostos para o teste de paridade com o cliente", () => {
    expect(DEFAULTS.eyesClosedEarThreshold).toBeGreaterThan(0);
    expect(Object.keys(DEFAULTS)).toHaveLength(8);
  });
});
