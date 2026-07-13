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

describe("bt-readings — multi-antena (chave composta estação|MAC)", () => {
  const MAC = "CC:CC:CC:00:00:01";

  it("CA-1: duas estações vendo a MESMA tag coexistem (nenhuma sobrescrita)", () => {
    bt.ingest("est-a", [{ mac: MAC, rssi: -50 }], 100_000);
    bt.ingest("est-b", [{ mac: MAC, rssi: -70 }], 100_100);
    const recs = bt.snapshot(100_200).filter((r) => r.mac === MAC);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.stationId).sort()).toEqual(["est-a", "est-b"]);
    expect(recs.find((r) => r.stationId === "est-a").rssi).toBe(-50);
    expect(recs.find((r) => r.stationId === "est-b").rssi).toBe(-70);
  });

  it("último-vence continua valendo DENTRO da mesma fonte", () => {
    bt.ingest("est-a", [{ mac: MAC, rssi: -45 }], 100_300);
    const recs = bt.snapshot(100_400).filter((r) => r.mac === MAC);
    expect(recs.find((r) => r.stationId === "est-a").rssi).toBe(-45);
    expect(recs.find((r) => r.stationId === "est-b").rssi).toBe(-70); // a outra série intacta
  });

  it("poda por staleness é POR FONTE: a estação que parou some sem apagar a outra", () => {
    const M = "CC:CC:CC:00:00:02";
    bt.ingest("est-a", [{ mac: M, rssi: -50 }], 200_000);
    bt.ingest("est-b", [{ mac: M, rssi: -60 }], 200_000 + 10_000);
    const recs = bt.snapshot(200_000 + bt.STALE_MS + 1).filter((r) => r.mac === M);
    expect(recs).toHaveLength(1);
    expect(recs[0].stationId).toBe("est-b");
  });

  it("snapshotLatestByMac colapsa por MAC (o mais fresco vence) — o formato retrocompat do GET", () => {
    const M = "CC:CC:CC:00:00:03";
    bt.ingest("est-a", [{ mac: M, rssi: -50 }], 300_000);
    bt.ingest("est-b", [{ mac: M, rssi: -70 }], 300_100);
    const recs = bt.snapshotLatestByMac(300_200).filter((r) => r.mac === M);
    expect(recs).toHaveLength(1);
    expect(recs[0].stationId).toBe("est-b"); // o mais fresco
    expect(recs[0].rssi).toBe(-70);
  });

  it("snapshotByStation agrupa as fontes vivas por estação", () => {
    const M = "CC:CC:CC:00:00:04";
    bt.ingest("est-a", [{ mac: M, rssi: -40 }], 400_000);
    bt.ingest("est-b", [{ mac: M, rssi: -80 }], 400_000);
    const by = bt.snapshotByStation(400_100);
    expect(by.get("est-a").some((r) => r.mac === M)).toBe(true);
    expect(by.get("est-b").some((r) => r.mac === M)).toBe(true);
  });

  it("CA-3: com UMA estação, snapshot e snapshotLatestByMac são idênticos (1 rec/MAC, mesmo shape)", () => {
    const M1 = "DD:DD:DD:00:00:01";
    const M2 = "DD:DD:DD:00:00:02";
    bt.ingest("solo", [{ mac: M1, rssi: -55 }], 500_000);
    bt.ingest("solo", [{ mac: M2, rssi: -65 }], 500_100);
    bt.ingest("solo", [{ mac: M1, rssi: -52 }], 500_200); // last-writer-wins na mesma fonte
    const only = (rows) => rows.filter((r) => r.mac.startsWith("DD:DD:DD"));
    const full = only(bt.snapshot(500_300));
    const collapsed = only(bt.snapshotLatestByMac(500_300));
    expect(collapsed).toEqual(full); // indistinguível: 1 rec por MAC
    expect(full.find((r) => r.mac === M1)).toEqual({
      mac: M1,
      rotulo: null,
      stationId: "solo",
      rssi: -52,
      ts: 500_200,
    });
  });
});
