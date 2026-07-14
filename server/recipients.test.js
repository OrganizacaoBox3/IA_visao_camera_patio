// Testes do store de destinatários de WhatsApp (recipients.js) — sem Postgres (fallback JSON).
// Foco: validação de número (DDI+DDD), dedup e o GATE ANTI-"PERSISTÊNCIA FALSA" (durável-primeiro
// com rollback) — o mesmo conserto de shifts.js. Efeito colateral: create/remove escrevem
// server/recipients.json (gitignored) → limpo no afterAll.
import { describe, it, expect, afterAll, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const recipients = require("./recipients");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "recipients.json");

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

describe("recipients — cadastro + validação", () => {
  it("create exige número plausível (DDI+DDD, ≥10 dígitos) e deduplica", async () => {
    expect((await recipients.create({ numero: "123" })).error).toMatch(/número inválido/i);
    const r = await recipients.create({ nome: "Fulano", numero: "55 84 99999-0001" });
    expect(r.error).toBeUndefined();
    expect(r.recipient.numero).toBe("5584999990001"); // só dígitos
    expect(r.recipient.ativo).toBe(true);
    const dup = await recipients.create({ numero: "5584999990001" });
    expect(dup.error).toMatch(/já cadastrado/i);
  });

  it("update aplica patch; remove tira da lista", async () => {
    const r = await recipients.create({ numero: "558499999002" });
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
    const r = await recipients.create({ numero: "558490000000" });
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect(recipients.all().length).toBe(antes);
  });

  it("update: escrita falha → ROLLBACK (o valor antigo permanece) + 503", async () => {
    const r = await recipients.create({ nome: "Original", numero: "558491111111" });
    const spy = failWrite();
    const bad = await recipients.update(r.recipient.id, { nome: "Editado" });
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(recipients.all().find((x) => x.id === r.recipient.id).nome).toBe("Original");
  });

  it("remove: escrita falha → o destinatário PERMANECE (rollback) + 503", async () => {
    const r = await recipients.create({ numero: "558492222222" });
    const spy = failWrite();
    const bad = await recipients.remove(r.recipient.id);
    spy.mockRestore();
    expect(bad.status).toBe(503);
    expect(recipients.all().some((x) => x.id === r.recipient.id)).toBe(true);
    await recipients.remove(r.recipient.id); // limpeza (grava de verdade)
  });
});
