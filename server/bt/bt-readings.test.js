// Testes do store efêmero de leituras BLE (bt-readings.js) — ingest/normalização/último-vence/poda.
// `now` é injetado → determinístico, sem timers. Tag não cadastrada → rotulo null (enriquecimento
// com rótulo é coberto por bt-tags.test.js via match()).
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const bt = require("./bt-readings");

describe("bt-readings — ingest", () => {
  it("ingere válidas, normaliza MAC p/ maiúsculo, descarta inválidas", () => {
    const out = bt.ingest(
      "tc22",
      [
        { mac: "aa:bb:cc:11:22:33", rssi: -50 },
        { mac: "", rssi: -60 }, // sem mac → descarta
        { mac: "dd:ee:ff", rssi: "x" }, // rssi inválido → descarta
      ],
      1000,
    );
    expect(out).toHaveLength(1);
    expect(out[0].mac).toBe("AA:BB:CC:11:22:33");
    expect(out[0].rssi).toBe(-50);
    expect(out[0].rotulo).toBeNull(); // tag não cadastrada → sem rótulo
    expect(out[0].stationId).toBe("tc22");
    expect(out[0].ts).toBe(1000);
  });

  it("último-vence: a leitura mais nova da mesma tag substitui", () => {
    bt.ingest("s1", [{ mac: "ab:cd:ef:00:00:01", rssi: -70 }], 20_000);
    bt.ingest("s1", [{ mac: "ab:cd:ef:00:00:01", rssi: -55 }], 20_100);
    const rec = bt.snapshot(20_200).find((r) => r.mac === "AB:CD:EF:00:00:01");
    expect(rec.rssi).toBe(-55);
  });
});

describe("bt-readings — snapshot (poda o velho)", () => {
  it("mostra o vivo e some com o > STALE_MS (tag saiu de alcance)", () => {
    bt.ingest("tc22", [{ mac: "11:22:33:44:55:66", rssi: -40 }], 10_000);
    expect(bt.snapshot(10_500).some((r) => r.mac === "11:22:33:44:55:66")).toBe(true);
    expect(bt.snapshot(10_000 + bt.STALE_MS + 1).some((r) => r.mac === "11:22:33:44:55:66")).toBe(false);
  });
});
