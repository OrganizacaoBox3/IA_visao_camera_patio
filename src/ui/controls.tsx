import * as RSwitch from "@radix-ui/react-switch";
import * as RCheckbox from "@radix-ui/react-checkbox";
import * as RSlider from "@radix-ui/react-slider";
import * as Label from "@radix-ui/react-label";
import { type ReactNode } from "react";

export function Switch({ checked, onCheckedChange, ariaLabel }: { checked: boolean; onCheckedChange: (v: boolean) => void; ariaLabel?: string }) {
  return (
    <RSwitch.Root className="ui-switch" checked={checked} onCheckedChange={onCheckedChange} aria-label={ariaLabel}>
      <RSwitch.Thumb className="ui-switch-thumb" />
    </RSwitch.Root>
  );
}

export function Checkbox({ checked, onCheckedChange, id, ariaLabel }: { checked: boolean; onCheckedChange: (v: boolean) => void; id?: string; ariaLabel?: string }) {
  return (
    <RCheckbox.Root className="ui-check" checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} id={id} aria-label={ariaLabel}>
      <RCheckbox.Indicator className="ui-check-ind">✓</RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

// Molécula: checkbox + rótulo clicável (associação acessível).
export function CheckboxRow({ checked, onCheckedChange, children, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; children: ReactNode; id: string }) {
  return (
    <div className="ui-checkrow">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} id={id} />
      <Label.Root htmlFor={id} style={{ cursor: "pointer" }}>{children}</Label.Root>
    </div>
  );
}

export function Slider({ value, onChange, min = 0, max = 100, step = 1, ariaLabel }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; ariaLabel?: string }) {
  return (
    <RSlider.Root className="ui-slider" value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])}>
      <RSlider.Track className="ui-slider-track"><RSlider.Range className="ui-slider-range" /></RSlider.Track>
      <RSlider.Thumb className="ui-slider-thumb" aria-label={ariaLabel ?? "valor"} />
    </RSlider.Root>
  );
}
