// Testes do store de destinatários de WhatsApp (recipients.js) — sem Postgres (fallback JSON).
// Foco: validação de número (DDI+DDD), dedup e o GATE ANTI-"PERSISTÊNCIA FALSA" (durável-primeiro
// com rollback) — o mesmo conserto de shifts.js. Efeito colateral: create/remove escrevem
// server/recipients.json (gitignored) → limpo no afterAll.
import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const recipients = require("./recipients");
const users = require("./users");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "recipients.json");
const BACKUP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "recipients.pre-user-link.bak.json",
);
const OWNER_ID = "u-recipient-test";

beforeAll(() => {
  users.all().push({
    id: OWNER_ID,
    usuario: "owner-recipient-test",
    papel: "superadmin",
    ativo: true,
    cameraIds: [],
  });
});

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
  try {
    fs.unlinkSync(BACKUP);
  } catch {
    /* pode não existir */
  }
  const idx = users.all().findIndex((u) => u.id === OWNER_ID);
  if (idx >= 0) users.all().splice(idx, 1);
});

describe("recipients — cadastro + validação", () => {
  it("create exige número plausível (DDI+DDD, ≥10 dígitos) e deduplica", async () => {
    expect((await recipients.create({ numero: "123", userId: OWNER_ID })).error).toMatch(
      /número inválido/i,
    );
    const r = await recipients.create({
      nome: "Fulano",
      numero: "55 84 99999-0001",
      userId: OWNER_ID,
    });
    expect(r.error).toBeUndefined();
    expect(r.recipient.numero).toBe("5584999990001"); // só dígitos
    expect(r.recipient.ativo).toBe(true);
    const dup = await recipients.create({ numero: "5584999990001", userId: OWNER_ID });
    expect(dup.error).toMatch(/já cadastrado/i);
  });

  it("update aplica patch; remove tira da lista", async () => {
    const r = await recipients.create({ numero: "558499999002", userId: OWNER_ID });
    expect((await recipients.update(r.recipient.id, { ativo: false })).recipient.ativo).toBe(false);
    await recipients.remove(r.recipient.id);
    expect(recipients.all().some((x) => x.id === r.recipient.id)).toBe(false);
  });
});

describe("recipients — persistência atômica (durável-primeiro, com rollback)", () => {
  const failWrite = () =>
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("SIMULADO: disco cheio");
    });

  it("create: escrita falha → memória INTOCADA + erro 503", async () => {
    const antes = recipients.all().length;
    const spy = failWrite();
    const r = await recipients.create({ numero: "558490000000", userId: OWNER_ID });
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect(recipients.all().length).toBe(antes);
  });

  it("update: escrita falha → ROLLBACK (o valor antigo permanece) + 503", async () => {
    const r = await recipients.create({
      nome: "Original",
      numero: "558491111111",
      userId: OWNER_ID,
    });
    const spy = failWrite();
    const bad = await recipients.update(r.recipient.id, { nome: "Editado" });
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(recipients.all().find((x) => x.id === r.recipient.id).nome).toBe("Original");
  });

  it("remove: escrita falha → o destinatário PERMANECE (rollback) + 503", async () => {
    const r = await recipients.create({ numero: "558492222222", userId: OWNER_ID });
    const spy = failWrite();
    const bad = await recipients.remove(r.recipient.id);
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(recipients.all().some((x) => x.id === r.recipient.id)).toBe(true);
    await recipients.remove(r.recipient.id); // limpeza (grava de verdade)
  });
});

describe("recipients — vínculo com usuário e número principal", () => {
  it("marcar outro principal desmarca o anterior", async () => {
    const a = await recipients.create({
      numero: "558493333331",
      userId: OWNER_ID,
      principal: true,
    });
    const b = await recipients.create({
      numero: "558493333332",
      userId: OWNER_ID,
      principal: true,
    });
    expect(recipients.principalForUser(OWNER_ID).id).toBe(b.recipient.id);
    expect(recipients.all().find((r) => r.id === a.recipient.id).principal).toBe(false);
  });

  it("Meu perfil cria, edita e apaga o mesmo destinatário principal", async () => {
    const owner = users.getById(OWNER_ID);
    const old = recipients.principalForUser(OWNER_ID);
    if (old) await recipients.remove(old.id);
    const created = await recipients.updateProfile(OWNER_ID, {
      whatsapp: "+55 88 99999-9911",
      optIn: true,
      filtros: { ativo: true, somenteCriticos: false, tipos: ["atividade"] },
    });
    expect(created.user.whatsapp).toBe("5588999999911");
    const id = recipients.principalForUser(OWNER_ID).id;
    const edited = await recipients.updateProfile(OWNER_ID, { whatsapp: "5588999999922" });
    expect(edited.user.whatsapp).toBe("5588999999922");
    expect(recipients.principalForUser(OWNER_ID).id).toBe(id);
    const cleared = await recipients.updateProfile(OWNER_ID, { whatsapp: "" });
    expect(cleared.user.whatsapp).toBe("");
    expect(recipients.principalForUser(OWNER_ID)).toBeNull();
    expect(owner).toBeTruthy();
  });

  it("migra perfil legado uma vez e liga avulsos ao superadmin sem perder datas", async () => {
    const userId = "u-legacy-profile";
    const createdAt = 1_700_000_000_000;
    const beforeIds = new Set(recipients.all().map((r) => r.id));
    const owner = users.getById(OWNER_ID);
    const oldOwnerVersion = owner.recipientMigrationVersion;
    owner.recipientMigrationVersion = 0;
    users.all().push({
      id: userId,
      usuario: "cliente-legado",
      papel: "cliente",
      ativo: true,
      cameraIds: ["cam-1"],
      whatsapp: "55 88 98888-1111",
      filtros: { ativo: true, somenteCriticos: false, tipos: ["atividade"] },
      optInEm: createdAt + 1,
      criadoEm: createdAt,
      recipientMigrationVersion: 0,
    });
    recipients.all().push({
      id: "r-legacy-standalone",
      nome: "Avulso legado",
      numero: "5588988882222",
      ativo: true,
      somenteCriticos: true,
      tipos: [],
      criadoEm: createdAt - 1,
    });
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {});
    const copy = vi.spyOn(fs, "copyFileSync").mockImplementation(() => {});
    await recipients.migrateLegacy();
    copy.mockRestore();
    rename.mockRestore();
    write.mockRestore();

    const principal = recipients.principalForUser(userId);
    expect(principal.numero).toBe("5588988881111");
    expect(principal.criadoEm).toBe(createdAt);
    expect(principal.optInEm).toBe(createdAt + 1);
    const standalone = recipients.all().find((r) => r.id === "r-legacy-standalone");
    expect(standalone.userId).toBe(OWNER_ID);
    expect(standalone.criadoEm).toBe(createdAt - 1);
    expect(users.getById(userId).recipientMigrationVersion).toBe(1);

    principal.numero = "5588988883333";
    const writeAgain = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});
    const renameAgain = vi.spyOn(fs, "renameSync").mockImplementation(() => {});
    await recipients.migrateLegacy();
    renameAgain.mockRestore();
    writeAgain.mockRestore();
    expect(recipients.principalForUser(userId).numero).toBe("5588988883333");

    for (let i = recipients.all().length - 1; i >= 0; i--)
      if (!beforeIds.has(recipients.all()[i].id)) recipients.all().splice(i, 1);
    const userIdx = users.all().findIndex((u) => u.id === userId);
    if (userIdx >= 0) users.all().splice(userIdx, 1);
    owner.recipientMigrationVersion = oldOwnerVersion;
  });
});
