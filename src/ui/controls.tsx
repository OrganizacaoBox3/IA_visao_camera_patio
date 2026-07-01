import * as RSwitch from "@radix-ui/react-switch";
import * as RCheckbox from "@radix-ui/react-checkbox";
import * as RSlider from "@radix-ui/react-slider";
import * as Label from "@radix-ui/react-label";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  ariaLabel?: string;
} & Omit<
  ComponentPropsWithoutRef<typeof RSwitch.Root>,
  "checked" | "onCheckedChange" | "aria-label"
>;
export const Switch = forwardRef<ElementRef<typeof RSwitch.Root>, SwitchProps>(function Switch(
  { checked, onCheckedChange, ariaLabel, className, ...rest },
  ref,
) {
  return (
    <RSwitch.Root
      ref={ref}
      className={cx(
        // Tailwind (tokens mapeados no @theme). Tamanho fixo → nunca estica.
        "box-border inline-flex h-5 w-9 shrink-0 cursor-pointer items-center self-center rounded-full border border-border bg-panel-2 p-0.5 transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
        className,
      )}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={ariaLabel}
      {...rest}
    >
      <RSwitch.Thumb className="block h-3.5 w-3.5 rounded-full bg-text-dim transition-transform data-[state=checked]:translate-x-4 data-[state=checked]:bg-white" />
    </RSwitch.Root>
  );
});

type CheckboxProps = {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id?: string;
  ariaLabel?: string;
} & Omit<
  ComponentPropsWithoutRef<typeof RCheckbox.Root>,
  "checked" | "onCheckedChange" | "id" | "aria-label"
>;
export const Checkbox = forwardRef<ElementRef<typeof RCheckbox.Root>, CheckboxProps>(
  function Checkbox({ checked, onCheckedChange, id, ariaLabel, className, ...rest }, ref) {
    return (
      <RCheckbox.Root
        ref={ref}
        className={cx(
          "box-border inline-flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded border border-border bg-panel-2 p-0 transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-white",
          className,
        )}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        id={id}
        aria-label={ariaLabel}
        {...rest}
      >
        <RCheckbox.Indicator className="text-[12px] leading-none">✓</RCheckbox.Indicator>
      </RCheckbox.Root>
    );
  },
);

// Molécula: checkbox + rótulo clicável (associação acessível).
export function CheckboxRow({
  checked,
  onCheckedChange,
  children,
  id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  children: ReactNode;
  id: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} id={id} />
      <Label.Root htmlFor={id} className="cursor-pointer">
        {children}
      </Label.Root>
    </div>
  );
}

type SliderProps = {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
} & Omit<
  ComponentPropsWithoutRef<typeof RSlider.Root>,
  "value" | "onChange" | "onValueChange" | "min" | "max" | "step" | "defaultValue"
>;
export const Slider = forwardRef<ElementRef<typeof RSlider.Root>, SliderProps>(function Slider(
  { value, onChange, min = 0, max = 100, step = 1, ariaLabel, className, ...rest },
  ref,
) {
  return (
    <RSlider.Root
      ref={ref}
      className={cx("ui-slider", className)}
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0])}
      {...rest}
    >
      <RSlider.Track className="ui-slider-track">
        <RSlider.Range className="ui-slider-range" />
      </RSlider.Track>
      <RSlider.Thumb className="ui-slider-thumb" aria-label={ariaLabel ?? "valor"} />
    </RSlider.Root>
  );
});
