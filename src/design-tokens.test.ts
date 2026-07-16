import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");

function colorToken(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!match?.[1]) throw new Error(`Token de cor --${name} ausente ou não hexadecimal`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255);
  const [red = 0, green = 0, blue = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("tokens de texto secundário", () => {
  const darkSurfaces = [
    "bg",
    "panel",
    "panel-2",
    "state-neutral-bg",
    "state-ok-bg",
    "state-info-bg",
    "state-warn-bg",
    "state-critical-bg",
  ];

  it.each(["text-dim", "text-muted", "state-neutral-dim"])(
    "mantém --%s em WCAG AA nas superfícies do app",
    (foreground) => {
      for (const background of darkSurfaces) {
        expect(
          contrast(colorToken(foreground), colorToken(background)),
          `--${foreground} sobre --${background}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("preserva a hierarquia texto principal > dim > muted", () => {
    expect(luminance(colorToken("text"))).toBeGreaterThan(luminance(colorToken("text-dim")));
    expect(luminance(colorToken("text-dim"))).toBeGreaterThan(luminance(colorToken("text-muted")));
  });
});
