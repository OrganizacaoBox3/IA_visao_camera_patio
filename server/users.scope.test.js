// RBAC com escopo (papel "cliente") — server/users.js. cameraIds sanitizado no create/update;
// canSeeCamera fail-closed (vazio/ausente = nenhuma câmera); demais papéis sempre veem tudo.
// writeFileSync mockado como NO-OP (mesmo padrão de users.persist.test.js): nunca toca o
// users.json real do dev.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const users = require("./users");

let writeSpy;
beforeEach(() => {
  writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
});
afterEach(() => {
  writeSpy.mockRestore();
});

describe("users — canSeeCamera (predicado puro)", () => {
  it("papel cliente com cameraIds vazio/ausente não vê NENHUMA câmera (fail-closed)", () => {
    expect(users.canSeeCamera({ papel: "cliente", cameraIds: [] }, "cam-1")).toBe(false);
    expect(users.canSeeCamera({ papel: "cliente" }, "cam-1")).toBe(false);
  });

  it("papel cliente só vê as câmeras da própria lista", () => {
    const u = { papel: "cliente", cameraIds: ["cam-1", "cam-2"] };
    expect(users.canSeeCamera(u, "cam-1")).toBe(true);
    expect(users.canSeeCamera(u, "cam-2")).toBe(true);
    expect(users.canSeeCamera(u, "cam-3")).toBe(false);
  });

  it("cameraId ausente (null/undefined) nunca casa para papel cliente", () => {
    const u = { papel: "cliente", cameraIds: ["cam-1"] };
    expect(users.canSeeCamera(u, null)).toBe(false);
    expect(users.canSeeCamera(u, undefined)).toBe(false);
  });

  it("papéis de equipe (superadmin/engenheiro/usuario) sempre veem tudo, mesmo sem cameraIds", () => {
    for (const papel of ["superadmin", "engenheiro", "usuario"]) {
      expect(users.canSeeCamera({ papel, cameraIds: [] }, "qualquer-camera")).toBe(true);
      expect(users.canSeeCamera({ papel }, "qualquer-camera")).toBe(true);
    }
  });

  it("user null/undefined: a função é PURA e não filtra por si só (quem chama já garantiu auth antes)", () => {
    expect(users.canSeeCamera(null, "cam-1")).toBe(true);
    expect(users.canSeeCamera(undefined, "cam-1")).toBe(true);
  });
});

describe("users — cameraIds no createUser/updateUser (sanitização)", () => {
  it("createUser aceita papel 'cliente' e salva cameraIds sanitizados (de-dup, strings)", async () => {
    const r = await users.createUser({
      usuario: `cliente-${Date.now()}`,
      senha: "x",
      papel: "cliente",
      cameraIds: ["cam-1", "cam-1", "cam-2", 42],
    });
    expect(r.user.papel).toBe("cliente");
    expect(r.user.cameraIds).toEqual(["cam-1", "cam-2", "42"]);
  });

  it("createUser sem cameraIds → [] (fail-closed por default, não undefined)", async () => {
    const r = await users.createUser({ usuario: `cliente2-${Date.now()}`, senha: "x", papel: "cliente" });
    expect(r.user.cameraIds).toEqual([]);
  });

  it("updateUser troca cameraIds; patch sem o campo PRESERVA o valor atual (retrocompat)", async () => {
    // updateUser recusa QUALQUER edição se isso deixasse zero superadmin ativo no store —
    // este arquivo de teste ainda não criou nenhum (users.persist.test.js roda em outro
    // módulo isolado), então precisa de 1 aqui antes de editar o usuário "cliente".
    await users.createUser({ usuario: `boss-scope-${Date.now()}`, senha: "x", papel: "superadmin" });
    const created = await users.createUser({
      usuario: `cliente3-${Date.now()}`,
      senha: "x",
      papel: "cliente",
      cameraIds: ["cam-1"],
    });
    const r1 = await users.updateUser(created.user.id, { cameraIds: ["cam-2", "cam-3"] });
    expect(r1.user.cameraIds).toEqual(["cam-2", "cam-3"]);
    const r2 = await users.updateUser(created.user.id, { ativo: true }); // sem cameraIds no patch
    expect(r2.user.cameraIds).toEqual(["cam-2", "cam-3"]); // preservado, não zerado
  });

  it("ROLES inclui 'cliente' e normalizeRole aceita", () => {
    expect(users.ROLES).toContain("cliente");
    expect(users.normalizeRole("cliente")).toBe("cliente");
  });

  it("canConfigure(papel) é false pra 'cliente' (só-visualização, nunca configura)", () => {
    expect(users.canConfigure("cliente")).toBe(false);
  });
});
