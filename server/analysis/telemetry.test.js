// Testes da montagem do /api/analysis/status (telemetry.js) — o shape é CONTRATO
// ADITIVO consumido pelo front/diagnóstico: aqui congelamos os campos existentes
// e a agregação por câmera (fps real, dets1m, poda do gateLog, auto-máscara).
// vitest é ESM; o módulo sob teste é CommonJS → createRequire (padrão da pasta).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildStatus } = require("./telemetry");
const { createAutoMask, AM_COLS, AM_ROWS, AUTOMASK_MODE } = require("./automask");
const { createInflightSlots } = require("./inflight");

const NOW = 100_000;

// slots com N inferências em voo (p/ o campo `queue` do status).
const slotsWith = (n = 0) => {
  const s = createInflightSlots();
  for (let i = 1; i <= n; i++) s.begin(i);
  return s;
};

function fakeSt(over = {}) {
  return {
    slots: createInflightSlots(),
    latest: null,
    rounds: [],
    detsLog: [],
    gateLog: [],
    skipped: 0,
    motionRatio: 0,
    lastMs: 0,
    longRange: false,
    fadiga: false,
    source: "relay",
    autoMask: null,
    ...over,
  };
}

// Uma rodada GATEADA como engine.recordGateRound a grava. `infer` deriva do motivo
// (só "skip" não roda) — assim o teste não pode inventar um par (infer,reason) que o
// engine nunca produziria.
const round = (t, reason, ratio = 0, moving = 0) => ({
  t,
  ratio,
  infer: reason !== "skip",
  reason,
  moving,
});
// Bloco `gate` de uma câmera sem NENHUMA rodada na janela (zero-fill declarado).
const GATE_ZERO = {
  skipMoving1m: 0,
  ratioP50: 0,
  ratioP95: 0,
  reasons1m: { baseline: 0, motion: 0, probe: 0, skip: 0 },
};

function snapWith(states, over = {}) {
  return {
    now: NOW,
    states,
    focusedCams: new Set(),
    targetFpsOf: () => 1,
    enabled: true,
    modelFile: "dfine_s_obj2coco.onnx",
    fps: { normal: 1, line: 2, focus: 6 },
    motionGate: { enabled: true, ratio: 0.005, probeMs: 6000, probeFocusMs: 2000, thumb: "64x48" },
    autoscale: { mode: "auto", tier: "s", pin: null, choked: 0, idle: 0, lastSwitchAt: 0 },
    worker: { ready: true, size: 2 },
    go2rtcPull: { active: false, mode: "relay-less", streams: 0 },
    ...over,
  };
}

describe("buildStatus — shape global (contrato aditivo do /api/analysis/status)", () => {
  it("expõe os campos existentes com os valores do snapshot", () => {
    const s = buildStatus(snapWith(new Map()));
    expect(s.enabled).toBe(true);
    expect(s.model).toBe("dfine_s_obj2coco.onnx");
    expect(s.targetFps).toBe(1);
    expect(s.lineFps).toBe(2);
    expect(s.focusFps).toBe(6);
    expect(s.focused).toEqual([]);
    expect(s.autoMask).toEqual({ mode: AUTOMASK_MODE });
    expect(s.motionGate).toEqual({
      enabled: true,
      ratio: 0.005,
      probeMs: 6000,
      probeFocusMs: 2000,
      thumb: "64x48",
      skipped1m: 0,
      skippedTotal: 0,
    });
    expect(s.autoscale).toEqual({ mode: "auto", tier: "s", pin: null, choked: 0, idle: 0, lastSwitchAt: 0 });
    expect(s.worker).toEqual({ ready: true, size: 2 });
    expect(s.go2rtcPull).toEqual({ active: false, mode: "relay-less", streams: 0 });
    expect(s.perCamera).toEqual({});
  });

  it("focused reflete a união de câmeras focadas (ids em array)", () => {
    const s = buildStatus(snapWith(new Map(), { focusedCams: new Set(["cam2"]) }));
    expect(s.focused).toEqual(["cam2"]);
  });
});

describe("buildStatus — agregação por câmera", () => {
  it("fps real (rounds/60), dets1m/excluded1m somados do detsLog, queue e flags", () => {
    const st = fakeSt({
      rounds: [95_000, 96_000, 97_000, 98_000, 99_000, 99_500], // 6 rodadas → 0.1 fps
      detsLog: [
        { t: 95_000, n: 2, x: 1, a: 0 },
        { t: 96_000, n: 3, x: 0, a: 0 },
      ],
      slots: slotsWith(1), // 1 inferência em voo
      latest: { buf: Buffer.alloc(0), ts: 99_000 },
      motionRatio: 0.12345,
      lastMs: 380,
      longRange: true,
      source: "go2rtc",
    });
    const s = buildStatus(snapWith(new Map([["cam1", st]]), { focusedCams: new Set(["cam1"]) }));
    expect(s.perCamera.cam1).toEqual({
      fps: 0.1,
      targetFps: 1,
      focused: true,
      queue: 2, // 1 em voo + latest pendente
      skipped1m: 0,
      skippedTotal: 0,
      motion: 0.1235, // arredondado a 4 casas
      lastMs: 380,
      // IDADE DO QUADRO (aditivo, 2026-08-16): `null` porque este estado não tem ageLog — e
      // `null` é o valor CERTO para "não medi nada na janela". Se um dia virar 0 aqui, é
      // regressão: ausência de medição passando por medição de zero é o falso-OK da casa.
      frameAge: null,
      dets1m: 5,
      excluded1m: 1,
      longRange: true,
      fadiga: false,
      source: "go2rtc",
      gate: GATE_ZERO, // bloco ADITIVO do sensor do gate (sem rodadas na janela)
    });
  });

  it("poda o gateLog além de 60s (mutação deliberada) e agrega skipped no motionGate", () => {
    const gateLog = [round(30_000, "skip"), round(50_000, "skip"), round(90_000, "skip")]; // cutoff = 40_000
    const st = fakeSt({ gateLog, skipped: 7 });
    const s = buildStatus(snapWith(new Map([["cam1", st]])));
    expect(st.gateLog.map((g) => g.t)).toEqual([50_000, 90_000]); // 30_000 podado NO estado
    expect(s.perCamera.cam1.skipped1m).toBe(2);
    expect(s.perCamera.cam1.skippedTotal).toBe(7);
    expect(s.motionGate.skipped1m).toBe(2); // agregado de todas as câmeras
    expect(s.motionGate.skippedTotal).toBe(7);
  });

  it("estado SEM gateLog (parcial/legado) não derruba o /status — leitura defensiva", () => {
    const st = fakeSt({ gateLog: undefined, skipped: 3 });
    const s = buildStatus(snapWith(new Map([["cam1", st]])));
    expect(s.perCamera.cam1.skipped1m).toBe(0);
    expect(s.perCamera.cam1.gate).toEqual(GATE_ZERO);
    expect(s.perCamera.cam1.skippedTotal).toBe(3); // acumulado do boot é independente da janela
  });
});

// ── O SENSOR DO GATE (frente C) ──────────────────────────────────────────────
// A PERGUNTA QUE ISTO EXISTE PARA RESPONDER: "o gate de movimento está me cegando?".
// `skipped1m` só media o CUSTO economizado — pulo em cena parada e pulo com uma pessoa
// distante andando (poucas células mudadas no thumbnail 64×48, abaixo do limiar) iam
// no MESMO balde. `gate.skipMoving1m` separa: pulo com ≥1 track vivo NÃO estacionário
// é cegueira MEDIDA. Nenhum limiar muda aqui — medir vem antes de mexer.
describe("perCamera[].gate — cegueira do gate medida, não presumida", () => {
  it("pulo COM gente se movendo conta em skipMoving1m; pulo com a cena vazia NÃO", () => {
    const st = fakeSt({
      gateLog: [
        round(70_000, "skip", 0.001, 2), // pulou com 2 pessoas em movimento → CEGUEIRA
        round(71_000, "skip", 0.002, 0), // pulou com a cena vazia → economia legítima
        round(72_000, "skip", 0.001, 1), // pulou com 1 pessoa em movimento → CEGUEIRA
        round(73_000, "motion", 0.02, 3), // rodou (não é pulo — não entra no skipMoving)
      ],
    });
    const g = buildStatus(snapWith(new Map([["cam1", st]]))).perCamera.cam1;
    expect(g.gate.skipMoving1m).toBe(2);
    expect(g.skipped1m).toBe(3); // os 3 pulos seguem contados como CUSTO, como antes
  });

  it("moving=0 em TODOS os pulos → skipMoving1m 0 (o gate não está cegando esta câmera)", () => {
    const st = fakeSt({ gateLog: [round(70_000, "skip", 0.0), round(71_000, "skip", 0.001)] });
    const g = buildStatus(snapWith(new Map([["cam1", st]]))).perCamera.cam1;
    expect(g.gate.skipMoving1m).toBe(0);
    expect(g.skipped1m).toBe(2);
  });

  it("track parado NÃO é cegueira: moving já vem líquido de estacionários (engine.movingOf)", () => {
    // Contrato com o engine: `moving` é alive-estacionários NO INSTANTE da decisão.
    // Pessoa parada em quadro com a cena estática é exatamente o caso que o gate
    // existe p/ pular (e o coasting cobre) — não pode inflar a cegueira.
    const st = fakeSt({ gateLog: [round(70_000, "skip", 0.0004, 0)] });
    expect(buildStatus(snapWith(new Map([["cam1", st]]))).perCamera.cam1.gate.skipMoving1m).toBe(0);
  });

  it("ratioP50/P95 por nearest-rank sobre a janela, arredondados a 4 casas", () => {
    // 10 ratios 0.001..0.010 → P50 = 5º (0.005), P95 = 10º (0.010).
    const gateLog = Array.from({ length: 10 }, (_, i) =>
      round(70_000 + i, i < 5 ? "skip" : "motion", (i + 1) / 1000),
    );
    const g = buildStatus(snapWith(new Map([["cam1", fakeSt({ gateLog })]]))).perCamera.cam1;
    expect(g.gate.ratioP50).toBe(0.005);
    expect(g.gate.ratioP95).toBe(0.01);
  });

  it("percentil arredonda a 4 casas (ratio cru de 6 casas não vaza)", () => {
    const st = fakeSt({ gateLog: [round(70_000, "motion", 0.0123456)] });
    const g = buildStatus(snapWith(new Map([["cam1", st]]))).perCamera.cam1;
    expect(g.gate.ratioP50).toBe(0.0123);
    expect(g.gate.ratioP95).toBe(0.0123); // amostra única: os dois percentis são ela
  });

  it("rodada NÃO MEDIDA (decode-error/gate-off) fica FORA do percentil, mas conta em reasons1m", () => {
    // O engine grava ratio=0 quando não houve medição. Se esses zeros entrassem no
    // percentil, puxariam P50/P95 PARA BAIXO — justamente o número que se leria p/
    // decidir o limiar (mediria o instrumento, não a cena).
    const gateLog = [
      round(70_000, "motion", 0.02),
      round(71_000, "decode-error", 0), // fail-open: rodou sem medir
      round(72_000, "gate-off", 0), // gate desligado: nem decode houve
      round(73_000, "motion", 0.04),
    ];
    const g = buildStatus(snapWith(new Map([["cam1", fakeSt({ gateLog })]]))).perCamera.cam1;
    expect(g.gate.ratioP50).toBe(0.02); // só os 2 medidos entram
    expect(g.gate.ratioP95).toBe(0.04);
    expect(g.gate.reasons1m).toEqual({
      baseline: 0,
      motion: 2,
      probe: 0,
      skip: 0,
      "decode-error": 1, // motivos raros entram ADITIVAMENTE (nada se perde)
      "gate-off": 1,
    });
  });

  it("reasons1m diz POR QUE cada rodada rodou; a soma é o total de rodadas gateadas", () => {
    const gateLog = [
      round(70_000, "baseline"),
      round(71_000, "motion", 0.03),
      round(72_000, "probe", 0.001),
      round(73_000, "skip", 0.001),
      round(74_000, "skip", 0.002),
    ];
    const g = buildStatus(snapWith(new Map([["cam1", fakeSt({ gateLog })]]))).perCamera.cam1;
    expect(g.gate.reasons1m).toEqual({ baseline: 1, motion: 1, probe: 1, skip: 2 });
    const total = Object.values(g.gate.reasons1m).reduce((a, b) => a + b, 0);
    expect(total).toBe(gateLog.length);
    expect(g.skipped1m).toBe(g.gate.reasons1m.skip); // pulo == reason "skip", sem terceira via
  });

  it("CONTRATO ADITIVO: todo campo ANTIGO de perCamera segue presente e com o mesmo valor", () => {
    // O bloco `gate` é ACRÉSCIMO. Se algum campo que o front/diagnóstico já lê sumir
    // ou mudar de semântica, este teste cai — é o gate do contrato, não decoração.
    const st = fakeSt({
      rounds: [95_000, 96_000],
      detsLog: [{ t: 95_000, n: 2, x: 1, a: 0 }],
      gateLog: [round(70_000, "skip", 0.001, 4), round(71_000, "motion", 0.03, 4)],
      skipped: 9,
      motionRatio: 0.03,
      lastMs: 120,
    });
    const cam = buildStatus(snapWith(new Map([["cam1", st]]))).perCamera.cam1;
    for (const k of [
      "fps",
      "targetFps",
      "focused",
      "queue",
      "skipped1m",
      "skippedTotal",
      "motion",
      "lastMs",
      "dets1m",
      "excluded1m",
      "longRange",
      "fadiga",
      "source",
    ])
      expect(cam).toHaveProperty(k);
    expect(cam.skipped1m).toBe(1); // MESMA semântica de antes: pulos na janela de 60s
    expect(cam.skippedTotal).toBe(9); // acumulado do boot, intocado
    expect(cam.motion).toBe(0.03); // último ratio, intocado
    expect(cam.gate.skipMoving1m).toBe(1); // e o campo novo ao lado, sem tocar nos velhos
  });
});

describe("buildStatus — agregação por câmera (auto-máscara e tracker)", () => {
  it("câmera COM auto-máscara ganha automasked1m + autoMask (rects via automask.statusOf)", () => {
    const am = createAutoMask();
    const cell = 9 * AM_COLS + 12;
    am.suggestions = [{ cell, presentPct: 1, jitter: 0 }];
    am.suppressed = new Set([cell]);
    const st = fakeSt({ autoMask: am, detsLog: [{ t: 95_000, n: 0, x: 0, a: 4 }] });
    const s = buildStatus(snapWith(new Map([["cam1", st]])));
    expect(s.perCamera.cam1.automasked1m).toBe(4);
    expect(s.perCamera.cam1.autoMask.mode).toBe(AUTOMASK_MODE);
    expect(s.perCamera.cam1.autoMask.suggestions[0]).toMatchObject({
      x: 12 / AM_COLS,
      y: 9 / AM_ROWS,
      w: 1 / AM_COLS,
      h: 1 / AM_ROWS,
    });
  });

  it("câmera SEM auto-máscara não expõe os campos de auto-máscara (aditivo)", () => {
    const s = buildStatus(snapWith(new Map([["cam1", fakeSt()]])));
    expect(s.perCamera.cam1).not.toHaveProperty("autoMask");
    expect(s.perCamera.cam1).not.toHaveProperty("automasked1m");
  });

  it("câmera COM tracker.stats expõe tracker { reassoc1m, reassocTotal, lost }; sem, não (aditivo)", () => {
    const st = fakeSt({
      detsLog: [
        { t: 95_000, n: 1, x: 0, a: 0, r: 2 }, // rodada com 2 re-associações (salto recuperado)
        { t: 96_000, n: 1, x: 0, a: 0 }, // rodada sem o campo (retrocompatível)
      ],
      tracker: { stats: () => ({ reassociations: 7, lost: 1 }) },
    });
    const s = buildStatus(snapWith(new Map([["cam1", st]])));
    expect(s.perCamera.cam1.tracker).toEqual({ reassoc1m: 2, reassocTotal: 7, lost: 1 });
    const s2 = buildStatus(snapWith(new Map([["cam2", fakeSt()]])));
    expect(s2.perCamera.cam2).not.toHaveProperty("tracker");
  });
});
