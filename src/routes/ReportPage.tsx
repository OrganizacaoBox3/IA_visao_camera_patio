import { useEffect, useMemo, useRef, useState } from "react";
import {
  windows,
  kpis,
  heatmap,
  ranking,
  evolution,
  insights,
  fmtMin,
  readingWindows,
  readingKpis,
  readingHeatmap,
  readingRanking,
  readingByCamera,
  readingEvolution,
  readingInsights,
  objectWindows,
  objectKpis,
  objectHeatmap,
  objectPresence,
  objectRanking,
  objectByClass,
  objectEvolution,
  objectInsights,
  fadigaWindows,
  fadigaKpis,
  fadigaHeatmap,
  fadigaEvolution,
  fadigaInsights,
  filterAlarms,
  alarmKpis,
  alarmTrend,
  alarmHeatmap,
  alarmInsights,
  alarmDayStart,
  type Period,
  type Shift,
  type Filters,
  type Dataset,
  type EventRow,
  type ReadingFilters,
  type ReadingDataset,
  type ReadingEventRow,
  type ObjectFilters,
  type ObjectDataset,
  type ObjectEventRow,
  type FadigaFilters,
  type FadigaDataset,
  type FadigaEventRow,
  type AlarmWindow,
} from "../report/mock";
import type { AlarmEvent, AlarmPriority, AlarmState } from "../types/alarm";
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
  peoplePeakOf,
  loadFlowDataset,
  flowWindow,
  flowKpis,
  flowByHour,
  flowByLine,
  type FlowDataset,
} from "../report/store";
import { getDataStatus, type DataPersistence } from "../api";
import {
  buildCSV,
  downloadCSVFile,
  dateStamp,
  metaSection,
  resumoSection,
  atividadeSections,
  leituraSections,
  objetosSections,
  fadigaSections,
  alarmesSections,
  type CsvSection,
} from "./report/csv";
import { filterByWindow, byShift } from "./report/aggregate";
import {
  Button,
  IconButton,
  PageHeader,
  Select,
  SegmentedControl,
  Skeleton,
  useToast,
  AlertDialog,
} from "../ui";
import "../report/alarms.css";
import { type RepTab } from "./report/chrome";
import { AtividadePanel } from "./report/AtividadePanel";
import { LeituraPanel } from "./report/LeituraPanel";
import { ObjetosPanel, classLabel } from "./report/ObjetosPanel";
import { FadigaPanel } from "./report/FadigaPanel";
import { AlarmesPanel, PRIORITY_LABEL, STATE_LABEL } from "./report/AlarmesPanel";

const ALARM_DAY_MS = 86_400_000;

type Mode = "resumo" | "atividade" | "leitura" | "objetos" | "fadiga" | "alarmes";
const MODE_LABEL: Record<Mode, string> = {
  resumo: "Resumo executivo",
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Operador (fadiga)",
  alarmes: "Alarmes",
};
const PERIOD_LABEL: Record<Period, string> = {
  hoje: "Hoje",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
};
const EMPTY_DS: Dataset = { days: 0, areas: [], cameraOf: {}, cells: [], startMs: Date.now() };
const EMPTY_RDS: ReadingDataset = {
  days: 0,
  pontos: [],
  cameraLabels: {},
  cells: [],
  startMs: Date.now(),
};
const EMPTY_ODS: ObjectDataset = {
  days: 0,
  setores: [],
  classes: [],
  cells: [],
  startMs: Date.now(),
};
const EMPTY_FDS: FadigaDataset = { days: 0, postos: [], cells: [], startMs: Date.now() };

export function ReportPage() {
  const [mode, setMode] = useState<Mode>("resumo");
  const [ds, setDs] = useState<Dataset | null>(null);
  const [allEvents, setAllEvents] = useState<EventRow[]>([]);
  const [rds, setRds] = useState<ReadingDataset | null>(null);
  const [rEvents, setREvents] = useState<ReadingEventRow[]>([]);
  const [ods, setOds] = useState<ObjectDataset | null>(null);
  const [oEvents, setOEvents] = useState<ObjectEventRow[]>([]);
  const [fds, setFds] = useState<FadigaDataset | null>(null);
  const [fEvents, setFEvents] = useState<FadigaEventRow[]>([]);
  const [alarms, setAlarms] = useState<AlarmEvent[]>([]);
  // Fluxo de pessoas (plano 1.3). null = hub sem o kind "flow" (ou falha) → seção oculta.
  const [flowDs, setFlowDs] = useState<FlowDataset | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Fonte da persistência do histórico (contrato aditivo GET /api/data/status).
  // null = desconhecido (hub antigo sem a rota / falha do status) → mantém o texto atual.
  const [dataSource, setDataSource] = useState<DataPersistence | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const [period, setPeriod] = useState<Period>("7d");
  const [shift, setShift] = useState<Shift | "Todos">("Todos");
  const [area, setArea] = useState<string | "Todas">("Todas");
  const [ponto, setPonto] = useState<string | "Todos">("Todos");
  const [setor, setSetor] = useState<string | "Todos">("Todos");
  const [posto, setPosto] = useState<string | "Todos">("Todos");
  const [present, setPresent] = useState(false);
  const [tab, setTab] = useState<RepTab>("quando");
  const [confirmClear, setConfirmClear] = useState(false); // AlertDialog de "limpar histórico"
  const [printedAt, setPrintedAt] = useState("");
  // Estado compartilhado da ligação RELATÓRIO↔EVENTOS (Onda B, item 8).
  const [alarmPriority, setAlarmPriority] = useState<AlarmPriority | "Todas">("Todas");
  const [alarmState, setAlarmState] = useState<AlarmState | "Todos">("Todos");
  const [alarmWindow, setAlarmWindow] = useState<AlarmWindow | null>(null); // janela de tempo (clique na tendência)
  const [alarmHour, setAlarmHour] = useState<number | null>(null); // hora-do-dia (clique no heatmap)
  const [selAlarm, setSelAlarm] = useState<string | null>(null); // evento selecionado (destaque bidirecional)
  const trendRef = useRef<HTMLDivElement | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    // Status da persistência em paralelo, com falha ISOLADA: erro aqui (404 no hub antigo)
    // nunca derruba o carregamento do relatório — só deixa a fonte como "desconhecida".
    getDataStatus()
      .then((s) => setDataSource(s.persistence === "pg" || s.persistence === "json" ? s.persistence : null))
      .catch(() => setDataSource(null));
    // Fluxo (kind "flow", plano 1.3) com falha ISOLADA (mesmo padrão do status acima): num hub
    // antigo sem o kind, o GET falha/404 → seção de fluxo não aparece, sem derrubar o relatório.
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
  async function onClear() {
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

  // ── Atividade (sempre computado p/ ordem estável de hooks) ──
  const dataset = ds ?? EMPTY_DS;
  // Filtros memorizados (identidade estável p/ entrarem nas deps dos memos sem recomputar a cada
  // render): só mudam quando period/shift/area mudam — mesmo gatilho dos campos primitivos de antes.
  const fA = useMemo<Filters>(() => ({ period, shift, area }), [period, shift, area]);
  const { current: aCur, previous: aPrev } = useMemo(() => windows(dataset, fA), [dataset, fA]);
  const k = useMemo(() => kpis(aCur), [aCur]);
  const kPrev = useMemo(() => kpis(aPrev), [aPrev]);
  // Pico de pessoas no recorte (plano 2.6): people_peak já persistia e era ignorado no relatório.
  const kPeople = useMemo(() => peoplePeakOf(aCur), [aCur]);
  const areasForHeat = area === "Todas" ? dataset.areas : [area];
  const hm = useMemo(() => heatmap(aCur, areasForHeat), [aCur, area]); // eslint-disable-line react-hooks/exhaustive-deps
  const rank = useMemo(() => ranking(aCur, dataset.areas), [aCur, dataset.areas]);
  const evo = useMemo(() => evolution(dataset, fA, 14), [dataset, fA]);
  const evt = useMemo(
    () => filterByWindow(allEvents, period, shift, (e) => area === "Todas" || e.area === area).slice(0, 80),
    [allEvents, period, shift, area],
  );
  const tips = useMemo(() => insights(aCur, k), [aCur, k]);
  const byAtiv = useMemo(() => {
    const m = new Map<string, { idleMin: number; alerts: number }>();
    for (const c of aCur) {
      const a = c.atividade ?? "Indefinida";
      const e = m.get(a) ?? { idleMin: 0, alerts: 0 };
      e.idleMin += c.idleMin;
      e.alerts += c.alerts;
      m.set(a, e);
    }
    const rows = [...m.entries()]
      .map(([atividade, v]) => ({ atividade, ...v }))
      .filter((r) => r.idleMin > 0)
      .sort((a, b) => b.idleMin - a.idleMin);
    return { rows, max: Math.max(1, ...rows.map((r) => r.idleMin)) };
  }, [aCur]);
  const byShiftA = useMemo(() => byShift(aCur, (c) => c.idleMin), [aCur]);
  // ── Fluxo de pessoas (plano 1.3) — dentro da história de Atividade. Respeita período/turno;
  // o filtro de ÁREA não se aplica (buckets são câmera×linha, sem área — documentado no painel).
  const flowCur = useMemo(
    () => (flowDs ? flowWindow(flowDs, period, shift) : []),
    [flowDs, period, shift],
  );
  const flowK = useMemo(() => flowKpis(flowCur), [flowCur]);
  const flowHours = useMemo(() => flowByHour(flowCur), [flowCur]);
  const flowLines = useMemo(() => flowByLine(flowCur), [flowCur]);
  const flowView = useMemo(
    () =>
      flowDs
        ? { hasAny: flowDs.cells.length > 0, k: flowK, byHour: flowHours, byLine: flowLines }
        : null,
    [flowDs, flowK, flowHours, flowLines],
  );

  // ── Leitura ──
  const rdataset = rds ?? EMPTY_RDS;
  const fR = useMemo<ReadingFilters>(() => ({ period, shift, ponto }), [period, shift, ponto]);
  const { current: rCur, previous: rPrev } = useMemo(
    () => readingWindows(rdataset, fR),
    [rdataset, fR],
  );
  const rk = useMemo(() => readingKpis(rCur), [rCur]);
  const rkPrev = useMemo(() => readingKpis(rPrev), [rPrev]);
  const pontosForHeat = ponto === "Todos" ? rdataset.pontos : [ponto];
  const rhm = useMemo(() => readingHeatmap(rCur, pontosForHeat), [rCur, ponto]); // eslint-disable-line react-hooks/exhaustive-deps
  const rrank = useMemo(() => readingRanking(rCur, rdataset.pontos), [rCur, rdataset.pontos]);
  const byCam = useMemo(
    () => readingByCamera(rCur, rdataset.cameraLabels),
    [rCur, rdataset.cameraLabels],
  );
  const revo = useMemo(() => readingEvolution(rdataset, fR, 14), [rdataset, fR]);
  const revt = useMemo(
    () =>
      filterByWindow(rEvents, period, shift, (e) => ponto === "Todos" || e.ponto === ponto).slice(
        0,
        120,
      ),
    [rEvents, period, shift, ponto],
  );
  const rtips = useMemo(() => readingInsights(rk), [rk]);
  const byShiftR = useMemo(() => byShift(rCur, (c) => c.boxes), [rCur]);

  // ── Objetos ──
  const odataset = ods ?? EMPTY_ODS;
  const fO = useMemo<ObjectFilters>(() => ({ period, shift, setor }), [period, shift, setor]);
  const { current: oCur } = useMemo(() => objectWindows(odataset, fO), [odataset, fO]);
  const ok = useMemo(() => objectKpis(oCur), [oCur]);
  const ohm = useMemo(() => objectHeatmap(oCur, odataset.classes), [oCur, odataset.classes]);
  const opres = useMemo(
    () => objectPresence(oCur, setor === "Todos" ? odataset.setores : [setor], odataset.classes),
    [oCur, setor, odataset.setores, odataset.classes],
  );
  const orank = useMemo(() => objectRanking(oCur, odataset.setores), [oCur, odataset.setores]);
  const obyClass = useMemo(() => objectByClass(oCur, odataset.classes), [oCur, odataset.classes]);
  const oevo = useMemo(() => objectEvolution(odataset, fO, 14), [odataset, fO]);
  const oevt = useMemo(
    () =>
      filterByWindow(oEvents, period, shift, (e) => setor === "Todos" || e.setor === setor).slice(
        0,
        120,
      ),
    [oEvents, period, shift, setor],
  );
  const oLoads = useMemo(() => oevt.filter((e) => e.type === "carregamento").length, [oevt]);
  const otips = useMemo(() => objectInsights(ok, oLoads), [ok, oLoads]);
  const presSetores = setor === "Todos" ? odataset.setores : [setor];

  // ── Fadiga ──
  const fdataset = fds ?? EMPTY_FDS;
  const fF = useMemo<FadigaFilters>(() => ({ period, shift, posto }), [period, shift, posto]);
  const { current: fCur } = useMemo(() => fadigaWindows(fdataset, fF), [fdataset, fF]);
  const fk = useMemo(() => fadigaKpis(fCur), [fCur]);
  const fhm = useMemo(() => fadigaHeatmap(fCur), [fCur]);
  const fevo = useMemo(() => fadigaEvolution(fdataset, fF, 14), [fdataset, fF]);
  const fevt = useMemo(
    () =>
      filterByWindow(fEvents, period, shift, (e) => posto === "Todos" || e.posto === posto).slice(
        0,
        120,
      ),
    [fEvents, period, shift, posto],
  );
  const fOccFadiga = useMemo(() => fevt.filter((e) => e.type === "fadiga").length, [fevt]);
  const fOccCelular = useMemo(() => fevt.filter((e) => e.type === "celular").length, [fevt]);
  const fBocejos = useMemo(() => fevt.filter((e) => e.type === "bocejo").length, [fevt]);
  const ftips = useMemo(
    () => fadigaInsights(fk, fOccFadiga, fOccCelular),
    [fk, fOccFadiga, fOccCelular],
  );

  // ── Alarmes (eventos B1) — sempre computado p/ ordem estável de hooks ──
  const aFilters = useMemo(
    () => ({ period, priority: alarmPriority, state: alarmState }),
    [period, alarmPriority, alarmState],
  );
  // Conjunto que respeita só prioridade/estado/período (alimenta os gráficos — sem a janela/hora,
  // p/ os gráficos não "encolherem" ao clicar neles próprios).
  const alarmsScoped = useMemo(() => filterAlarms(alarms, aFilters), [alarms, aFilters]);
  // Lista visível: aplica também a janela de tempo e a hora selecionadas nos gráficos.
  const alarmsView = useMemo(
    () => filterAlarms(alarms, aFilters, alarmWindow, alarmHour),
    [alarms, aFilters, alarmWindow, alarmHour],
  );
  const ak = useMemo(() => alarmKpis(alarmsView), [alarmsView]);
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

  const isResumo = mode === "resumo";
  const isReading = mode === "leitura";
  const isObjects = mode === "objetos";
  const isFadiga = mode === "fadiga";
  const isAlarmes = mode === "alarmes";
  // Alarmes tem estado de vazio próprio (dentro da view); não entra no noData genérico.
  const noData =
    !loading &&
    !error &&
    !isAlarmes &&
    (isResumo
      ? dataset.cells.length === 0 &&
        rdataset.cells.length === 0 &&
        odataset.cells.length === 0 &&
        fdataset.cells.length === 0
      : isReading
        ? rdataset.cells.length === 0
        : isObjects
          ? odataset.cells.length === 0
          : isFadiga
            ? fdataset.cells.length === 0
            : dataset.cells.length === 0);
  const lens = isAlarmes
    ? `${PERIOD_LABEL[period]} · Prioridade: ${alarmPriority === "Todas" ? "todas" : PRIORITY_LABEL[alarmPriority]} · Estado: ${alarmState === "Todos" ? "todos" : STATE_LABEL[alarmState]}`
    : isReading
      ? `${PERIOD_LABEL[period]} · ${ponto === "Todos" ? "Todos os pontos" : ponto} · Turno: ${shift === "Todos" ? "todos" : shift}`
      : isObjects
        ? `${PERIOD_LABEL[period]} · ${setor === "Todos" ? "Todos os setores" : setor} · Turno: ${shift === "Todos" ? "todos" : shift}`
        : isFadiga
          ? `${PERIOD_LABEL[period]} · ${posto === "Todos" ? "Todos os postos" : posto} · Turno: ${shift === "Todos" ? "todos" : shift}`
          : `${PERIOD_LABEL[period]} · ${area === "Todas" ? "Todas as áreas" : area} · Turno: ${shift === "Todos" ? "todos" : shift}`;

  const filtroLabel = isAlarmes
    ? `Prioridade ${alarmPriority === "Todas" ? "todas" : PRIORITY_LABEL[alarmPriority]} · Estado ${alarmState === "Todos" ? "todos" : STATE_LABEL[alarmState]}`
    : isReading
      ? ponto === "Todos"
        ? "Todos os pontos"
        : ponto
      : isObjects
        ? setor === "Todos"
          ? "Todos os setores"
          : setor
        : isFadiga
          ? posto === "Todos"
            ? "Todos os postos"
            : posto
          : area === "Todas"
            ? "Todas as áreas"
            : area;

  // CSV "rico": metadados + indicadores + detalhamento + eventos, num arquivo só (auto-descritivo).
  // Orquestração pura: os builders por modo vivem em ./report/csv.ts (seções reutilizáveis).
  function downloadCSV() {
    const now = new Date();
    const sections: CsvSection[] = [
      metaSection({
        modeLabel: MODE_LABEL[mode],
        periodLabel: PERIOD_LABEL[period],
        shift: shift === "Todos" ? "Todos" : shift,
        filtroLabel,
        now,
      }),
    ];

    if (isResumo) {
      sections.push(resumoSection({ k, fk, fOccFadiga, fOccCelular, rk, ok }));
    } else if (mode === "atividade") {
      // Fluxo (plano 1.3): só quando o hub expõe o kind "flow" (hub antigo → omite). Recorte
      // período/turno; o filtro de área NÃO se aplica ao fluxo (câmera×linha, sem área).
      sections.push(
        ...atividadeSections({
          k,
          peoplePeak: kPeople,
          rankRows: rank.rows,
          byAtivRows: byAtiv.rows,
          byShiftA: byShiftA.m,
          flow: flowDs ? { k: flowK, lineRows: flowLines.rows } : null,
          evt,
        }),
      );
    } else if (isReading) {
      sections.push(
        ...leituraSections({
          rk,
          rrankRows: rrank.rows,
          byCamRows: byCam.rows,
          byShiftR: byShiftR.m,
          revt,
        }),
      );
    } else if (isObjects) {
      sections.push(
        ...objetosSections({
          ok,
          oLoads,
          classes: odataset.classes,
          presSetores,
          opres,
          orankRows: orank.rows,
          obyClassRows: obyClass.rows,
          oevt,
        }),
      );
    } else if (isFadiga) {
      sections.push(...fadigaSections({ fk, fOccFadiga, fOccCelular, fBocejos, fevt }));
    } else if (isAlarmes) {
      sections.push(...alarmesSections({ ak, alarmsView }));
    }

    downloadCSVFile(`relatorio_${mode}_${period}_${dateStamp(now)}.csv`, buildCSV(sections));
  }

  // Cabeçalho impresso (só no PDF): título + recorte + carimbo de geração.
  function printPDF() {
    setPrintedAt(new Date().toLocaleString("pt-BR"));
    setTimeout(() => window.print(), 60);
  }

  return (
    <div className={`page report ${present ? "present" : ""}`}>
      {/* Header padrão da casa (átomo PageHeader, h1 título 14) — substitui .page-head/.page-title */}
      <PageHeader title="Relatório Operacional" className="no-print">
        <SegmentedControl<Mode>
          value={mode}
          onChange={(m) => {
            setMode(m);
            // a aba "fluxo" só existe no modo Atividade — devolve o estado compartilhado.
            if (tab === "fluxo" && m !== "atividade") setTab("quando");
          }}
          ariaLabel="Modo do relatório"
          options={[
            { value: "resumo", label: "Resumo" },
            { value: "atividade", label: "Atividade" },
            { value: "leitura", label: "Leitura" },
            { value: "objetos", label: "Objetos" },
            { value: "fadiga", label: "Operador" },
            { value: "alarmes", label: "Alarmes" },
          ]}
        />
        <span className="privacy">● indicadores · sem imagens</span>
        <div className="flex-1" />
        <span className="muted text-[11px]">
          {isAlarmes
            ? "alarmes · fila de eventos (metadados)"
            : isReading
              ? "leitura · código de barras"
              : isObjects
                ? "objetos · contagem/presença"
                : isFadiga
                  ? "operador · fadiga/risco"
                  : "atividade · ocupação/ociosidade"}
        </span>
      </PageHeader>

      <div className="rep-filters rep-filters-m no-print">
        <SegmentedControl<Period>
          value={period}
          onChange={setPeriod}
          ariaLabel="Período"
          options={(["hoje", "7d", "30d"] as Period[]).map((p) => ({
            value: p,
            label: PERIOD_LABEL[p],
          }))}
        />
        {!isAlarmes && (
          <Select
            value={shift}
            onChange={(v) => setShift(v as Shift | "Todos")}
            ariaLabel="Turno"
            options={[
              { value: "Todos", label: "Turno: todos" },
              { value: "Manhã", label: "Manhã" },
              { value: "Tarde", label: "Tarde" },
              { value: "Noite", label: "Noite" },
            ]}
          />
        )}
        {isAlarmes ? (
          <>
            <Select
              value={alarmPriority}
              onChange={(v) => setAlarmPriority(v as AlarmPriority | "Todas")}
              ariaLabel="Prioridade"
              options={[
                { value: "Todas", label: "Prioridade: todas" },
                { value: "critical", label: "Crítica" },
                { value: "high", label: "Alta" },
                { value: "advisory", label: "Informativo" },
              ]}
            />
            <Select
              value={alarmState}
              onChange={(v) => setAlarmState(v as AlarmState | "Todos")}
              ariaLabel="Estado"
              options={[
                { value: "Todos", label: "Estado: todos" },
                { value: "new", label: "Novo" },
                { value: "acknowledged", label: "Reconhecido" },
                { value: "forwarded", label: "Encaminhado" },
              ]}
            />
          </>
        ) : isResumo ? null : isReading ? (
          <Select
            value={ponto}
            onChange={setPonto}
            ariaLabel="Ponto"
            options={[
              { value: "Todos", label: "Todos os pontos" },
              ...rdataset.pontos.map((p) => ({ value: p, label: p })),
            ]}
          />
        ) : isObjects ? (
          <Select
            value={setor}
            onChange={setSetor}
            ariaLabel="Setor"
            options={[
              { value: "Todos", label: "Todos os setores" },
              ...odataset.setores.map((s) => ({ value: s, label: s })),
            ]}
          />
        ) : isFadiga ? (
          <Select
            value={posto}
            onChange={setPosto}
            ariaLabel="Posto"
            options={[
              { value: "Todos", label: "Todos os postos" },
              ...fdataset.postos.map((p) => ({ value: p, label: p })),
            ]}
          />
        ) : (
          <Select
            value={area}
            onChange={setArea}
            ariaLabel="Área"
            options={[
              { value: "Todas", label: "Todas as áreas" },
              ...dataset.areas.map((a) => ({ value: a, label: a })),
            ]}
          />
        )}
        <div className="spacer" />
        {dataSource && (
          <span className="muted text-[11px]" title="Onde o hub grava os indicadores">
            histórico: {dataSource === "pg" ? "banco" : "arquivo local"}
          </span>
        )}
        <IconButton label="Recarregar do histórico" onClick={refresh}>
          ↻
        </IconButton>
        <Button onClick={() => setPresent((v) => !v)}>
          {present ? "Sair da apresentação" : "Apresentação"}
        </Button>
        <Button onClick={downloadCSV}>⬇ CSV</Button>
        <Button onClick={printPDF}>⎙ PDF</Button>
      </div>

      <div className="print-head only-print" aria-hidden>
        <div className="ph-title">Relatório Operacional · {MODE_LABEL[mode]}</div>
        <div className="ph-sub">
          {isResumo
            ? `${PERIOD_LABEL[period]} · Turno: ${shift === "Todos" ? "todos" : shift}`
            : lens}
        </div>
        <div className="ph-meta">
          Gerado em {printedAt || "—"} · indicadores agregados, sem imagens (LGPD)
        </div>
      </div>

      <div className="rep-body">
        {loading && (
          <div className="rep-skeleton" aria-busy="true" aria-label="Carregando relatório">
            <div className="kpi-row">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="kpi big">
                  <Skeleton w="55%" h={22} />
                  <Skeleton w="80%" h={11} />
                </div>
              ))}
            </div>
            <Skeleton w="100%" h={240} />
          </div>
        )}
        {!loading && error && (
          <div className="dash-empty" role="alert">
            <p>
              <b>Não foi possível carregar o histórico.</b>
            </p>
            <p className="muted">{error}</p>
            <p className="mt-[var(--sp-3)]">
              <Button variant="primary" onClick={refresh}>
                Tentar novamente
              </Button>
            </p>
          </div>
        )}
        {noData && (
          <div className="dash-empty">
            <p>
              <b>
                Sem histórico de{" "}
                {isReading
                  ? "leitura"
                  : isObjects
                    ? "objetos"
                    : isFadiga
                      ? "operador"
                      : "atividade"}{" "}
                ainda.
              </b>
            </p>
            {/* Descoberta dos modos (jul/2026): o vazio agora dá o CAMINHO exato (Central →
                zona → ⚙ Configurar zona → Modo), no tom do painel de Fluxo. Antes dizia
                "marque a câmera como Leitura/Objetos" — esse ajuste não existe por câmera. */}
            <p>
              {isReading ? (
                <>
                  Na Central, abra a câmera → desenhe uma zona sobre a etiqueta/esteira (✎ Zona) →
                  ⚙ Configurar zona → <b>Modo: Leitura</b>.
                </>
              ) : isObjects ? (
                <>
                  Na Central, abra a câmera → desenhe uma zona sobre a área (✎ Zona) → ⚙ Configurar
                  zona → <b>Modo: Objetos</b> e escolha as classes.
                </>
              ) : isFadiga ? (
                <>
                  Em <b>Câmeras → Ajustes desta câmera</b>, selecione <b>Operador (fadiga)</b> na
                  câmera do posto — ou desenhe uma zona com <b>Modo: Fadiga</b> numa câmera de área.
                </>
              ) : (
                <>
                  Na Central, abra a câmera → desenhe uma zona sobre a área de trabalho (✎ Zona) —
                  o modo <b>Atividade</b> é o padrão. Deixe a Central rodando para acumular
                  indicadores.
                </>
              )}
            </p>
            {/* Vazio HONESTO (plano 1.2): com a persistência confirmada pelo hub, afirmamos que é
                falta de dados no período (não banco ausente). Sem o status (hub antigo), texto atual. */}
            <p className="muted">
              {dataSource
                ? `Sem dados no período — deixe a Central aberta com câmeras ativas. Histórico gravado em ${
                    dataSource === "pg" ? "banco" : "arquivo local no servidor"
                  }.`
                : "Os dados aparecem automaticamente conforme as câmeras operam."}
            </p>
          </div>
        )}

        {!loading && !error && !noData && isResumo && (
          <>
            <div className="rep-lens">
              Resumo executivo · <b>{PERIOD_LABEL[period]}</b> · Turno:{" "}
              {shift === "Todos" ? "todos" : shift}
            </div>
            <div className="rep-resumo">
              <button className="resumo-card" onClick={() => setMode("atividade")}>
                <div className="rc-h">
                  Operação <span className="muted">atividade</span>
                </div>
                <div className="rc-kpis">
                  <div className="rc-k">
                    {/* going-gray: verde incondicional removido — cor só condicional a estado */}
                    <b>{k.activePct}%</b>
                    <span>tempo ativo</span>
                  </div>
                  <div className="rc-k">
                    <b>{fmtMin(k.idleMin)}</b>
                    <span>parado</span>
                  </div>
                  <div className="rc-k">
                    <b style={{ color: k.alerts ? "var(--state-critical)" : undefined }}>
                      {k.alerts}
                    </b>
                    <span>alertas</span>
                  </div>
                </div>
                <div className="rc-foot">
                  área mais parada: {k.topArea} · pico {String(k.peakHour).padStart(2, "0")}h
                </div>
              </button>

              <button className="resumo-card" onClick={() => setMode("fadiga")}>
                <div className="rc-h">
                  Segurança <span className="muted">operador/fadiga</span>
                </div>
                <div className="rc-kpis">
                  <div className="rc-k">
                    <b
                      style={{
                        // going-gray: ≤2% é o normal → sem cor; saturada só no risco.
                        color:
                          fk.alertPct <= 2
                            ? undefined
                            : fk.alertPct <= 10
                              ? "var(--state-warn)"
                              : "var(--state-critical)",
                      }}
                    >
                      {fk.alertPct}%
                    </b>
                    <span>em alerta</span>
                  </div>
                  <div className="rc-k">
                    <b style={{ color: fOccFadiga ? "var(--state-warn)" : undefined }}>
                      {fOccFadiga}
                    </b>
                    <span>fadiga</span>
                  </div>
                  <div className="rc-k">
                    <b style={{ color: fOccCelular ? "var(--state-warn)" : undefined }}>
                      {fOccCelular}
                    </b>
                    <span>celular</span>
                  </div>
                </div>
                <div className="rc-foot">
                  horário crítico: {String(fk.peakHour).padStart(2, "0")}h
                </div>
              </button>

              <button className="resumo-card" onClick={() => setMode("leitura")}>
                <div className="rc-h">
                  Logística <span className="muted">leitura/expedição</span>
                </div>
                <div className="rc-kpis">
                  <div className="rc-k">
                    <b>{rk.boxes.toLocaleString("pt-BR")}</b>
                    <span>caixas</span>
                  </div>
                  <div className="rc-k">
                    <b
                      style={{
                        // going-gray: taxa boa (≥95%) é o normal → sem cor; saturada só no degradado.
                        color:
                          rk.ratePct >= 95
                            ? undefined
                            : rk.ratePct >= 80
                              ? "var(--state-warn)"
                              : "var(--state-critical)",
                      }}
                    >
                      {rk.ratePct}%
                    </b>
                    <span>taxa</span>
                  </div>
                  <div className="rc-k">
                    <b style={{ color: rk.noReads ? "var(--state-critical)" : undefined }}>
                      {rk.noReads}
                    </b>
                    <span>no-reads</span>
                  </div>
                </div>
                <div className="rc-foot">ponto de maior volume: {rk.topPonto}</div>
              </button>

              <button className="resumo-card" onClick={() => setMode("objetos")}>
                <div className="rc-h">
                  Objetos <span className="muted">contagem/presença</span>
                </div>
                <div className="rc-kpis">
                  <div className="rc-k">
                    <b>{ok.avgCount}</b>
                    <span>médios</span>
                  </div>
                  <div className="rc-k">
                    <b>{ok.peak}</b>
                    <span>pico</span>
                  </div>
                  <div className="rc-k">
                    <b style={{ color: oLoads ? "var(--state-warn)" : undefined }}>{oLoads}</b>
                    <span>carregam.</span>
                  </div>
                </div>
                <div className="rc-foot">predominante: {classLabel(ok.topClasse)}</div>
              </button>
            </div>
            <section className="insight">
              <b>Destaques</b>{" "}
              {[...tips.slice(0, 1), ...ftips.slice(0, 1), ...rtips.slice(0, 1)]
                .filter(Boolean)
                .join(" · ") || "Sem ocorrências relevantes no período."}
            </section>
            <p className="rep-foot">
              Toque num cartão para abrir o detalhe. Indicadores agregados, sem imagens (LGPD).
            </p>
          </>
        )}

        {!loading && !error && !noData && mode === "atividade" && (
          <AtividadePanel
            lens={lens}
            k={k}
            kPrev={kPrev}
            peoplePeak={kPeople}
            tips={tips}
            hm={hm}
            rank={rank}
            byAtiv={byAtiv}
            evo={evo}
            byShiftA={byShiftA}
            evt={evt}
            flow={flowView}
            tab={tab}
            onTabChange={setTab}
            busy={busy}
            onClear={() => setConfirmClear(true)}
          />
        )}

        {!loading && !error && !noData && isReading && (
          <LeituraPanel
            lens={lens}
            rk={rk}
            rkPrev={rkPrev}
            rtips={rtips}
            rhm={rhm}
            rrank={rrank}
            byCam={byCam}
            revo={revo}
            byShiftR={byShiftR}
            revt={revt}
            tab={tab}
            onTabChange={setTab}
            busy={busy}
            onClear={() => setConfirmClear(true)}
          />
        )}

        {!loading && !error && !noData && isObjects && (
          <ObjetosPanel
            lens={lens}
            ok={ok}
            oLoads={oLoads}
            otips={otips}
            ohm={ohm}
            opres={opres}
            orank={orank}
            obyClass={obyClass}
            oevo={oevo}
            oevt={oevt}
            classes={odataset.classes}
            presSetores={presSetores}
            tab={tab}
            onTabChange={setTab}
            busy={busy}
            onClear={() => setConfirmClear(true)}
          />
        )}

        {!loading && !error && !noData && isFadiga && (
          <FadigaPanel
            lens={lens}
            fk={fk}
            fOccFadiga={fOccFadiga}
            fOccCelular={fOccCelular}
            fBocejos={fBocejos}
            ftips={ftips}
            fhm={fhm}
            fevo={fevo}
            fevt={fevt}
            tab={tab}
            onTabChange={setTab}
            busy={busy}
            onClear={() => setConfirmClear(true)}
          />
        )}

        {!loading && !error && isAlarmes && (
          <AlarmesPanel
            periodLabel={PERIOD_LABEL[period]}
            alarmPriority={alarmPriority}
            alarmState={alarmState}
            alarms={alarms}
            ak={ak}
            aTips={aTips}
            aTrend={aTrend}
            aHeat={aHeat}
            alarmsView={alarmsView}
            alarmWindow={alarmWindow}
            alarmHour={alarmHour}
            selAlarm={selAlarm}
            selDay={selDay}
            selHour={selHour}
            trendRef={trendRef}
            pickDay={pickDay}
            pickHour={pickHour}
            pickAlarm={pickAlarm}
            clearAlarmSel={clearAlarmSel}
            onRefresh={refresh}
          />
        )}
      </div>

      <AlertDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        variant="danger"
        title="Limpar todo o histórico?"
        description="Esta ação apaga permanentemente todos os indicadores, eventos e alarmes registrados no histórico (Postgres). Não é possível desfazer."
        confirmLabel="Limpar histórico"
        cancelLabel="Cancelar"
        onConfirm={onClear}
        busy={busy}
      />
    </div>
  );
}
