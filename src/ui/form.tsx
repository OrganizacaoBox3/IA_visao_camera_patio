import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";
import * as Label from "@radix-ui/react-label";
import { cx } from "./cx";

// Base compartilhada por Input e Textarea (tokens mapeados no @theme).
// Replica .ui-input/.ui-textarea: fonte/tamanho/cor, superfície panel-2, borda,
// radius-sm, placeholder muted, estado inválido (aria-invalid) e foco em anel accent.
const fieldControlBase =
  "box-border font-[family-name:var(--sans)] text-[13px] text-text min-w-[180px] " +
  "bg-panel-2 border border-border rounded-sm placeholder:text-text-muted " +
  "aria-[invalid=true]:border-critical " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    // Altura fixa (34px = --ui-ctrl-h) e padding lateral 12px (--sp-3).
    return (
      <input ref={ref} className={cx(fieldControlBase, "h-[34px] px-3", className)} {...rest} />
    );
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  // width:100%, altura automática, padding 8px/12px, altura mínima 64px, resize vertical.
  return (
    <textarea
      ref={ref}
      className={cx(
        fieldControlBase,
        "w-full px-3 py-2 min-h-16 resize-y leading-[1.4]",
        className,
      )}
      {...rest}
    />
  );
});

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <Label.Root className="text-[12px] text-text-dim" htmlFor={htmlFor}>
      {children}
    </Label.Root>
  );
}

// Molécula: rótulo + controle + dica/erro, com associação acessível (htmlFor ↔ id do controle).
export function Field({
  label,
  hint,
  error,
  htmlFor,
  className,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    // Coluna com gap 4px (--sp-1). Dentro do Field, o controle ocupa a largura toda
    // (replica .ui-field > .ui-input/.ui-textarea { width:100%; min-width:0 }).
    <div
      className={cx(
        "flex flex-col gap-1 [&>input]:w-full [&>input]:min-w-0 [&>textarea]:min-w-0",
        className,
      )}
    >
      {label && <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>}
      {children}
      {error ? (
        <span className="text-[11px] text-critical">{error}</span>
      ) : hint ? (
        <span className="text-[11px] text-text-muted">{hint}</span>
      ) : null}
    </div>
  );
}
