import { type ReactNode } from "react";
import { ScrollArea } from "../../ui";
import { SectionTitle } from "./chrome";

// Tabela de eventos (.rtable em ScrollArea) reutilizada por Atividade/Leitura/Objetos/Fadiga.
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
      <ScrollArea className="rep-tablescroll" orientation="both">
        <table className="rtable">
          <thead>
            <tr>
              {headers.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>{renderCells(r)}</tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={headers.length} className="empty-note">
                  {emptyNote}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollArea>
    </section>
  );
}
