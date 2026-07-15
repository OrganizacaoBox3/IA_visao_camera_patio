import { describe, expect, it } from "vitest";
import { cameraZona, formatTs } from "./format";

describe("formatTs", () => {
  it("ts inválido/null vira travessão", () => {
    expect(formatTs(null)).toBe("—");
    expect(formatTs(undefined)).toBe("—");
    expect(formatTs(Number.NaN)).toBe("—");
  });
  it("epoch-ms vira string com data e hora", () => {
    const s = formatTs(Date.UTC(2026, 6, 14, 12, 0, 0));
    expect(s).toMatch(/2026/);
    expect(s).toMatch(/\d{2}:\d{2}/);
  });
});

describe("cameraZona", () => {
  it("meta ausente vira travessão", () => {
    expect(cameraZona(null)).toBe("—");
    expect(cameraZona({})).toBe("—");
  });
  it("prefere cameraLabel e junta com zona", () => {
    expect(cameraZona({ cameraLabel: "Doca 3", zona: "entrada" })).toBe("Doca 3 · entrada");
  });
  it("cai para cameraId quando não há label", () => {
    expect(cameraZona({ cameraId: "cam-7" })).toBe("cam-7");
  });
});
