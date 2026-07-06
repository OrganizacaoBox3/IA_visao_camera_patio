// EVENTOS DE ALARME — ligação RELATÓRIO↔EVENTOS.
// Consome o contrato B1 (GET /api/alarms): SÓ METADADOS, sem imagens (LGPD).
// O relatório lê os eventos e os cruza com a própria timeline (jump-to-time +
// destaque bidirecional). As funções abaixo são puras (agregação/filtro em memória).

import { type Period, periodDays } from "./common";

// Tipo do evento de alarme: fonte ÚNICA em src/types/alarm.ts. Re-exportado daqui para
// retrocompatibilidade dos consumidores que importam via o barrel calc.
export type { AlarmEvent, AlarmPriority, AlarmState, AlarmTipo } from "../../types/alarm";
import type { AlarmEvent, AlarmPriority, AlarmState } from "../../types/alarm";

export type AlarmFilters = {
  period: Period;
  priority: AlarmPriority | "Todas";
  state: AlarmState | "Todos";
};
/** Janela de tempo selecionada via gráfico (jump-to-time): [from, to). */
export type AlarmWindow = { from: number; to: number; label: string };

const ALARM_DAY = 86_400_000;

/** Filtra eventos por período + prioridade + estado + (opcional) janela/hora. Janela de
 *  tempo (clique no gráfico) sobrepõe o limite inferior do período → jump-to-time funciona
 *  mesmo num dia anterior ao recorte atual. */
export function filterAlarms(
  events: AlarmEvent[],
  f: AlarmFilters,
  window: AlarmWindow | null = null,
  hourSel: number | null = null,
  now: number = Date.now(),
): AlarmEvent[] {
  const lo = now - periodDays[f.period] * ALARM_DAY;
  return events.filter(
    (e) =>
      (window ? e.ts >= window.from && e.ts < window.to : e.ts >= lo) &&
      (f.priority === "Todas" || e.priority === f.priority) &&
      (f.state === "Todos" || e.state === f.state) &&
      (hourSel == null || new Date(e.ts).getHours() === hourSel),
  );
}

export type AlarmKpis = {
  total: number;
  critical: number;
  high: number;
  advisory: number;
  news: number;
};

export function alarmKpis(events: AlarmEvent[]): AlarmKpis {
  let critical = 0,
    high = 0,
    advisory = 0,
    news = 0;
  for (const e of events) {
    if (e.priority === "critical") critical++;
    else if (e.priority === "high") high++;
    else advisory++;
    if (e.state === "new") news++;
  }
  return { total: events.length, critical, high, advisory, news };
}

/** Início (epoch-ms) do dia de um timestamp — base do bucket diário da tendência. */
export function alarmDayStart(ts: number): number {
  return Math.floor(ts / ALARM_DAY) * ALARM_DAY;
}

/** Tendência: nº de alarmes por dia nos últimos N dias (bidirecional: clicar num bar
 *  filtra a lista para aquele dia). `critical` separado p/ colorir o pico. */
export function alarmTrend(events: AlarmEvent[], lastN = 14, now: number = Date.now()) {
  const startToday = alarmDayStart(now);
  const bars: { dayStart: number; label: string; count: number; critical: number }[] = [];
  for (let i = lastN - 1; i >= 0; i--) {
    const dayStart = startToday - i * ALARM_DAY;
    bars.push({
      dayStart,
      label: new Date(dayStart).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }),
      count: 0,
      critical: 0,
    });
  }
  const idx = new Map(bars.map((b, i) => [b.dayStart, i] as const));
  for (const e of events) {
    const i = idx.get(alarmDayStart(e.ts));
    if (i != null) {
      bars[i].count++;
      if (e.priority === "critical") bars[i].critical++;
    }
  }
  const max = Math.max(1, ...bars.map((b) => b.count));
  return { bars, max };
}

export const ALARM_PRIORITIES: AlarmPriority[] = ["critical", "high", "advisory"];

/** Heatmap: nº de alarmes por prioridade × hora-do-dia (clicar numa célula filtra por hora). */
export function alarmHeatmap(events: AlarmEvent[]) {
  const rows = ALARM_PRIORITIES.map((priority) => {
    const hours = new Array(24).fill(0) as number[];
    for (const e of events) if (e.priority === priority) hours[new Date(e.ts).getHours()]++;
    return { priority, hours };
  });
  const max = Math.max(1, ...rows.flatMap((r) => r.hours));
  return { rows, max };
}

export function alarmInsights(k: AlarmKpis, trend: ReturnType<typeof alarmTrend>): string[] {
  const out: string[] = [];
  if (k.total === 0) return ["Nenhum alarme no período."];
  const critPct = Math.round((k.critical / k.total) * 100);
  out.push(`${k.total} alarme(s) no período · ${k.critical} crítico(s) (${critPct}%).`);
  if (k.news > 0) out.push(`${k.news} ainda em aberto (não reconhecidos).`);
  const peak = [...trend.bars].sort((a, b) => b.count - a.count)[0];
  if (peak && peak.count > 0) out.push(`Pico em ${peak.label} (${peak.count} alarmes).`);
  return out;
}
