import { cx } from "./cx";

// Átomo StatusDot — bolinha de estado (going-gray): a cor é a leitura RÁPIDA, mas NUNCA a única —
// há SEMPRE um rótulo textual (sr-only) para o leitor de tela e para quem não distingue a cor
// (doutrina: "cor é informação", nunca a ÚNICA informação). DRY: unifica a bolinha desenhada à mão
// em CameraTile/aba Tags/lista de estações.
//
// `tone` escolhe a cor de estado (--state-{tone}); `color` sobrepõe com uma cor inline arbitrária
// (ex.: a cor derivada do status da câmera em CameraTile). O `label` é obrigatório (o texto que a
// cor representa) e vai num <span class="sr-only">.
export function StatusDot({
  tone = "neutral",
  color,
  label,
  className,
}: {
  tone?: "neutral" | "ok" | "info" | "warn" | "critical";
  color?: string;
  label: string;
  className?: string;
}) {
  return (
    <span className={cx("inline-flex items-center", className)}>
      <span
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ background: color ?? `var(--state-${tone})` }}
        aria-hidden
      />
      <span className="sr-only">{label}</span>
    </span>
  );
}
