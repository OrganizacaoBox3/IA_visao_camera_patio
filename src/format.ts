// Formatação compartilhada (DRY) — usada por views e processadores.
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)); const m = Math.floor(s / 60); const r = s % 60;
  return m <= 0 ? `${r}s` : `${m}m ${String(r).padStart(2, "0")}s`;
}
export function fmtLimit(ms: number): string { return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`; }
export function clock(d: Date): string { return d.toLocaleTimeString("pt-BR", { hour12: false }); }
