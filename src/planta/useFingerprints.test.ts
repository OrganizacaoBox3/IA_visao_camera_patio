import { describe, expect, it } from "vitest";
import type { BtReading } from "../api";
import {
  appendCaptureReadings,
  buildFreshLiveVectors,
  createCaptureAccumulator,
  primeCaptureAccumulator,
} from "./useFingerprints";

const reading = (over: Partial<BtReading>): BtReading => ({
  mac: "AA",
  rotulo: null,
  rssi: -60,
  stationId: "TC22",
  ts: 10_000,
  measuredAt: 9_000,
  ...over,
});

describe("buildFreshLiveVectors", () => {
  it("usa somente medições frescas e sincronizadas para o mesmo MAC", () => {
    const built = buildFreshLiveVectors(
      [
        reading({ stationId: "A", rssi: -50, measuredAt: 9_000 }),
        reading({ stationId: "B", rssi: -60, measuredAt: 8_500 }),
        reading({ stationId: "C", rssi: -70, measuredAt: 4_000 }), // velha
        reading({ stationId: "D", rssi: -80, measuredAt: 5_000 }), // fresca no limite, dessincronizada
      ],
      10_000,
      { freshMs: 5_000, syncMs: 1_000 },
    );
    expect(built.get("AA")?.vec).toEqual({ A: -50, B: -60 });
    expect(built.get("AA")?.evidence).toMatchObject({
      liveStations: 2,
      oldestMeasuredAt: 8_500,
      newestMeasuredAt: 9_000,
      skewMs: 500,
    });
  });

  it("descarta leitura sem identidade temporal em vez de inventar frescor", () => {
    const built = buildFreshLiveVectors(
      [reading({ ts: undefined, measuredAt: undefined })],
      10_000,
    );
    expect(built.size).toBe(0);
  });
});

describe("appendCaptureReadings", () => {
  it("ignora o passado e deduplica station+MAC+measuredAt", () => {
    const acc = createCaptureAccumulator(10_000);
    appendCaptureReadings(acc, [
      reading({ measuredAt: 9_999 }),
      reading({ measuredAt: 10_001, rssi: -61 }),
      reading({ measuredAt: 10_001, rssi: -61 }),
      reading({ stationId: "tc22", mac: "aa", measuredAt: 10_001, rssi: -61 }),
      reading({ measuredAt: 12_500, rssi: -62 }),
    ]);
    expect(acc.samples).toHaveLength(2);
    expect(acc.seen.size).toBe(2);
  });

  it("usa o snapshot inicial como watermark sem depender do relógio do navegador", () => {
    const acc = createCaptureAccumulator(1_000_000); // relógio do browser propositalmente torto
    primeCaptureAccumulator(acc, [reading({ measuredAt: 10_000 })]);
    appendCaptureReadings(acc, [
      reading({ measuredAt: 10_000 }), // snapshot anterior repetido
      reading({ measuredAt: 12_500 }), // nova medição no relógio do hub
    ]);
    expect(acc.samples.map((sample) => sample.measuredAt)).toEqual([12_500]);
  });
});
