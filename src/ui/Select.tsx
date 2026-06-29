import * as RSelect from "@radix-ui/react-select";
import { forwardRef, type ReactNode, type ElementRef } from "react";

export type SelectOption = { value: string; label: ReactNode };

// Wrapper do Radix Select com API por array (cobre os dezenas de <select> do app, DRY).
// `forwardRef` encaminha p/ o Trigger (DOM) → compõe com Tooltip/DropdownMenu.
export const Select = forwardRef<ElementRef<typeof RSelect.Trigger>, {
  value: string; onChange: (v: string) => void; options: SelectOption[];
  placeholder?: string; ariaLabel?: string; className?: string; disabled?: boolean;
}>(function Select({ value, onChange, options, placeholder, ariaLabel, className, disabled }, ref) {
  return (
    <RSelect.Root value={value} onValueChange={onChange} disabled={disabled}>
      <RSelect.Trigger ref={ref} className={`ui-select ${className ?? ""}`} aria-label={ariaLabel}>
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="ui-select-icon">▾</RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="ui-select-content" position="popper" sideOffset={4}>
          <RSelect.Viewport className="ui-select-viewport">
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="ui-select-item">
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
