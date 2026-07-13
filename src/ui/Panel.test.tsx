import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Panel } from "./Panel";

// G9 — Panel (spec-padronizacao-interface §1): formaliza .panel legado como átomo
// semântico (<section> + <h2> via SectionTitle embutido), reusando o CSS existente.

describe("Panel (G9)", () => {
  it("renderiza <section class='panel'> com <h2> quando title é passado", () => {
    const html = renderToStaticMarkup(<Panel title="Presença por setor">conteúdo</Panel>);
    expect(html).toMatch(/<section class="panel">/);
    expect(html).toMatch(/<h2[^>]*>Presença por setor<\/h2>/);
    expect(html).toContain("conteúdo");
  });

  it("sem title: sem heading (children compõem SectionTitle custom se precisarem)", () => {
    const html = renderToStaticMarkup(<Panel>solto</Panel>);
    expect(html).not.toContain("<h2");
    expect(html).toContain("solto");
  });

  it("className mescla com .panel (layout da página, ex.: flex-1)", () => {
    const html = renderToStaticMarkup(<Panel className="flex-1 flex flex-col">x</Panel>);
    expect(html).toMatch(/<section class="panel flex-1 flex flex-col">/);
  });
});
