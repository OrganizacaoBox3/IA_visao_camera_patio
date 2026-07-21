// GATE ANTI-DERIVA cliente↔servidor (F1a, spec-fadiga-no-hub): o motor de risco de fadiga do
// hub (server/analysis/fadiga-risk.js) espelha os limiares/índices de APP_CONFIG.fadiga. Este
// teste importa OS DOIS lados — mudou um número no cliente sem mudar no servidor (ou vice-versa),
// o build quebra AQUI. É a versão executável do "mesma semântica dos alertas".
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { APP_CONFIG } from "../config";

const require = createRequire(import.meta.url);
const server = require("../../server/analysis/fadiga-risk.js");

describe("paridade cliente↔servidor do risco de fadiga", () => {
  it("limiares/janelas idênticos ao APP_CONFIG.fadiga", () => {
    const F = APP_CONFIG.fadiga;
    expect(server.DEFAULTS).toEqual({
      eyesClosedEarThreshold: F.eyesClosedEarThreshold,
      yawnMarThreshold: F.yawnMarThreshold,
      fatigueConfirmationMs: F.fatigueConfirmationMs,
      phoneConfirmationMs: F.phoneConfirmationMs,
      yawnConfirmationMs: F.yawnConfirmationMs,
      recoveryGraceMs: F.recoveryGraceMs,
      signalSmoothingAlpha: F.signalSmoothingAlpha,
      minAlertStateHoldMs: F.minAlertStateHoldMs,
    });
  });

  it("índices da malha idênticos (EAR/MAR calculados nos MESMOS pontos)", () => {
    expect(server.LEFT_EYE).toEqual(APP_CONFIG.fadiga.eyeIndices.left);
    expect(server.RIGHT_EYE).toEqual(APP_CONFIG.fadiga.eyeIndices.right);
    expect(server.MOUTH_W).toEqual(APP_CONFIG.fadiga.mouthIndices.width);
    expect(server.MOUTH_O).toEqual(APP_CONFIG.fadiga.mouthIndices.open);
  });
});
