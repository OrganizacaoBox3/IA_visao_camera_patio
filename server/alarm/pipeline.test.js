// Teste do pipeline de alarme (alarm/pipeline.js): decisão REAL (alarmPolicy) + canais/
// persistência/broadcast como FAKES — exercita o caminho crítico de notificação sem socket.
// Mesmo isolamento do alarmPolicy.test.js: ALARM_SHELVES_FILE aponta p/ tmp ANTES do require;
// tempo fixado com fake timers (Date.now() é usado por evaluate/dedup).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const SHELVES_FILE = path.join(os.tmpdir(), `alarm-shelves-pipe-${process.pid}-${Date.now()}.json`);
process.env.ALARM_SHELVES_FILE = SHELVES_FILE;

const pipeline = require("./pipeline");
const policy = require("../alarmPolicy");

const BASE = 1_700_000_000_000;

// Fakes de canais/persistência/broadcast — capturam chamadas p/ asserção.
// io.of("/").sockets: RBAC com escopo (socket-scope.emitScopedByCamera) itera os sockets da
// sala "dashboards" e emite POR SOCKET, não mais broadcast único — o fake tem 1 socket de
// EQUIPE (papel != "cliente" → users.canSeeCamera sempre true, recebe tudo, como antes).
function makeFakes({ recordFails = false } = {}) {
  const calls = { notify: [], dispatchAlert: [], record: [], emitted: [] };
  const fakeSocket = {
    data: { user: { id: "s1", papel: "superadmin" } },
    rooms: new Set(["dashboards"]),
    emit: (ev, payload) => calls.emitted.push({ ev, payload }),
  };
  const io = {
    to: (room) => ({ emit: (ev, payload) => calls.emitted.push({ room, ev, payload }) }),
    of: () => ({ sockets: new Map([["s1", fakeSocket]]) }),
  };
  const deps = {
    notify: (d) => calls.notify.push(d),
    dispatchAlert: (text, ts, priority) => calls.dispatchAlert.push({ text, ts, priority }),
    record: async (e) => {
      if (recordFails) throw new Error("pg indisponível");
      calls.record.push(e);
      return { id: "ev1", state: "new", ...e };
    },
  };
  return { calls, io, deps };
}

beforeEach(() => {
  const s = policy._state;
  s.dedup.clear();
  s.floodWin.clear();
  s.floodState.clear();
  s.shelved.clear();
  s.flap.clear();
  s.emitLog.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(BASE);
});

afterAll(() => {
  vi.useRealTimers();
  try {
    fs.unlinkSync(SHELVES_FILE);
  } catch {
    /* pode não existir */
  }
  try {
    fs.unlinkSync(`${SHELVES_FILE}.tmp`);
  } catch {
    /* idem */
  }
});

describe("handleAlert — decisão → canais → persistência → broadcast", () => {
  it("alerta suprimido pela política não toca canal nenhum", async () => {
    const { calls, io, deps } = makeFakes();
    const ev = await pipeline.handleAlert({ text: "" }, { cameras: new Map(), io }, deps);
    expect(ev).toBeNull();
    expect(calls.notify.length).toBe(0);
    expect(calls.dispatchAlert.length).toBe(0);
    expect(calls.record.length).toBe(0);
    expect(calls.emitted.length).toBe(0);
  });

  it("alerta aprovado percorre o pipeline inteiro com a MESMA decisão", async () => {
    const { calls, io, deps } = makeFakes();
    const cameras = new Map([["cam-1", { id: "cam-1", label: "Doca 1" }]]);
    const p = { text: "Zona parada há 20min", cameraId: "cam-1", zona: "doca", ts: BASE };
    const ev = await pipeline.handleAlert(p, { cameras, io }, deps);

    // canais recebem a decisão da política (priority "high" — regex de parada)
    expect(calls.notify.length).toBe(1);
    expect(calls.notify[0].priority).toBe("high");
    expect(calls.dispatchAlert).toEqual([
      { text: "Zona parada há 20min", ts: BASE, priority: "high" },
    ]);
    // persistência SÓ com metadados, cameraLabel resolvido do Map
    expect(calls.record.length).toBe(1);
    expect(calls.record[0]).toMatchObject({
      ts: BASE,
      cameraId: "cam-1",
      cameraLabel: "Doca 1",
      zona: "doca",
      priority: "high",
      text: "Zona parada há 20min",
    });
    // broadcast do evento gravado aos painéis (por socket, escopado por câmera — ver makeFakes)
    expect(calls.emitted).toEqual([{ ev: "alarm-event", payload: ev }]);
    expect(ev).toMatchObject({ id: "ev1", cameraId: "cam-1" });
  });

  it("dedup mora na POLÍTICA: repetição na janela não alcança canal nenhum", async () => {
    const { calls, io, deps } = makeFakes();
    const cameras = new Map();
    const p = { text: "Painel: repetida", ts: BASE };
    expect(await pipeline.handleAlert(p, { cameras, io }, deps)).not.toBeNull();
    expect(await pipeline.handleAlert({ ...p }, { cameras, io }, deps)).toBeNull();
    expect(calls.notify.length).toBe(1);
    expect(calls.dispatchAlert.length).toBe(1);
    expect(calls.record.length).toBe(1);
    expect(calls.emitted.length).toBe(1);
  });

  it("falha de persistência é engolida (não derruba o handler) e nada é emitido", async () => {
    const { calls, io, deps } = makeFakes({ recordFails: true });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const ev = await pipeline.handleAlert(
      { text: "Painel: falha de pg", ts: BASE },
      { cameras: new Map(), io },
      deps,
    );
    expect(ev).toBeNull();
    expect(calls.emitted.length).toBe(0);
    // canais AINDA notificam (a persistência falhar não pode silenciar o Andon/WhatsApp)
    expect(calls.notify.length).toBe(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
