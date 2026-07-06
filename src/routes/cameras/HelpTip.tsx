import { type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Tooltip } from "../../ui";

// "?" de ajuda — degrau 3 da hierarquia de ajuda da casa (label → placeholder → tooltip ? →
// nunca parágrafo): o detalhe/explicação sai da superfície e mora num Tooltip (átomo Radix).
// Gatilho = botão real (focável; o Radix abre no foco → acessível por teclado, aria-label estável).
export function HelpTip({ label = "Ajuda", children }: { label?: string; children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <button type="button" className="cam-help" aria-label={label}>
        <CircleHelp size={14} strokeWidth={1.75} aria-hidden />
      </button>
    </Tooltip>
  );
}
