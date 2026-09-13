// ESPELHO DE FRONT de `server/alarm/intervals.js` — vocabulário de intervalo de tempo.
// Par espelhado: mudou a lista lá, muda aqui, no MESMO PR.
//
// O back é quem VALIDA (o front pode ser contornado); aqui a lista existe para a tela oferecer
// as mesmas opções e o mesmo texto, e para o campo "personalizado" avisar ANTES de salvar
// quando o número digitado vai ser ajustado.

export const INTERVALO_MIN_MS = 60_000; // 1 min — abaixo disso o tick de saúde (30s) não honra
export const INTERVALO_MAX_MS = 24 * 3_600_000; // 24 h — mais que um dia não é lembrete

export type IntervaloPreset = { ms: number; label: string };

export const INTERVALO_PRESETS: IntervaloPreset[] = [
  { ms: 60_000, label: "1 minuto" },
  { ms: 5 * 60_000, label: "5 minutos" },
  { ms: 10 * 60_000, label: "10 minutos" },
  { ms: 15 * 60_000, label: "15 minutos" },
  { ms: 30 * 60_000, label: "30 minutos" },
  { ms: 60 * 60_000, label: "1 hora" },
  { ms: 2 * 3_600_000, label: "2 horas" },
  { ms: 4 * 3_600_000, label: "4 horas" },
  { ms: 8 * 3_600_000, label: "8 horas (turno)" },
  { ms: 12 * 3_600_000, label: "12 horas" },
  { ms: 24 * 3_600_000, label: "24 horas" },
];

/** Prende em [1min, 24h]. `null` no que não é número — quem chama decide o default. */
export function clampIntervalo(ms: unknown): number | null {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(INTERVALO_MAX_MS, Math.max(INTERVALO_MIN_MS, Math.round(n)));
}

/** Minutos digitados → ms. Branco/zero/negativo devolvem `null`, nunca 0 (0 seria "lembrar
 *  a cada tick", a inundação que a política inteira existe para evitar). */
export function intervaloDeMinutos(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().replace(",", ".");
  if (s.startsWith("-")) return null; // o sinal é lido ANTES da limpeza (ver o back)
  const n = Number(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampIntervalo(n * 60_000);
}

/** Texto humano — o MESMO da tela, do log e da mensagem. */
export function intervaloHumano(ms: unknown): string {
  const v = clampIntervalo(ms);
  if (v === null) return "—";
  const preset = INTERVALO_PRESETS.find((p) => p.ms === v);
  if (preset) return preset.label;
  const min = Math.round(v / 60_000);
  if (min < 60) return `${min} minutos`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `${h} hora${h > 1 ? "s" : ""}` : `${h}h ${r}min`;
}

export const ehIntervaloPreset = (ms: unknown): boolean =>
  INTERVALO_PRESETS.some((p) => p.ms === clampIntervalo(ms));
