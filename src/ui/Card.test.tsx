import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "./Card";

// Mesmo molde de Panel.test/Meter.test: renderToStaticMarkup (sem jsdom).
describe("Card — superfície interativa", () => {
  it("reusa a classe .panel (superfície da casa) + afordância de clique", () => {
    const html = renderToStaticMarkup(<Card onClick={() => {}}>conteúdo</Card>);
    expect(html).toContain("panel");
    expect(html).toContain("cursor-pointer");
    expect(html).toContain("hover:border-accent");
    expect(html).toContain("conteúdo");
  });

  it("com onClick é <button> (semântica de teclado/AT de graça)", () => {
    const html = renderToStaticMarkup(<Card onClick={() => {}}>x</Card>);
    expect(html).toMatch(/^<button/);
  });

  it("as='div' força superfície não-semântica (pai já é interativo)", () => {
    const html = renderToStaticMarkup(
      <Card as="div" onClick={() => {}}>
        x
      </Card>,
    );
    expect(html).toMatch(/^<div/);
  });

  it("repassa aria-* para a superfície", () => {
    const html = renderToStaticMarkup(
      <Card onClick={() => {}} aria-label="abrir câmera 3">
        x
      </Card>,
    );
    expect(html).toContain('aria-label="abrir câmera 3"');
  });

  it("className mescla (tamanho/conteúdo vêm de fora)", () => {
    const html = renderToStaticMarkup(<Card className="w-40 flex flex-col">x</Card>);
    expect(html).toContain("w-40 flex flex-col");
  });
});
