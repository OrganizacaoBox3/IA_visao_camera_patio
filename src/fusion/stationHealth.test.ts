// Testes do núcleo PURO de saúde da estação de referência (src/fusion/stationHealth.ts).
// Determinístico: `now` é sempre passado explicitamente (sem Date.now/random).
import { describe, it, expect } from "vitest";
import { computeStationHealth, rssiAt1m, type BtReadingLike } from "./stationHealth";

const REF = "AA:BB:CC:DD:EE:FF";

describe("computeStationHealth — heartbeat / down", () => {
  it("(a) sem refMac → down", () => {
    const h = computeStationHealth([{ mac: REF, rssi: -60 }], undefined, null, 0);
    expect(h.status).toBe("down");
    expect(h.alive).toBe(false);
    expect(h.rssi).toBeNull();
  });

  it("(a) refMac definido mas SEM a leitura em cena → down", () => {
    const readings: BtReadingLike[] = [{ mac: "11:22:33:44:55:66", rssi: -50 }];
    const h = computeStationHealth(readings, REF, null, 0);
    expect(h.status).toBe("down");
    expect(h.alive).toBe(false);
  });

  it("leitura mais velha que staleMs → down (mas preserva o rssi cru e o baseline)", () => {
    const readings: BtReadingLike[] = [{ mac: REF, rssi: -62, ts: 0 }];
    const h = computeStationHealth(readings, REF, -60, 20000, 15000);
    expect(h.status).toBe("down");
    expect(h.alive).toBe(false);
    expect(h.rssi).toBe(-62);
    expect(h.baseline).toBe(-60); // baseline anterior não é perdido na queda
  });
});

describe("computeStationHealth — viva / baseline / drift", () => {
  it("(b) referência viva (sem baseline prévio) → alive, baseline inicial = rssi, ok", () => {
    const readings: BtReadingLike[] = [{ mac: REF, rssi: -55, ts: 1000 }];
    const h = computeStationHealth(readings, REF, null, 2000);
    expect(h.alive).toBe(true);
    expect(h.rssi).toBe(-55);
    expect(h.baseline).toBe(-55);
    expect(h.driftDb).toBe(0);
    expect(h.status).toBe("ok");
  });

  it("leitura sem ts, mas presente na lista → considerada viva", () => {
    const h = computeStationHealth([{ mac: REF, rssi: -70 }], REF, null, 999999);
    expect(h.alive).toBe(true);
    expect(h.rssi).toBe(-70);
  });

  it("(c) desvio grande do baseline (> 6 dB) → status 'drift'", () => {
    // baseline prévio -60; leitura -80 ⇒ baseline EMA = -62; driftDb = -80-(-62) = -18 (|18| > 6).
    const readings: BtReadingLike[] = [{ mac: REF, rssi: -80, ts: 100 }];
    const h = computeStationHealth(readings, REF, -60, 200);
    expect(h.status).toBe("drift");
    expect(h.baseline).toBeCloseTo(-62, 6);
    expect(h.driftDb).toBeCloseTo(-18, 6);
  });

  it("desvio pequeno (≤ 6 dB) permanece 'ok'", () => {
    const h = computeStationHealth([{ mac: REF, rssi: -63, ts: 100 }], REF, -60, 200);
    // baseline EMA = -60*0.9 + -63*0.1 = -60.3; drift = -2.7 → ok
    expect(h.status).toBe("ok");
  });

  it("casa o MAC ignorando caixa (refMac vs leitura em minúsculas)", () => {
    const h = computeStationHealth([{ mac: REF.toLowerCase(), rssi: -50 }], REF, null, 0);
    expect(h.alive).toBe(true);
    expect(h.rssi).toBe(-50);
  });
});

describe("rssiAt1m — modelo log-distância", () => {
  it("(d) refRssi -65 a 4 m, n=2 → ≈ -52.96 dBm", () => {
    expect(rssiAt1m(-65, 4, 2)).toBeCloseTo(-52.96, 2);
  });

  it("a 1 m o RSSI0 é o próprio RSSI (log10(1)=0)", () => {
    expect(rssiAt1m(-59, 1)).toBeCloseTo(-59, 6);
  });

  it("distância ≤ 0 é saturada em 0.1 m (não estoura log10)", () => {
    expect(Number.isFinite(rssiAt1m(-60, 0))).toBe(true);
  });
});
