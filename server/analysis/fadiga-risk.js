// ─────────────────────────────────────────────────────────────────────────────
// fadiga-risk.js — domínio PURO do risco de fadiga no SERVIDOR (F1a da spec
// docs/analises/spec-fadiga-no-hub.md). PORT 1:1 da lógica do cliente
// (src/processors/fadiga.ts::updateRisk + recorder; src/fadiga/landmarks.ts::
// calcEar/calcMar). Sem IO, sem modelo — recebe medições (ear/mar/phone) e
// devolve risco/eventos/amostras. Estado por câmera vive numa instância.
//
// ANTI-DERIVA: os DEFAULTS abaixo espelham APP_CONFIG.fadiga do cliente; o teste
// src/fadiga/risk-parity.test.ts importa OS DOIS lados e quebra o build se algum
// número divergir. Mudou limiar no cliente → muda aqui no MESMO commit.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

// Índices da malha 468/478 do MediaPipe (espelho de APP_CONFIG.fadiga.eyeIndices/mouthIndices).
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const MOUTH_W = [78, 308];
const MOUTH_O = [13, 14];

// Espelho de APP_CONFIG.fadiga (src/config.ts) — coberto pelo teste de paridade.
const DEFAULTS = {
  eyesClosedEarThreshold: 0.21,
  yawnMarThreshold: 0.15, // 0.075→0.15 (2026-07-22): fala disparava bocejo — espelha o cliente
  fatigueConfirmationMs: 1500,
  phoneConfirmationMs: 1000,
  yawnConfirmationMs: 900,
  recoveryGraceMs: 600,
  signalSmoothingAlpha: 0.35,
  minAlertStateHoldMs: 900,
};

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function eyeAspectRatio(landmarks, indices) {
  const [p1, p2, p3, p4, p5, p6] = indices.map((i) => landmarks[i]);
  if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) return null;
  const horizontal = distance(p1, p4);
  if (horizontal <= Number.EPSILON) return null;
  return (distance(p2, p6) + distance(p3, p5)) / (2 * horizontal);
}

/** EAR médio dos dois olhos sobre a malha completa ({x,y}[478]). null sem pontos. */
function calcEar(landmarks) {
  const l = eyeAspectRatio(landmarks, LEFT_EYE),
    r = eyeAspectRatio(landmarks, RIGHT_EYE);
  if (l == null || r == null) return null;
  return (l + r) / 2;
}

/** MAR (abertura/largura da boca). null sem pontos. */
function calcMar(landmarks) {
  const wA = landmarks[MOUTH_W[0]],
    wB = landmarks[MOUTH_W[1]],
    oA = landmarks[MOUTH_O[0]],
    oB = landmarks[MOUTH_O[1]];
  if (!wA || !wB || !oA || !oB) return null;
  const width = distance(wA, wB);
  if (width <= Number.EPSILON) return null;
  return distance(oA, oB) / width;
}

/**
 * Motor de risco por câmera (estado interno; uma instância por posto).
 * update({ear, mar, phone, now, wallTs}) alimenta EMA + janelas e devolve
 * { events, alertRisk, risk } — semântica IDÊNTICA ao cliente:
 *  · olhos fechados ≥ fatigueMs OU bocejo ≥ yawnConfirmationMs → fadiga;
 *  · celular ≥ phoneConfirmationMs → celular; ambos → duplo;
 *  · saída de alerta só após recoveryGraceMs; troca entre alertas segura
 *    minAlertStateHoldMs (anti-flicker).
 * `wallTs` (relógio de parede) carimba eventos; `now` é o relógio monotônico
 * das janelas — no cliente eram performance.now() e Date.now().
 */
class FadigaRisk {
  constructor(overrides = {}) {
    this.th = { ...DEFAULTS, ...overrides };
    this.smooth = { ear: null, mar: null };
    this.win = { eyesClosedSince: null, yawnSince: null, phoneSince: null };
    this.trans = { lastChangeAt: 0, clearSince: null };
    this.risk = "OK";
    this.yawnActive = false;
    this.counters = { fadiga: 0, bocejo: 0, celular: 0, duplo: 0 };
    this.accum = { samples: 0, ok: 0, fadiga: 0, celular: 0, duplo: 0, earSum: 0, earSamples: 0 };
    this.lastAccum = 0;
    this.lastEmit = 0;
  }

  update({ ear, mar, phone = false, now, wallTs = now }) {
    const a = this.th.signalSmoothingAlpha;
    this.smooth.ear =
      ear == null ? null : this.smooth.ear == null ? ear : a * ear + (1 - a) * this.smooth.ear;
    this.smooth.mar =
      mar == null ? null : this.smooth.mar == null ? mar : a * mar + (1 - a) * this.smooth.mar;

    const events = [];
    const e = this.smooth.ear,
      m = this.smooth.mar,
      w = this.win;
    w.eyesClosedSince =
      e != null && e < this.th.eyesClosedEarThreshold ? (w.eyesClosedSince ?? now) : null;
    w.yawnSince = m != null && m >= this.th.yawnMarThreshold ? (w.yawnSince ?? now) : null;
    w.phoneSince = phone ? (w.phoneSince ?? now) : null;

    const eyesConfirmed =
      w.eyesClosedSince != null && now - w.eyesClosedSince >= this.th.fatigueConfirmationMs;
    const yawnConfirmed =
      w.yawnSince != null && now - w.yawnSince >= this.th.yawnConfirmationMs;
    const fatigue = eyesConfirmed || yawnConfirmed;
    const phoneConfirmed =
      w.phoneSince != null && now - w.phoneSince >= this.th.phoneConfirmationMs;

    if (yawnConfirmed !== this.yawnActive) {
      this.yawnActive = yawnConfirmed;
      if (yawnConfirmed) {
        this.counters.bocejo++;
        events.push({ type: "bocejo", ts: wallTs });
      }
    }

    const detected =
      fatigue && phoneConfirmed
        ? "ALERTA_DUPLO"
        : fatigue
          ? "ALERTA_FADIGA"
          : phoneConfirmed
            ? "ALERTA_CELULAR"
            : "OK";
    let next = detected;
    const prev = this.risk,
      t = this.trans,
      inAlert = prev !== "OK";
    if (inAlert && detected === "OK") {
      t.clearSince = t.clearSince ?? now;
      next = now - t.clearSince >= this.th.recoveryGraceMs ? "OK" : prev;
    } else t.clearSince = null;
    if (inAlert && detected !== "OK" && detected !== prev)
      next = now - t.lastChangeAt >= this.th.minAlertStateHoldMs ? detected : prev;

    let alertRisk = null;
    if (next !== prev) {
      t.lastChangeAt = now;
      this.risk = next;
      if (next !== "OK") {
        alertRisk = next;
        const type =
          next === "ALERTA_FADIGA" ? "fadiga" : next === "ALERTA_CELULAR" ? "celular" : "duplo";
        events.push({ type, ts: wallTs });
        if (next === "ALERTA_FADIGA") this.counters.fadiga++;
        else if (next === "ALERTA_CELULAR") this.counters.celular++;
        else this.counters.duplo++;
      }
    }
    return { events, alertRisk, risk: this.risk };
  }

  /** Recorder (idêntico ao cliente): 1 amostra/s no acumulador; a cada 5s devolve e zera. */
  sampleTick(now) {
    if (now - this.lastAccum > 1000) {
      this.lastAccum = now;
      const ac = this.accum,
        r = this.risk;
      ac.samples++;
      if (r === "OK") ac.ok++;
      else if (r === "ALERTA_FADIGA") ac.fadiga++;
      else if (r === "ALERTA_CELULAR") ac.celular++;
      else ac.duplo++;
      if (this.smooth.ear != null) {
        ac.earSum += this.smooth.ear;
        ac.earSamples++;
      }
    }
    if (now - this.lastEmit > 5000) {
      this.lastEmit = now;
      if (this.accum.samples > 0) {
        const sample = { ...this.accum };
        this.accum = { samples: 0, ok: 0, fadiga: 0, celular: 0, duplo: 0, earSum: 0, earSamples: 0 };
        return sample;
      }
    }
    return null;
  }

  snapshot() {
    return {
      risk: this.risk,
      ear: this.smooth.ear,
      mar: this.smooth.mar,
      counters: { ...this.counters },
    };
  }
}

module.exports = { FadigaRisk, calcEar, calcMar, DEFAULTS, LEFT_EYE, RIGHT_EYE, MOUTH_W, MOUTH_O };
