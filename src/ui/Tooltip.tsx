import * as RTooltip from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";

// Coloque <TooltipProvider> uma vez na raiz; use <Tooltip> em volta de qualquer gatilho.
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RTooltip.Provider delayDuration={300}>{children}</RTooltip.Provider>;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="ui-tooltip" sideOffset={6}>
          {content}
          <RTooltip.Arrow className="ui-tooltip-arrow" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
