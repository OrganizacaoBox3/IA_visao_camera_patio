import * as RScrollArea from "@radix-ui/react-scroll-area";
import { forwardRef, type ReactNode, type ComponentPropsWithoutRef, type ElementRef } from "react";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

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
export const ScrollArea = forwardRef<ElementRef<typeof RScrollArea.Root>, ScrollAreaProps>(function ScrollArea(
  { children, orientation = "vertical", type = "hover", className, viewportClassName, ...rest }, ref
) {
  const vertical = orientation === "vertical" || orientation === "both";
  const horizontal = orientation === "horizontal" || orientation === "both";
  return (
    <RScrollArea.Root ref={ref} type={type} className={cx("ui-scroll", className)} {...rest}>
      <RScrollArea.Viewport className={cx("ui-scroll-vp", viewportClassName)}>{children}</RScrollArea.Viewport>
      {vertical && (
        <RScrollArea.Scrollbar orientation="vertical" className="ui-scrollbar">
          <RScrollArea.Thumb className="ui-scroll-thumb" />
        </RScrollArea.Scrollbar>
      )}
      {horizontal && (
        <RScrollArea.Scrollbar orientation="horizontal" className="ui-scrollbar">
          <RScrollArea.Thumb className="ui-scroll-thumb" />
        </RScrollArea.Scrollbar>
      )}
      {orientation === "both" && <RScrollArea.Corner className="ui-scroll-corner" />}
    </RScrollArea.Root>
  );
});
