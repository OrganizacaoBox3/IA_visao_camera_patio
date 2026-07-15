// Formatação de tempo — pt-BR, local. Puro, testável.

const dtf = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Timestamp epoch-ms → data/hora local pt-BR. Valor inválido → "—". */
export function formatTs(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return "—";
  return dtf.format(new Date(ts));
}

/** Câmera/zona a partir do meta do alarme, para exibição. Vazio → "—". */
export function cameraZona(meta: { cameraLabel?: string; cameraId?: string; zona?: string } | null | undefined): string {
  if (!meta) return "—";
  const cam = meta.cameraLabel || meta.cameraId || "";
  const parts = [cam, meta.zona].filter((s): s is string => !!s);
  return parts.length ? parts.join(" · ") : "—";
}
