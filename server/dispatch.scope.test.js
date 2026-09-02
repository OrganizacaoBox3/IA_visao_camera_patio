// Roteamento de notificação por câmera (dispatch.targets) — papel "cliente" só recebe alarme
// das câmeras alocadas a ele; papéis de equipe recebem de todas. Todo número vem de recipients
// e herda o escopo do usuário proprietário. writeFileSync mockado como NO-OP (mesmo padrão dos
// testes de users.js — nunca toca o users.json real do dev).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const users = require("./users");
const recipients = require("./recipients");
const dispatch = require("./dispatch");

let writeSpy;
let renameSpy;
const TEST_ADMIN_ID = "u-dispatch-test-admin";
beforeAll(() => {
  users.all().push({
    id: TEST_ADMIN_ID,
    usuario: "dispatch-test-admin",
    papel: "superadmin",
    ativo: true,
    cameraIds: [],
    recipientMigrationVersion: 1,
  });
});
afterAll(() => {
  const idx = users.all().findIndex((u) => u.id === TEST_ADMIN_ID);
  if (idx >= 0) users.all().splice(idx, 1);
});
beforeEach(() => {
  writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
  renameSpy = vi.spyOn(fs, "renameSync").mockImplementation(() => {});
});
afterEach(() => {
  writeSpy.mockRestore();
  renameSpy.mockRestore();
});

async function makeNotifiableUser({ usuario, papel, cameraIds, whatsapp }) {
  const r = await users.createUser({ usuario, senha: "x", papel, cameraIds });
  await recipients.updateProfile(r.user.id, { whatsapp, optIn: true });
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

  it("aplica o mesmo escopo a vários números do usuário e bloqueia usuário desativado", async () => {
    const tag = Date.now();
    const made = await users.createUser({
      usuario: `cli-multi-${tag}`,
      senha: "x",
      papel: "cliente",
      cameraIds: ["cam-multi"],
    });
    await recipients.updateProfile(made.user.id, {
      whatsapp: "5588900000011",
      optIn: true,
    });
    await recipients.create({
      nome: "Segundo telefone",
      numero: "5588900000012",
      userId: made.user.id,
      somenteCriticos: false,
    });
    expect(dispatch.targets(META, "cam-multi").map((t) => t.numero)).toEqual(
      expect.arrayContaining(["5588900000011", "5588900000012"]),
    );
    expect(dispatch.targets(META, "cam-outra").map((t) => t.numero)).not.toEqual(
      expect.arrayContaining(["5588900000011", "5588900000012"]),
    );
    const deactivated = await users.updateUser(made.user.id, { ativo: false });
    expect(deactivated.error).toBeUndefined();
    expect(users.getById(made.user.id).ativo).toBe(false);
    expect(dispatch.targets(META, "cam-multi").map((t) => t.numero)).not.toEqual(
      expect.arrayContaining(["5588900000011", "5588900000012"]),
    );
  });

  it("não envia o principal sem consentimento", async () => {
    const tag = Date.now();
    const made = await users.createUser({
      usuario: `cli-optout-${tag}`,
      senha: "x",
      papel: "cliente",
      cameraIds: ["cam-optout"],
    });
    await recipients.updateProfile(made.user.id, {
      whatsapp: "5588900000013",
      optIn: false,
    });
    expect(dispatch.targets(META, "cam-optout").some((t) => t.numero === "5588900000013")).toBe(
      false,
    );
  });
});
