// Átomos MÍNIMOS locais do portal (não é o src/ui do hub). Radix/monorepo fica p/ depois.
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

export function Button({
  variant = "default",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
}) {
  const v =
    variant === "primary" ? "cp-btn--primary" : variant === "ghost" ? "cp-btn--ghost" : "";
  return <button className={`cp-btn ${v} ${className ?? ""}`.trim()} {...rest} />;
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="cp-input" {...props} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className="cp-input cp-select" {...props} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="cp-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Badge going-gray: cor + TEXTO sempre (cor nunca sozinha — doutrina).
export function Badge({
  tone,
  children,
}: {
  tone: "online" | "offline" | "alarm" | "neutral";
  children: ReactNode;
}) {
  return (
    <span className={`cp-badge cp-badge--${tone}`}>
      <span className="cp-badge__dot" aria-hidden="true" />
      {children}
    </span>
  );
}

export function Loading({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="cp-state" role="status" aria-live="polite">
      <span className="cp-spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="cp-state cp-state--error" role="alert">
      {message}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="cp-state">{children}</div>;
}
