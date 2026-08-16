// Idade do quadro no /api/analysis/status — o sensor que separa "o modelo está ruim" de "a rede
// está ruim". O que estes testes protegem, em ordem de importância:
//   1. o campo é ADITIVO (nenhum campo existente do contrato mudou de shape);
//   2. `null` quando nada foi medido — ausência de dado NÃO pode virar "idade 0", que é o
//      falso-OK que a casa mais teme (CLAUDE.md: sucesso sem efeito mata o dado em silêncio);
//   3. `trend` detecta FILA (fenômeno cumulativo, invisível na mediana).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão de bytetrack.test.js).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildStatus } = require("./telemetry");

/** Snapshot mínimo do engine — só o que o buildStatus lê. */
function snapCom(ageLog) {
  const st = {
    rounds: [],
    slots: { count: () => 0 },
    latest: null,
    skipped: 0,
    motionRatio: 0,
    lastMs: 42,
    detsLog: [],
    gateLog: [],
    ageLog,
    longRange: false,
    fadiga: false,
    source: "relay",
  };
  return {
    now: 100_000,
    states: new Map([["cam-1", st]]),
    focusedCams: new Set(),
    targetFpsOf: () => 1,
    enabled: true,
    modelFile: "dfine_s_obj2coco.onnx",
    fps: { normal: 1, line: 2, focus: 6 },
    motionGate: { enabled: true, ratio: 0.005, probeMs: 6000, probeFocusMs: 2000, thumb: "64x48" },
    autoscale: {},
    worker: {},
    go2rtcPull: null,
  };
}

/** n amostras dentro da janela, com as idades dadas. */
function log(idades, now = 100_000) {
  return idades.map((a, i) => ({ t: now - (idades.length - i) * 500, a }));
}

describe("frameAge no /api/analysis/status", () => {
  it("janela SEM medição devolve null — nunca 0 (ausência ≠ zero)", () => {
    const s = buildStatus(snapCom([]));
    expect(s.perCamera["cam-1"].frameAge).toBeNull();
  });

  it("p50 e p90 da janela, com a contagem de amostras", () => {
    const fa = buildStatus(snapCom(log([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]))).perCamera[
      "cam-1"
    ].frameAge;
    expect(fa.n).toBe(10);
    expect(fa.p50).toBe(50);
    expect(fa.p90).toBe(90);
  });

  it("idade estável não acusa tendência (latência constante ≠ fila)", () => {
    const fa = buildStatus(snapCom(log([80, 82, 79, 81, 80, 83, 78, 80, 81, 79]))).perCamera[
      "cam-1"
    ].frameAge;
    expect(Math.abs(fa.trend)).toBeLessThan(50);
  });

  it("idade CRESCENDO ao longo da janela vira trend positivo grande = FILA", () => {
    const fa = buildStatus(
      snapCom(log([50, 60, 70, 80, 900, 1400, 2000, 2600, 3200, 3800])),
    ).perCamera["cam-1"].frameAge;
    expect(fa.trend).toBeGreaterThanOrEqual(250);
  });

  it("amostras de menos não arriscam tendência (trend fica 0)", () => {
    const fa = buildStatus(snapCom(log([10, 5000, 9000]))).perCamera["cam-1"].frameAge;
    expect(fa.n).toBe(3);
    expect(fa.trend).toBe(0);
  });

  it("poda a janela: amostra de mais de 60s não entra na conta", () => {
    const now = 100_000;
    const velhas = [{ t: now - 120_000, a: 9999 }]; // fora da janela
    const novas = log([10, 12, 11, 13], now);
    const fa = buildStatus(snapCom([...velhas, ...novas])).perCamera["cam-1"].frameAge;
    expect(fa.n).toBe(4);
    expect(fa.p90).toBeLessThan(100); // a amostra velha não contaminou
  });

  it("é ADITIVO — os campos que já existiam continuam lá e com o mesmo shape", () => {
    const c = buildStatus(snapCom(log([10, 20]))).perCamera["cam-1"];
    expect(c).toMatchObject({ lastMs: 42, dets1m: 0, excluded1m: 0, fadiga: false });
    expect(typeof c.fps).toBe("number");
    expect(c.gate).toBeDefined();
  });

  it("estado antigo SEM ageLog não derruba o /status (leitura defensiva)", () => {
    const snap = snapCom([]);
    delete snap.states.get("cam-1").ageLog;
    expect(() => buildStatus(snap)).not.toThrow();
    expect(buildStatus(snap).perCamera["cam-1"].frameAge).toBeNull();
  });
});
