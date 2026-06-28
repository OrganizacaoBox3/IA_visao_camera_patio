import { type ReactNode } from "react";

// Cabeçalho de página padrão: título como <h1> (hierarquia de leitura correta) + ações à direita.
export function PageHeader({ title, subtitle, children, className }: { title: ReactNode; subtitle?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={`page-head ${className ?? ""}`}>
      <div className="page-head-titles">
        <h1 className="page-title">{title}</h1>
        {subtitle && <p className="page-sub">{subtitle}</p>}
      </div>
      <div className="spacer" />
      {children}
    </header>
  );
}
