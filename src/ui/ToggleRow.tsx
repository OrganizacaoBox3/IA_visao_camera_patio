import { type ReactNode } from "react";
import { Switch } from "./controls";

// Átomo DRY: uma linha "rótulo (+ dica opcional) · Switch". Reúne o padrão repetido
// de listas de toggles (camadas, preferências) num componente único e consistente.
export function ToggleRow({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border py-2 last:border-b-0">
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-text">{label}</span>
        {hint && <span className="text-[11px] text-text-dim">{hint}</span>}
      </span>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        ariaLabel={typeof label === "string" ? label : undefined}
      />
    </div>
  );
}
