// Relatório Operacional — ORQUESTRAÇÃO: carga do histórico, modo/filtros, CSV/PDF e o JSX
// das cascas. O pipeline de cada modo vive num view-model hook (routes/report/use*VM) que
// computa SÓ a visão atual ("off"/"summary"/"full"); as agregações puras vivem em report/calc.
// LGPD: tudo aqui são indicadores agregados — nunca imagens.
import { useState } from "react";
import { Download, Printer, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { type Period, type Shift } from "../report/calc";
import { type AlarmPriority, type AlarmState } from "../types/alarm";
import { buildCSV, downloadCSVFile, dateStamp, reportSections } from "./report/csv";
import {
  Button,
  IconButton,
  PageHeader,
  Select,
  SegmentedControl,
  Skeleton,
  AlertDialog,
} from "../ui";
import "../report/alarms.css";
import { type RepTab, type VmView } from "./report/chrome";
import {
  MODE_LABEL,
  PERIOD_LABEL,
  reportLens,
  reportFiltroLabel,
  type Mode,
} from "./report/labels";
import { useReportData } from "./report/useReportData";
import { useAtividadeVM } from "./report/useAtividadeVM";
import { useLeituraVM } from "./report/useLeituraVM";
import { useObjetosVM } from "./report/useObjetosVM";
import { useFadigaVM } from "./report/useFadigaVM";
import { useAlarmesVM } from "./report/useAlarmesVM";
import { EmptyHistory } from "./report/EmptyHistory";
import { ResumoPanel } from "./report/ResumoPanel";
import { AtividadePanel } from "./report/AtividadePanel";
import { LeituraPanel } from "./report/LeituraPanel";
import { ObjetosPanel } from "./report/ObjetosPanel";
import { FadigaPanel } from "./report/FadigaPanel";
import { AlarmesPanel } from "./report/AlarmesPanel";

export function ReportPage() {
  const [mode, setMode] = useState<Mode>("resumo");
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

  // Carga do histórico (5 dimensões + alarmes + fluxo) e limpeza — useReportData.
  const data = useReportData();
  const { alarms, loading, error, dataSource, busy, refresh, clearHistory } = data;

  // ── View-models por modo: SÓ o modo ativo computa ("full"); o Resumo pede o "summary"
  //    das 4 dimensões (é o que ele exibe); o resto fica "off" (memos devolvem null). ──
  const viewFor = (m: Mode): VmView =>
    mode === m ? "full" : mode === "resumo" ? "summary" : "off";
  const atividade = useAtividadeVM({
    view: viewFor("atividade"),
    ds: data.ds,
    events: data.allEvents,
    flowDs: data.flowDs,
    period,
    shift,
    area,
  });
  const leitura = useLeituraVM({
    view: viewFor("leitura"),
    ds: data.rds,
    events: data.rEvents,
    period,
    shift,
    ponto,
  });
  const objetos = useObjetosVM({
    view: viewFor("objetos"),
    ds: data.ods,
    events: data.oEvents,
    period,
    shift,
    setor,
  });
  const fadiga = useFadigaVM({
    view: viewFor("fadiga"),
    ds: data.fds,
    events: data.fEvents,
    period,
    shift,
    posto,
  });
  const al = useAlarmesVM({ active: mode === "alarmes", alarms, period });

  const isResumo = mode === "resumo";
  const isReading = mode === "leitura";
  const isObjects = mode === "objetos";
  const isFadiga = mode === "fadiga";
  const isAlarmes = mode === "alarmes";
  // Alarmes tem estado de vazio próprio (dentro da view); não entra no noData genérico.
  // Resumo só é "vazio" quando as QUATRO dimensões estão vazias.
  const modeVm = isReading ? leitura : isObjects ? objetos : isFadiga ? fadiga : atividade;
  const noData =
    !loading &&
    !error &&
    !isAlarmes &&
    (isResumo
      ? [atividade, leitura, objetos, fadiga].every((v) => v.dataset.cells.length === 0)
      : modeVm.dataset.cells.length === 0);
  const ready = !loading && !error && !noData; // painéis só com dados carregados e não-vazios
  const { alarmPriority, alarmState } = al;
  const filters = { mode, period, shift, area, ponto, setor, posto, alarmPriority, alarmState };
  const lens = reportLens(filters);
  const filtroLabel = reportFiltroLabel(filters);
  // Filtro específico do modo (mesmo <Select> p/ ponto/setor/posto/área — só muda a fonte).
  // "Todas" (área) × "Todos" (demais) preservados como valores-sentinela.
  const modeFilter = isReading
    ? {
        aria: "Ponto",
        value: ponto,
        set: setPonto,
        allValue: "Todos",
        allLabel: "Todos os pontos",
        items: leitura.dataset.pontos,
      }
    : isObjects
      ? {
          aria: "Setor",
          value: setor,
          set: setSetor,
          allValue: "Todos",
          allLabel: "Todos os setores",
          items: objetos.dataset.setores,
        }
      : isFadiga
        ? {
            aria: "Posto",
            value: posto,
            set: setPosto,
            allValue: "Todos",
            allLabel: "Todos os postos",
            items: fadiga.dataset.postos,
          }
        : {
            aria: "Área",
            value: area,
            set: setArea,
            allValue: "Todas",
            allLabel: "Todas as áreas",
            items: atividade.dataset.areas,
          };

  // CSV "rico": metadados + indicadores + detalhamento + eventos, num arquivo só (auto-
  // descritivo). A montagem por modo vive em ./report/csv.ts (reportSections).
  function downloadCSV() {
    const now = new Date();
    const sections = reportSections({
      mode,
      period,
      shift,
      filtroLabel,
      now,
      atividade,
      leitura,
      objetos,
      fadiga,
      alarmes: { ak: al.ak, alarmsView: al.alarmsView },
    });
    downloadCSVFile(`relatorio_${mode}_${period}_${dateStamp(now)}.csv`, buildCSV(sections));
  }

  // Cabeçalho impresso (só no PDF): título + recorte + carimbo de geração.
  function printPDF() {
    setPrintedAt(new Date().toLocaleString("pt-BR"));
    setTimeout(() => window.print(), 60);
  }

  return (
    <div className={`page report ${present ? "present" : ""}`}>
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
        {/* going-gray (#12): estado normal → pílula neutra (.rep-privacy, report/report.css)
            com ShieldCheck (mesmo par do rail), não verde saturado permanente. */}
        <span className="rep-privacy">
          <ShieldCheck size={13} strokeWidth={1.75} aria-hidden /> indicadores · sem imagens
        </span>
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
              value={al.alarmPriority}
              onChange={(v) => al.setAlarmPriority(v as AlarmPriority | "Todas")}
              ariaLabel="Prioridade"
              options={[
                { value: "Todas", label: "Prioridade: todas" },
                { value: "critical", label: "Crítica" },
                { value: "high", label: "Alta" },
                { value: "advisory", label: "Informativo" },
              ]}
            />
            <Select
              value={al.alarmState}
              onChange={(v) => al.setAlarmState(v as AlarmState | "Todos")}
              ariaLabel="Estado"
              options={[
                { value: "Todos", label: "Estado: todos" },
                { value: "new", label: "Novo" },
                { value: "acknowledged", label: "Reconhecido" },
                { value: "forwarded", label: "Encaminhado" },
              ]}
            />
          </>
        ) : isResumo ? null : (
          <Select
            value={modeFilter.value}
            onChange={modeFilter.set}
            ariaLabel={modeFilter.aria}
            options={[
              { value: modeFilter.allValue, label: modeFilter.allLabel },
              ...modeFilter.items.map((x) => ({ value: x, label: x })),
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
          <RefreshCw size={18} strokeWidth={1.75} aria-hidden />
        </IconButton>
        <Button onClick={() => setPresent((v) => !v)}>
          {present ? "Sair da apresentação" : "Apresentação"}
        </Button>
        <Button onClick={downloadCSV}>
          <Download size={16} strokeWidth={1.75} aria-hidden /> CSV
        </Button>
        <Button onClick={printPDF}>
          <Printer size={16} strokeWidth={1.75} aria-hidden /> PDF
        </Button>
        {/* #13: ação destrutiva clara na área de ferramentas (ghost discreto, texto em tom
            crítico) — era link mono 10px escondido no rodapé. O AlertDialog abaixo confirma. */}
        <Button
          variant="ghost"
          className="rep-clear"
          disabled={busy}
          onClick={() => setConfirmClear(true)}
        >
          <Trash2 size={16} strokeWidth={1.75} aria-hidden /> Limpar histórico
        </Button>
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
        {noData && <EmptyHistory mode={mode} dataSource={dataSource} />}

        {ready &&
          isResumo &&
          atividade.summary &&
          fadiga.summary &&
          leitura.summary &&
          objetos.summary && (
            <ResumoPanel
              periodLabel={PERIOD_LABEL[period]}
              shiftLabel={shift === "Todos" ? "todos" : shift}
              k={atividade.summary.k}
              tips={atividade.summary.tips}
              fk={fadiga.summary.fk}
              fOccFadiga={fadiga.summary.fOccFadiga}
              fOccCelular={fadiga.summary.fOccCelular}
              ftips={fadiga.summary.ftips}
              rk={leitura.summary.rk}
              rtips={leitura.summary.rtips}
              ok={objetos.summary.ok}
              oLoads={objetos.summary.oLoads}
              onOpenMode={setMode}
            />
          )}

        {ready && mode === "atividade" && atividade.summary && atividade.details && (
          <AtividadePanel
            lens={lens}
            k={atividade.summary.k}
            kPrev={atividade.summary.kPrev}
            peoplePeak={atividade.summary.kPeople}
            tips={atividade.summary.tips}
            hm={atividade.details.hm}
            rank={atividade.details.rank}
            byAtiv={atividade.details.byAtiv}
            evo={atividade.details.evo}
            byShiftA={atividade.details.byShiftA}
            evt={atividade.details.evt}
            flow={atividade.details.flowView}
            tab={tab}
            onTabChange={setTab}
          />
        )}

        {ready && isReading && leitura.summary && leitura.details && (
          <LeituraPanel
            lens={lens}
            rk={leitura.summary.rk}
            rkPrev={leitura.summary.rkPrev}
            rtips={leitura.summary.rtips}
            rhm={leitura.details.rhm}
            rrank={leitura.details.rrank}
            byCam={leitura.details.byCam}
            revo={leitura.details.revo}
            byShiftR={leitura.details.byShiftR}
            revt={leitura.details.revt}
            tab={tab}
            onTabChange={setTab}
          />
        )}

        {ready && isObjects && objetos.summary && objetos.details && (
          <ObjetosPanel
            lens={lens}
            ok={objetos.summary.ok}
            oLoads={objetos.summary.oLoads}
            otips={objetos.summary.otips}
            ohm={objetos.details.ohm}
            opres={objetos.details.opres}
            orank={objetos.details.orank}
            obyClass={objetos.details.obyClass}
            oevo={objetos.details.oevo}
            oevt={objetos.summary.oevt}
            classes={objetos.dataset.classes}
            presSetores={objetos.details.presSetores}
            tab={tab}
            onTabChange={setTab}
          />
        )}

        {ready && isFadiga && fadiga.summary && fadiga.details && (
          <FadigaPanel
            lens={lens}
            fk={fadiga.summary.fk}
            fOccFadiga={fadiga.summary.fOccFadiga}
            fOccCelular={fadiga.summary.fOccCelular}
            fBocejos={fadiga.summary.fBocejos}
            ftips={fadiga.summary.ftips}
            fhm={fadiga.details.fhm}
            fevo={fadiga.details.fevo}
            fevt={fadiga.summary.fevt}
            tab={tab}
            onTabChange={setTab}
          />
        )}

        {!loading && !error && isAlarmes && (
          <AlarmesPanel
            periodLabel={PERIOD_LABEL[period]}
            alarmPriority={al.alarmPriority}
            alarmState={al.alarmState}
            alarms={alarms}
            ak={al.ak}
            aTips={al.aTips}
            aTrend={al.aTrend}
            aHeat={al.aHeat}
            alarmsView={al.alarmsView}
            alarmWindow={al.alarmWindow}
            alarmHour={al.alarmHour}
            selAlarm={al.selAlarm}
            selDay={al.selDay}
            selHour={al.selHour}
            trendRef={al.trendRef}
            pickDay={al.pickDay}
            pickHour={al.pickHour}
            pickAlarm={al.pickAlarm}
            clearAlarmSel={al.clearAlarmSel}
            onRefresh={refresh}
          />
        )}
      </div>

      <AlertDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        variant="danger"
        title="Limpar todo o histórico?"
        description="Esta ação apaga permanentemente todos os indicadores, eventos e alarmes registrados no histórico do servidor. Não é possível desfazer."
        confirmLabel="Limpar histórico"
        cancelLabel="Cancelar"
        onConfirm={clearHistory}
        busy={busy}
      />
    </div>
  );
}
