import { type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Tooltip } from "./Tooltip";

// "?" de ajuda — degrau 3 da hierarquia de ajuda da casa (label → placeholder → tooltip "?" →
// nunca parágrafo permanente no meio da UI). Gatilho = botão real (focável; o Radix abre no
// foco → acessível por teclado; aria-label estável).
// CANÔNICO (Onda B da simplificação): este é o átomo do barrel. As duas cópias legadas
// (routes/cameras/HelpTip.tsx e o padrão equivalente em routes/users) migram para cá em onda
// própria — não importar de lá.
export function HelpTip({ label = "Ajuda", children }: { label?: string; children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <button
        type="button"
        aria-label={label}
        className={
          "ui-help inline-flex cursor-help items-center justify-center border-0 bg-transparent p-0 " +
          "align-middle text-text-muted hover:text-text " +
          "focus-visible:rounded-[var(--radius-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        }
      >
        <CircleHelp size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
}
