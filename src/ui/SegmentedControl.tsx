import * as Toggle from "@radix-ui/react-toggle-group";
import { type ReactNode } from "react";

export type SegOption<T extends string> = { value: T; label: ReactNode };

// Controle segmentado acessível (ToggleGroup single). Substitui os .seg bespoke.
export function SegmentedControl<T extends string>({ value, onChange, options, ariaLabel }: {
  value: T; onChange: (v: T) => void; options: SegOption<T>[]; ariaLabel?: string;
}) {
  return (
    <Toggle.Root type="single" className="ui-seg" value={value} aria-label={ariaLabel} onValueChange={(v) => { if (v) onChange(v as T); }}>
      {options.map((o) => (
        <Toggle.Item key={o.value} value={o.value} className="ui-seg-item">{o.label}</Toggle.Item>
      ))}
    </Toggle.Root>
  );
}
