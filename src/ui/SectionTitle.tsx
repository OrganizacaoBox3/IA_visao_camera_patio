import type { ReactNode } from "react";
import { cx } from "./cx";

// Título de seção padrão da casa: <h2> SEMÂNTICO com o visual do antigo h3 de painel
// (.panel h3/.side h3): label 11px uppercase, tracking 0.12em, text-muted, margem
// inferior 12px por padrão. `flush` remove a margem (ex.: dentro de toolbar/header).
// text-label == var(--fs-label) == 11px → visual idêntico ao text-[11px] de chrome.tsx.
export function SectionTitle({
  children,
  className,
  flush,
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean; // sem a margem inferior padrão (ex.: dentro de toolbar)
}) {
  return (
    <h2
      className={cx(
        "m-0",
        !flush && "mb-3",
        "text-label font-bold uppercase tracking-[0.12em] text-text-muted",
        className,
      )}
    >
      {children}
    </h2>
  );
}
