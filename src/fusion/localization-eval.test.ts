import { describe, expect, it } from "vitest";
import {
  evaluateLocalizationSequence,
  wilsonInterval95,
  type LocalizationEvalSample,
} from "./localization-eval";

const sample = (
  overrides: Partial<LocalizationEvalSample> = {},
): LocalizationEvalSample => ({
  tag: "TAG-1",
  ts: 0,
  split: "test",
  source: "fingerprint",
  real: { x: 0, y: 0 },
  estimated: { x: 0, y: 0 },
  accepted: true,
  ...overrides,
});

describe("wilsonInterval95", () => {
  it("mantem n explicito e nao chama 13/13 de certeza", () => {
    const interval = wilsonInterval95(13, 13);

    expect(interval?.low).toBeCloseTo(0.7719, 4);
    expect(interval?.high).toBeCloseTo(1, 8);
    expect(wilsonInterval95(0, 0)).toBeNull();
  });
});

describe("evaluateLocalizationSequence", () => {
  it("falha fechado quando o split avaliado esta vazio", () => {
    const result = evaluateLocalizationSequence([], {
      split: "test",
      maxJumpSpeedMps: 2,
    });

    expect(result.evidence.status).toBe("empty-split");
    expect(result.evidence.canClaimSuccess).toBe(false);
    expect(result.overall.coverage).toEqual({
      numerator: 0,
      denominator: 0,
      rate: null,
      wilson95: null,
    });
    expect(result.overall.errorM).toEqual({ n: 0, p50: null, p90: null });
  });

  it("avalia somente o holdout informado e nunca mistura treino", () => {
    const rows = [
      sample({ split: "train", estimated: { x: 0, y: 0 } }),
      sample({ split: "test", estimated: { x: 3, y: 4 } }),
      sample({ split: "validation", estimated: { x: 6, y: 8 } }),
    ];

    const testResult = evaluateLocalizationSequence(rows, {
      split: "test",
      maxJumpSpeedMps: 2,
    });
    const validationResult = evaluateLocalizationSequence(rows, {
      split: "validation",
      maxJumpSpeedMps: 2,
    });

    expect(testResult.split).toBe("test");
    expect(testResult.sampleCount).toBe(1);
    expect(testResult.ignoredOtherSplits).toBe(2);
    expect(testResult.overall.errorM.p50).toBe(5);
    expect(validationResult.overall.errorM.p50).toBe(10);
  });

  it("mede cobertura, rejeicao, clamp, erro, jitter parado e saltos", () => {
    const rows = [
      sample({ ts: 0, clamped: false, estimated: { x: 0, y: 0 } }),
      sample({ ts: 1_000, clamped: false, estimated: { x: 0.2, y: 0 } }),
      sample({ ts: 2_000, clamped: true, estimated: { x: 0.1, y: 0 } }),
      sample({
        ts: 3_000,
        real: { x: 1, y: 0 },
        estimated: null,
        accepted: false,
        clamped: false,
      }),
    ];

    const result = evaluateLocalizationSequence(rows, {
      split: "test",
      maxJumpSpeedMps: 0.15,
      stationaryGroundTruthSpeedMps: 0.01,
    });

    expect(result.evidence.status).toBe("measured");
    expect(result.overall.coverage.numerator).toBe(3);
    expect(result.overall.coverage.denominator).toBe(4);
    expect(result.overall.coverage.rate).toBe(0.75);
    expect(result.overall.coverage.wilson95).not.toBeNull();
    expect(result.overall.rejectedRate.rate).toBe(0.25);
    expect(result.overall.clampedRate?.numerator).toBe(1);
    expect(result.overall.clampedRate?.denominator).toBe(3);
    expect(result.overall.errorM.n).toBe(3);
    expect(result.overall.errorM.p50).toBeCloseTo(0.1, 8);
    expect(result.overall.errorM.p90).toBeCloseTo(0.18, 8);
    expect(result.overall.stationaryJitterM.n).toBe(3);
    expect(result.overall.stationaryJitterM.p90).toBeCloseTo(0.1, 8);
    expect(result.overall.impossibleJumps.numerator).toBe(1);
    expect(result.overall.impossibleJumps.denominator).toBe(2);
  });

  it("nao inventa clampedRate quando a flag nao foi instrumentada", () => {
    const result = evaluateLocalizationSequence([sample()], {
      split: "test",
      maxJumpSpeedMps: 2,
    });

    expect(result.overall.clampedRate).toBeNull();
  });

  it("explicita o mecanismo ruim mesmo quando o agregado parece bom", () => {
    const rows: LocalizationEvalSample[] = [];
    for (let index = 0; index < 10; index += 1) {
      rows.push(
        sample({
          tag: "TAG-FP",
          ts: index * 1_000,
          source: "fingerprint",
          real: { x: index, y: 0 },
          estimated: { x: index + 0.1, y: 0 },
        }),
      );
    }
    for (let index = 0; index < 2; index += 1) {
      rows.push(
        sample({
          tag: "TAG-ML",
          ts: index * 1_000,
          source: "multilateration",
          real: { x: index, y: 0 },
          estimated: { x: index + 10, y: 0 },
        }),
      );
    }

    const result = evaluateLocalizationSequence(rows, {
      split: "test",
      maxJumpSpeedMps: 2,
    });

    expect(result.overall.errorM.p50).toBeCloseTo(0.1, 8);
    expect(result.bySource.fingerprint.errorM.p50).toBeCloseTo(0.1, 8);
    expect(result.bySource.multilateration.errorM).toEqual({
      n: 2,
      p50: 10,
      p90: 10,
    });
    expect(result.bySource.multilateration.evidence.canClaimSuccess).toBe(true);
  });

  it("nao permite que um mecanismo sem nenhuma posicao aceita alegue sucesso", () => {
    const result = evaluateLocalizationSequence(
      [
        sample({ source: "fingerprint" }),
        sample({ source: "multilateration", accepted: false, estimated: null }),
      ],
      { split: "test", maxJumpSpeedMps: 2 },
    );

    expect(result.evidence.status).toBe("measured");
    expect(result.bySource.multilateration.evidence).toEqual({
      status: "no-accepted-estimates",
      canClaimSuccess: false,
      reason: "Nenhuma posicao aceita foi publicada por este recorte.",
    });
    expect(result.bySource.multilateration.coverage.rate).toBe(0);
    expect(result.bySource.multilateration.rejectedRate.rate).toBe(1);
  });
});
