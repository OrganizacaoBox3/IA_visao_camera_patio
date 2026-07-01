import { type ReactNode } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// Cabeçalho de página padrão: título como <h1> (hierarquia de leitura correta) + ações à direita.
// Estilo migrado de .page-head/.page-head-titles/.page-title/.page-sub/.spacer (index.css + ui.css)
// para utilities Tailwind (tokens @theme). Visual idêntico ao efetivo renderizado
// (título 14px/600 — index.css vence a fonte sobre ui.css; sub 12px muted; header em panel-2).
const HEAD = cx(
  "flex items-center gap-3 px-3 py-2 bg-panel-2 border-b border-border",
  // ≤640px: quebra em linhas e reduz o gap (réplica do @media do index.css).
  "max-[640px]:flex-wrap max-[640px]:gap-2",
);

export function PageHeader({
  title,
  subtitle,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx(HEAD, className)}>
      <div className="flex flex-col gap-px min-w-0">
        <h1 className="m-0 text-[14px] font-semibold text-text">{title}</h1>
        {subtitle && <p className="m-0 text-[12px] text-text-muted">{subtitle}</p>}
      </div>
      <div className="flex-1" />
      {children}
    </header>
  );
}
