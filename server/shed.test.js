// Testes do shed por audiência (server/shed.js) — em especial a INVARIANTE ADR-009:
// "análise conta como espectador" aplicada no PONTO DE DECISÃO (shedCamera), nos DOIS ramos
// (RTSP e webcam). Desde o fps dinâmico (perf-round3 frente 1), a proteção RTSP mudou de
// forma sem mudar de essência: câmera analisada NUNCA vai a idle (nunca-cego), mas sem
// espectador HUMANO desce ao MODO VIGÍLIA (piso = max(2× cadência efetiva, 2)fps) e volta
// ao fps configurado quando ganha espectador ou foco. A decisão é PURA (decideRtspFps).
// Tempo determinístico via fake timers (idleSince/debounce usam Date.now()).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createShed, decideRtspFps } = require("./shed");

const BASE = 1_700_000_000_000;
const IDLE_MS = 60_000; // default SHED_IDLE_MS (lido no require do módulo)

function makeHub({ analysisViewer, effectiveFps, isFocused, rtspCfgFps = 10 } = {}) {
  const rooms = new Map(); // room -> Set(socketIds) — espelho de io.sockets.adapter.rooms
  const io = { sockets: { adapter: { rooms } } };
  const cameras = new Map([
    ["w1", { id: "w1", label: "Webcam 1" }], // kind ausente = webcam (browser)
    ["r1", { id: "r1", label: "RTSP 1", kind: "rtsp" }],
  ]);
  const camSocket = { emit: vi.fn() };
  const socketById = new Map([["w1", camSocket]]);
  const rtsp = {
    idleSource: vi.fn(),
    wakeSource: vi.fn(),
    vigilSource: vi.fn(),
    captureFps: vi.fn(() => rtspCfgFps),
  };
  const shed = createShed({ io, cameras, socketById, rtsp, analysisViewer, effectiveFps, isFocused });
  return { rooms, io, cameras, camSocket, socketById, rtsp, shed };
}

// Duas varreduras: a 1ª marca idleSince, a 2ª (após SHED_IDLE_MS) decide o rebaixamento.
function elapseIdle(shed) {
  shed.sweepShed();
  vi.setSystemTime(BASE + IDLE_MS);
  shed.sweepShed();
}

let active = null; // shed da vez — sempre parado no afterEach (timer interno de sweep)

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterEach(() => {
  if (active) active.stop();
  active = null;
  vi.useRealTimers();
});

describe("decideRtspFps — decisão PURA do fps-alvo do ingest (fps dinâmico, frente 1)", () => {
  it("com espectador: full no fps configurado, analisada ou não", () => {
    expect(decideRtspFps({ viewers: 1, focused: false, analyzed: true, effFps: 1, cfgFps: 10 }))
      .toEqual({ mode: "full", fps: 10 });
    expect(decideRtspFps({ viewers: 3, focused: false, analyzed: false, effFps: 0, cfgFps: 15 }))
      .toEqual({ mode: "full", fps: 15 });
  });

  it("focada sem espectador: full (foco conta como audiência)", () => {
    expect(decideRtspFps({ viewers: 0, focused: true, analyzed: true, effFps: 1, cfgFps: 10 }))
      .toEqual({ mode: "full", fps: 10 });
  });

  it("sem espectador e SEM análise: idle (semântica antiga do shed preservada)", () => {
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: false, effFps: 0, cfgFps: 10 }))
      .toEqual({ mode: "idle", fps: 0 });
  });

  it("vigília normal (cadência 1fps): piso 2fps — max(2×1, 2)", () => {
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: true, effFps: 1, cfgFps: 10 }))
      .toEqual({ mode: "vigil", fps: 2 });
  });

  it("vigília com tripwire (FPS_LINE=2): piso 4fps — 2× a cadência efetiva", () => {
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: true, effFps: 2, cfgFps: 10 }))
      .toEqual({ mode: "vigil", fps: 4 });
  });

  it("piso absoluto 2fps: cadência baixa (0.2fps) NÃO leva o ingest abaixo de 2fps (nunca-cego)", () => {
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: true, effFps: 0.2, cfgFps: 10 }))
      .toEqual({ mode: "vigil", fps: 2 });
  });

  it("piso ≥ fps configurado: fica full (reduzir não ganharia nada; ex.: foco 6fps → 12 ≥ 10)", () => {
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: true, effFps: 6, cfgFps: 10 }))
      .toEqual({ mode: "full", fps: 10 });
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: true, effFps: 2, cfgFps: 4 }))
      .toEqual({ mode: "full", fps: 4 });
  });

  it("insumo inválido cai no lado SEGURO: cfg desconhecido → 10; cadência inválida → 1 (piso 2)", () => {
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: true, effFps: NaN, cfgFps: null }))
      .toEqual({ mode: "vigil", fps: 2 });
    expect(decideRtspFps({ viewers: 0, focused: false, analyzed: true, effFps: 0, cfgFps: -1 }))
      .toEqual({ mode: "vigil", fps: 2 });
  });
});

describe("shed sem análise (comportamento base)", () => {
  it("sem espectador por SHED_IDLE_MS: webcam rebaixada e RTSP pausada", () => {
    const { shed, camSocket, rtsp } = makeHub();
    active = shed;
    elapseIdle(shed);
    expect(camSocket.emit).toHaveBeenCalledWith("capture", { fps: 2 }); // SHED_WEBCAM_FPS
    expect(rtsp.idleSource).toHaveBeenCalledWith("r1");
    expect(rtsp.vigilSource).not.toHaveBeenCalled(); // sem análise não há vigília
  });

  it("dentro do debounce (antes de SHED_IDLE_MS) nada é rebaixado", () => {
    const { shed, camSocket, rtsp } = makeHub();
    active = shed;
    shed.sweepShed();
    vi.setSystemTime(BASE + IDLE_MS - 1);
    shed.sweepShed();
    expect(camSocket.emit).not.toHaveBeenCalled();
    expect(rtsp.idleSource).not.toHaveBeenCalled();
    expect(rtsp.vigilSource).not.toHaveBeenCalled();
  });

  it("espectador religa: webcam volta ao perfil (default ou manual) e RTSP acorda", () => {
    const { shed, rooms, camSocket, rtsp } = makeHub();
    active = shed;
    elapseIdle(shed); // rebaixa os dois
    camSocket.emit.mockClear();
    rooms.set("cam:w1", new Set(["dash-a"]));
    rooms.set("cam:r1", new Set(["dash-a"]));
    shed.sweepShed();
    expect(camSocket.emit).toHaveBeenCalledWith("capture", { fps: 12 }); // WEBCAM_DEFAULT_FPS
    expect(rtsp.wakeSource).toHaveBeenCalledWith("r1");

    // com set-capture manual guardado, restaura O PERFIL DO OPERADOR, não o default
    rooms.clear();
    shed.setLastCapture("w1", { width: 1280, quality: 0.8, fps: 24 });
    vi.setSystemTime(BASE + 2 * IDLE_MS);
    shed.sweepShed();
    vi.setSystemTime(BASE + 3 * IDLE_MS);
    shed.sweepShed(); // rebaixa de novo
    camSocket.emit.mockClear();
    rooms.set("cam:w1", new Set(["dash-b"]));
    shed.sweepShed();
    expect(camSocket.emit).toHaveBeenCalledWith("capture", { width: 1280, quality: 0.8, fps: 24 });
  });
});

describe("INVARIANTE ADR-009 + fps dinâmico — análise segura o PISO, nunca fica cega", () => {
  it("webcam analisada NUNCA recebe capture de rebaixamento, mesmo sem espectador", () => {
    const { shed, camSocket } = makeHub({ analysisViewer: () => true });
    active = shed;
    elapseIdle(shed);
    vi.setSystemTime(BASE + 10 * IDLE_MS);
    shed.sweepShed(); // muito além do debounce — segue protegida
    expect(camSocket.emit).not.toHaveBeenCalled();
  });

  it("RTSP analisada NUNCA é pausada (idleSource não é chamado) — desce à VIGÍLIA @2fps", () => {
    const { shed, rtsp } = makeHub({ analysisViewer: () => true });
    active = shed;
    elapseIdle(shed);
    expect(rtsp.idleSource).not.toHaveBeenCalled();
    expect(rtsp.vigilSource).toHaveBeenCalledWith("r1", 2); // piso: max(2×1fps, 2) — effFps default 1
  });

  it("cadência efetiva com tripwire (2fps): vigília pede o piso 4fps", () => {
    const { shed, rtsp } = makeHub({ analysisViewer: () => true, effectiveFps: () => 2 });
    active = shed;
    elapseIdle(shed);
    expect(rtsp.vigilSource).toHaveBeenCalledWith("r1", 4);
  });

  it("cadência mudou DURANTE a vigília (ganhou linha): o sweep re-decide e pede o piso novo", () => {
    let eff = 1;
    const { shed, rtsp } = makeHub({ analysisViewer: () => true, effectiveFps: () => eff });
    active = shed;
    elapseIdle(shed);
    expect(rtsp.vigilSource).toHaveBeenLastCalledWith("r1", 2);
    eff = 2; // operador desenhou uma tripwire → FPS_LINE
    vi.setSystemTime(BASE + 2 * IDLE_MS);
    shed.sweepShed();
    expect(rtsp.vigilSource).toHaveBeenLastCalledWith("r1", 4); // vigilSource é idempotente por fps
  });

  it("espectador chega: wakeSource (fps cheio) imediato, sem debounce", () => {
    const { shed, rooms, rtsp } = makeHub({ analysisViewer: () => true });
    active = shed;
    elapseIdle(shed); // vigília
    rooms.set("cam:r1", new Set(["dash-a"]));
    shed.sweepShed();
    expect(rtsp.wakeSource).toHaveBeenCalledWith("r1");
  });

  it("câmera FOCADA: não desce à vigília e é restaurada mesmo sem room", () => {
    const { shed, rtsp } = makeHub({ analysisViewer: () => true, isFocused: (id) => id === "r1" });
    active = shed;
    elapseIdle(shed);
    expect(rtsp.vigilSource).not.toHaveBeenCalled(); // foco conta como audiência
    expect(rtsp.wakeSource).toHaveBeenCalledWith("r1"); // e mantém/retoma o fps cheio (idempotente)
  });

  it("fps configurado ≤ piso: NÃO entra em vigília (re-spawn não ganharia nada)", () => {
    const { shed, rtsp } = makeHub({ analysisViewer: () => true, rtspCfgFps: 2 });
    active = shed;
    elapseIdle(shed);
    expect(rtsp.vigilSource).not.toHaveBeenCalled();
    expect(rtsp.idleSource).not.toHaveBeenCalled(); // e MUITO menos idle (nunca-cego)
  });

  it("o predicado decide POR câmera: só a analisada é poupada", () => {
    const { shed, camSocket, rtsp } = makeHub({ analysisViewer: (id) => id === "w1" });
    active = shed;
    elapseIdle(shed);
    expect(camSocket.emit).not.toHaveBeenCalled(); // w1 (webcam) analisada → protegida
    expect(rtsp.idleSource).toHaveBeenCalledWith("r1"); // r1 sem análise → shed normal
  });
});
