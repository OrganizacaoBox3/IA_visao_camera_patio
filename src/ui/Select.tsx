import * as RSelect from "@radix-ui/react-select";
import { forwardRef, type ReactNode, type ElementRef } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export type SelectOption = { value: string; label: ReactNode };

// Wrapper do Radix Select com API por array (cobre os dezenas de <select> do app, DRY).
// `forwardRef` encaminha p/ o Trigger (DOM) → compõe com Tooltip/DropdownMenu.
// Estilo migrado de .ui-select* (ui.css) para utilities Tailwind (tokens @theme). Visual idêntico.
export const Select = forwardRef<
  ElementRef<typeof RSelect.Trigger>,
  {
    value: string;
    onChange: (v: string) => void;
    options: SelectOption[];
    placeholder?: string;
    ariaLabel?: string;
    className?: string;
    disabled?: boolean;
  }
>(function Select({ value, onChange, options, placeholder, ariaLabel, className, disabled }, ref) {
  return (
    <RSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RSelect.Trigger
        ref={ref}
        className={cx(
          "inline-flex h-[var(--ui-ctrl-h)] min-w-[120px] cursor-pointer items-center justify-between gap-2",
          "rounded-sm border border-border bg-panel-2 pl-3 pr-2 text-[13px] text-text [font-family:var(--sans)]",
          "data-[placeholder]:text-text-muted",
          "focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--accent)]",
          className,
        )}
        aria-label={ariaLabel}
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="text-text-muted">▾</RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          className={cx(
            "z-[150] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-sm",
            "border border-border bg-panel shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
            // portado p/ o body; garante clique mesmo dentro de Dialog modal
            "pointer-events-auto",
          )}
          position="popper"
          sideOffset={4}
        >
          <RSelect.Viewport className="p-1">
            {options.map((o) => (
              <RSelect.Item
                key={o.value}
                value={o.value}
                className={cx(
                  "flex cursor-pointer select-none items-center gap-2 rounded-[4px] px-2 py-1",
                  "text-[13px] text-text outline-none",
                  "data-[highlighted]:bg-[#0b3a4a] data-[highlighted]:text-[var(--state-info-fg)]",
                  "data-[state=checked]:font-semibold",
                )}
              >
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator>✓</RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
});
