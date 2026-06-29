import { type ReactNode, type CSSProperties } from "react";

export type Tone = "ok" | "warn" | "alert" | "info";
export function Badge({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`ui-badge ${tone ? `ui-badge--${tone}` : ""}`}>{children}</span>;
}

export function Spinner() {
  return <span className="ui-spinner" aria-hidden />;
}

// Placeholder de carregamento (shimmer). Decorativo → aria-hidden.
export function Skeleton({
  w,
  h,
  radius,
}: {
  w?: number | string;
  h?: number | string;
  radius?: number;
}) {
  return (
    <span
      className="ui-skeleton"
      style={{ width: w, height: h ?? 14, borderRadius: radius }}
      aria-hidden
    />
  );
}
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="ui-skel-text">
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className="ui-skeleton"
          style={{ width: i === lines - 1 ? "60%" : "100%" }}
          aria-hidden
        />
      ))}
    </span>
  );
}

// Mensagem inline (erro/sucesso/aviso/info), anunciada por leitores de tela.
export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "ok" | "alert" | "warn";
  children: ReactNode;
}) {
  return (
    <div className={`ui-alert ui-alert--${tone}`} role={tone === "alert" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="ui-empty">{children}</div>;
}

export function KpiCard({
  value,
  label,
  color,
}: {
  value: ReactNode;
  label: ReactNode;
  color?: string;
}) {
  const style: CSSProperties | undefined = color ? { color } : undefined;
  return (
    <div className="ui-kpi">
      <div className="ui-kpi-v" style={style}>
        {value}
      </div>
      <div className="ui-kpi-l">{label}</div>
    </div>
  );
}
