import * as Toggle from "@radix-ui/react-toggle-group";
import { forwardRef, type ReactNode, type ElementRef, type ForwardedRef } from "react";

export type SegOption<T extends string> = { value: T; label: ReactNode };

type SegProps<T extends string> = {
  value: T;
  onChange: (v: T) => void;
  options: SegOption<T>[];
  ariaLabel?: string;
};

// Controle segmentado acessível (ToggleGroup single). Substitui os .seg bespoke.
function SegmentedControlInner<T extends string>(
  { value, onChange, options, ariaLabel }: SegProps<T>,
  ref: ForwardedRef<ElementRef<typeof Toggle.Root>>,
) {
  return (
    <Toggle.Root
      ref={ref}
      type="single"
      className={
        // Container: inline-flex, fundo var(--panel), borda var(--border), raio --radius-sm, recorta cantos.
        // Responsivo (≤640px): permite rolagem horizontal (replica .ui-seg do ui.css).
        "inline-flex overflow-hidden rounded-sm border border-border bg-panel " +
        "max-sm:max-w-full max-sm:overflow-x-auto"
      }
      value={value}
      aria-label={ariaLabel}
      onValueChange={(v) => {
        if (v) onChange(v as T);
      }}
    >
      {options.map((o) => (
        <Toggle.Item
          key={o.value}
          value={o.value}
          className={
            // Item: 12px, padding lateral var(--sp-3), altura 30px, transparente, texto atenuado.
            "inline-flex h-[30px] cursor-pointer items-center border-none bg-transparent px-3 text-[12px] text-text-dim " +
            // Hover: texto pleno.
            "hover:text-text " +
            // Foco visível (replica var(--ui-focus): anel accent com offset na cor do fundo).
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg " +
            // Selecionado (data-state=on): fundo #0b3a4a, texto var(--state-info-fg). Réplica exata do ui.css.
            "data-[state=on]:bg-[#0b3a4a] data-[state=on]:text-[var(--state-info-fg)] " +
            // Alvo de toque ≥44px em telas estreitas (WCAG 2.5.5).
            "max-sm:min-h-[44px]"
          }
        >
          {o.label}
        </Toggle.Item>
      ))}
    </Toggle.Root>
  );
}

// forwardRef preservando a genérica (cast no tipo do export, sem alterar a API de chamada).
export const SegmentedControl = forwardRef(SegmentedControlInner) as <T extends string>(
  props: SegProps<T> & { ref?: ForwardedRef<ElementRef<typeof Toggle.Root>> },
) => ReturnType<typeof SegmentedControlInner>;
