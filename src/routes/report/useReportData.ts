// Carga do HISTÓRICO do Relatório: busca as 5 dimensões + alarmes + fluxo numa leva, com
// estado de loading/erro e a fonte de persistência. Regras de resiliência preservadas:
// status e fluxo falham ISOLADOS (hub antigo → seção oculta/texto genérico, relatório de pé);
// o resto falha JUNTO (erro visível — "API fora do ar" nunca vira "sem dados").
import { useEffect, useState } from "react";
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
  loadAlarms,
  loadFlowDataset,
} from "../../report/store";
import { getDataStatus, type DataPersistence } from "../../api";
import { useToast } from "../../ui";

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
    // sem o kind, o GET falha/404 → seção de fluxo não aparece, sem derrubar o relatório.
    const flowP = loadFlowDataset().catch(() => null);
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
        loadAlarms({ limit: 500 }),
      ]);
      setDs(d);
      setAllEvents(e);
      setRds(rd);
      setREvents(re);
      setOds(od);
      setOEvents(oe);
      setFds(fd);
      setFEvents(fe);
      setAlarms(al);
      setFlowDs(await flowP); // nunca rejeita (catch acima) — só habilita/oculta a seção
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha ao carregar o histórico.";
      setError(msg);
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
      toast("Histórico limpo.", "ok");
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
