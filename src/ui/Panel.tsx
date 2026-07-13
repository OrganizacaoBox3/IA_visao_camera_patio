import { type ReactNode } from "react";
import { cx } from "./cx";
import { SectionTitle } from "./SectionTitle";

// Formaliza o padrão legado `.panel` (index.css) como átomo SEMÂNTICO: <section> com
// heading embutido (<h2> via SectionTitle). NÃO reescreve o CSS — reusa a classe .panel
// (superfície --panel, borda, radius 10, padding --sp-4); o átomo é a API, não estilo novo.
// Uso canônico:  <Panel title="Presença por setor" className="flex-1">…</Panel>
// Título custom (flush/composto)? Omita `title` e componha o SectionTitle nos children.
export function Panel({
  title,
  className,
  children,
}: {
  /** Título de seção (vira <h2> via SectionTitle). */
  title?: ReactNode;
  /** Classes extras do <section> (layout da página, ex.: "flex-1 flex flex-col"). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx("panel", className)}>
      {title && <SectionTitle>{title}</SectionTitle>}
      {children}
    </section>
  );
}
