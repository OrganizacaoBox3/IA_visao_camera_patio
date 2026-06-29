import * as RTabs from "@radix-ui/react-tabs";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

// ── Compound (baixo nível) — Radix faz ARIA tab/tabpanel + navegação por setas ──
const Root = forwardRef<ElementRef<typeof RTabs.Root>, ComponentPropsWithoutRef<typeof RTabs.Root>>(
  function TabsRoot({ className, ...rest }, ref) {
    return <RTabs.Root ref={ref} className={cx("ui-tabs", className)} {...rest} />;
  }
);

const List = forwardRef<ElementRef<typeof RTabs.List>, ComponentPropsWithoutRef<typeof RTabs.List>>(
  function TabsList({ className, ...rest }, ref) {
    return <RTabs.List ref={ref} className={cx("ui-tablist", className)} {...rest} />;
  }
);

const Trigger = forwardRef<ElementRef<typeof RTabs.Trigger>, ComponentPropsWithoutRef<typeof RTabs.Trigger>>(
  function TabsTrigger({ className, ...rest }, ref) {
    return <RTabs.Trigger ref={ref} className={cx("ui-tab", className)} {...rest} />;
  }
);

const Content = forwardRef<ElementRef<typeof RTabs.Content>, ComponentPropsWithoutRef<typeof RTabs.Content>>(
  function TabsContentBase({ className, ...rest }, ref) {
    return <RTabs.Content ref={ref} className={cx("ui-tabpanel", className)} {...rest} />;
  }
);

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
function TabsComponent({ items, value, defaultValue, onValueChange, ariaLabel, orientation, className, children }: TabsProps) {
  return (
    <Root value={value} defaultValue={defaultValue} onValueChange={onValueChange} orientation={orientation} className={className}>
      <List aria-label={ariaLabel}>
        {items.map((it) => (
          <Trigger key={it.value} value={it.value} disabled={it.disabled}>{it.label}</Trigger>
        ))}
      </List>
      {children}
    </Root>
  );
}

export const Tabs = Object.assign(TabsComponent, { Root, List, Trigger, Content });
export const TabsContent = Content;
