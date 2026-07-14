// GATE ANTI-"PERSISTÊNCIA FALSA" no store de eventos de alarme (events.js) — sem Postgres (JSON).
// Se a escrita durável falha, o alarme NÃO pode ficar só na fila em memória (some no restart).
// Conserto de shifts.js: durável-primeiro com rollback. `record` LANÇA (o pipeline já trata com
// .catch e não emite o evento); `ack`/`forward` devolvem 503 (a rota routes/alarms.js faz surface).
//
// writeFileSync mockado como NO-OP no arquivo todo (nunca toca o alarms.json real); failNext lança 1×.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const events = require("./events");

let writeSpy;
beforeEach(() => {
  writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
});
afterEach(() => {
  writeSpy.mockRestore();
});
const failNext = () =>
  writeSpy.mockImplementationOnce(() => {
    throw new Error("SIMULADO: disco cheio");
  });

describe("events — persistência atômica (durável-primeiro, com rollback)", () => {
  it("record: escrita falha → REJEITA e a fila fica INTOCADA (sem alarme-fantasma)", async () => {
    const antes = events.all().length;
    failNext();
    await expect(events.record({ text: "alarme fantasma", tipo: "atividade" })).rejects.toThrow();
    expect(events.all().length).toBe(antes);
  });

  it("ack: escrita falha → ROLLBACK do estado (segue 'new') + 503", async () => {
    const ev = await events.record({ text: "ack-me", tipo: "atividade" });
    expect(ev.state).toBe("new");
    failNext();
    const bad = await events.ack(ev.id, "op");
    expect(bad.status).toBe(503);
    expect(events.get(ev.id).state).toBe("new"); // rollback: não reconheceu
  });

  it("forward: escrita falha → ROLLBACK do estado (segue 'new') + 503", async () => {
    const ev = await events.record({ text: "fwd-me", tipo: "atividade" });
    failNext();
    const bad = await events.forward(ev.id, "op");
    expect(bad.status).toBe(503);
    expect(events.get(ev.id).state).toBe("new"); // rollback: não encaminhou
  });
});
