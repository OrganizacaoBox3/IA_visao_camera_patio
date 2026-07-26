// Carga do HISTÓRICO do Relatório: busca as 5 dimensões + alarmes + fluxo numa leva, com
// estado de loading/erro e a fonte de persistência. Regras de resiliência preservadas:
// status e fluxo falham ISOLADOS (hub antigo → seção oculta/texto genérico, relatório de pé);
// o resto falha JUNTO (erro visível — "API fora do ar" nunca vira "sem dados").
import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  Dataset,
  EventRow,
  ReadingDataset,
  ReadingEventRow,
  ObjectDataset,
  ObjectEventRow,
  FadigaDataset,
  FadigaEventRow,
  FlowDataset,
} from "../../report/calc";
import { periodDays } from "../../report/calc";
import type { AlarmEvent } from "../../types/alarm";
import {
  loadDataset,
  loadEvents,
  clearAll,
  loadReadingDataset,
  loadReadingEvents,
  loadObjectDataset,
  loadObjectEvents,
  loadFadigaDataset,
  loadFadigaEvents,
  loadFlowDataset,
} from "../../report/store";
import { apiGet, ApiError, getDataStatus, type DataPersistence } from "../../api";
import { useToast } from "../../ui";

// ── Carga dos ALARMES: página + META DO CORTE (bug B3) ────────────────────────────────────────
// A fila de alarmes do hub é memória com retenção; pedíamos 500 e calculávamos KPI/tendência de
// "últimos 30 dias" em cima disso, SEM NUNCA DIZER que houve corte — subcontagem em silêncio.
// Duas correções, nesta ordem:
//   1) o corte passa a ser DECLARADO (`?meta=1` → { events, total, truncated, ... });
//   2) a janela vai no PEDIDO (`since`), não só no filtro do cliente. O servidor filtra ANTES de
//      cortar (events.match → slice), então mandar o maior período do relatório (30d, o teto de
//      `Period`) faz o corte incidir sobre o universo QUE A TELA MOSTRA, e não sobre a fila
//      inteira. Não subimos o `limit`: payload previsível > "resolver escondendo" — e agora,
//      quando ele morde, a tela avisa.
const ALARM_FETCH_LIMIT = 500;
// Derivado de `periodDays` (fonte única dos períodos): se um período mais largo for criado, a
// janela pedida acompanha sozinha — nº mágico aqui viraria subcontagem silenciosa de volta.
const ALARM_FETCH_WINDOW_MS = Math.max(...Object.values(periodDays)) * 86_400_000;

/** O que a tela precisa saber sobre a carga da fila de alarmes (null = o hub não informa). */
export type AlarmsLoadMeta = {
  limit: number;
  total: number | null;
  /** null = desconhecido (hub antigo, sem o envelope) — NÃO é "não truncou". */
  truncated: boolean | null;
  retention: number | null;
  /** true = a janela pedida começa antes do alarme mais antigo que o hub ainda guarda. */
  retentionClipped: boolean;
};
type AlarmsEnvelope = {
  events: AlarmEvent[];
  total: number;
  truncated: boolean;
  limit: number;
  retention?: number;
  retentionClipped?: boolean;
};

export const ALARMS_META_UNKNOWN: AlarmsLoadMeta = {
  limit: ALARM_FETCH_LIMIT,
  total: null,
  truncated: null,
  retention: null,
  retentionClipped: false,
};

// Exportada p/ teste: normaliza a resposta (envelope novo OU array do hub antigo) sem MENTIR —
// hub antigo com página cheia vira `truncated: null` ("não sei"), nunca `false`.
export async function fetchAlarmsPage(
  now: number = Date.now(),
  get: (path: string) => Promise<unknown> = apiGet,
): Promise<{ events: AlarmEvent[]; meta: AlarmsLoadMeta }> {
  const since = now - ALARM_FETCH_WINDOW_MS;
  const r = await get(`/api/alarms?limit=${ALARM_FETCH_LIMIT}&since=${since}&meta=1`);
  // Hub antigo: ignora `meta` e devolve o array puro. Página CHEIA ⇒ pode ter sido cortada e
  // não há como saber — `truncated: null` ("não sei"), que a tela mostra como ressalva.
  if (Array.isArray(r)) {
    const full = r.length >= ALARM_FETCH_LIMIT;
    return {
      events: r as AlarmEvent[],
      meta: { ...ALARMS_META_UNKNOWN, truncated: full ? null : false, total: full ? null : r.length },
    };
  }
  // Envelope: campo que não vier no formato esperado vira null (desconhecido) — nunca um número
  // inventado, que é o modo silencioso de mentir.
  const env = (r ?? {}) as Partial<AlarmsEnvelope>;
  if (!Array.isArray(env.events)) throw new Error("Resposta inesperada de /api/alarms.");
  return {
    events: env.events,
    meta: {
      limit: typeof env.limit === "number" ? env.limit : ALARM_FETCH_LIMIT,
      total: typeof env.total === "number" ? env.total : null,
      truncated: typeof env.truncated === "boolean" ? env.truncated : null,
      retention: typeof env.retention === "number" ? env.retention : null,
      retentionClipped: env.retentionClipped === true,
    },
  };
}

// A meta é da CARGA (não do view-model do modo Alarmes) e é lida onde os números aparecem
// (AlarmesPanel) — store externo em vez de furar props por ReportPage, e reativo de verdade
// (useSyncExternalStore), sem cache mentiroso entre refreshes.
let alarmsMeta: AlarmsLoadMeta = ALARMS_META_UNKNOWN;
const metaSubs = new Set<() => void>();
function setAlarmsMeta(m: AlarmsLoadMeta) {
  alarmsMeta = m;
  for (const fn of metaSubs) fn();
}
export function useAlarmsLoadMeta(): AlarmsLoadMeta {
  return useSyncExternalStore(
    (fn) => {
      metaSubs.add(fn);
      return () => metaSubs.delete(fn);
    },
    () => alarmsMeta,
    () => alarmsMeta,
  );
}

export function useReportData() {
  const { toast } = useToast();
  const [ds, setDs] = useState<Dataset | null>(null);
  const [allEvents, setAllEvents] = useState<EventRow[]>([]);
  const [rds, setRds] = useState<ReadingDataset | null>(null);
  const [rEvents, setREvents] = useState<ReadingEventRow[]>([]);
  const [ods, setOds] = useState<ObjectDataset | null>(null);
  const [oEvents, setOEvents] = useState<ObjectEventRow[]>([]);
  const [fds, setFds] = useState<FadigaDataset | null>(null);
  const [fEvents, setFEvents] = useState<FadigaEventRow[]>([]);
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  // null = hub sem o kind "flow" (ou falha) → seção de fluxo oculta.
  const [flowDs, setFlowDs] = useState<FlowDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Fonte da persistência do histórico (contrato aditivo GET /api/data/status).
  // null = desconhecido (hub antigo sem a rota / falha do status) → texto genérico na UI.
  const [dataSource, setDataSource] = useState<DataPersistence | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);
    // Status da persistência em paralelo, com falha ISOLADA: erro aqui (404 no hub antigo)
    // nunca derruba o carregamento do relatório — só deixa a fonte como "desconhecida".
    getDataStatus()
      .then((s) =>
        setDataSource(s.persistence === "pg" || s.persistence === "json" ? s.persistence : null),
      )
      .catch(() => setDataSource(null));
    // Fluxo (kind "flow") com falha ISOLADA (mesmo padrão do status acima): num hub antigo
    // sem o kind, o GET dá 404 → seção de fluxo não aparece, sem derrubar o relatório.
    // MAS 404 (ausência legítima) ≠ rede/500 (falha): o `catch(() => null)` de antes fazia uma
    // seção inteira sumir em silêncio por queda de rede. Agora a ausência segue muda e a FALHA
    // fala (toast) — sem derrubar o resto do relatório.
    const flowP = loadFlowDataset().then(
      (v) => ({ ds: v, err: null as string | null }),
      (e: unknown) => ({
        ds: null,
        err:
          e instanceof ApiError && e.status === 404
            ? null // hub sem o kind "flow": ausência, não falha
            : e instanceof Error
              ? e.message
              : "Falha ao carregar o fluxo.",
      }),
    );
    try {
      const [d, e, rd, re, od, oe, fd, fe, al] = await Promise.all([
        loadDataset(),
        loadEvents(),
        loadReadingDataset(),
        loadReadingEvents(),
        loadObjectDataset(),
        loadObjectEvents(),
        loadFadigaDataset(),
        loadFadigaEvents(),
        fetchAlarmsPage(),
      ]);
      setDs(d);
      setAllEvents(e);
      setRds(rd);
      setREvents(re);
      setOds(od);
      setOEvents(oe);
      setFds(fd);
      setFEvents(fe);
      setAlarms(al.events);
      setAlarmsMeta(al.meta); // "500 de N" vira informação da tela, não segredo do servidor
      const flow = await flowP; // nunca rejeita (handler acima) — só habilita/oculta a seção
      setFlowDs(flow.ds);
      // Só avisa com o relatório DE PÉ: se a carga principal também falhou, o erro geral já
      // apareceu e um segundo toast seria ruído sobre a mesma queda.
      if (flow.err) toast(`Fluxo indisponível (${flow.err}) — a seção de fluxo fica oculta.`, "alert");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha ao carregar o histórico.";
      setError(msg);
      setAlarmsMeta(ALARMS_META_UNKNOWN); // carga falhou: nada a afirmar sobre cobertura
      toast(msg, "alert");
    }
    setLoading(false);
  }
  useEffect(() => {
    refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Limpa TODO o histórico no hub e recarrega (a confirmação destrutiva fica na página).
  async function clearHistory() {
    setBusy(true);
    try {
      await clearAll();
      await refresh();
      // "de indicadores" NÃO é detalhe: clear() não toca em alarm_events (ver CLEAR_DOMAINS em
      // ReportTools.tsx) — dizer "histórico limpo" com o modo Alarmes cheio é mentira.
      toast("Histórico de indicadores limpo.", "ok");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Falha ao limpar o histórico.", "alert");
    }
    setBusy(false);
  }

  return {
    ds,
    allEvents,
    rds,
    rEvents,
    ods,
    oEvents,
    fds,
    fEvents,
    alarms,
    flowDs,
    loading,
    error,
    dataSource,
    busy,
    refresh,
    clearHistory,
  };
}
