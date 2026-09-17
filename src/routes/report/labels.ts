// Rótulos do recorte do Relatório: modo/período + a "lente" (linha de contexto exibida/impressa)
// e a etiqueta de filtro (CSV). Funções PURAS do estado dos filtros — texto idêntico nos três
// destinos (tela, print-head, CSV), num lugar só.
import type { Period, ShiftFilter } from "../../report/calc";
import {
  ALARM_PRIORITY_LABEL,
  ALARM_STATE_LABEL,
  type AlarmPriority,
  type AlarmState,
} from "../../types/alarm";

/** Rótulo da sentinela "sem recorte de câmera" (a página resolve com `rotuloDaCamera`). Só
 *  serve para NÃO poluir a lente com "Todas as câmeras" em toda folha. */
const TODAS_LABEL = "Todas as câmeras";

export type Mode =
  | "resumo"
  | "atividade"
  | "fluxo"
  | "leitura"
  | "objetos"
  | "fadiga"
  | "alarmes";
export const MODE_LABEL: Record<Mode, string> = {
  resumo: "Resumo executivo",
  atividade: "Atividade",
  fluxo: "Linhas de contagem",
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
  shift: ShiftFilter;
  /** rótulo JÁ resolvido do turno (nome do cadastro; "todos" na sentinela) — a página resolve
   *  com `shiftLabelOf`, porque a CHAVE do filtro hoje é o id do turno, não o texto exibido. */
  shiftLabel: string;
  area: string | "Todas";
  /** rótulo JÁ resolvido da CÂMERA (a chave é o id, que não se mostra a ninguém) — mesma
   *  separação chave/rótulo do turno e da linha. "Todas as câmeras" na sentinela. */
  cameraLabel: string;
  /** rótulo JÁ resolvido da linha de contagem (a chave é `cameraId|tripwireId`, que não se
   *  mostra a ninguém) — mesmo motivo do `shiftLabel`. */
  linhaLabel: string;
  ponto: string | "Todos";
  setor: string | "Todos";
  posto: string | "Todos";
  alarmPriority: AlarmPriority | "Todas";
  alarmState: AlarmState | "Todos";
};

/** Linha de contexto do recorte atual (ex.: "Últimos 7 dias · Todas as áreas · Turno: todos").
 *  É ELA que vai no cabeçalho impresso do PDF — por isso a CÂMERA entra aqui: o papel circula
 *  sozinho, e uma folha que não diz de qual câmera está falando é indefensável numa reunião. */
export function reportLens(f: ReportFilters): string {
  const turno = `Turno: ${f.shiftLabel}`;
  // Só aparece quando HÁ recorte: "Todas as câmeras" em toda folha seria ruído constante.
  const cam = f.cameraLabel && f.cameraLabel !== TODAS_LABEL ? ` · Câmera: ${f.cameraLabel}` : "";
  switch (f.mode) {
    case "alarmes":
      return `${PERIOD_LABEL[f.period]}${cam} · Prioridade: ${f.alarmPriority === "Todas" ? "todas" : ALARM_PRIORITY_LABEL[f.alarmPriority]} · Estado: ${f.alarmState === "Todos" ? "todos" : ALARM_STATE_LABEL[f.alarmState]}`;
    case "fluxo":
      // Filtro de LINHA, não de área: o cruzamento é por câmera×linha (foi por não caber no
      // filtro de área que o fluxo saiu de dentro do modo Atividade).
      return `${PERIOD_LABEL[f.period]}${cam} · ${f.linhaLabel} · ${turno}`;
    case "leitura":
      return `${PERIOD_LABEL[f.period]}${cam} · ${f.ponto === "Todos" ? "Todos os pontos" : f.ponto} · ${turno}`;
    case "objetos":
      return `${PERIOD_LABEL[f.period]}${cam} · ${f.setor === "Todos" ? "Todos os setores" : f.setor} · ${turno}`;
    case "fadiga":
      return `${PERIOD_LABEL[f.period]}${cam} · ${f.posto === "Todos" ? "Todos os postos" : f.posto} · ${turno}`;
    default:
      return `${PERIOD_LABEL[f.period]}${cam} · ${f.area === "Todas" ? "Todas as áreas" : f.area} · ${turno}`;
  }
}

/** Etiqueta curta do filtro do modo (linha "Filtro" do CSV). A CÂMERA entra como prefixo: a
 *  planilha é aberta sem quem a gerou por perto, e "Doca 1 · Todas as áreas" responde de cara a
 *  primeira pergunta de quem abre ("isto é de quê?"). */
export function reportFiltroLabel(f: ReportFilters): string {
  const cam = f.cameraLabel && f.cameraLabel !== TODAS_LABEL ? `${f.cameraLabel} · ` : "";
  return cam + filtroDoModo(f);
}

function filtroDoModo(f: ReportFilters): string {
  switch (f.mode) {
    case "alarmes":
      return `Prioridade ${f.alarmPriority === "Todas" ? "todas" : ALARM_PRIORITY_LABEL[f.alarmPriority]} · Estado ${f.alarmState === "Todos" ? "todos" : ALARM_STATE_LABEL[f.alarmState]}`;
    case "fluxo":
      return f.linhaLabel;
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
