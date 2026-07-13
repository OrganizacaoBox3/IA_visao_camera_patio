import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Field, Input } from "./form";
import { Select } from "./Select";

// G1 — Field acessível (spec-padronizacao-interface §1): dica/erro ligados ao controle
// por aria-describedby, aria-invalid no filho quando há erro, erro com role="alert".
// SSR puro (renderToStaticMarkup): valida o HTML emitido sem jsdom/dep nova.

/** Extrai o valor de aria-describedby do primeiro elemento que o tiver. */
function describedByOf(html: string, tag: string): string | null {
  const m = html.match(new RegExp(`<${tag}[^>]*aria-describedby="([^"]+)"`));
  return m ? m[1] : null;
}

describe("Field (G1 — acessível)", () => {
  it("liga a dica ao controle por aria-describedby", () => {
    const html = renderToStaticMarkup(
      <Field label="Nome" hint="dica da casa">
        <Input defaultValue="" />
      </Field>,
    );
    const id = describedByOf(html, "input");
    expect(id).toBeTruthy();
    // o span da dica carrega o MESMO id referenciado pelo controle
    expect(html).toContain(`<span id="${id}"`);
    expect(html).toContain("dica da casa");
    // sem erro → sem aria-invalid
    expect(html).not.toContain("aria-invalid");
  });

  it("com erro: aria-invalid no controle, role=alert no erro, describedby → erro", () => {
    const html = renderToStaticMarkup(
      <Field label="URL" error="URL inválida">
        <Input defaultValue="" />
      </Field>,
    );
    expect(html).toMatch(/<input[^>]*aria-invalid="true"/);
    const id = describedByOf(html, "input");
    expect(id).toBeTruthy();
    expect(html).toContain(`<span id="${id}" role="alert"`);
    expect(html).toContain("URL inválida");
  });

  it("erro substitui a dica (comportamento vigente) e o describedby aponta só o visível", () => {
    const html = renderToStaticMarkup(
      <Field label="URL" hint="dica oculta" error="deu ruim">
        <Input defaultValue="" />
      </Field>,
    );
    expect(html).not.toContain("dica oculta");
    const id = describedByOf(html, "input");
    expect(html).toContain(`<span id="${id}" role="alert"`);
  });

  it("preserva um aria-describedby que o call-site já tenha posto (merge)", () => {
    const html = renderToStaticMarkup(
      <Field hint="dica">
        <Input defaultValue="" aria-describedby="externo" />
      </Field>,
    );
    const val = describedByOf(html, "input");
    expect(val).toBeTruthy();
    const ids = val!.split(" ");
    expect(ids[0]).toBe("externo");
    expect(ids).toHaveLength(2);
    expect(html).toContain(`<span id="${ids[1]}"`);
  });

  it("multi-filho (ex.: slider composto): não injeta, não quebra — erro segue anunciado", () => {
    const html = renderToStaticMarkup(
      <Field label="Sensibilidade" error="fora da faixa">
        <div className="cfg-slider">controle</div>
        <div aria-live="polite">estimativa</div>
      </Field>,
    );
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
    expect(html).toMatch(/role="alert"/);
  });

  it("API pública intocada: label/htmlFor seguem associando como antes", () => {
    const html = renderToStaticMarkup(
      <Field label="Usuário" htmlFor="login-user">
        <Input id="login-user" defaultValue="" />
      </Field>,
    );
    expect(html).toContain('for="login-user"');
    expect(html).toMatch(/<input[^>]*id="login-user"/);
  });

  it("Select dentro de Field: o Trigger (button) recebe o aria-describedby injetado", () => {
    const html = renderToStaticMarkup(
      <Field label="Zona" hint="escolha uma câmera antes">
        <Select
          value="a"
          onChange={() => {}}
          options={[{ value: "a", label: "A" }]}
          ariaLabel="Zona"
        />
      </Field>,
    );
    const id = describedByOf(html, "button");
    expect(id).toBeTruthy();
    expect(html).toContain(`<span id="${id}"`);
  });
});
