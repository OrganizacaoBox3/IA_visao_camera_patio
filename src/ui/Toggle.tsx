import * as RToggle from "@radix-ui/react-toggle";
import * as RToggleGroup from "@radix-ui/react-toggle-group";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/* Tailwind (tokens mapeados no @theme). Replica EXATO o antigo `.ui-toggle`:
   base panel + text-dim, on = estado `info` (going-gray), foco = duplo anel (--ui-focus). */
const TOGGLE_CLS = cx(
  "box-border inline-flex h-[var(--ui-ctrl-h)] cursor-pointer items-center justify-center gap-[var(--sp-2)]",
  "whitespace-nowrap rounded-sm border border-border bg-panel px-[var(--sp-3)]",
  "font-[family-name:var(--sans)] text-[13px] font-medium text-text-dim",
  "transition-colors duration-[120ms]",
  "hover:text-text",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  "disabled:cursor-not-allowed disabled:opacity-45",
  "data-[state=on]:border-[var(--state-info-border)] data-[state=on]:bg-[var(--state-info-bg)] data-[state=on]:text-[var(--state-info-fg)]",
);

// ── Toggle — botão de estado (aria-pressed automático via Radix) ──
export const Toggle = forwardRef<
  ElementRef<typeof RToggle.Root>,
  ComponentPropsWithoutRef<typeof RToggle.Root>
>(function Toggle({ className, ...rest }, ref) {
  return <RToggle.Root ref={ref} className={cx(TOGGLE_CLS, className)} {...rest} />;
});

// ── ToggleGroup.Item (baixo nível) ──
export const ToggleGroupItem = forwardRef<
  ElementRef<typeof RToggleGroup.Item>,
  ComponentPropsWithoutRef<typeof RToggleGroup.Item>
>(function ToggleGroupItem({ className, ...rest }, ref) {
  return <RToggleGroup.Item ref={ref} className={cx(TOGGLE_CLS, className)} {...rest} />;
});

export type ToggleGroupOption = {
  value: string;
  label: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
};

type CommonProps = {
  items: ToggleGroupOption[];
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  orientation?: "horizontal" | "vertical";
};

type ToggleGroupProps =
  | (CommonProps & {
      type?: "single";
      value?: string;
      defaultValue?: string;
      onValueChange?: (value: string) => void;
    })
  | (CommonProps & {
      type: "multiple";
      value?: string[];
      defaultValue?: string[];
      onValueChange?: (value: string[]) => void;
    });

// ── ToggleGroup (alto nível) — single ou multiple, a partir de `items` ──
export function ToggleGroup(props: ToggleGroupProps) {
  const { items, ariaLabel, className, disabled, orientation } = props;
  const children = items.map((it) => (
    <ToggleGroupItem
      key={it.value}
      value={it.value}
      disabled={it.disabled}
      aria-label={it.ariaLabel}
    >
      {it.label}
    </ToggleGroupItem>
  ));
  const common = {
    className: cx(
      "inline-flex gap-[var(--sp-2)] data-[orientation=vertical]:flex-col",
      className,
    ),
    "aria-label": ariaLabel,
    disabled,
    orientation,
  };

  if (props.type === "multiple") {
    return (
      <RToggleGroup.Root
        type="multiple"
        value={props.value}
        defaultValue={props.defaultValue}
        onValueChange={props.onValueChange}
        {...common}
      >
        {children}
      </RToggleGroup.Root>
    );
  }
  return (
    <RToggleGroup.Root
      type="single"
      value={props.value}
      defaultValue={props.defaultValue}
      onValueChange={props.onValueChange}
      {...common}
    >
      {children}
    </RToggleGroup.Root>
  );
}

ToggleGroup.Item = ToggleGroupItem;
