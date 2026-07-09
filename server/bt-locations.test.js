// Testes do store de LOCALIZAÇÃO last-known por tag BLE (bt-locations.js) — sem Postgres (fallback JSON).
// Foco na lógica NOVA: normalização do MAC p/ maiúsculo, descarte de lat/lon inválidos, last-wins e
// enriquecimento do rótulo via bt-tags.match. `ts` é injetado → determinístico, sem timers.
// Efeito colateral: update escreve server/bt-locations.json (gitignored) → limpo no afterAll.
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const loc = require("./bt-locations");
const btTags = require("./bt-tags");
const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, "bt-locations.json");
const TAGS_FILE = path.join(DIR, "bt-tags.json"); // criado ao registrar a tag do teste de enriquecimento

afterAll(() => {
  for (const f of [FILE, TAGS_FILE]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* pode não existir */
    }
  }
});

describe("bt-locations — update", () => {
  it("grava e normaliza o MAC p/ maiúsculo (chave = MAC maiúsculo)", () => {
    loc.update("aa:bb:cc:11:22:33", { lat: -23.5, lon: -46.6, acc: 12 }, 1000);
    const rec = loc.snapshot().find((r) => r.mac === "AA:BB:CC:11:22:33");
    expect(rec).toBeTruthy();
    expect(rec.lat).toBe(-23.5);
    expect(rec.lon).toBe(-46.6);
    expect(rec.acc).toBe(12);
    expect(rec.ts).toBe(1000);
  });

  it("descarta lat/lon não-finitos ou fora de range (não grava)", () => {
    expect(loc.update("11:22:33:44:55:01", { lat: NaN, lon: -46.6 }, 2000)).toBeNull();
    expect(loc.update("11:22:33:44:55:02", { lat: 91, lon: 0 }, 2000)).toBeNull(); // lat > 90
    expect(loc.update("11:22:33:44:55:03", { lat: 0, lon: 181 }, 2000)).toBeNull(); // lon > 180
    const macs = loc.snapshot().map((r) => r.mac);
    expect(macs).not.toContain("11:22:33:44:55:01");
    expect(macs).not.toContain("11:22:33:44:55:02");
    expect(macs).not.toContain("11:22:33:44:55:03");
  });

  it("last-wins: o 2º update sobrescreve a localização da mesma tag", () => {
    loc.update("ab:cd:ef:00:00:01", { lat: 10, lon: 20, acc: 5 }, 3000);
    loc.update("ab:cd:ef:00:00:01", { lat: 11, lon: 21, acc: 8 }, 3100);
    const rec = loc.snapshot().find((r) => r.mac === "AB:CD:EF:00:00:01");
    expect(rec.lat).toBe(11);
    expect(rec.lon).toBe(21);
    expect(rec.acc).toBe(8);
    expect(rec.ts).toBe(3100);
  });

  it("acc ausente/inválida vira null", () => {
    loc.update("ab:cd:ef:00:00:02", { lat: 1, lon: 2 }, 4000);
    const rec = loc.snapshot().find((r) => r.mac === "AB:CD:EF:00:00:02");
    expect(rec.acc).toBeNull();
  });
});

describe("bt-locations — snapshot (enriquece rótulo via bt-tags)", () => {
  it("tag NÃO cadastrada → rotulo null", () => {
    loc.update("de:ad:be:ef:00:99", { lat: 5, lon: 5 }, 5000);
    const rec = loc.snapshot().find((r) => r.mac === "DE:AD:BE:EF:00:99");
    expect(rec.rotulo).toBeNull();
  });

  it("tag cadastrada em bt-tags → rotulo vem do match(mac)", async () => {
    await btTags.create({ btName: "AA:BB:CC:DD:EE:FF", rotulo: "Maria" });
    loc.update("aa:bb:cc:dd:ee:ff", { lat: -23.4, lon: -46.5 }, 6000);
    const rec = loc.snapshot().find((r) => r.mac === "AA:BB:CC:DD:EE:FF");
    expect(rec.rotulo).toBe("Maria");
  });
});
