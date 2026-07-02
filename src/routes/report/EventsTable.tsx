import { type ReactNode } from "react";
import { ScrollArea } from "../../ui";

// Tabela de eventos (.rtable em ScrollArea) reutilizada por Atividade/Leitura/Objetos/Fadiga.
// `renderCells` devolve os <td> de uma linha; o cabeçalho e o estado-vazio são padronizados.
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
    <section className="panel panel-events">
      <h3>{title}</h3>
      <ScrollArea className="rep-tablescroll">
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
