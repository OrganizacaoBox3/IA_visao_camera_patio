// Testes do shed por audiência (server/shed.js) — em especial a INVARIANTE ADR-009:
// "análise conta como espectador" aplicada no PONTO DE DECISÃO (shedCamera), nos DOIS ramos
// (RTSP e webcam). Sem ela, o shed mataria à noite o stream que o motor 24/7 consome.
// Tempo determinístico via fake timers (idleSince/debounce usam Date.now()).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createShed } = require("./shed");

const BASE = 1_700_000_000_000;
const IDLE_MS = 60_000; // default SHED_IDLE_MS (lido no require do módulo)

function makeHub({ analysisViewer } = {}) {
  const rooms = new Map(); // room -> Set(socketIds) — espelho de io.sockets.adapter.rooms
  const io = { sockets: { adapter: { rooms } } };
  const cameras = new Map([
    ["w1", { id: "w1", label: "Webcam 1" }], // kind ausente = webcam (browser)
    ["r1", { id: "r1", label: "RTSP 1", kind: "rtsp" }],
  ]);
  const camSocket = { emit: vi.fn() };
  const socketById = new Map([["w1", camSocket]]);
  const rtsp = { idleSource: vi.fn(), wakeSource: vi.fn() };
  const shed = createShed({ io, cameras, socketById, rtsp, analysisViewer });
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

describe("shed sem análise (comportamento base)", () => {
  it("sem espectador por SHED_IDLE_MS: webcam rebaixada e RTSP pausada", () => {
    const { shed, camSocket, rtsp } = makeHub();
    active = shed;
    elapseIdle(shed);
    expect(camSocket.emit).toHaveBeenCalledWith("capture", { fps: 2 }); // SHED_WEBCAM_FPS
    expect(rtsp.idleSource).toHaveBeenCalledWith("r1");
  });

  it("dentro do debounce (antes de SHED_IDLE_MS) nada é rebaixado", () => {
    const { shed, camSocket, rtsp } = makeHub();
    active = shed;
    shed.sweepShed();
    vi.setSystemTime(BASE + IDLE_MS - 1);
    shed.sweepShed();
    expect(camSocket.emit).not.toHaveBeenCalled();
    expect(rtsp.idleSource).not.toHaveBeenCalled();
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

describe("INVARIANTE ADR-009 — análise conta como espectador (os DOIS ramos)", () => {
  it("webcam analisada NUNCA recebe capture de rebaixamento, mesmo sem espectador", () => {
    const { shed, camSocket } = makeHub({ analysisViewer: () => true });
    active = shed;
    elapseIdle(shed);
    vi.setSystemTime(BASE + 10 * IDLE_MS);
    shed.sweepShed(); // muito além do debounce — segue protegida
    expect(camSocket.emit).not.toHaveBeenCalled();
  });

  it("RTSP analisada NUNCA é pausada (idleSource não é chamado), mesmo sem espectador", () => {
    const { shed, rtsp } = makeHub({ analysisViewer: () => true });
    active = shed;
    elapseIdle(shed);
    expect(rtsp.idleSource).not.toHaveBeenCalled();
  });

  it("o predicado decide POR câmera: só a analisada é poupada", () => {
    const { shed, camSocket, rtsp } = makeHub({ analysisViewer: (id) => id === "w1" });
    active = shed;
    elapseIdle(shed);
    expect(camSocket.emit).not.toHaveBeenCalled(); // w1 (webcam) analisada → protegida
    expect(rtsp.idleSource).toHaveBeenCalledWith("r1"); // r1 sem análise → shed normal
  });
});
