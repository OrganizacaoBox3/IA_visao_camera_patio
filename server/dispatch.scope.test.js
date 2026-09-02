// Roteamento de notificação por câmera (dispatch.targets) — papel "cliente" só recebe alarme
// das câmeras alocadas a ele; papéis de equipe e os avulsos (recipients.json) não são escopados
// por câmera (só o "cliente" é). writeFileSync mockado como NO-OP (mesmo padrão dos demais
// testes de users.js — nunca toca o users.json real do dev).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const users = require("./users");
const dispatch = require("./dispatch");

let writeSpy;
beforeEach(() => {
  writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
});
afterEach(() => {
  writeSpy.mockRestore();
});

async function makeNotifiableUser({ usuario, papel, cameraIds, whatsapp }) {
  const r = await users.createUser({ usuario, senha: "x", papel, cameraIds });
  await users.updateProfile(r.user.id, { whatsapp, optIn: true });
  return users.getById(r.user.id);
}

const META = { tipo: "atividade", critico: false };

describe("dispatch.targets — escopo por câmera (papel cliente)", () => {
  it("cliente alocado à câmera do alarme ENTRA na lista", async () => {
    const tag = Date.now();
    await makeNotifiableUser({
      usuario: `cli-a-${tag}`,
      papel: "cliente",
      cameraIds: ["cam-1"],
      whatsapp: "5588900000001",
    });
    const t = dispatch.targets(META, "cam-1");
    expect(t.some((x) => x.numero === "5588900000001")).toBe(true);
  });

  it("cliente NÃO alocado à câmera do alarme FICA DE FORA", async () => {
    const tag = Date.now();
    await makeNotifiableUser({
      usuario: `cli-b-${tag}`,
      papel: "cliente",
      cameraIds: ["cam-2"], // alocado a cam-2, não a cam-1
      whatsapp: "5588900000002",
    });
    const t = dispatch.targets(META, "cam-1");
    expect(t.some((x) => x.numero === "5588900000002")).toBe(false);
  });

  it("cliente SEM cameraIds fica de fora de QUALQUER câmera (fail-closed)", async () => {
    const tag = Date.now();
    await makeNotifiableUser({
      usuario: `cli-c-${tag}`,
      papel: "cliente",
      cameraIds: [],
      whatsapp: "5588900000003",
    });
    expect(dispatch.targets(META, "cam-1").some((x) => x.numero === "5588900000003")).toBe(false);
    expect(dispatch.targets(META, "cam-2").some((x) => x.numero === "5588900000003")).toBe(false);
  });

  it("papel de EQUIPE (usuario/engenheiro/superadmin) recebe de QUALQUER câmera, sem escopo", async () => {
    const tag = Date.now();
    await makeNotifiableUser({
      usuario: `eng-${tag}`,
      papel: "engenheiro",
      whatsapp: "5588900000004",
    });
    expect(dispatch.targets(META, "cam-1").some((x) => x.numero === "5588900000004")).toBe(true);
    expect(dispatch.targets(META, "cam-999-desconhecida").some((x) => x.numero === "5588900000004")).toBe(
      true,
    );
    expect(dispatch.targets(META, undefined).some((x) => x.numero === "5588900000004")).toBe(true);
  });

  it("dois clientes com câmeras diferentes recebem SÓ o alarme da própria câmera (isolamento cruzado)", async () => {
    const tag = Date.now();
    await makeNotifiableUser({
      usuario: `cli-x-${tag}`,
      papel: "cliente",
      cameraIds: ["cam-x"],
      whatsapp: "5588900000005",
    });
    await makeNotifiableUser({
      usuario: `cli-y-${tag}`,
      papel: "cliente",
      cameraIds: ["cam-y"],
      whatsapp: "5588900000006",
    });
    const paraX = dispatch.targets(META, "cam-x").map((t) => t.numero);
    expect(paraX).toContain("5588900000005");
    expect(paraX).not.toContain("5588900000006");
    const paraY = dispatch.targets(META, "cam-y").map((t) => t.numero);
    expect(paraY).toContain("5588900000006");
    expect(paraY).not.toContain("5588900000005");
  });
});
