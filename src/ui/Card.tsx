import { type ReactNode } from "react";
import { cx } from "./cx";

// Átomo Card — superfície INTERATIVA: reusa a classe legada `.panel` (fundo --panel, borda, radius)
// e adiciona a afordância de clique (hover realça a borda no --accent, cursor pointer, anel de foco
// visível por teclado). DRY: unifica os "cards clicáveis" (tiles de câmera, cartões de zona/ranking)
// que reescreviam superfície + hover + foco à mão. É SÓ a superfície — tamanho/conteúdo vêm por
// className/children.
//
// `as="button"` (default quando há onClick) dá semântica de botão (teclado/AT de graça); `as="div"`
// para quando o pai já fornece a semântica interativa.
const CARD_INTERACTIVE = cx(
  "panel text-left w-full cursor-pointer",
  "transition-[border-color] duration-[120ms] hover:border-accent",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
);

export function Card({
  as,
  onClick,
  className,
  children,
  ...aria
}: {
  as?: "button" | "div";
  onClick?: () => void;
  className?: string;
  children: ReactNode;
} & React.AriaAttributes) {
  const tag = as ?? (onClick ? "button" : "div");
  const cls = cx(CARD_INTERACTIVE, className);
  if (tag === "button") {
    return (
      <button type="button" className={cls} onClick={onClick} {...aria}>
        {children}
      </button>
    );
  }
  return (
    <div className={cls} onClick={onClick} {...aria}>
      {children}
    </div>
  );
}
