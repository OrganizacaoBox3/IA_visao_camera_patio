import { describe, expect, it } from "vitest";
import type { TagLocation, BtReading } from "../api";
import { fromTagLocations } from "./adapters";

const NOW = 1_700_000_000_000;

const loc = (over: Partial<TagLocation> = {}): TagLocation => ({
  mac: "AA:BB:CC:DD:EE:FF",
  rotulo: null,
  lat: -3.688,
  lon: -40.348,
  acc: 12,
  ts: NOW - 60_000,
  ...over,
});

const reading = (over: Partial<BtReading> = {}): BtReading => ({
  mac: "AA:BB:CC:DD:EE:FF",
  rotulo: null,
  rssi: -70,
  ...over,
});

describe("fromTagLocations", () => {
  it("mapeia uma localização para LocatedEntity (posição, precisão, source gps, não-live)", () => {
    const [e] = fromTagLocations([loc({ rotulo: "João" })], [], NOW);
    expect(e).toEqual({
      id: "AA:BB:CC:DD:EE:FF",
      label: "João",
      position: { lat: -3.688, lon: -40.348 },
      accuracyM: 12,
      seenAt: NOW - 60_000,
      live: false,
      source: "gps",
    });
  });

  it("funde reading → live=true e seenAt=now, mantendo a posição da localização", () => {
    const [e] = fromTagLocations([loc()], [reading()], NOW);
    expect(e.live).toBe(true);
    expect(e.seenAt).toBe(NOW);
    expect(e.position).toEqual({ lat: -3.688, lon: -40.348 });
  });

  it("faz match por MAC case-insensível (reading em minúsculas casa localização)", () => {
    const out = fromTagLocations([loc()], [reading({ mac: "aa:bb:cc:dd:ee:ff" })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0].live).toBe(true);
  });

  it("label: cai no MAC quando não há rótulo", () => {
    const [e] = fromTagLocations([loc({ rotulo: null })], [], NOW);
    expect(e.label).toBe("AA:BB:CC:DD:EE:FF");
  });

  it("label: rótulo da reading tem prioridade quando presente", () => {
    const [e] = fromTagLocations([loc({ rotulo: null })], [reading({ rotulo: "Maria" })], NOW);
    expect(e.label).toBe("Maria");
  });

  it("reading sem localização vira entidade live sem posição", () => {
    const [e] = fromTagLocations([], [reading({ mac: "11:22:33:44:55:66", rotulo: "Ana" })], NOW);
    expect(e).toEqual({
      id: "11:22:33:44:55:66",
      label: "Ana",
      position: null,
      accuracyM: null,
      seenAt: NOW,
      live: true,
      source: "gps",
    });
  });

  it("acc nula vira accuracyM null; posição não-finita vira null", () => {
    const [e] = fromTagLocations([loc({ acc: null, lat: Number.NaN, lon: -40 })], [], NOW);
    expect(e.accuracyM).toBeNull();
    expect(e.position).toBeNull();
  });

  it("é determinística e não muta a entrada", () => {
    const rows = [loc()];
    const reads = [reading()];
    const a = fromTagLocations(rows, reads, NOW);
    const b = fromTagLocations(rows, reads, NOW);
    expect(a).toEqual(b);
    expect(rows[0].rotulo).toBeNull(); // entrada intacta
  });
});
