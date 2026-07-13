import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Table, TableEmpty, Th } from "./Table";

// G2 — átomo Table (spec-padronizacao-interface §1): th scope="col" por construção,
// nome acessível (ariaLabel/caption), rolagem interna (A12) reusando .rtable.

describe("Table (G2)", () => {
  it("columns gera thead com scope=col em TODO th + aria-label + .rtable", () => {
    const html = renderToStaticMarkup(
      <Table
        ariaLabel="Usuários"
        columns={[
          { label: "Usuário", className: "w-full" },
          { label: "Papel" },
          { label: "Ações", className: "text-right" },
        ]}
      >
        <tbody>
          <tr>
            <td>maria</td>
            <td>engenheiro</td>
            <td>—</td>
          </tr>
        </tbody>
      </Table>,
    );
    expect(html.match(/scope="col"/g)).toHaveLength(3);
    expect(html).toMatch(/<table[^>]*aria-label="Usuários"/);
    expect(html).toMatch(/<table[^>]*class="rtable"/);
    // classes de coluna chegam ao th (w-full absorve a largura livre)
    expect(html).toMatch(/<th[^>]*class="w-full"/);
  });

  it("rolagem é INTERNA: a tabela vive dentro do viewport da ScrollArea (overflow-hidden)", () => {
    const html = renderToStaticMarkup(
      <Table columns={[{ label: "A" }]} className="flex-1">
        <tbody />
      </Table>,
    );
    // container (root da ScrollArea) envolve a tabela e corta overflow — a página não rola
    const rootIdx = html.indexOf("overflow-hidden");
    const tableIdx = html.indexOf("<table");
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThan(rootIdx);
    expect(html).toContain("flex-1");
  });

  it("caption renderiza visually-hidden; minWidth vira style no table", () => {
    const html = renderToStaticMarkup(
      <Table caption="Eventos do período" minWidth={480}>
        <tbody />
      </Table>,
    );
    expect(html).toMatch(/<caption class="sr-only">Eventos do período<\/caption>/);
    expect(html).toMatch(/<table[^>]*min-width:\s*480px/);
  });

  it("Th: scope=col por padrão, overridável p/ cabeçalho de linha", () => {
    expect(renderToStaticMarkup(<Th>Hora</Th>)).toContain('scope="col"');
    expect(renderToStaticMarkup(<Th scope="row">Setor</Th>)).toContain('scope="row"');
  });

  it("TableEmpty: colSpan + .empty-note (a fórmula das tabelas atuais)", () => {
    const html = renderToStaticMarkup(
      <table>
        <tbody>
          <TableEmpty colSpan={5}>Nenhum destinatário avulso.</TableEmpty>
        </tbody>
      </table>,
    );
    // React 19 emite o atributo como `colSpan` no SSR — casa nas duas grafias
    expect(html).toMatch(/<td colspan="5" class="empty-note">Nenhum destinatário avulso\./i);
  });
});
