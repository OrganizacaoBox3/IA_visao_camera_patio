import * as RScrollArea from "@radix-ui/react-scroll-area";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { cx } from "./cx";

/* Tailwind v4 (tokens mapeados no @theme — ADR-008). Replica EXATO os antigos
   `.ui-scroll/.ui-scroll-vp/.ui-scrollbar/.ui-scroll-thumb/.ui-scroll-corner` do ui.css:
   viewport 100% herdando o raio; barra 10px com track transparente (panel-2 no hover);
   thumb pílula na cor da borda (text-muted no hover). Estados via data-[orientation]. */

const ROOT_CLS = "overflow-hidden";
const VIEWPORT_CLS = "size-full rounded-[inherit]";
const SCROLLBAR_CLS = cx(
  "flex touch-none select-none bg-transparent p-[2px]",
  "transition-[background-color] duration-[120ms] hover:bg-panel-2",
  "data-[orientation=vertical]:w-[10px]",
  "data-[orientation=horizontal]:h-[10px] data-[orientation=horizontal]:flex-col",
);
const THUMB_CLS = "relative flex-1 rounded-full bg-border hover:bg-text-muted";
const CORNER_CLS = "bg-transparent";

export type ScrollAreaProps = {
  children: ReactNode;
  /** Eixos de rolagem com scrollbar estilizada (default: "vertical"). */
  orientation?: "vertical" | "horizontal" | "both";
  /** Visibilidade da scrollbar Radix (default: "hover"). */
  type?: ComponentPropsWithoutRef<typeof RScrollArea.Root>["type"];
  className?: string;
  viewportClassName?: string;
} & Omit<ComponentPropsWithoutRef<typeof RScrollArea.Root>, "type" | "children" | "className">;

// Área rolável com scrollbar estilizada (cross-browser) preservando rolagem nativa por teclado/touch.
export const ScrollArea = forwardRef<ElementRef<typeof RScrollArea.Root>, ScrollAreaProps>(
  function ScrollArea(
    { children, orientation = "vertical", type = "hover", className, viewportClassName, ...rest },
    ref,
  ) {
    const vertical = orientation === "vertical" || orientation === "both";
    const horizontal = orientation === "horizontal" || orientation === "both";
    return (
      <RScrollArea.Root ref={ref} type={type} className={cx(ROOT_CLS, className)} {...rest}>
        <RScrollArea.Viewport className={cx(VIEWPORT_CLS, viewportClassName)}>
          {children}
        </RScrollArea.Viewport>
        {vertical && (
          <RScrollArea.Scrollbar orientation="vertical" className={SCROLLBAR_CLS}>
            <RScrollArea.Thumb className={THUMB_CLS} />
          </RScrollArea.Scrollbar>
        )}
        {horizontal && (
          <RScrollArea.Scrollbar orientation="horizontal" className={SCROLLBAR_CLS}>
            <RScrollArea.Thumb className={THUMB_CLS} />
          </RScrollArea.Scrollbar>
        )}
        {orientation === "both" && <RScrollArea.Corner className={CORNER_CLS} />}
      </RScrollArea.Root>
    );
  },
);
