import { forwardRef, type ButtonHTMLAttributes, type Ref } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cx } from "./cx";

type Variant = "default" | "primary" | "danger" | "ghost";
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md";
  active?: boolean;
  block?: boolean;
  asChild?: boolean;
};

// Tailwind v4 (tokens mapeados no @theme; hex literais = valores que NÃO são tokens no going-gray).
// Estrutura por grupos SEM propriedade duplicada entre grupos (Tailwind resolve conflito por ordem
// de geração, não pela ordem no className) → cada botão recebe exatamente uma classe por propriedade.
const BTN_BASE = cx(
  "box-border inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap no-underline",
  "[font-family:var(--sans)] font-medium leading-none",
  "rounded-[6px] border",
  "transition-[background-color,border-color,opacity] duration-[120ms]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
  "disabled:opacity-45 disabled:cursor-not-allowed",
);

// bg/hover/borda/cor por variante (uma só declaração de cada por botão → sem colisão de utilities).
// Tints via tokens do @theme (--ctrl-bg/--accent-bg/--danger-bg em index.css :root) —
// mesmos valores dos hexes antigos; a fonte da cor mudou, a cor renderizada não.
const BTN_VARIANT: Record<Variant, string> = {
  default: "bg-ctrl-bg text-text border-border hover:bg-ctrl-bg-hover",
  primary:
    "bg-accent-bg text-[var(--state-info-fg)] border-accent-border hover:bg-accent-bg-hover",
  danger:
    "bg-danger-bg text-[var(--state-critical-fg)] border-[var(--state-critical-border)] hover:bg-danger-bg-hover",
  ghost: "bg-transparent text-text border-transparent hover:bg-panel",
};

// altura/padding/fonte por tamanho (sm ganha alvo de toque ≥44px em <=640px, WCAG 2.5.5).
const BTN_SIZE: Record<NonNullable<ButtonProps["size"]>, string> = {
  md: "h-[34px] px-3 text-body",
  sm: "h-7 px-2 text-sec max-[640px]:min-h-[44px]",
};

// active: contorno de foco/seleção (equivale a outline: 2px solid var(--accent); offset 1px).
const OUTLINE_ACTIVE = "outline-2 outline-accent outline-offset-1";

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "default", size = "md", active, block, asChild, className, type, ...rest },
  ref,
) {
  const cls = cx(
    BTN_BASE,
    BTN_VARIANT[variant],
    BTN_SIZE[size],
    active && OUTLINE_ACTIVE,
    block && "w-full",
    className,
  );
  // asChild: compõe estilo no filho (ex.: <Button asChild><a/></Button> ou Trigger de Dialog/Tooltip/DropdownMenu).
  if (asChild) return <Slot ref={ref as Ref<HTMLElement>} className={cls} {...rest} />;
  return <button ref={ref} type={type ?? "button"} className={cls} {...rest} />;
});

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
  asChild?: boolean;
};

// Botão quadrado (34px) só-ícone. Só a cor de fundo transiciona (como .ui-iconbtn).
const ICONBTN_BASE = cx(
  "box-border inline-flex items-center justify-center size-[34px] cursor-pointer",
  "rounded-[6px] border border-border bg-ctrl-bg text-text",
  "transition-[background-color] duration-[120ms]",
  "hover:bg-ctrl-bg-hover",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
  "disabled:opacity-45 disabled:cursor-not-allowed",
  "max-[640px]:min-w-[44px] max-[640px]:min-h-[44px]",
);

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, active, asChild, className, type, children, ...rest },
  ref,
) {
  const cls = cx(ICONBTN_BASE, active && OUTLINE_ACTIVE, className);
  if (asChild)
    return (
      <Slot ref={ref as Ref<HTMLElement>} aria-label={label} className={cls} {...rest}>
        {children}
      </Slot>
    );
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cls}
      {...rest}
    >
      {children}
    </button>
  );
});
