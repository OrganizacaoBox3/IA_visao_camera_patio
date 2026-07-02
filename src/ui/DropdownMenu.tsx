import * as RDropdown from "@radix-ui/react-dropdown-menu";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// Estilo migrado de .ui-menu* (ui.css) para utilities Tailwind (tokens @theme). Visual idêntico.
const menuContentCls = cx(
  "z-[150] min-w-[180px] rounded-sm border border-border bg-panel p-1",
  "shadow-[0_12px_32px_rgba(0,0,0,0.5)]",
  // portado p/ o body; garante clique mesmo dentro de Dialog modal
  "pointer-events-auto",
);

const menuItemCls = cx(
  "flex cursor-pointer select-none items-center gap-2 rounded-[4px] px-2 py-1",
  "text-[13px] text-text outline-none",
  // highlight: tokens -bg/-fg não mapeados no @theme → var() literal (mesma decisão do Select)
  "data-[highlighted]:bg-[var(--state-info-bg)] data-[highlighted]:text-[var(--state-info-fg)]",
  "data-[danger]:text-[var(--state-critical-fg)]",
  "data-[danger]:data-[highlighted]:bg-[var(--state-critical-bg)]",
  "data-[danger]:data-[highlighted]:text-[var(--state-critical-fg)]",
  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45",
  "focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--accent)]",
);

// ── Compound (baixo nível) — Radix faz portal, teclado, foco e ARIA menu ──
const Root = RDropdown.Root;

const Trigger = forwardRef<
  ElementRef<typeof RDropdown.Trigger>,
  ComponentPropsWithoutRef<typeof RDropdown.Trigger>
>(function DMTrigger(props, ref) {
  return <RDropdown.Trigger ref={ref} {...props} />;
});

const Content = forwardRef<
  ElementRef<typeof RDropdown.Content>,
  ComponentPropsWithoutRef<typeof RDropdown.Content>
>(function DMContent({ className, sideOffset = 4, children, ...rest }, ref) {
  return (
    <RDropdown.Portal>
      <RDropdown.Content
        ref={ref}
        className={cx(menuContentCls, className)}
        sideOffset={sideOffset}
        {...rest}
      >
        {children}
      </RDropdown.Content>
    </RDropdown.Portal>
  );
});

type ItemProps = ComponentPropsWithoutRef<typeof RDropdown.Item> & { danger?: boolean };
const Item = forwardRef<ElementRef<typeof RDropdown.Item>, ItemProps>(function DMItem(
  { className, danger, ...rest },
  ref,
) {
  return (
    <RDropdown.Item
      ref={ref}
      className={cx(menuItemCls, className)}
      data-danger={danger ? "" : undefined}
      {...rest}
    />
  );
});

const Separator = forwardRef<
  ElementRef<typeof RDropdown.Separator>,
  ComponentPropsWithoutRef<typeof RDropdown.Separator>
>(function DMSeparator({ className, ...rest }, ref) {
  return (
    <RDropdown.Separator ref={ref} className={cx("my-1 h-px bg-border", className)} {...rest} />
  );
});

const MenuLabel = forwardRef<
  ElementRef<typeof RDropdown.Label>,
  ComponentPropsWithoutRef<typeof RDropdown.Label>
>(function DMLabel({ className, ...rest }, ref) {
  return (
    <RDropdown.Label
      ref={ref}
      className={cx(
        "px-2 py-1 text-[11px] uppercase tracking-[0.3px] text-text-muted",
        className,
      )}
      {...rest}
    />
  );
});

export type DropdownItem =
  | {
      type?: "item";
      label: ReactNode;
      onSelect?: () => void;
      disabled?: boolean;
      danger?: boolean;
      icon?: ReactNode;
    }
  | { type: "separator" }
  | { type: "label"; label: ReactNode };

type DropdownMenuProps = {
  /** Elemento gatilho (recebe asChild internamente — encaminhe a ref, ex.: <IconButton/>). */
  trigger: ReactNode;
  items: DropdownItem[];
  align?: RDropdown.DropdownMenuContentProps["align"];
  side?: RDropdown.DropdownMenuContentProps["side"];
  ariaLabel?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
};

// ── Alto nível — menu de ações a partir de `items` (ações por linha/toolbar) ──
function DropdownMenuComponent({
  trigger,
  items,
  align = "end",
  side,
  ariaLabel,
  open,
  defaultOpen,
  onOpenChange,
}: DropdownMenuProps) {
  return (
    <Root open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
      <Trigger asChild>{trigger}</Trigger>
      <Content align={align} side={side} aria-label={ariaLabel}>
        {items.map((it, i) => {
          if (it.type === "separator") return <Separator key={i} />;
          if (it.type === "label") return <MenuLabel key={i}>{it.label}</MenuLabel>;
          return (
            <Item key={i} disabled={it.disabled} danger={it.danger} onSelect={it.onSelect}>
              {it.icon}
              {it.label}
            </Item>
          );
        })}
      </Content>
    </Root>
  );
}

export const DropdownMenu = Object.assign(DropdownMenuComponent, {
  Root,
  Trigger,
  Content,
  Item,
  Separator,
  Label: MenuLabel,
});
