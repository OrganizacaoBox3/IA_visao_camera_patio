// Testes do store de tags BLE (bt-tags.js) — sem Postgres (fallback JSON). Foco na lógica NOVA:
// dedup por bt_name, `match` case/space-insensitive (base da associação tag↔pessoa) e remove.
// Efeito colateral: create/remove escrevem server/bt-tags.json (gitignored) → limpo no afterAll.
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const bt = require("./bt-tags");
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "bt-tags.json");

afterAll(() => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    /* pode não existir */
  }
});

describe("bt-tags — cadastro + dedup", () => {
  it("create exige bt_name e usa o próprio nome como rótulo default", async () => {
    expect((await bt.create({ btName: "" })).error).toBeTruthy();
    const r = await bt.create({ btName: "Tag-01" });
    expect(r.tag.btName).toBe("Tag-01");
    expect(r.tag.rotulo).toBe("Tag-01"); // sem rótulo → cai no bt_name
    expect(r.tag.ativo).toBe(true);
    expect(r.tag.id).toMatch(/^bt/);
  });

  it("dedup por bt_name é case/space-insensitive", async () => {
    await bt.create({ btName: "Crachá João", rotulo: "João" });
    const dup = await bt.create({ btName: "  cracHÁ joão ", rotulo: "outro" });
    expect(dup.error).toMatch(/já cadastrada/i);
  });
});

describe("bt-tags — match (a base da associação tag↔pessoa)", () => {
  it("casa o nome visto pela estação com a tag ATIVA, ignorando caixa/espaço", async () => {
    await bt.create({ btName: "AA:BB:CC:11:22:33", rotulo: "Maria" });
    const m = bt.match(" aa:bb:cc:11:22:33 ");
    expect(m).toBeTruthy();
    expect(m.rotulo).toBe("Maria");
    expect(bt.match("nome-que-nao-existe")).toBeNull();
  });

  it("tag inativa NÃO casa (não rotula quem foi desativado)", async () => {
    const r = await bt.create({ btName: "Tag-inativa" });
    await bt.update(r.tag.id, { ativo: false });
    expect(bt.match("Tag-inativa")).toBeNull();
  });
});

describe("bt-tags — update + remove", () => {
  it("update troca rótulo e barra bt_name duplicado", async () => {
    const a = await bt.create({ btName: "Tag-A" });
    await bt.create({ btName: "Tag-B" });
    expect((await bt.update(a.tag.id, { rotulo: "Novo" })).tag.rotulo).toBe("Novo");
    expect((await bt.update(a.tag.id, { btName: "Tag-B" })).error).toMatch(/já cadastrado/i);
  });

  it("remove tira da lista (e do match)", async () => {
    const r = await bt.create({ btName: "Tag-remover" });
    await bt.remove(r.tag.id);
    expect(bt.all().some((t) => t.id === r.tag.id)).toBe(false);
    expect(bt.match("Tag-remover")).toBeNull();
  });
});
