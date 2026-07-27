// Relatório Operacional — ORQUESTRAÇÃO da tela unificada (spec-arquitetura-informacao §2).
// A saúde de alarmes (rota /alarmes-saude) foi ABSORVIDA aqui: nenhuma das duas telas respondia
// sozinha "o alarme está saudável E o que aconteceu ontem" — o gestor trocava de rota.
//
// A HIERARQUIA (o que o gestor lê primeiro):
//   N1  saúde do detector  — AlarmHealthStrip (janela de ~10 min, EM MEMÓRIA; NÃO obedece ao
//                            filtro de período, e diz isso na cara)
//   N1b saúde do MOTOR     — SaudeMotorPanel (/api/analysis/status, janela de 1 min): "as
//                            contagens estão sendo FEITAS?". Mesmo relógio-próprio, mesma
//                            regra de escala. Até esta onda o dado existia no hub e ninguém o
//                            consumia — motor desligado, worker em loop e gate cegando a câmera
//                            se pareciam com "0 pessoas · tudo normal" (falso-OK).
//   N2  resumo executivo   — só as dimensões COM DADO + o 5º cartão (Alarmes)
//   N3  alarmes            — tendência clicável + heatmap prioridade×hora + fila com ack
//   N4  dimensão           — só as que têm dado; o filtro do recorte é ANCORADO NA SEÇÃO
//   N5  ferramentas        — silenciamentos · limpar histórico · fonte (canConfigure)
// Razão de N1/N1b virem primeiro: se o alarme está inundando — ou se o motor está parado —, TODO
// número abaixo é suspeito. As duas faixas respondem "posso confiar no que vou ler?"; o corpo
// histórico responde "o que aconteceu". Nessa ordem, e nunca sob o mesmo relógio.
//
// A carga do histórico é ÚNICA (useReportData); o pipeline de cada modo vive num view-model hook
// (routes/report/use*VM) que computa SÓ a visão atual ("off"/"summary"/"full"); as agregações
// puras vivem em report/calc. LGPD: tudo aqui são indicadores agregados — nunca imagens.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, Printer, RefreshCw, ShieldCheck } from "lucide-react";
import {
  ALL_SHIFTS,
  legacyShiftsIn,
  objectWindows,
  shiftLabelOf,
  shiftOptions,
  type Period,
  type ShiftFilter,
  type ShiftRow,
} from "../report/calc";
import { getShifts, type Shift as ShiftCfg } from "../api";
import { useAuth } from "../auth";
import { type AlarmPriority, type AlarmState } from "../types/alarm";
import { buildCSV, downloadCSVFile, dateStamp, reportSections } from "./report/csv";
import {
  Alert,
  Button,
  EmptyState,
  IconButton,
  Kpi,
  KpiRow,
  Loading,
  PageHeader,
  Select,
  SegmentedControl,
  Skeleton,
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
import { AlarmHealthStrip } from "./report/AlarmHealthStrip";
import { SaudeMotorPanel } from "./report/SaudeMotorPanel";
import { ReportTools } from "./report/ReportTools";
import { ResumoPanel } from "./report/ResumoPanel";
import { AtividadePanel } from "./report/AtividadePanel";
import { LeituraPanel } from "./report/LeituraPanel";
import { ObjetosPanel } from "./report/ObjetosPanel";
import { FadigaPanel } from "./report/FadigaPanel";
import { AlarmesPanel } from "./report/AlarmesPanel";

// As 4 dimensões de câmera (o modo é por CÂMERA e elas são mutuamente exclusivas).
const DIMS = ["atividade", "leitura", "objetos", "fadiga"] as const;
type Dim = (typeof DIMS)[number];

// Rótulo CURTO do botão de modo. O MODE_LABEL (labels.ts) é o do CSV/impressão — "Resumo
// executivo", "Operador (fadiga)" — longo demais para o seletor. Os rótulos são CONTRATO do
// e2e ("Atividade"): mudou aqui, atualiza o spec no mesmo PR (regra A18).
const SEG_LABEL: Record<Mode, string> = {
  resumo: "Resumo",
  atividade: "Atividade",
  leitura: "Leitura",
  objetos: "Objetos",
  fadiga: "Operador",
  alarmes: "Alarmes",
};

// Filtro específico do modo (mesmo <Select> p/ ponto/setor/posto/área — só muda a fonte).
// "Todas" (área) × "Todos" (demais) preservados como valores-sentinela.
type ModeFilter = {
  aria: string;
  value: string;
  set: (v: string) => void;
  allValue: string;
  allLabel: string;
  items: string[];
};

// Barra de recorte GLOBAL (.rep-filters): período + turno à esquerda, ações à direita.
// Enxugada na unificação: o filtro do MODO desceu p/ a seção (ver SectionFilter — a barra que
// mudava de forma conforme o modo era exatamente o que produzia o "tem bastante coisa"); o
// "modo apresentação" morreu (o efeito TOTAL eram 2 regras de CSS: esconder filtros e crescer o
// KPI de 24→30px — não era um modo TV, era um zoom); e a "fonte do histórico" (banco/arquivo)
// desceu p/ N5 (ninguém AGE sobre "pg vs json" no meio de um relatório).
function FilterBar({
  period,
  setPeriod,
  isAlarmes,
  shift,
  setShift,
  shiftItems,
  refresh,
  downloadCSV,
  printPDF,
}: {
  period: Period;
  setPeriod: (p: Period) => void;
  /** Alarmes não tem recorte por turno (o evento de alarme não carrega carimbo de turno). */
  isAlarmes: boolean;
  shift: ShiftFilter;
  setShift: (v: ShiftFilter) => void;
  /** turnos do CADASTRO (+ legados presentes no dado) — nunca mais 3 strings hardcoded. */
  shiftItems: { value: string; label: string }[];
  refresh: () => void;
  downloadCSV: () => void;
  printPDF: () => void;
}) {
  return (
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
      {/* Filtro de turno POPULADO DO CADASTRO (/api/shifts) — o hardcode "Manhã/Tarde/Noite"
          morreu; os legados só aparecem se o DADO carregado ainda os tiver (retrocompat CA-8). */}
      {!isAlarmes && (
        <Select
          value={shift}
          onChange={setShift}
          ariaLabel="Turno"
          options={[{ value: ALL_SHIFTS, label: "Turno: todos" }, ...shiftItems]}
        />
      )}
      <div className="spacer" />
      <IconButton label="Recarregar do histórico" onClick={refresh}>
        <RefreshCw size={18} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <Button onClick={downloadCSV}>
        <Download size={16} strokeWidth={1.75} aria-hidden /> CSV
      </Button>
      <Button onClick={printPDF}>
        <Printer size={16} strokeWidth={1.75} aria-hidden /> PDF
      </Button>
    </div>
  );
}

// Filtro ANCORADO NA SEÇÃO (N4/N3): o recorte que só vale para a dimensão aberta mora com ela,
// não no header global. Some junto com a seção — nunca fica um Select órfão no topo.
function SectionFilter({ children }: { children: ReactNode }) {
  return (
    <div className="rep-secfilter no-print" role="group" aria-label="Filtros da seção">
      {children}
    </div>
  );
}

// ESTADO DE VAZIO DA JANELA — distinto do "sem histórico" (EmptyHistory).
// Auditoria 2026-07-26 (A2): o gate olhava o DATASET INTEIRO. Com 20 dias gravados e o período
// "Hoje" sem operação, `ready` era true, o painel renderizava inteiro e o Insight afirmava
// "Taxa de leitura de 100% — excelente cobertura". Existe histórico; o RECORTE é que está vazio —
// e um painel de zeros/100% aqui se lê como operação perfeita. Nenhum indicador é exibido.
// A DECISÃO do vazio, pura e testável fora do React (o bug A2 morava exatamente aqui).
// `null` = há dado no recorte. Ordem importa: sem histórico nenhum, o texto é o de ativação
// (EmptyHistory); com histórico e recorte vazio, o texto é o do recorte (EmptyWindow).
// `windowCells === null` significa "view off, não computado" — e NUNCA vira vazio.
export type ModeEmpty = "no-history" | "empty-window" | null;
export function modeEmptyState(p: { datasetCells: number; windowCells: number | null }): ModeEmpty {
  if (p.datasetCells === 0) return "no-history";
  if (p.windowCells === 0) return "empty-window";
  return null;
}
/** Mesma decisão para o Resumo (N2): ele agrega as dimensões, não uma só. */
export function resumoEmptyState(p: {
  dimsWithHistory: number;
  hasAlarmHistory: boolean;
  anyDimensionInWindow: boolean;
}): ModeEmpty {
  if (p.dimsWithHistory === 0 && !p.hasAlarmHistory) return "no-history";
  if (!p.anyDimensionInWindow) return "empty-window";
  return null;
}

function EmptyWindow({ lens, days }: { lens: string; days: number }) {
  return (
    <EmptyState>
      <p>
        <b>Sem dados no recorte — {lens}.</b>
      </p>
      <p>
        O histórico existe ({days} dia{days === 1 ? "" : "s"} gravado{days === 1 ? "" : "s"}), mas
        nada foi registrado neste recorte. Nenhum indicador é exibido: uma tela de zeros (ou de
        100%) se leria como operação normal.
      </p>
      <p className="muted">Amplie o período ou remova os filtros para ver o que existe.</p>
    </EmptyState>
  );
}

export function ReportPage() {
  const { canConfigure, isSuper } = useAuth();
  const [modeState, setMode] = useState<Mode>("resumo");
  const [period, setPeriod] = useState<Period>("7d");
  const [shift, setShift] = useState<ShiftFilter>(ALL_SHIFTS);
  // Cadastro de turnos: fonte ÚNICA do filtro. Falha (hub antigo sem /api/shifts) → lista vazia
  // e o relatório segue no legado, sem derrubar a página (mesmo padrão do status/fluxo).
  const [shifts, setShifts] = useState<ShiftCfg[]>([]);
  const [area, setArea] = useState<string | "Todas">("Todas");
  const [ponto, setPonto] = useState<string | "Todos">("Todos");
  const [setor, setSetor] = useState<string | "Todos">("Todos");
  const [posto, setPosto] = useState<string | "Todos">("Todos");
  const [tab, setTab] = useState<RepTab>("quando");
  const [printedAt, setPrintedAt] = useState("");

  // Carga do histórico (5 dimensões + alarmes + fluxo) e limpeza — useReportData.
  const data = useReportData();
  const { alarms, loading, error, dataSource, busy, refresh, clearHistory } = data;

  useEffect(() => {
    getShifts()
      .then(setShifts)
      .catch(() => setShifts([]));
  }, []);

  // ── Quais dimensões EXISTEM neste site (têm dado no histórico) ──
  // `modo` é por CÂMERA e os 4 modos são mutuamente exclusivos: num CD de câmeras de ocupação,
  // 3 dimensões ficam permanentemente vazias. Elas não viram botão nem cartão de zeros.
  const has = useMemo(
    () => ({
      atividade: (data.ds?.cells.length ?? 0) > 0,
      leitura: (data.rds?.cells.length ?? 0) > 0,
      objetos: (data.ods?.cells.length ?? 0) > 0,
      fadiga: (data.fds?.cells.length ?? 0) > 0,
      alarmes: alarms.length > 0,
    }),
    [data.ds, data.rds, data.ods, data.fds, alarms],
  );
  const dims: Dim[] = DIMS.filter((d) => has[d]);
  // "Alarmes" é SEÇÃO fixa da tela (N3) — existe sempre, com estado de vazio próprio e honesto.
  const modeOptions: Mode[] = ["resumo", ...dims, "alarmes"];
  // O modo escolhido pode deixar de existir (F5 depois de limpar o histórico): cai no Resumo.
  const mode: Mode = modeOptions.includes(modeState) ? modeState : "resumo";

  // Opções do filtro = turnos ATIVOS do cadastro + os LEGADOS que o dado carregado ainda carrega
  // (linhas sem carimbo). Um site já 100% carimbado não exibe as 3 strings mortas.
  const shiftItems = useMemo(() => {
    const rows: ShiftRow[] = [
      ...(data.ds?.cells ?? []),
      ...(data.rds?.cells ?? []),
      ...(data.ods?.cells ?? []),
      ...(data.fds?.cells ?? []),
      ...data.allEvents,
    ];
    return shiftOptions(shifts, legacyShiftsIn(rows));
  }, [shifts, data.ds, data.rds, data.ods, data.fds, data.allEvents]);
  // A CHAVE do filtro é o id do turno; o rótulo (lente/impressão/CSV) é o NOME do cadastro.
  const shiftLabel = shiftLabelOf(shift, shifts);

  // ── View-models por modo: SÓ o modo ativo computa ("full"); o Resumo pede o "summary"
  //    das dimensões (é o que ele exibe); o resto fica "off" (memos devolvem null). ──
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
    shifts,
  });
  const leitura = useLeituraVM({
    view: viewFor("leitura"),
    ds: data.rds,
    events: data.rEvents,
    period,
    shift,
    ponto,
    shifts,
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

  // ── O RECORTE, não o dataset (auditoria A2) ──────────────────────────────────────────────────
  // Objetos é a única dimensão cujo view-model não é desta frente: a janela sai aqui, com a MESMA
  // função pura dos demais (calc/objetos), sem tocar no useObjetosVM.
  const objWindowCells = useMemo(
    () =>
      isObjects || isResumo
        ? objectWindows(objetos.dataset, { period, shift, setor }).current.length
        : null,
    [isObjects, isResumo, objetos.dataset, period, shift, setor],
  );
  // Dimensão COM DADO NA JANELA filtrada (≠ `has`, que é "existe no histórico do site").
  // `has` continua mandando em quem vira BOTÃO de modo — o gestor precisa poder abrir a dimensão
  // e ver o vazio honesto; `hasWindow` manda em quem vira NÚMERO.
  const hasWindow = {
    atividade: (atividade.windowCells ?? 0) > 0,
    leitura: (leitura.windowCells ?? 0) > 0,
    objetos: (objWindowCells ?? 0) > 0,
    fadiga: (fadiga.windowCells ?? 0) > 0,
    alarmes: al.akPeriod.total > 0,
  };
  const modeWindowCells = isReading
    ? leitura.windowCells
    : isObjects
      ? objWindowCells
      : isFadiga
        ? fadiga.windowCells
        : atividade.windowCells;
  // Alarmes tem estado de vazio próprio (dentro da view); não entra nos gates genéricos.
  // Resumo só é "vazio" quando NENHUMA dimensão (nem os alarmes) tem dado.
  const modeVm = isReading ? leitura : isObjects ? objetos : isFadiga ? fadiga : atividade;
  const live = !loading && !error && !isAlarmes;
  // Dois vazios DIFERENTES, com textos diferentes: nunca houve dado × não houve NESTE recorte.
  const empty: ModeEmpty = !live
    ? null
    : isResumo
      ? resumoEmptyState({
          dimsWithHistory: dims.length,
          hasAlarmHistory: has.alarmes,
          anyDimensionInWindow: Object.values(hasWindow).some(Boolean),
        })
      : modeEmptyState({
          datasetCells: modeVm.dataset.cells.length,
          windowCells: modeWindowCells,
        });
  const noHistory = empty === "no-history";
  const emptyWindow = empty === "empty-window";
  const ready = !loading && !error && !noHistory && !emptyWindow; // painéis só com dado no recorte
  // Dias de histórico do recorte (o texto do vazio de janela diz o que EXISTE — no Resumo, o
  // maior entre as dimensões, que é o alcance real do histórico do site).
  const historyDays = isResumo
    ? Math.max(
        atividade.dataset.days,
        leitura.dataset.days,
        objetos.dataset.days,
        fadiga.dataset.days,
      )
    : modeVm.dataset.days;
  const { alarmPriority, alarmState } = al;
  const filters = {
    mode,
    period,
    shift,
    shiftLabel,
    area,
    ponto,
    setor,
    posto,
    alarmPriority,
    alarmState,
  };
  const lens = reportLens(filters);
  const filtroLabel = reportFiltroLabel(filters);
  // Filtro específico do modo (tipo ModeFilter acima) — só muda a fonte por modo.
  const modeFilter: ModeFilter = isReading
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
  // É PARA CÁ que desceram os KPIs crus podados da tela (pico de pessoas, saldo do fluxo,
  // bocejos, presença/médios/pico de objetos, quebras por turno/classe): o dado não some.
  function downloadCSV() {
    const now = new Date();
    const sections = reportSections({
      mode,
      period,
      shiftLabel,
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
    <div className="page report">
      {/* Descrição do modo virou subtitle do PageHeader (padrão da casa) — era span custom. */}
      <PageHeader
        title="Relatório Operacional"
        subtitle={
          isAlarmes
            ? "alarmes · fila de eventos (metadados)"
            : isReading
              ? "leitura · código de barras"
              : isObjects
                ? "objetos · contagem/presença"
                : isFadiga
                  ? "operador · fadiga/risco"
                  : isResumo
                    ? "resumo · o que aconteceu no período"
                    : "atividade · ocupação/ociosidade"
        }
        className="no-print"
      >
        <SegmentedControl<Mode>
          value={mode}
          onChange={(m) => {
            setMode(m);
            // a aba "fluxo" só existe no modo Atividade — devolve o estado compartilhado.
            if (tab === "fluxo" && m !== "atividade") setTab("quando");
          }}
          ariaLabel="Modo do relatório"
          options={modeOptions.map((m) => ({ value: m, label: SEG_LABEL[m] }))}
        />
        {/* going-gray (#12): estado normal → pílula neutra (.rep-privacy, report/report.css)
            com ShieldCheck (mesmo par do rail), não verde saturado permanente. */}
        <span className="rep-privacy">
          <ShieldCheck size={13} strokeWidth={1.75} aria-hidden /> indicadores · sem imagens
        </span>
        {/* espaçador espelha o flex-1 interno do PageHeader: mantém o seletor de modo
            centrado entre o título e a borda direita (layout anterior). */}
        <div className="flex-1" />
      </PageHeader>

      {/* N1 — a saúde do detector. Fora do filtro de período (outra escala temporal) e dona do
          ÚNICO timer da tela: o corpo histórico abaixo é carga única e não pode piscar. */}
      <AlarmHealthStrip />

      {/* N1b — a saúde do MOTOR. O alarme acima responde "o detector está confiável?"; esta
          responde a pergunta anterior a ela: "as contagens estão sendo FEITAS?". Sem entrada nova
          na navegação de propósito — rota órfã é o código morto que a auditoria já achou; e é
          nesta tela, cuja razão de existir são os números do motor, que a resposta muda a decisão.
          RBAC: o ACHADO é de todos (muda a confiança no número que o operador lê); só o número
          CRU (fps/cpu/respawn/p95) fica sob canConfigure — ver cabeçalho do SaudeMotorPanel. */}
      <SaudeMotorPanel canConfigure={canConfigure} />

      <FilterBar
        period={period}
        setPeriod={setPeriod}
        isAlarmes={isAlarmes}
        shift={shift}
        setShift={setShift}
        shiftItems={shiftItems}
        refresh={refresh}
        downloadCSV={downloadCSV}
        printPDF={printPDF}
      />

      <div className="print-head only-print" aria-hidden>
        <div className="ph-title">Relatório Operacional · {MODE_LABEL[mode]}</div>
        <div className="ph-sub">
          {isResumo ? `${PERIOD_LABEL[period]} · Turno: ${shiftLabel}` : lens}
        </div>
        <div className="ph-meta">
          Gerado em {printedAt || "—"} · indicadores agregados, sem imagens (LGPD)
        </div>
      </div>

      <div className="rep-body">
        {loading && (
          <div className="rep-skeleton" aria-busy="true" aria-label="Carregando relatório">
            <KpiRow>
              {Array.from({ length: 5 }).map((_, i) => (
                <Kpi
                  key={i}
                  value={<Skeleton w="55%" h={22} />}
                  label={<Skeleton w="80%" h={11} />}
                />
              ))}
            </KpiRow>
            <Loading variant="skeleton" lines={6} label="Carregando gráfico" />
          </div>
        )}
        {!loading && error && <Alert tone="alert">{error}</Alert>}
        {noHistory && <EmptyHistory mode={mode} dataSource={dataSource} />}
        {emptyWindow && (
          <EmptyWindow
            lens={isResumo ? `${PERIOD_LABEL[period]} · Turno: ${shiftLabel}` : lens}
            days={historyDays}
          />
        )}

        {/* N2 — Resumo: só as dimensões COM DADO NO RECORTE (`hasWindow`, não `has`) + o cartão de
            Alarmes. Um cartão de zeros/100% para uma dimensão que não operou no período é o mesmo
            falso-OK dos KPIs; a dimensão segue acessível pelo seletor, com o vazio honesto lá. */}
        {ready && isResumo && (
          <ResumoPanel
            periodLabel={PERIOD_LABEL[period]}
            shiftLabel={shiftLabel}
            atividade={
              hasWindow.atividade && atividade.summary
                ? { k: atividade.summary.k, tips: atividade.summary.tips }
                : null
            }
            fadiga={
              hasWindow.fadiga && fadiga.summary
                ? {
                    fk: fadiga.summary.fk,
                    fOccFadiga: fadiga.summary.fOccFadiga,
                    fOccCelular: fadiga.summary.fOccCelular,
                    ftips: fadiga.summary.ftips,
                  }
                : null
            }
            leitura={
              hasWindow.leitura && leitura.summary
                ? { rk: leitura.summary.rk, rtips: leitura.summary.rtips }
                : null
            }
            objetos={
              hasWindow.objetos && objetos.summary
                ? { ok: objetos.summary.ok, oLoads: objetos.summary.oLoads }
                : null
            }
            alarmes={has.alarmes ? { ak: al.akPeriod } : null}
            onOpenMode={setMode}
          />
        )}

        {/* N4 — Dimensão. O filtro do recorte vive COM a seção (não no header global).
            Ele SOBREVIVE ao vazio de janela: se foi o próprio filtro (ponto/área/posto) que
            esvaziou o recorte, esconder o Select deixaria o gestor sem como voltar atrás. */}
        {(ready || emptyWindow) && !isResumo && !isAlarmes && (
          <SectionFilter>
            <Select
              value={modeFilter.value}
              onChange={modeFilter.set}
              ariaLabel={modeFilter.aria}
              options={[
                { value: modeFilter.allValue, label: modeFilter.allLabel },
                ...modeFilter.items.map((x) => ({ value: x, label: x })),
              ]}
            />
          </SectionFilter>
        )}

        {ready && mode === "atividade" && atividade.summary && atividade.details && (
          <AtividadePanel
            lens={lens}
            k={atividade.summary.k}
            kPrev={atividade.summary.kPrev}
            ruler={atividade.summary.ruler}
            idle={atividade.summary.idle}
            tips={atividade.summary.tips}
            hm={atividade.details.hm}
            rank={atividade.details.rank}
            byAtiv={atividade.details.byAtiv}
            evo={atividade.details.evo}
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
            ftips={fadiga.summary.ftips}
            fhm={fadiga.details.fhm}
            fevo={fadiga.details.fevo}
            fevt={fadiga.summary.fevt}
            tab={tab}
            onTabChange={setTab}
          />
        )}

        {/* N3 — Alarmes (histórico persistido, sob o filtro de período — NUNCA confundir com a
            faixa N1, que é a janela de 10 min em memória). Filtros ancorados na seção. */}
        {!loading && !error && isAlarmes && (
          <>
            {alarms.length > 0 && (
              <SectionFilter>
                <Select
                  value={alarmPriority}
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
                  value={alarmState}
                  onChange={(v) => al.setAlarmState(v as AlarmState | "Todos")}
                  ariaLabel="Estado"
                  options={[
                    { value: "Todos", label: "Estado: todos" },
                    { value: "new", label: "Novo" },
                    { value: "acknowledged", label: "Reconhecido" },
                    { value: "forwarded", label: "Encaminhado" },
                  ]}
                />
              </SectionFilter>
            )}
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
            />
          </>
        )}

        {/* N5 — Ferramentas. RBAC EXPLÍCITO: a Saúde era protegida pela ROTA; a rota morreu, então
            o gate mora aqui (senão ação de configuração vaza para o operador). */}
        {canConfigure && !loading && (
          <ReportTools
            isSuper={isSuper}
            dataSource={dataSource}
            busy={busy}
            onClear={clearHistory}
          />
        )}
      </div>
    </div>
  );
}
