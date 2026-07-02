import * as RTooltip from "@radix-ui/react-tooltip";
import { type ReactNode } from "react";

// Tailwind v4 (tokens do @theme; #0b1118 = tom próprio do tooltip, não mapeado → arbitrary).
// z-150 = acima do dialog content (101), abaixo do toast (200).
const TOOLTIP_CONTENT = [
  "bg-[#0b1118] text-text text-[12px]",
  "border border-border rounded-[var(--radius-sm)]",
  "px-2 py-1 max-w-[260px]",
  "shadow-[0_8px_20px_rgba(0,0,0,0.45)] z-[150]",
].join(" ");

// Coloque <TooltipProvider> uma vez na raiz; use <Tooltip> em volta de qualquer gatilho.
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RTooltip.Provider delayDuration={300}>{children}</RTooltip.Provider>;
}

export function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className={TOOLTIP_CONTENT} sideOffset={6}>
          {content}
          <RTooltip.Arrow className="fill-[#0b1118]" />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}
