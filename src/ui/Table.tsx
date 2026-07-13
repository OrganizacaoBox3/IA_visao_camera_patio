import { type ReactNode, type ThHTMLAttributes } from "react";
import { ScrollArea } from "./ScrollArea";
import { cx } from "./cx";

// Átomo Table da casa — formaliza o padrão .rtable (index.css) com semântica correta
// POR CONSTRUÇÃO: cabeçalho com th scope="col", nome acessível (ariaLabel/caption) e
// rolagem INTERNA (regra A12: o min-width do .rtable + ScrollArea "both" rolam a tabela
// DENTRO da caixa — a página nunca ganha scroll horizontal; gate e2e mobile-390).
// A implementação REUSA a classe .rtable (mesma densidade 6/8px, th sticky, linhas por
// borda) — o átomo é a API semântica, não um CSS novo. Matrizes com estilo próprio
// (ex.: .obj-matrix) ficam fora: lá o ganho de semântica vem de usar <Th> direto.
//
// Dois jeitos de usar (desenhados p/ migrar as tabelas cruas com o MENOR diff):
//   1) `columns` gera o <thead> correto — o corpo segue JSX livre:
//        <Table ariaLabel="Usuários" className="min-h-[200px] flex-1"
//               columns={[{ label: "Usuário", className: "w-full" }, …]}>
//          <tbody>…</tbody>
//        </Table>
//   2) children 100% semânticos, com <Th> garantindo o scope:
//        <Table caption="Eventos"><thead><tr><Th>Hora</Th>…</tr></thead><tbody>…</tbody></Table>

export type TableColumn = {
  label: ReactNode;
  /** classes do <th> (ex.: "w-full" absorve a largura livre; "whitespace-nowrap text-right") */
  className?: string;
  /** chave estável da coluna (default: índice) */
  key?: string;
};

export function Table({
  columns,
  caption,
  ariaLabel,
  minWidth,
  className,
  tableClassName,
  children,
}: {
  /** Gera o <thead> com th scope="col". Omita para thead custom via <Th>. */
  columns?: TableColumn[];
  /** Legenda acessível da tabela (renderiza <caption> visually-hidden — visual intocado). */
  caption?: ReactNode;
  /** Alternativa curta ao caption (aria-label no <table>). */
  ariaLabel?: string;
  /** Override do min-width herdado do .rtable (560px) quando a tabela pede outra largura. */
  minWidth?: number | string;
  /** Classes do CONTAINER de rolagem (altura/flex vêm do layout da página, ex.: "flex-1"). */
  className?: string;
  /** Classes extras do <table>. */
  tableClassName?: string;
  children: ReactNode;
}) {
  return (
    <ScrollArea orientation="both" className={className}>
      <table
        className={cx("rtable", tableClassName)}
        aria-label={ariaLabel}
        style={minWidth !== undefined ? { minWidth } : undefined}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        {columns && (
          <thead>
            <tr>
              {columns.map((c, i) => (
                <Th key={c.key ?? i} className={c.className}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
        )}
        {children}
      </table>
    </ScrollArea>
  );
}

// <th> com scope="col" por padrão (semântica por construção); overridável p/ "row"
// quando a célula é cabeçalho de LINHA (ex.: a coluna Setor de uma matriz).
export function Th({ scope = "col", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope={scope} {...rest} />;
}

// Linha de estado-vazio padrão das tabelas da casa (colSpan + .empty-note — a mesma
// fórmula que EventsTable/NotificacoesTab já usam hoje).
export function TableEmpty({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="empty-note">
        {children}
      </td>
    </tr>
  );
}
