import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type ReactNode,
} from "react";
import * as Label from "@radix-ui/react-label";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx("ui-input", className)} {...rest} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx("ui-textarea", className)} {...rest} />;
});

export function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: ReactNode }) {
  return (
    <Label.Root className="ui-label" htmlFor={htmlFor}>
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
    <div className={cx("ui-field", className)}>
      {label && <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>}
      {children}
      {error ? (
        <span className="ui-err">{error}</span>
      ) : hint ? (
        <span className="ui-hint">{hint}</span>
      ) : null}
    </div>
  );
}
