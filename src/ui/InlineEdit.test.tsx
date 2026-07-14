import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineEdit } from "./InlineEdit";

// A molécula que a lista de Tags e a de Estações COMPARTILHAM (DRY). Mesmo molde de Panel.test.tsx.
const noop = () => {};

describe("InlineEdit — edição inline de nome (fonte única das 2 abas BLE)", () => {
  it("renderiza Input + Salvar + Cancelar", () => {
    const html = renderToStaticMarkup(
      <InlineEdit value="Doca 3" onChange={noop} onSave={noop} onCancel={noop} ariaLabel="Nome" />,
    );
    expect(html).toContain("<input");
    expect(html).toContain(">Salvar<");
    expect(html).toContain(">Cancelar<");
    // valor não-vazio, não salvando → Salvar HABILITADO. Checa o ATRIBUTO disabled="", não a
    // substring "disabled" (as classes do Button carregam variantes `disabled:opacity-45`).
    expect(html).not.toContain('disabled=""');
  });

  it("saving: o botão vira 'Salvando…' e desabilita", () => {
    const html = renderToStaticMarkup(
      <InlineEdit value="x" onChange={noop} onSave={noop} onCancel={noop} saving ariaLabel="n" />,
    );
    expect(html).toContain(">Salvando…<");
    expect(html).toContain('disabled=""');
  });

  it("valor só-espaços desabilita Salvar (não grava rascunho vazio)", () => {
    const html = renderToStaticMarkup(
      <InlineEdit value="   " onChange={noop} onSave={noop} onCancel={noop} ariaLabel="n" />,
    );
    expect(html).toContain('disabled=""');
  });

  it("com label visível: renderiza o rótulo e liga por htmlFor (acessível)", () => {
    const html = renderToStaticMarkup(
      <InlineEdit
        value="x"
        onChange={noop}
        onSave={noop}
        onCancel={noop}
        label="Nome da estação"
      />,
    );
    expect(html).toContain("Nome da estação");
    expect(html).toContain("for="); // <label htmlFor> → for=
  });

  it("sem label: aria-label no Input", () => {
    const html = renderToStaticMarkup(
      <InlineEdit value="x" onChange={noop} onSave={noop} onCancel={noop} ariaLabel="Nome da tag" />,
    );
    expect(html).toContain('aria-label="Nome da tag"');
  });
});
