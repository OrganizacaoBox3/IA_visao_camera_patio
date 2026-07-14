import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Meter } from "./Meter";

// Mesmo molde de Panel.test.tsx: renderToStaticMarkup (sem jsdom).
describe("Meter — barra analógica going-gray", () => {
  it("value vira a LARGURA do preenchimento; clampa a [0,100]", () => {
    expect(renderToStaticMarkup(<Meter value={40} ariaLabel="sinal 40%" />)).toContain("width:40%");
    expect(renderToStaticMarkup(<Meter value={150} ariaLabel="x" />)).toContain("width:100%");
    expect(renderToStaticMarkup(<Meter value={-10} ariaLabel="x" />)).toContain("width:0%");
  });

  it("acessível: role=img + aria-label (informação nunca só por cor)", () => {
    const html = renderToStaticMarkup(<Meter value={50} ariaLabel="sinal 50%" />);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="sinal 50%"');
  });

  it("tone escolhe a cor de estado; muted esmaece para --border", () => {
    expect(renderToStaticMarkup(<Meter value={50} ariaLabel="x" tone="ok" />)).toContain(
      "var(--state-ok)",
    );
    expect(renderToStaticMarkup(<Meter value={50} ariaLabel="x" tone="warn" />)).toContain(
      "var(--state-warn)",
    );
    expect(renderToStaticMarkup(<Meter value={50} ariaLabel="x" muted />)).toContain("var(--border)");
  });
});
