// Fonte ÚNICA do vocabulário de ALARME no front: o contrato de evento (espelha 1:1 o backend
// B1, §1 de `docs/analises/contrato-eventos-alarme.md`) e a sua apresentação (rótulos pt-BR + token
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

/** Classificação da política. Aceita string p/ ser retrocompatível com tipos futuros do backend.
 *  "presenca" = violação de zona PROIBIDA (spec alerta-por-atividade E1): tipo PRÓPRIO de
 *  propósito — a chave de dedup do back é `cam|zona|tipo`, então atividade e presença na MESMA
 *  zona não se suprimem mutuamente (armadilha A3). */
export type AlarmTipo = "atividade" | "fadiga" | "leitura" | "objetos" | "presenca" | (string & {});

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

// ── Emissão ESTRUTURADA do alerta (armadilha A3 da spec alerta-por-atividade) ──────────────────
// O payload do socket "alert" ganhou campos OPCIONAIS { cameraId?, zona?, tipo? } — aditivo: o
// servidor já os prefere ao parse de texto (server/alarm/keys.js) e segue parseando quando
// ausentes. Emissores legados só entregam o TEXTO ("⚠ <câmera>: msg" | "⚠ <câmera> · <zona>: msg");
// este helper deriva os campos resolvendo o RÓTULO contra as câmeras vivas — CONSERVADOR: sem
// match EXATO de rótulo devolve {} (o fallback de regex do servidor continua valendo). Puro e
// testável (alarm.test.ts); consumido pelo handleAlert da central (DashboardPage).
export type AlertEmitMeta = { cameraId?: string; zona?: string; tipo?: string };
export function alertMetaFromText(
  text: string,
  cameras: ReadonlyArray<{ id: string; label: string }>,
): AlertEmitMeta {
  const i = text.indexOf(": ");
  if (i <= 0 || i > 80) return {};
  // remove os marcadores iniciais (⚠/✋/emoji/espaços) — tudo antes da 1ª letra/dígito do rótulo
  const head = text
    .slice(0, i)
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim();
  const sep = head.indexOf(" · ");
  const camLabel = (sep >= 0 ? head.slice(0, sep) : head).trim();
  const zona = sep >= 0 ? head.slice(sep + 3).trim() : "";
  const cam = cameras.find((c) => c.label === camLabel);
  if (!cam) return {};
  return zona ? { cameraId: cam.id, zona } : { cameraId: cam.id };
}

// ── SUPRIMIDOS PELA JANELA DE TURNO (spec-turnos-por-zona §4.1 — gate em server/alarm/shift.js) ──
// Campos ADITIVOS de `GET /api/alarms/metrics`, expostos pelo alarmPolicy.metrics(). Existem por
// DOUTRINA: supressão silenciosa é como se perde a confiança num sistema de alarme — quem cala,
// MOSTRA que calou (e por quê). Going-gray: isto é informação NORMAL (o gate funcionando), não
// anormalidade — renderiza em neutro, nunca em cor de alerta.
//
// NOTA DE PROPRIEDADE: o tipo `AlarmMetrics` mora em `src/api.ts` (o cliente da rota). Esta frente
// não é dona daquele arquivo, então os campos novos entram COMPONDO (`AlarmMetrics &
// AlarmShiftSuppression`) em vez de duplicar a definição. Opcionais de propósito: hub anterior a
// esta onda não os manda — a UI degrada para "sem dados" em vez de mostrar 0 mentiroso.
export type AlarmShiftSuppression = {
  /** total de alarmes suprimidos pela janela desde o boot do hub (contador volátil). */
  suppressedByShift?: number;
  /** suprimidos na última hora (janela rolante — a leitura "está calando AGORA?"). */
  suppressedByShiftLastHour?: number;
  /** quebra por MOTIVO na última hora — a chave é o motivo do gate (ver rótulos abaixo). */
  suppressedByShiftReasons?: Record<string, number>;
};

/** Motivos que o gate de turno reporta (server/alarm/shift.js). Chave desconhecida (motivo novo no
 *  back, front antigo) renderiza a própria chave — nunca some da tela. */
export const SHIFT_SUPPRESSION_REASON_LABEL: Record<string, string> = {
  "fora-do-turno": "Fora do turno",
  "em-pausa": "Em pausa",
  "presenca-fora-do-turno": "Zona proibida · fora do turno",
  "presenca-dentro-do-turno": "Zona proibida · dentro do turno",
};

/** Rótulo pt-BR do motivo do gate (fallback = a própria chave do back). */
export function shiftSuppressionReasonLabel(reason: string): string {
  return SHIFT_SUPPRESSION_REASON_LABEL[reason] ?? reason;
}

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
