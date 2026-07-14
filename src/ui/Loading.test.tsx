import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Loading } from "./Loading";

// Mesmo molde de Panel.test/Meter.test: renderToStaticMarkup (sem jsdom).
describe("Loading — estado de carregamento acessível", () => {
  it("inline: wrapper aria-busy + aria-label garantidos, com o rótulo visível", () => {
    const html = renderToStaticMarkup(<Loading label="Carregando leituras" />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Carregando leituras"');
    expect(html).toContain("Carregando leituras…");
  });

  it("skeleton: MESMO contrato aria-busy + aria-label, com N barras no lugar do texto", () => {
    const html = renderToStaticMarkup(
      <Loading label="Carregando" variant="skeleton" lines={4} />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Carregando"');
    // 4 linhas de shimmer; sem o texto visível "…"
    expect(html).not.toContain("Carregando…");
    expect(html.match(/ui-shimmer/g)?.length).toBe(4);
  });
});
