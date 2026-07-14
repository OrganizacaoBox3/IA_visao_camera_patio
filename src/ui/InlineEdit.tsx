import { useId } from "react";
import { Button } from "./Button";
import { Input, Field } from "./form";

// Molécula InlineEdit — edição inline de nome: Input + Salvar + Cancelar, com Enter (salva) e Escape
// (cancela). DRY: era reimplementada IDÊNTICA na lista de Tags e na de Estações da tela BLE (o mesmo
// estado de rascunho, os mesmos dois botões, os mesmos atalhos). O ESTADO (qual linha edita, o valor,
// o `saving`) mora no container; esta molécula é só a apresentação + os atalhos de teclado.
//
// Acessibilidade: com `label` visível, gera um id estável (useId) e liga rótulo↔controle via
// htmlFor (o <Field> da casa); sem `label`, usa `ariaLabel` no Input.
export function InlineEdit({
  value,
  onChange,
  onSave,
  onCancel,
  saving = false,
  placeholder,
  ariaLabel,
  label,
  inputClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  placeholder?: string;
  /** aria-label do Input quando NÃO há rótulo visível. */
  ariaLabel?: string;
  /** Rótulo visível (envolve o Input num <Field> com associação acessível); ausente = só aria-label. */
  label?: string;
  /** Classes extras do Input (ex.: largura fixa). */
  inputClassName?: string;
}) {
  const id = useId();
  const disabled = saving || !value.trim();
  const input = (
    <Input
      id={label ? id : undefined}
      value={value}
      placeholder={placeholder}
      aria-label={label ? undefined : ariaLabel}
      autoFocus
      className={inputClassName}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !disabled) onSave();
        if (e.key === "Escape") onCancel();
      }}
    />
  );
  return (
    <div className="flex flex-wrap items-end gap-2">
      {label ? (
        <Field label={label} htmlFor={id}>
          {input}
        </Field>
      ) : (
        input
      )}
      <Button size="sm" variant="primary" disabled={disabled} onClick={onSave}>
        {saving ? "Salvando…" : "Salvar"}
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
    </div>
  );
}
