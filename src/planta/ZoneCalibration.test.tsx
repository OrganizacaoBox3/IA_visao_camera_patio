import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmProvider } from "../ui";
import type { Fingerprint } from "../api";
import {
  ZoneCalibration,
  groupFingerprints,
  sameStationId,
  validateZoneSampleForm,
} from "./ZoneCalibration";

const samples: Fingerprint[] = [
  {
    id: "a1",
    label: "Montagem",
    x: 1,
    y: 2,
    vec: { ANT_A: { mean: -45, std: 2, n: 10 } },
    createdAt: 1,
  },
  {
    id: "i1",
    label: "Inspeção",
    vec: { ANT_B: { mean: -50, std: 3, n: 8 } },
    createdAt: 2,
  },
  {
    id: "a2",
    label: "Montagem",
    x: 3,
    y: 4,
    vec: { ANT_A: { mean: -48, std: 2, n: 9 } },
    createdAt: 3,
  },
];

describe("validateZoneSampleForm", () => {
  it("exige o nome do local", () => {
    const result = validateZoneSampleForm("  ", "", "");
    expect(result.ok).toBe(false);
    expect(result.errors.name).toMatch(/nome do local/i);
  });

  it("aceita uma zona sem coordenadas", () => {
    expect(validateZoneSampleForm(" Montagem ", "", "")).toEqual({
      ok: true,
      name: "Montagem",
      xy: null,
      errors: {},
    });
  });

  it("exige X e Y como par", () => {
    const result = validateZoneSampleForm("Montagem", "2", "");
    expect(result.ok).toBe(false);
    expect(result.errors.coordinates).toMatch(/X e Y/);
  });

  it("aceita vírgula decimal e rejeita coordenada inválida", () => {
    expect(validateZoneSampleForm("Montagem", "1,5", "2,25")).toMatchObject({
      ok: true,
      xy: { x: 1.5, y: 2.25 },
    });
    expect(validateZoneSampleForm("Montagem", "-1", "2").ok).toBe(false);
    expect(validateZoneSampleForm("Montagem", "abc", "2").ok).toBe(false);
  });
});

describe("groupFingerprints", () => {
  it("agrupa amostras por zona preservando a ordem", () => {
    expect(
      groupFingerprints(samples).map((group) => [
        group.label,
        group.samples.map((sample) => sample.id),
      ]),
    ).toEqual([
      ["Montagem", ["a1", "a2"]],
      ["Inspeção", ["i1"]],
    ]);
  });
});

describe("sameStationId", () => {
  it("compara IDs de estação sem diferenciar maiúsculas e minúsculas", () => {
    expect(sameStationId("TC22", "tc22")).toBe(true);
    expect(sameStationId("TC22-70A3", "tc22-70a3")).toBe(true);
    expect(sameStationId("TC22-0963", "tc22-70a3")).toBe(false);
  });
});

describe("ZoneCalibration", () => {
  it("emite a hierarquia de zonas, amostras e formulário estreito", () => {
    const html = renderToStaticMarkup(
      <ConfirmProvider>
        <ZoneCalibration
          rows={[{ id: "ANT_A", label: "Antena A", live: true, pos: { x: 1, y: 2 } }]}
          fingerprints={samples}
          capturing={null}
          onCapture={async () => ({ ok: true })}
          onRemove={async () => ({ ok: true })}
        />
      </ConfirmProvider>,
    );

    expect(html).toContain("Locais de referência");
    expect(html).toContain("Referências junto às antenas");
    expect(html).toContain("Nova amostra de local");
    expect(html).toContain("Amostras de calibração");
    expect(html).toContain("grid-cols-2");
    expect(html.match(/Montagem/g)).toHaveLength(1);
    expect(html).toContain("2 amostras");
  });
});
