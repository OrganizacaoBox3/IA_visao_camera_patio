// Fonte ÚNICA do vocabulário de ALARME no front: o contrato de evento (espelha 1:1 o backend
// B1, §1 de `analises/contrato-eventos-alarme.md`) e a sua apresentação (rótulos pt-BR + token
// de cor por prioridade/estado). Prioridade nova = tipo + rótulo + cor mudam JUNTOS, aqui.
// SÓ METADADOS (LGPD): nunca imagem/frame — apenas texto, identificadores e timestamps.
//
// Consumidores re-exportam daqui para manter retrocompatibilidade:
//   - `src/api.ts`         → re-exporta os tipos (DashboardPage/AlarmHealthPage importam via `../api`).
//   - `src/report/calc/alarmes.ts` → re-exporta os tipos (consumidores do barrel calc).

/** Prioridade já calculada pela política (não é recalculada no front). EEMUA 191: `critical` baixo. */
export type AlarmPriority = "advisory" | "high" | "critical";

/** Ciclo de vida do alarme na fila acionável (acknowledge/forward). */
export type AlarmState = "new" | "acknowledged" | "forwarded";

/** Classificação da política. Aceita string p/ ser retrocompatível com tipos futuros do backend. */
export type AlarmTipo = "atividade" | "fadiga" | "leitura" | "objetos" | (string & {});

/** Evento de alarme — metadados (§1 de contrato-eventos-alarme.md). */
export type AlarmEvent = {
  id: string; // string única, gerada no servidor
  ts: number; // epoch-ms do alarme (da decisão da política)
  cameraId?: string; // id da câmera (ausente se não identificável)
  cameraLabel?: string; // rótulo amigável (resolvido das câmeras vivas)
  zona?: string; // zona/área lógica (ausente quando a política não identifica)
  tipo: AlarmTipo; // atividade | fadiga | leitura | objetos (classificação da política)
  priority: AlarmPriority; // advisory | high | critical (JÁ calculada pela política)
  text: string; // texto do alarme (pode ser resumo de causa-raiz)
  state: AlarmState; // new | acknowledged | forwarded
  ackBy?: string; // quem reconheceu/encaminhou
  ackAt?: number; // epoch-ms de quando reconheceu/encaminhou
};

// ── Apresentação do vocabulário de alarme (fonte única — rótulos pt-BR + tokens de cor) ──
// Antes replicado em AlarmesPanel, AlarmDrawer e report/csv (com RGB cru no heatmap).
// Going-gray: advisory=info (azul, não-alarme), high=warn (amarelo), critical=critical (vermelho).
// Cor SEMPRE via token --state-* — nunca RGB cru (o token é o dono da paleta).

export const ALARM_PRIORITY_LABEL: Record<AlarmPriority, string> = {
  advisory: "Informativo",
  high: "Alta",
  critical: "Crítica",
};
export const ALARM_STATE_LABEL: Record<AlarmState, string> = {
  new: "Novo",
  acknowledged: "Reconhecido",
  forwarded: "Encaminhado",
};

const ALARM_PRIORITY_TOKEN: Record<AlarmPriority, { color: string; border: string }> = {
  advisory: { color: "var(--state-info)", border: "var(--state-info-border)" },
  high: { color: "var(--state-warn)", border: "var(--state-warn-border)" },
  critical: { color: "var(--state-critical)", border: "var(--state-critical-border)" },
};

/** Cor de destaque (texto/dot) da prioridade. */
export function alarmPriorityColor(p: AlarmPriority): string {
  return ALARM_PRIORITY_TOKEN[p].color;
}
/** Cor de borda (faixa/realce discreto) da prioridade. */
export function alarmPriorityBorder(p: AlarmPriority): string {
  return ALARM_PRIORITY_TOKEN[p].border;
}
