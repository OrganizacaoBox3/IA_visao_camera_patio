// Rótulos do recorte do Relatório: modo/período + a "lente" (linha de contexto exibida/impressa)
// e a etiqueta de filtro (CSV). Funções PURAS do estado dos filtros — texto idêntico nos três
// destinos (tela, print-head, CSV), num lugar só.
import type { Period, Shift } from "../../report/calc";
import {
  ALARM_PRIORITY_LABEL,
  ALARM_STATE_LABEL,
  type AlarmPriority,
  type AlarmState,
} from "../../types/alarm";

export type Mode = "resumo" | "atividade" | "leitura" | "objetos" | "fadiga" | "alarmes";
export const MODE_LABEL: Record<Mode, string> = {
  resumo: "Resumo executivo",
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Operador (fadiga)",
  alarmes: "Alarmes",
};
export const PERIOD_LABEL: Record<Period, string> = {
  hoje: "Hoje",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
};

export type ReportFilters = {
  mode: Mode;
  period: Period;
  shift: Shift | "Todos";
  area: string | "Todas";
  ponto: string | "Todos";
  setor: string | "Todos";
  posto: string | "Todos";
  alarmPriority: AlarmPriority | "Todas";
  alarmState: AlarmState | "Todos";
};

/** Linha de contexto do recorte atual (ex.: "Últimos 7 dias · Todas as áreas · Turno: todos"). */
export function reportLens(f: ReportFilters): string {
  const turno = `Turno: ${f.shift === "Todos" ? "todos" : f.shift}`;
  switch (f.mode) {
    case "alarmes":
      return `${PERIOD_LABEL[f.period]} · Prioridade: ${f.alarmPriority === "Todas" ? "todas" : ALARM_PRIORITY_LABEL[f.alarmPriority]} · Estado: ${f.alarmState === "Todos" ? "todos" : ALARM_STATE_LABEL[f.alarmState]}`;
    case "leitura":
      return `${PERIOD_LABEL[f.period]} · ${f.ponto === "Todos" ? "Todos os pontos" : f.ponto} · ${turno}`;
    case "objetos":
      return `${PERIOD_LABEL[f.period]} · ${f.setor === "Todos" ? "Todos os setores" : f.setor} · ${turno}`;
    case "fadiga":
      return `${PERIOD_LABEL[f.period]} · ${f.posto === "Todos" ? "Todos os postos" : f.posto} · ${turno}`;
    default:
      return `${PERIOD_LABEL[f.period]} · ${f.area === "Todas" ? "Todas as áreas" : f.area} · ${turno}`;
  }
}

/** Etiqueta curta do filtro do modo (linha "Filtro" do CSV). */
export function reportFiltroLabel(f: ReportFilters): string {
  switch (f.mode) {
    case "alarmes":
      return `Prioridade ${f.alarmPriority === "Todas" ? "todas" : ALARM_PRIORITY_LABEL[f.alarmPriority]} · Estado ${f.alarmState === "Todos" ? "todos" : ALARM_STATE_LABEL[f.alarmState]}`;
    case "leitura":
      return f.ponto === "Todos" ? "Todos os pontos" : f.ponto;
    case "objetos":
      return f.setor === "Todos" ? "Todos os setores" : f.setor;
    case "fadiga":
      return f.posto === "Todos" ? "Todos os postos" : f.posto;
    default:
      return f.area === "Todas" ? "Todas as áreas" : f.area;
  }
}
