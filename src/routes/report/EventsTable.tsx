import { type ReactNode } from "react";
import { Table, TableEmpty } from "../../ui";
import { SectionTitle } from "./chrome";

// Tabela de eventos (átomo Table da casa — th scope="col" por construção + rolagem interna,
// regra A12) reutilizada por Atividade/Leitura/Objetos/Fadiga.
// `renderCells` devolve os <td> de uma linha; o cabeçalho e o estado-vazio são padronizados.
// `flex-1`: o painel PREENCHE o tabpanel (coluna flex) quando há pouca linha; com muitas,
// mantém a altura natural e o tabpanel rola (min-height:auto — contrato "rola, não corta").
export function EventsTable<T>({
  title,
  headers,
  rows,
  emptyNote,
  renderCells,
}: {
  title: ReactNode;
  headers: string[];
  rows: T[];
  emptyNote: string;
  renderCells: (row: T) => ReactNode;
}) {
  return (
    <section className="panel panel-events flex-1">
      <SectionTitle>{title}</SectionTitle>
      {/* Hint de rolagem: some no desktop; no estreito a tabela (min-width) rola
          DENTRO da caixa (overflow-x), sem empurrar a página. */}
      <div className="rep-scrollhint" aria-hidden="true">
        deslize a tabela para o lado →
      </div>
      <Table className="rep-tablescroll" columns={headers.map((h) => ({ key: h, label: h }))}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{renderCells(r)}</tr>
          ))}
          {rows.length === 0 && <TableEmpty colSpan={headers.length}>{emptyNote}</TableEmpty>}
        </tbody>
      </Table>
    </section>
  );
}
