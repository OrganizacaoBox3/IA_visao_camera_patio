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
    <div className="ui-togglerow">
      <span className="ui-togglerow-txt">
        <span className="ui-togglerow-label">{label}</span>
        {hint && <span className="ui-togglerow-hint">{hint}</span>}
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
