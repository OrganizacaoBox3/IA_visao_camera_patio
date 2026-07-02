import * as RTabs from "@radix-ui/react-tabs";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/* Tailwind v4 (tokens mapeados no @theme — ADR-008). Replica EXATO os antigos
   `.ui-tabs/.ui-tablist/.ui-tab/.ui-tabpanel` do ui.css. Sem preflight: `border-0` +
   `border-solid` são explícitos (UA de div tem style none; de button, 2px outset).
   Foco = duplo anel (ring-offset bg + ring accent ≡ var(--ui-focus)), como Toggle/Button. */

const ROOT_CLS = "flex min-h-0 flex-col";

/* `ui-tablist`/`ui-tabpanel` permanecem como MARCADORES (sem estilo próprio pós-migração):
   cine.css depende deles (.cam-drawer .drawer-tabs .ui-tablist / .ui-tabpanel). */
const LIST_CLS = cx(
  "ui-tablist",
  "inline-flex gap-[2px] border-0 border-b border-solid border-border",
  "data-[orientation=vertical]:flex-col data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-r",
);

const TRIGGER_CLS = cx(
  "box-border cursor-pointer whitespace-nowrap bg-transparent",
  "[font-family:var(--sans)] text-[13px] text-text-dim",
  "border-0 border-b-2 border-solid border-transparent",
  "-mb-px px-[var(--sp-3)] py-[var(--sp-2)]",
  "transition-[color,border-color] duration-[120ms]",
  "hover:text-text",
  "data-[state=active]:border-b-accent data-[state=active]:text-[var(--state-info-fg)]",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
  "disabled:cursor-not-allowed disabled:opacity-45",
);

const CONTENT_CLS = cx(
  "ui-tabpanel",
  "min-h-0 outline-none",
  "focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
);

// ── Compound (baixo nível) — Radix faz ARIA tab/tabpanel + navegação por setas ──
const Root = forwardRef<ElementRef<typeof RTabs.Root>, ComponentPropsWithoutRef<typeof RTabs.Root>>(
  function TabsRoot({ className, ...rest }, ref) {
    return <RTabs.Root ref={ref} className={cx(ROOT_CLS, className)} {...rest} />;
  },
);

const List = forwardRef<ElementRef<typeof RTabs.List>, ComponentPropsWithoutRef<typeof RTabs.List>>(
  function TabsList({ className, ...rest }, ref) {
    return <RTabs.List ref={ref} className={cx(LIST_CLS, className)} {...rest} />;
  },
);

const Trigger = forwardRef<
  ElementRef<typeof RTabs.Trigger>,
  ComponentPropsWithoutRef<typeof RTabs.Trigger>
>(function TabsTrigger({ className, ...rest }, ref) {
  return <RTabs.Trigger ref={ref} className={cx(TRIGGER_CLS, className)} {...rest} />;
});

const Content = forwardRef<
  ElementRef<typeof RTabs.Content>,
  ComponentPropsWithoutRef<typeof RTabs.Content>
>(function TabsContentBase({ className, ...rest }, ref) {
  return <RTabs.Content ref={ref} className={cx(CONTENT_CLS, className)} {...rest} />;
});

export type TabItem = { value: string; label: ReactNode; disabled?: boolean };

type TabsProps = {
  items: TabItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  ariaLabel?: string;
  orientation?: "horizontal" | "vertical";
  className?: string;
  /** Os <TabsContent value=...> correspondentes a cada item. */
  children?: ReactNode;
};

// ── Alto nível — render da barra de abas a partir de `items`; painéis vêm como children ──
function TabsComponent({
  items,
  value,
  defaultValue,
  onValueChange,
  ariaLabel,
  orientation,
  className,
  children,
}: TabsProps) {
  return (
    <Root
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
      orientation={orientation}
      className={className}
    >
      <List aria-label={ariaLabel}>
        {items.map((it) => (
          <Trigger key={it.value} value={it.value} disabled={it.disabled}>
            {it.label}
          </Trigger>
        ))}
      </List>
      {children}
    </Root>
  );
}

export const Tabs = Object.assign(TabsComponent, { Root, List, Trigger, Content });
export const TabsContent = Content;
