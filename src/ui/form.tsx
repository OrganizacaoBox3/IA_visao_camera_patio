import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useId,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
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

// Injeta aria-describedby/aria-invalid no controle quando children é UM único elemento
// (Input/Textarea/Select…) — o caminho comum de todos os call-sites. Casos compostos
// (vários filhos, ex.: slider com extremos "−/+") seguem intocados por construção: sem
// elemento único não há onde injetar, e o Field renderiza exatamente como antes.
// cloneElement (e não render-prop) é o padrão menos invasivo: a API pública
// label/hint/error/htmlFor não muda e nenhum call-site precisa ser tocado.
function injectAria(children: ReactNode, describedBy: string | undefined, invalid: boolean) {
  if (!describedBy && !invalid) return children;
  const arr = Children.toArray(children);
  if (arr.length !== 1 || !isValidElement(arr[0])) return children;
  const only = arr[0] as ReactElement<Record<string, unknown>>;
  const own = only.props["aria-describedby"] as string | undefined;
  return cloneElement(only, {
    // preserva um describedby que o call-site já tenha posto (o do filho vem primeiro)
    "aria-describedby": cx(own, describedBy) || undefined,
    // dispara o estilo aria-[invalid=true]:border-critical; valor explícito do filho vence
    ...(invalid && only.props["aria-invalid"] === undefined ? { "aria-invalid": true } : {}),
  });
}

// Molécula: rótulo + controle + dica/erro, com associação acessível (htmlFor ↔ id do controle;
// aria-describedby liga dica/erro ao controle; erro seta aria-invalid e é anunciado por
// leitores de tela via role="alert").
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
  // ids estáveis (useId) para ligar dica/erro ao controle por aria-describedby.
  const uid = useId();
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-err`;
  // O erro SUBSTITUI a dica (comportamento vigente) → descreve só o que está visível.
  const describedBy = error ? errorId : hint ? hintId : undefined;
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
      {injectAria(children, describedBy, Boolean(error))}
      {error ? (
        <span id={errorId} role="alert" className="text-[11px] text-critical">
          {error}
        </span>
      ) : hint ? (
        <span id={hintId} className="text-[11px] text-text-muted">
          {hint}
        </span>
      ) : null}
    </div>
  );
}
