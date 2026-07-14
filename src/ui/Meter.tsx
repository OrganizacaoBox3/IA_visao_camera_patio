import { cx } from "./cx";

// Átomo Meter — barra/medidor analógico (going-gray): mostra uma PROPORÇÃO como COMPRIMENTO, não só
// como número (doutrina: a barra analógica antes do número cru). Formaliza a barra de sinal que a
// aba Tags desenhava à mão (a lacuna <Meter>/<Bar> catalogada na auditoria de layout).
//
// `value` em 0..100 (clampado). `muted` (ex.: leitura velha/sem sinal) esmaece o preenchimento para
// --border. `tone` escolhe a cor de ESTADO do preenchimento; o trilho é sempre neutro (--panel).
// Acessível: role="img" + aria-label obrigatório (o número/rótulo por extenso — nunca só a cor).
export function Meter({
  value,
  ariaLabel,
  tone = "ok",
  muted = false,
  className,
}: {
  value: number;
  ariaLabel: string;
  tone?: "ok" | "warn" | "alert" | "info" | "neutral";
  muted?: boolean;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const fill = muted ? "var(--border)" : `var(--state-${tone})`;
  return (
    <span
      className={cx("h-1.5 flex-1 overflow-hidden rounded-full bg-panel", className)}
      role="img"
      aria-label={ariaLabel}
    >
      <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: fill }} />
    </span>
  );
}
