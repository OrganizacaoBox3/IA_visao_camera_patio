// Testes do gate de movimento (motion.js) — o coração da economia de CPU: pular a inferência em
// cena estática SEM cegar a câmera. Provamos a matemática do diff de luma, a máscara de hotspot
// (reuso das zonas de exclusão) e a DECISÃO do gate: pula quando estático, roda no movimento,
// roda no PROBE (nunca abaixo do piso) e roda o baseline (1º frame).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { motionRatio, buildIgnoreMask, gateDecision, PIXEL_DELTA } = require("./motion");

// thumbnail cheio de um valor (single-channel 0..255).
function solid(len, v) {
  const a = new Uint8Array(len);
  a.fill(v);
  return a;
}

describe("motionRatio — diff de luminância", () => {
  it("frames IDÊNTICOS → ratio 0 (cena estática)", () => {
    const a = solid(64 * 48, 100);
    const b = solid(64 * 48, 100);
    expect(motionRatio(a, b).ratio).toBe(0);
  });

  it("frame TODO diferente (delta > pixelDelta) → ratio 1", () => {
    const a = solid(16, 0);
    const b = solid(16, 200); // 200 > 22
    const m = motionRatio(a, b);
    expect(m.changed).toBe(16);
    expect(m.total).toBe(16);
    expect(m.ratio).toBe(1);
  });

  it("delta ABAIXO do limiar não conta como mudança", () => {
    const a = solid(10, 100);
    const b = solid(10, 100 + PIXEL_DELTA); // == limiar → NÃO conta (usa > estrito)
    expect(motionRatio(a, b).ratio).toBe(0);
    const c = solid(10, 100 + PIXEL_DELTA + 1); // 1 acima → conta
    expect(motionRatio(a, c).ratio).toBe(1);
  });

  it("mudança PARCIAL → ratio proporcional", () => {
    const a = solid(4, 0);
    const b = Uint8Array.from([0, 0, 200, 200]); // 2/4 mudaram
    expect(motionRatio(a, b).ratio).toBeCloseTo(0.5, 6);
  });

  it("comprimentos diferentes / nulos → ratio 0 (defensivo, sem baseline)", () => {
    expect(motionRatio(solid(4, 0), solid(5, 0)).ratio).toBe(0);
    expect(motionRatio(null, solid(4, 0)).ratio).toBe(0);
    expect(motionRatio(solid(4, 0), null).ratio).toBe(0);
  });

  it("máscara de IGNORE exclui os pixels de hotspot do ratio", () => {
    const a = solid(4, 0);
    const b = Uint8Array.from([200, 200, 0, 0]); // os 2 que mudaram estão mascarados
    const ignore = Uint8Array.from([1, 1, 0, 0]);
    const m = motionRatio(a, b, ignore);
    expect(m.total).toBe(2); // só os 2 não-mascarados contam
    expect(m.changed).toBe(0);
    expect(m.ratio).toBe(0);
  });
});

describe("buildIgnoreMask — rasteriza zonas de exclusão no thumbnail", () => {
  it("sem retângulos → null (caminho rápido)", () => {
    expect(buildIgnoreMask(64, 48, [])).toBeNull();
    expect(buildIgnoreMask(64, 48, null)).toBeNull();
  });

  it("um retângulo no quadrante superior-esquerdo marca só a sua região", () => {
    const w = 10;
    const h = 10;
    const m = buildIgnoreMask(w, h, [{ x: 0, y: 0, w: 0.5, h: 0.5 }]);
    expect(m).not.toBeNull();
    expect(m[0]).toBe(1); // canto superior-esquerdo → dentro
    expect(m[w * h - 1]).toBe(0); // canto inferior-direito → fora
    // total marcado ≈ metade × metade da grade
    const marked = m.reduce((a, v) => a + v, 0);
    expect(marked).toBeGreaterThan(0);
    expect(marked).toBeLessThan(w * h);
  });

  it("retângulo cobrindo o frame inteiro marca tudo", () => {
    const m = buildIgnoreMask(8, 8, [{ x: 0, y: 0, w: 1, h: 1 }]);
    expect(m.every((v) => v === 1)).toBe(true);
  });
});

describe("gateDecision — pula estático, roda movimento/probe/baseline", () => {
  const THR = 0.005;
  const PROBE = 6000;

  it("BASELINE: sem frame anterior → SEMPRE roda (nunca-cego no 1º frame)", () => {
    const d = gateDecision({ ratio: 0, sinceMs: 0, threshold: THR, probeMs: PROBE, hasPrev: false });
    expect(d.infer).toBe(true);
    expect(d.reason).toBe("baseline");
  });

  it("cena ESTÁTICA dentro do piso → PULA", () => {
    const d = gateDecision({ ratio: 0, sinceMs: 1000, threshold: THR, probeMs: PROBE });
    expect(d.infer).toBe(false);
    expect(d.reason).toBe("skip");
  });

  it("MOVIMENTO acima do limiar → roda (reason 'motion')", () => {
    const d = gateDecision({ ratio: 0.02, sinceMs: 100, threshold: THR, probeMs: PROBE });
    expect(d.infer).toBe(true);
    expect(d.reason).toBe("motion");
  });

  it("ratio == limiar → roda (corte inclusivo, a favor do nunca-cego)", () => {
    const d = gateDecision({ ratio: THR, sinceMs: 100, threshold: THR, probeMs: PROBE });
    expect(d.infer).toBe(true);
    expect(d.reason).toBe("motion");
  });

  it("PROBE: estático MAS sinceMs ≥ piso → roda (reason 'probe')", () => {
    const d = gateDecision({ ratio: 0, sinceMs: PROBE, threshold: THR, probeMs: PROBE });
    expect(d.infer).toBe(true);
    expect(d.reason).toBe("probe");
  });

  it("NUNCA fica abaixo do piso: logo antes do probe pula, no probe roda", () => {
    expect(gateDecision({ ratio: 0, sinceMs: PROBE - 1, threshold: THR, probeMs: PROBE }).infer).toBe(
      false,
    );
    expect(gateDecision({ ratio: 0, sinceMs: PROBE, threshold: THR, probeMs: PROBE }).infer).toBe(true);
  });

  it("piso de FOCO menor faz a câmera focada rodar antes que a normal", () => {
    const focusProbe = 2000;
    // Estática há 3s: focada (piso 2s) roda; normal (piso 6s) ainda pula.
    expect(gateDecision({ ratio: 0, sinceMs: 3000, threshold: THR, probeMs: focusProbe }).infer).toBe(
      true,
    );
    expect(gateDecision({ ratio: 0, sinceMs: 3000, threshold: THR, probeMs: 6000 }).infer).toBe(false);
  });
});
