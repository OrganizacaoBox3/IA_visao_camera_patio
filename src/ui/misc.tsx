import { type ReactNode, type CSSProperties } from "react";
import { cx } from "./cx";

// Tailwind v4 (tokens mapeados no @theme; hex/token-não-mapeado = arbitrary value var(--...)).
// Composição por grupos SEM propriedade duplicada entre grupos → uma classe por propriedade
// (Tailwind resolve conflito por ordem de geração, não pela ordem no className).

export type Tone = "ok" | "warn" | "alert" | "info";

// ── Badge ──────────────────────────────────────────────────
// Layout/tipografia (default sem tom = surface panel-2 / texto dim / borda soft).
const BADGE_BASE = cx(
  "inline-flex items-center gap-1",
  "text-[11px] font-medium",
  "px-2 py-0.5 rounded-full border",
);
const BADGE_TONE: Record<Tone | "default", string> = {
  default: "bg-panel-2 text-text-dim border-border-soft",
  ok: "bg-[var(--state-ok-bg)] text-ok border-transparent",
  warn: "bg-[var(--state-warn-bg)] text-warn border-transparent",
  alert: "bg-[var(--state-critical-bg)] text-critical border-transparent",
  info: "bg-[var(--state-info-bg)] text-[var(--state-info-fg)] border-transparent",
};
export function Badge({ tone, children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx(BADGE_BASE, BADGE_TONE[tone ?? "default"])}>{children}</span>;
}

// ── Spinner ────────────────────────────────────────────────
// border completa na cor --border; topo em --accent; gira via keyframe ui-spin (ui.css).
export function Spinner() {
  return (
    <span
      className="inline-block size-[14px] rounded-full border-2 border-border border-t-accent animate-[ui-spin_0.7s_linear_infinite]"
      aria-hidden
    />
  );
}

// ── Skeleton (shimmer) ─────────────────────────────────────
// Gradiente 90deg + background-size 200% deslocado pelo keyframe ui-shimmer (ui.css).
// h padrão 14px (via style: h ?? 14); radius padrão 6px (override por style quando radius definido).
const SKELETON_BASE = cx(
  "inline-block h-[14px] rounded-[6px]",
  "bg-[linear-gradient(90deg,var(--panel-2)_25%,var(--ctrl-bg)_50%,var(--panel-2)_75%)] bg-[length:200%_100%]",
  "animate-[ui-shimmer_1.3s_infinite]",
);

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
      className={SKELETON_BASE}
      style={{ width: w, height: h ?? 14, borderRadius: radius }}
      aria-hidden
    />
  );
}
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="flex flex-col gap-2">
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className={SKELETON_BASE}
          style={{ width: i === lines - 1 ? "60%" : "100%" }}
          aria-hidden
        />
      ))}
    </span>
  );
}

// ── Alert (inline) ─────────────────────────────────────────
// Base: borda 1px + faixa esquerda 3px (cor da faixa/fundo por tom).
const ALERT_BASE = cx(
  "flex items-center gap-2",
  "text-[13px] px-3 py-2",
  "rounded-[6px] border border-border border-l-[3px]",
);
const ALERT_TONE: Record<"info" | "ok" | "alert" | "warn", string> = {
  info: "border-l-accent bg-[var(--state-info-bg)]",
  ok: "border-l-ok bg-[var(--state-ok-bg)]",
  warn: "border-l-warn bg-[var(--state-warn-bg)]",
  alert: "border-l-critical bg-[var(--state-critical-bg)] text-[var(--state-critical-fg)]",
};
// Mensagem inline (erro/sucesso/aviso/info), anunciada por leitores de tela.
export function Alert({
  tone = "info",
  children,
}: {
  tone?: "info" | "ok" | "alert" | "warn";
  children: ReactNode;
}) {
  return (
    <div
      className={cx(ALERT_BASE, ALERT_TONE[tone])}
      role={tone === "alert" ? "alert" : "status"}
    >
      {children}
    </div>
  );
}

// ── EmptyState ─────────────────────────────────────────────
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-text-dim">
      {children}
    </div>
  );
}

// ── KpiCard ────────────────────────────────────────────────
// Valor no papel kpi (24px, ÚNICO tamanho de número de KPI — padrão da casa).
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
    <div className="flex flex-col gap-0.5 rounded-[var(--radius)] border border-border bg-panel p-3">
      <div className="[font-family:var(--mono)] text-kpi font-semibold text-text" style={style}>
        {value}
      </div>
      <div className="text-label uppercase tracking-[0.3px] text-text-muted">{label}</div>
    </div>
  );
}
