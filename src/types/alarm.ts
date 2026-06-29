// Fonte ÚNICA do contrato de EVENTO DE ALARME no front (R2.2 — unificação do tipo que estava
// duplicado em `api.ts` e `report/mock.ts`, com risco de drift entre as frentes "alarmes ao vivo"
// e "relatório"). Espelha 1:1 o contrato do backend B1 (§1 de `analises/contrato-eventos-alarme.md`).
// SÓ METADADOS (LGPD): nunca imagem/frame — apenas texto, identificadores e timestamps.
//
// Consumidores re-exportam daqui para manter retrocompatibilidade:
//   - `src/api.ts`        → re-exporta (DashboardPage/AlarmHealthPage importam via `../api`).
//   - `src/report/mock.ts`→ re-exporta (report/csv.ts, report/store.ts importam via `./mock`).

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
