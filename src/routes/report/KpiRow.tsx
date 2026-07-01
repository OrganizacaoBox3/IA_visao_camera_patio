import { type CSSProperties, type ReactNode } from "react";

// Linha de KPIs "big" reutilizada por todos os modos do Relatório.
export function KpiRow({ children }: { children: ReactNode }) {
  return <div className="kpi-row">{children}</div>;
}

export function Kpi({
  value,
  label,
  valueStyle,
}: {
  value: ReactNode;
  label: ReactNode;
  valueStyle?: CSSProperties;
}) {
  return (
    <div className="kpi big">
      <div className="v" style={valueStyle}>
        {value}
      </div>
      <div className="l">{label}</div>
    </div>
  );
}

// Seta de variação (▲/▼ %). goodWhenDown=true → cair é "bom" (verde), subir é "ruim".
export function Delta({ v, goodWhenDown = true }: { v: number | null; goodWhenDown?: boolean }) {
  if (v == null) return <span className="delta muted">—</span>;
  const down = v < 0;
  const good = goodWhenDown ? down : !down;
  return (
    <span className={`delta ${good ? "good" : "bad"}`}>
      {down ? "▼" : "▲"} {Math.abs(v)}%
    </span>
  );
}
