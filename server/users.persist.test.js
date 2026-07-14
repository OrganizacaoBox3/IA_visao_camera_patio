// GATE ANTI-"PERSISTÊNCIA FALSA" no store de usuários (users.js) — sem Postgres (fallback JSON).
// Se a escrita durável falha (PG fora OU disco), a criação/edição/remoção NÃO pode ficar só em
// memória (mudaria a tela e reverteria no restart). Aplica-se o conserto de shifts.js: durável-
// primeiro com rollback + status 503; TODA a validação/RBAC/invariante de superadmin é preservada.
//
// O writeFileSync é mockado como NO-OP durante todo o arquivo (nunca toca o users.json real do dev);
// para simular a falha, o próximo write lança uma vez (failNext).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const users = require("./users");

let writeSpy;
beforeEach(() => {
  writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {}); // no-op: nunca grava de verdade
});
afterEach(() => {
  writeSpy.mockRestore();
});
const failNext = () =>
  writeSpy.mockImplementationOnce(() => {
    throw new Error("SIMULADO: disco cheio");
  });

describe("users — persistência atômica (durável-primeiro, com rollback)", () => {
  it("createUser: escrita falha → memória INTOCADA + 503", async () => {
    const antes = users.all().length;
    failNext();
    const r = await users.createUser({ usuario: "ghost", senha: "x", papel: "usuario" });
    expect(r.status).toBe(503);
    expect(users.all().length).toBe(antes);
    expect(users.all().some((u) => u.usuario === "ghost")).toBe(false);
  });

  it("updateUser: escrita falha → ROLLBACK do papel + 503 (invariante de superadmin intacta)", async () => {
    await users.createUser({ usuario: "boss", senha: "x", papel: "superadmin" });
    const op = await users.createUser({ usuario: "op1", senha: "x", papel: "usuario" });
    failNext();
    const bad = await users.updateUser(op.user.id, { papel: "engenheiro" });
    expect(bad.status).toBe(503);
    expect(users.getById(op.user.id).papel).toBe("usuario"); // rollback: papel não mudou
  });

  it("removeUser: escrita falha → o usuário PERMANECE (rollback) + 503", async () => {
    await users.createUser({ usuario: "boss2", senha: "x", papel: "superadmin" });
    const op = await users.createUser({ usuario: "op2", senha: "x", papel: "usuario" });
    failNext();
    const bad = await users.removeUser(op.user.id);
    expect(bad.status).toBe(503);
    expect(users.getById(op.user.id)).toBeTruthy(); // ainda lá
  });

  it("updateProfile: escrita falha → ROLLBACK das preferências + 503", async () => {
    const op = await users.createUser({ usuario: "op3", senha: "x", papel: "usuario" });
    failNext();
    const bad = await users.updateProfile(op.user.id, { whatsapp: "5584999990000" });
    expect(bad.status).toBe(503);
    expect(users.getById(op.user.id).whatsapp).toBe(""); // rollback: perfil intocado
  });
});
