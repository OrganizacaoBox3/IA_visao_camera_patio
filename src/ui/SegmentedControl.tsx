import * as Toggle from "@radix-ui/react-toggle-group";
import { forwardRef, type ReactNode, type ElementRef, type ForwardedRef } from "react";

export type SegOption<T extends string> = { value: T; label: ReactNode };

type SegProps<T extends string> = { value: T; onChange: (v: T) => void; options: SegOption<T>[]; ariaLabel?: string };

// Controle segmentado acessível (ToggleGroup single). Substitui os .seg bespoke.
function SegmentedControlInner<T extends string>(
  { value, onChange, options, ariaLabel }: SegProps<T>, ref: ForwardedRef<ElementRef<typeof Toggle.Root>>
) {
  return (
    <Toggle.Root ref={ref} type="single" className="ui-seg" value={value} aria-label={ariaLabel} onValueChange={(v) => { if (v) onChange(v as T); }}>
      {options.map((o) => (
        <Toggle.Item key={o.value} value={o.value} className="ui-seg-item">{o.label}</Toggle.Item>
      ))}
    </Toggle.Root>
  );
}

// forwardRef preservando a genérica (cast no tipo do export, sem alterar a API de chamada).
export const SegmentedControl = forwardRef(SegmentedControlInner) as <T extends string>(
  props: SegProps<T> & { ref?: ForwardedRef<ElementRef<typeof Toggle.Root>> }
) => ReturnType<typeof SegmentedControlInner>;
