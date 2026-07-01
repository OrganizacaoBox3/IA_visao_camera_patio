// Base compartilhada dos cálculos do Relatório: turnos, janelas de período e
// formatadores puros usados por todas as dimensões (atividade/leitura/objetos/fadiga/alarmes).
// Funções PURAS e determinísticas — nenhum efeito colateral.

export type Shift = "Manhã" | "Tarde" | "Noite";
export type Period = "hoje" | "7d" | "30d";

export function shiftOf(hour: number): Shift {
  if (hour >= 6 && hour < 14) return "Manhã";
  if (hour >= 14 && hour < 22) return "Tarde";
  return "Noite";
}

/** Nº de dias por período (interno; base das janelas current/previous). */
export const periodDays: Record<Period, number> = { hoje: 1, "7d": 7, "30d": 30 };

/** Verdadeiro se a hora pertence ao turno filtrado (ou "Todos"). Interno. */
export function inShift(hour: number, shift: Shift | "Todos") {
  return shift === "Todos" || shiftOf(hour) === shift;
}

export function deltaPct(cur: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

export function fmtMin(min: number): string {
  const h = Math.floor(min / 60),
    m = min % 60;
  return h <= 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`;
}
