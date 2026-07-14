import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusDot } from "./StatusDot";

// Mesmo molde de Panel.test/Meter.test: renderToStaticMarkup (sem jsdom).
describe("StatusDot — bolinha de estado going-gray", () => {
  it("rótulo textual (sr-only) SEMPRE presente — informação nunca só por cor", () => {
    const html = renderToStaticMarkup(<StatusDot tone="ok" label="viva" />);
    expect(html).toContain('class="sr-only"');
    expect(html).toContain(">viva<");
  });

  it("a cor vem de --state-{tone}", () => {
    expect(renderToStaticMarkup(<StatusDot tone="ok" label="viva" />)).toContain(
      "var(--state-ok)",
    );
    expect(renderToStaticMarkup(<StatusDot tone="critical" label="morta" />)).toContain(
      "var(--state-critical)",
    );
    expect(renderToStaticMarkup(<StatusDot tone="neutral" label="x" />)).toContain(
      "var(--state-neutral)",
    );
  });

  it("color sobrepõe a cor inline (ex.: st.dot de CameraTile)", () => {
    const html = renderToStaticMarkup(<StatusDot color="#abcdef" label="x" />);
    expect(html).toContain("#abcdef");
    expect(html).not.toContain("var(--state-");
  });
});
