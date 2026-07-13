// View-model do modo ALARMES do Relatório: estado dos filtros/seleção (prioridade, estado,
// janela-de-dia, hora, evento destacado) + agregações. Só computa quando o modo está ativo;
// o ESTADO persiste entre trocas de modo (o hook vive no ReportPage), como antes.
import { useMemo, useRef, useState } from "react";
import {
  filterAlarms,
  alarmKpis,
  alarmTrend,
  alarmHeatmap,
  alarmInsights,
  alarmDayStart,
  type AlarmWindow,
  type Period,
} from "../../report/calc";
import type { AlarmEvent, AlarmPriority, AlarmState } from "../../types/alarm";

const ALARM_DAY_MS = 86_400_000;

export function useAlarmesVM(args: { active: boolean; alarms: AlarmEvent[]; period: Period }) {
  const { active, alarms, period } = args;
  const [alarmPriority, setAlarmPriority] = useState<AlarmPriority | "Todas">("Todas");
  const [alarmState, setAlarmState] = useState<AlarmState | "Todos">("Todos");
  const [alarmWindow, setAlarmWindow] = useState<AlarmWindow | null>(null); // janela (clique na tendência)
  const [alarmHour, setAlarmHour] = useState<number | null>(null); // hora-do-dia (clique no heatmap)
  const [selAlarm, setSelAlarm] = useState<string | null>(null); // evento selecionado (destaque bidirecional)
  const trendRef = useRef<HTMLDivElement | null>(null);

  const aFilters = useMemo(
    () => ({ period, priority: alarmPriority, state: alarmState }),
    [period, alarmPriority, alarmState],
  );
  // Conjunto que respeita só prioridade/estado/período (alimenta os gráficos — sem a janela/hora,
  // p/ os gráficos não "encolherem" ao clicar neles próprios).
  const alarmsScoped = useMemo(
    () => (active ? filterAlarms(alarms, aFilters) : []),
    [active, alarms, aFilters],
  );
  // Lista visível: aplica também a janela de tempo e a hora selecionadas nos gráficos.
  const alarmsView = useMemo(
    () => (active ? filterAlarms(alarms, aFilters, alarmWindow, alarmHour) : []),
    [active, alarms, aFilters, alarmWindow, alarmHour],
  );
  const ak = useMemo(() => alarmKpis(alarmsView), [alarmsView]);
  // KPIs do PERÍODO — só o filtro global, sem prioridade/estado/janela/hora. É o que o CARTÃO do
  // Resumo (N2) mostra: se herdasse a seleção feita DENTRO do modo Alarmes (ex.: "só críticos do
  // dia 7"), o Resumo mentiria em silêncio — o gestor leria um subconjunto achando que é o total.
  const akPeriod = useMemo(
    () => alarmKpis(filterAlarms(alarms, { period, priority: "Todas", state: "Todos" })),
    [alarms, period],
  );
  const aTrend = useMemo(() => alarmTrend(alarmsScoped, 14), [alarmsScoped]);
  const aHeat = useMemo(() => alarmHeatmap(alarmsScoped), [alarmsScoped]);
  const aTips = useMemo(
    () => alarmInsights(alarmKpis(alarmsScoped), aTrend),
    [alarmsScoped, aTrend],
  );
  const selAlarmObj = useMemo(
    () => alarms.find((e) => e.id === selAlarm) ?? null,
    [alarms, selAlarm],
  );
  const selDay = selAlarmObj ? alarmDayStart(selAlarmObj.ts) : null;
  const selHour = selAlarmObj ? new Date(selAlarmObj.ts).getHours() : null;

  function pickDay(dayStart: number, label: string) {
    setAlarmHour(null);
    setSelAlarm(null);
    setAlarmWindow((w) =>
      w && w.from === dayStart ? null : { from: dayStart, to: dayStart + ALARM_DAY_MS, label },
    );
  }
  function pickHour(h: number) {
    setAlarmWindow(null);
    setSelAlarm(null);
    setAlarmHour((cur) => (cur === h ? null : h));
  }
  function pickAlarm(id: string) {
    setSelAlarm((cur) => (cur === id ? null : id));
    if (trendRef.current) trendRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function clearAlarmSel() {
    setAlarmWindow(null);
    setAlarmHour(null);
    setSelAlarm(null);
  }

  return {
    alarmPriority,
    setAlarmPriority,
    alarmState,
    setAlarmState,
    alarmWindow,
    alarmHour,
    selAlarm,
    selDay,
    selHour,
    trendRef,
    alarmsView,
    ak,
    akPeriod,
    aTrend,
    aHeat,
    aTips,
    pickDay,
    pickHour,
    pickAlarm,
    clearAlarmSel,
  };
}
