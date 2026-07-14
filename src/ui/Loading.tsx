import { cx } from "./cx";
import { Spinner, Skeleton } from "./misc";

// Átomo Loading — estado de carregamento com contrato de acessibilidade ÚNICO: o wrapper é sempre
// aria-busy="true" + aria-label={label} (o leitor de tela sempre anuncia O QUE carrega, nunca só um
// spinner mudo). DRY: unifica o "Carregando…" reescrito à mão em cada tela.
//
// variant="inline" (default): Spinner + "{label}…" visível. variant="skeleton": N barras shimmer no
// lugar do spinner+texto (para placeholders de conteúdo estruturado), com o MESMO wrapper acessível.
export function Loading({
  label,
  variant = "inline",
  lines = 3,
  className,
}: {
  label: string;
  variant?: "inline" | "skeleton";
  lines?: number;
  className?: string;
}) {
  if (variant === "skeleton") {
    return (
      <div
        className={cx("flex flex-col gap-2", className)}
        role="status"
        aria-busy="true"
        aria-label={label}
      >
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} w={i === lines - 1 ? "60%" : "100%"} />
        ))}
      </div>
    );
  }
  return (
    <div
      className={cx("inline-flex items-center gap-2 text-[13px] text-text-dim", className)}
      role="status"
      aria-busy="true"
      aria-label={label}
    >
      <Spinner /> {label}…
    </div>
  );
}
