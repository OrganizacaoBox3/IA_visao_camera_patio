import { useEffect, useMemo, useState } from "react";
import {
  windows, kpis, deltaPct, heatmap, ranking, evolution, insights, fmtMin, shiftOf,
  readingWindows, readingKpis, readingHeatmap, readingRanking, readingByCamera, readingEvolution, readingInsights,
  objectWindows, objectKpis, objectHeatmap, objectPresence, objectRanking, objectByClass, objectEvolution, objectInsights,
  fadigaWindows, fadigaKpis, fadigaHeatmap, fadigaEvolution, fadigaInsights,
  type Period, type Shift, type Filters, type Dataset, type EventRow,
  type ReadingFilters, type ReadingDataset, type ReadingEventRow,
  type ObjectFilters, type ObjectDataset, type ObjectEventRow,
  type FadigaFilters, type FadigaDataset, type FadigaEventRow,
} from "../report/mock";
import { loadDataset, loadEvents, clearAll, loadReadingDataset, loadReadingEvents, loadObjectDataset, loadObjectEvents, loadFadigaDataset, loadFadigaEvents } from "../report/store";
import { buildCSV, downloadCSVFile, dateStamp, type CsvSection } from "../report/csv";
import { objClass } from "../objects/catalog";
import { Button, IconButton, Select, SegmentedControl, Skeleton, useToast } from "../ui";

type Mode = "resumo" | "atividade" | "leitura" | "objetos" | "fadiga";
const MODE_LABEL: Record<Mode, string> = { resumo: "Resumo executivo", atividade: "Atividade", leitura: "Leitura", objetos: "Objetos", fadiga: "Operador (fadiga)" };
const PERIOD_LABEL: Record<Period, string> = { hoje: "Hoje", "7d": "Últimos 7 dias", "30d": "Últimos 30 dias" };
const PERIOD_DAYS: Record<Period, number> = { hoje: 1, "7d": 7, "30d": 30 };
const EMPTY_DS: Dataset = { days: 0, areas: [], cameraOf: {}, cells: [], startMs: Date.now() };
const EMPTY_RDS: ReadingDataset = { days: 0, pontos: [], cameraLabels: {}, cells: [], startMs: Date.now() };
const EMPTY_ODS: ObjectDataset = { days: 0, setores: [], classes: [], cells: [], startMs: Date.now() };
const EMPTY_FDS: FadigaDataset = { days: 0, postos: [], cells: [], startMs: Date.now() };
const HOURS = Array.from({ length: 24 }, (_, i) => i);
function classLabel(k: string): string { const c = objClass(k); return c ? `${c.emoji} ${c.label}` : k; }

function heatColor(v: number, max: number): string {
  if (v <= 0) return "transparent";
  const t = Math.min(1, v / max);
  const r = Math.round(40 + t * 199), g = Math.round(55 - t * 5), b = Math.round(72 - t * 40);
  return `rgba(${r}, ${g}, ${b}, ${0.18 + t * 0.82})`;
}
// Leitura: volume é POSITIVO → escala azul (accent), distinta da ociosidade (âmbar/vermelho).
function readColor(v: number, max: number): string {
  if (v <= 0) return "transparent";
  return `rgba(56, 189, 248, ${0.12 + Math.min(1, v / max) * 0.78})`;
}

function Delta({ v, goodWhenDown = true }: { v: number | null; goodWhenDown?: boolean }) {
  if (v == null) return <span className="delta muted">—</span>;
  const down = v < 0; const good = goodWhenDown ? down : !down;
  return <span className={`delta ${good ? "good" : "bad"}`}>{down ? "▼" : "▲"} {Math.abs(v)}%</span>;
}

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const [period, setPeriod] = useState<Period>("7d");
  const [shift, setShift] = useState<Shift | "Todos">("Todos");
  const [area, setArea] = useState<string | "Todas">("Todas");
  const [ponto, setPonto] = useState<string | "Todos">("Todos");
  const [setor, setSetor] = useState<string | "Todos">("Todos");
  const [posto, setPosto] = useState<string | "Todos">("Todos");
  const [present, setPresent] = useState(false);
  const [tab, setTab] = useState<"quando" | "onde" | "tendencia" | "eventos">("quando");
  const [printedAt, setPrintedAt] = useState("");

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const [d, e, rd, re, od, oe, fd, fe] = await Promise.all([loadDataset(), loadEvents(), loadReadingDataset(), loadReadingEvents(), loadObjectDataset(), loadObjectEvents(), loadFadigaDataset(), loadFadigaEvents()]);
      setDs(d); setAllEvents(e); setRds(rd); setREvents(re); setOds(od); setOEvents(oe); setFds(fd); setFEvents(fe);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Falha ao carregar o histórico.";
      setError(msg); toast(msg, "alert");
    }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  async function onClear() {
    setBusy(true);
    try { await clearAll(); await refresh(); toast("Histórico limpo.", "ok"); }
    catch (e) { toast(e instanceof Error ? e.message : "Falha ao limpar o histórico.", "alert"); }
    setBusy(false);
  }

  // ── Atividade (sempre computado p/ ordem estável de hooks) ──
  const dataset = ds ?? EMPTY_DS;
  const fA: Filters = { period, shift, area };
  const { current: aCur, previous: aPrev } = useMemo(() => windows(dataset, fA), [dataset, period, shift, area]);
  const k = useMemo(() => kpis(aCur), [aCur]);
  const kPrev = useMemo(() => kpis(aPrev), [aPrev]);
  const areasForHeat = area === "Todas" ? dataset.areas : [area];
  const hm = useMemo(() => heatmap(aCur, areasForHeat), [aCur, area]); // eslint-disable-line react-hooks/exhaustive-deps
  const rank = useMemo(() => ranking(aCur, dataset.areas), [aCur, dataset.areas]);
  const evo = useMemo(() => evolution(dataset, fA, 14), [dataset, period, shift, area]);
  const evt = useMemo(() => {
    const lo = Date.now() - PERIOD_DAYS[period] * 86_400_000;
    return allEvents.filter((e) => e.ts >= lo && (shift === "Todos" || shiftOf(new Date(e.ts).getHours()) === shift) && (area === "Todas" || e.area === area)).slice(0, 80);
  }, [allEvents, period, shift, area]);
  const tips = useMemo(() => insights(aCur, k), [aCur, k]);
  const byAtiv = useMemo(() => {
    const m = new Map<string, { idleMin: number; alerts: number }>();
    for (const c of aCur) { const a = c.atividade ?? "Indefinida"; const e = m.get(a) ?? { idleMin: 0, alerts: 0 }; e.idleMin += c.idleMin; e.alerts += c.alerts; m.set(a, e); }
    const rows = [...m.entries()].map(([atividade, v]) => ({ atividade, ...v })).filter((r) => r.idleMin > 0).sort((a, b) => b.idleMin - a.idleMin);
    return { rows, max: Math.max(1, ...rows.map((r) => r.idleMin)) };
  }, [aCur]);
  const byShiftA = useMemo(() => {
    const m: Record<Shift, number> = { "Manhã": 0, "Tarde": 0, "Noite": 0 };
    for (const c of aCur) m[shiftOf(c.hour)] += c.idleMin;
    return { m, max: Math.max(1, ...Object.values(m)) };
  }, [aCur]);

  // ── Leitura ──
  const rdataset = rds ?? EMPTY_RDS;
  const fR: ReadingFilters = { period, shift, ponto };
  const { current: rCur, previous: rPrev } = useMemo(() => readingWindows(rdataset, fR), [rdataset, period, shift, ponto]);
  const rk = useMemo(() => readingKpis(rCur), [rCur]);
  const rkPrev = useMemo(() => readingKpis(rPrev), [rPrev]);
  const pontosForHeat = ponto === "Todos" ? rdataset.pontos : [ponto];
  const rhm = useMemo(() => readingHeatmap(rCur, pontosForHeat), [rCur, ponto]); // eslint-disable-line react-hooks/exhaustive-deps
  const rrank = useMemo(() => readingRanking(rCur, rdataset.pontos), [rCur, rdataset.pontos]);
  const byCam = useMemo(() => readingByCamera(rCur, rdataset.cameraLabels), [rCur, rdataset.cameraLabels]);
  const revo = useMemo(() => readingEvolution(rdataset, fR, 14), [rdataset, period, shift, ponto]);
  const revt = useMemo(() => {
    const lo = Date.now() - PERIOD_DAYS[period] * 86_400_000;
    return rEvents.filter((e) => e.ts >= lo && (shift === "Todos" || shiftOf(new Date(e.ts).getHours()) === shift) && (ponto === "Todos" || e.ponto === ponto)).slice(0, 120);
  }, [rEvents, period, shift, ponto]);
  const rtips = useMemo(() => readingInsights(rk), [rk]);
  const byShiftR = useMemo(() => {
    const m: Record<Shift, number> = { "Manhã": 0, "Tarde": 0, "Noite": 0 };
    for (const c of rCur) m[shiftOf(c.hour)] += c.boxes;
    return { m, max: Math.max(1, ...Object.values(m)) };
  }, [rCur]);

  // ── Objetos ──
  const odataset = ods ?? EMPTY_ODS;
  const fO: ObjectFilters = { period, shift, setor };
  const { current: oCur } = useMemo(() => objectWindows(odataset, fO), [odataset, period, shift, setor]);
  const ok = useMemo(() => objectKpis(oCur), [oCur]);
  const ohm = useMemo(() => objectHeatmap(oCur, odataset.classes), [oCur, odataset.classes]);
  const opres = useMemo(() => objectPresence(oCur, setor === "Todos" ? odataset.setores : [setor], odataset.classes), [oCur, setor, odataset.setores, odataset.classes]);
  const orank = useMemo(() => objectRanking(oCur, odataset.setores), [oCur, odataset.setores]);
  const obyClass = useMemo(() => objectByClass(oCur, odataset.classes), [oCur, odataset.classes]);
  const oevo = useMemo(() => objectEvolution(odataset, fO, 14), [odataset, period, shift, setor]);
  const oevt = useMemo(() => {
    const lo = Date.now() - PERIOD_DAYS[period] * 86_400_000;
    return oEvents.filter((e) => e.ts >= lo && (shift === "Todos" || shiftOf(new Date(e.ts).getHours()) === shift) && (setor === "Todos" || e.setor === setor)).slice(0, 120);
  }, [oEvents, period, shift, setor]);
  const oLoads = useMemo(() => oevt.filter((e) => e.type === "carregamento").length, [oevt]);
  const otips = useMemo(() => objectInsights(ok, oLoads), [ok, oLoads]);
  const presSetores = setor === "Todos" ? odataset.setores : [setor];

  // ── Fadiga ──
  const fdataset = fds ?? EMPTY_FDS;
  const fF: FadigaFilters = { period, shift, posto };
  const { current: fCur } = useMemo(() => fadigaWindows(fdataset, fF), [fdataset, period, shift, posto]);
  const fk = useMemo(() => fadigaKpis(fCur), [fCur]);
  const fhm = useMemo(() => fadigaHeatmap(fCur), [fCur]);
  const fevo = useMemo(() => fadigaEvolution(fdataset, fF, 14), [fdataset, period, shift, posto]);
  const fevt = useMemo(() => {
    const lo = Date.now() - PERIOD_DAYS[period] * 86_400_000;
    return fEvents.filter((e) => e.ts >= lo && (shift === "Todos" || shiftOf(new Date(e.ts).getHours()) === shift) && (posto === "Todos" || e.posto === posto)).slice(0, 120);
  }, [fEvents, period, shift, posto]);
  const fOccFadiga = useMemo(() => fevt.filter((e) => e.type === "fadiga").length, [fevt]);
  const fOccCelular = useMemo(() => fevt.filter((e) => e.type === "celular").length, [fevt]);
  const fBocejos = useMemo(() => fevt.filter((e) => e.type === "bocejo").length, [fevt]);
  const ftips = useMemo(() => fadigaInsights(fk, fOccFadiga, fOccCelular), [fk, fOccFadiga, fOccCelular]);

  const isResumo = mode === "resumo";
  const isReading = mode === "leitura";
  const isObjects = mode === "objetos";
  const isFadiga = mode === "fadiga";
  const noData = !loading && !error && (isResumo
    ? dataset.cells.length === 0 && rdataset.cells.length === 0 && odataset.cells.length === 0 && fdataset.cells.length === 0
    : isReading ? rdataset.cells.length === 0 : isObjects ? odataset.cells.length === 0 : isFadiga ? fdataset.cells.length === 0 : dataset.cells.length === 0);
  const lens = isReading
    ? `${PERIOD_LABEL[period]} · ${ponto === "Todos" ? "Todos os pontos" : ponto} · Turno: ${shift === "Todos" ? "todos" : shift}`
    : isObjects
    ? `${PERIOD_LABEL[period]} · ${setor === "Todos" ? "Todos os setores" : setor} · Turno: ${shift === "Todos" ? "todos" : shift}`
    : isFadiga
    ? `${PERIOD_LABEL[period]} · ${posto === "Todos" ? "Todos os postos" : posto} · Turno: ${shift === "Todos" ? "todos" : shift}`
    : `${PERIOD_LABEL[period]} · ${area === "Todas" ? "Todas as áreas" : area} · Turno: ${shift === "Todos" ? "todos" : shift}`;

  const SHIFTS: Shift[] = ["Manhã", "Tarde", "Noite"];
  const filtroLabel = isReading ? (ponto === "Todos" ? "Todos os pontos" : ponto)
    : isObjects ? (setor === "Todos" ? "Todos os setores" : setor)
    : isFadiga ? (posto === "Todos" ? "Todos os postos" : posto)
    : (area === "Todas" ? "Todas as áreas" : area);

  // CSV "rico": metadados + indicadores + detalhamento + eventos, num arquivo só (auto-descritivo).
  function downloadCSV() {
    const now = new Date();
    const sections: CsvSection[] = [{
      title: "RELATÓRIO OPERACIONAL — VISÃO DE PÁTIO",
      rows: [
        ["Dimensão", MODE_LABEL[mode]],
        ["Período", PERIOD_LABEL[period]],
        ["Turno", shift === "Todos" ? "Todos" : shift],
        ["Filtro", filtroLabel],
        ["Gerado em", now.toLocaleString("pt-BR")],
        ["Privacidade", "Indicadores agregados, sem imagens (LGPD)"],
      ],
    }];

    if (isResumo) {
      sections.push({
        title: "INDICADORES CONSOLIDADOS", headers: ["Dimensão", "Indicador", "Valor"],
        rows: [
          ["Atividade", "Tempo ativo (%)", k.activePct], ["Atividade", "Tempo parado", fmtMin(k.idleMin)], ["Atividade", "Alertas", k.alerts], ["Atividade", "Área mais parada", k.topArea],
          ["Operador", "Tempo em alerta (%)", fk.alertPct], ["Operador", "Ocorrências de fadiga", fOccFadiga], ["Operador", "Ocorrências de celular", fOccCelular],
          ["Leitura", "Caixas lidas", rk.boxes], ["Leitura", "Taxa de leitura (%)", rk.ratePct], ["Leitura", "No-reads", rk.noReads], ["Leitura", "Ponto de maior volume", rk.topPonto],
          ["Objetos", "Objetos médios", ok.avgCount], ["Objetos", "Pico simultâneo", ok.peak], ["Objetos", "Predominante", classLabel(ok.topClasse)],
        ],
      });
    } else if (mode === "atividade") {
      sections.push({ title: "INDICADORES", headers: ["Indicador", "Valor"], rows: [
        ["Tempo parado", fmtMin(k.idleMin)], ["Alertas", k.alerts], ["Tempo ativo (%)", k.activePct], ["Área mais parada", k.topArea], ["Horário crítico", `${String(k.peakHour).padStart(2, "0")}h`],
      ] });
      sections.push({ title: "POR ÁREA", headers: ["Área", "Tempo parado", "Alertas"], rows: rank.rows.map((r) => [r.area, fmtMin(r.idleMin), r.alerts]) });
      sections.push({ title: "POR ATIVIDADE", headers: ["Atividade", "Tempo parado", "Alertas"], rows: byAtiv.rows.map((r) => [r.atividade, fmtMin(r.idleMin), r.alerts]) });
      sections.push({ title: "POR TURNO", headers: ["Turno", "Tempo parado"], rows: SHIFTS.map((s) => [s, fmtMin(byShiftA.m[s])]) });
      sections.push({ title: `EVENTOS (${evt.length})`, headers: ["Data/hora", "Área", "Câmera", "Duração (min)", "Turno"], rows: evt.map((r) => [new Date(r.ts).toLocaleString("pt-BR"), r.area, r.camera, r.durationMin, r.shift]) });
    } else if (isReading) {
      sections.push({ title: "INDICADORES", headers: ["Indicador", "Valor"], rows: [
        ["Caixas lidas", rk.boxes], ["Taxa de leitura (%)", rk.ratePct], ["No-reads", rk.noReads], ["Ponto de maior volume", rk.topPonto], ["Horário de pico", `${String(rk.peakHour).padStart(2, "0")}h`],
      ] });
      sections.push({ title: "POR PONTO", headers: ["Ponto", "Caixas", "Taxa (%)", "No-reads"], rows: rrank.rows.map((r) => [r.ponto, r.boxes, r.ratePct, r.noReads]) });
      sections.push({ title: "POR CÂMERA", headers: ["Câmera", "Leituras"], rows: byCam.rows.map((r) => [r.camera, r.reads]) });
      sections.push({ title: "POR TURNO", headers: ["Turno", "Caixas"], rows: SHIFTS.map((s) => [s, byShiftR.m[s]]) });
      sections.push({ title: `LEITURAS (${revt.length})`, headers: ["Data/hora", "Ponto", "Código", "Câmeras", "Turno"], rows: revt.map((r) => [new Date(r.ts).toLocaleString("pt-BR"), r.ponto, r.code, r.cameras, r.shift]) });
    } else if (isObjects) {
      sections.push({ title: "INDICADORES", headers: ["Indicador", "Valor"], rows: [
        ["Objetos médios em cena", ok.avgCount], ["Pico simultâneo", ok.peak], ["Predominante", classLabel(ok.topClasse)], ["Presença predominante (%)", ok.presenceTopPct], ["Carregamentos", oLoads],
      ] });
      sections.push({ title: "PRESENÇA SETOR × CLASSE (% do tempo)", headers: ["Setor", ...odataset.classes.map(classLabel)], rows: presSetores.map((s) => [s, ...odataset.classes.map((cl) => opres[s]?.[cl] ?? 0)]) });
      sections.push({ title: "POR SETOR", headers: ["Setor", "Média", "Pico"], rows: orank.rows.map((r) => [r.setor, r.avg, r.peak]) });
      sections.push({ title: "POR CLASSE", headers: ["Classe", "Média"], rows: obyClass.rows.map((r) => [classLabel(r.classe), r.avg]) });
      sections.push({ title: `EVENTOS (${oevt.length})`, headers: ["Data/hora", "Tipo", "Setor", "Classe", "Turno"], rows: oevt.map((r) => [new Date(r.ts).toLocaleString("pt-BR"), r.type, r.setor, classLabel(r.classe), r.shift]) });
    } else if (isFadiga) {
      sections.push({ title: "INDICADORES", headers: ["Indicador", "Valor"], rows: [
        ["Tempo em alerta (%)", fk.alertPct], ["Ocorrências de fadiga", fOccFadiga], ["Ocorrências de celular", fOccCelular], ["Bocejos", fBocejos], ["Horário crítico", `${String(fk.peakHour).padStart(2, "0")}h`],
      ] });
      sections.push({ title: `OCORRÊNCIAS (${fevt.length})`, headers: ["Data/hora", "Posto", "Tipo", "Turno"], rows: fevt.map((r) => [new Date(r.ts).toLocaleString("pt-BR"), r.posto, r.type, r.shift]) });
    }

    downloadCSVFile(`relatorio_${mode}_${period}_${dateStamp(now)}.csv`, buildCSV(sections));
  }

  // Cabeçalho impresso (só no PDF): título + recorte + carimbo de geração.
  function printPDF() { setPrintedAt(new Date().toLocaleString("pt-BR")); setTimeout(() => window.print(), 60); }

  return (
    <div className={`page report ${present ? "present" : ""}`}>
      <header className="page-head no-print">
        <h1 className="page-title">Relatório Operacional</h1>
        <SegmentedControl<Mode> value={mode} onChange={setMode} ariaLabel="Modo do relatório" options={[
          { value: "resumo", label: "Resumo" }, { value: "atividade", label: "Atividade" }, { value: "leitura", label: "Leitura" }, { value: "objetos", label: "Objetos" }, { value: "fadiga", label: "Operador" },
        ]} />
        <span className="privacy">● indicadores · sem imagens</span>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11 }}>{isReading ? "leitura · código de barras" : isObjects ? "objetos · contagem/presença" : isFadiga ? "operador · fadiga/risco" : "atividade · ocupação/ociosidade"}</span>
      </header>

      <div className="rep-filters no-print">
        <SegmentedControl<Period> value={period} onChange={setPeriod} ariaLabel="Período" options={(["hoje", "7d", "30d"] as Period[]).map((p) => ({ value: p, label: PERIOD_LABEL[p] }))} />
        <Select value={shift} onChange={(v) => setShift(v as Shift | "Todos")} ariaLabel="Turno" options={[{ value: "Todos", label: "Turno: todos" }, { value: "Manhã", label: "Manhã" }, { value: "Tarde", label: "Tarde" }, { value: "Noite", label: "Noite" }]} />
        {isResumo ? null : isReading ? (
          <Select value={ponto} onChange={setPonto} ariaLabel="Ponto" options={[{ value: "Todos", label: "Todos os pontos" }, ...rdataset.pontos.map((p) => ({ value: p, label: p }))]} />
        ) : isObjects ? (
          <Select value={setor} onChange={setSetor} ariaLabel="Setor" options={[{ value: "Todos", label: "Todos os setores" }, ...odataset.setores.map((s) => ({ value: s, label: s }))]} />
        ) : isFadiga ? (
          <Select value={posto} onChange={setPosto} ariaLabel="Posto" options={[{ value: "Todos", label: "Todos os postos" }, ...fdataset.postos.map((p) => ({ value: p, label: p }))]} />
        ) : (
          <Select value={area} onChange={setArea} ariaLabel="Área" options={[{ value: "Todas", label: "Todas as áreas" }, ...dataset.areas.map((a) => ({ value: a, label: a }))]} />
        )}
        <div className="spacer" />
        <IconButton label="Recarregar do histórico" onClick={refresh}>↻</IconButton>
        <Button onClick={() => setPresent((v) => !v)}>{present ? "Sair da apresentação" : "Apresentação"}</Button>
        <Button onClick={downloadCSV}>⬇ CSV</Button>
        <Button onClick={printPDF}>⎙ PDF</Button>
      </div>

      <div className="print-head only-print" aria-hidden>
        <div className="ph-title">Relatório Operacional · {MODE_LABEL[mode]}</div>
        <div className="ph-sub">{isResumo ? `${PERIOD_LABEL[period]} · Turno: ${shift === "Todos" ? "todos" : shift}` : lens}</div>
        <div className="ph-meta">Gerado em {printedAt || "—"} · indicadores agregados, sem imagens (LGPD)</div>
      </div>

      <div className="rep-body">
        {loading && (
          <div className="rep-skeleton" aria-busy="true" aria-label="Carregando relatório">
            <div className="kpi-row">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="kpi big"><Skeleton w="55%" h={22} /><Skeleton w="80%" h={11} /></div>)}</div>
            <Skeleton w="100%" h={240} />
          </div>
        )}
        {!loading && error && (
          <div className="dash-empty" role="alert">
            <p><b>Não foi possível carregar o histórico.</b></p>
            <p className="muted">{error}</p>
            <p style={{ marginTop: "var(--sp-3)" }}><Button variant="primary" onClick={refresh}>Tentar novamente</Button></p>
          </div>
        )}
        {noData && (
          <div className="dash-empty">
            <p><b>Sem histórico de {isReading ? "leitura" : isObjects ? "objetos" : isFadiga ? "operador" : "atividade"} ainda.</b></p>
            <p>{isReading ? <>Marque câmeras como <b>Leitura</b> na Central e aponte para códigos.</> : isObjects ? <>Marque câmeras como <b>Objetos</b> na Central.</> : isFadiga ? <>Marque uma câmera como <b>Operador (fadiga)</b> na Central.</> : <>Deixe a <b>Central</b> rodando para acumular indicadores.</>}</p>
            <p className="muted">Os dados aparecem automaticamente conforme as câmeras operam.</p>
          </div>
        )}

        {!loading && !error && !noData && isResumo && (<>
          <div className="rep-lens">Resumo executivo · <b>{PERIOD_LABEL[period]}</b> · Turno: {shift === "Todos" ? "todos" : shift}</div>
          <div className="rep-resumo">
            <button className="resumo-card" onClick={() => setMode("atividade")}>
              <div className="rc-h">Operação <span className="muted">atividade</span></div>
              <div className="rc-kpis">
                <div className="rc-k"><b style={{ color: "var(--ok)" }}>{k.activePct}%</b><span>tempo ativo</span></div>
                <div className="rc-k"><b>{fmtMin(k.idleMin)}</b><span>parado</span></div>
                <div className="rc-k"><b style={{ color: k.alerts ? "var(--alert)" : undefined }}>{k.alerts}</b><span>alertas</span></div>
              </div>
              <div className="rc-foot">área mais parada: {k.topArea} · pico {String(k.peakHour).padStart(2, "0")}h</div>
            </button>

            <button className="resumo-card" onClick={() => setMode("fadiga")}>
              <div className="rc-h">Segurança <span className="muted">operador/fadiga</span></div>
              <div className="rc-kpis">
                <div className="rc-k"><b style={{ color: fk.alertPct <= 2 ? "var(--ok)" : fk.alertPct <= 10 ? "var(--idle)" : "var(--alert)" }}>{fk.alertPct}%</b><span>em alerta</span></div>
                <div className="rc-k"><b style={{ color: fOccFadiga ? "var(--idle)" : undefined }}>{fOccFadiga}</b><span>fadiga</span></div>
                <div className="rc-k"><b style={{ color: fOccCelular ? "var(--idle)" : undefined }}>{fOccCelular}</b><span>celular</span></div>
              </div>
              <div className="rc-foot">horário crítico: {String(fk.peakHour).padStart(2, "0")}h</div>
            </button>

            <button className="resumo-card" onClick={() => setMode("leitura")}>
              <div className="rc-h">Logística <span className="muted">leitura/expedição</span></div>
              <div className="rc-kpis">
                <div className="rc-k"><b>{rk.boxes.toLocaleString("pt-BR")}</b><span>caixas</span></div>
                <div className="rc-k"><b style={{ color: rk.ratePct >= 95 ? "var(--ok)" : rk.ratePct >= 80 ? "var(--idle)" : "var(--alert)" }}>{rk.ratePct}%</b><span>taxa</span></div>
                <div className="rc-k"><b style={{ color: rk.noReads ? "var(--alert)" : undefined }}>{rk.noReads}</b><span>no-reads</span></div>
              </div>
              <div className="rc-foot">ponto de maior volume: {rk.topPonto}</div>
            </button>

            <button className="resumo-card" onClick={() => setMode("objetos")}>
              <div className="rc-h">Objetos <span className="muted">contagem/presença</span></div>
              <div className="rc-kpis">
                <div className="rc-k"><b>{ok.avgCount}</b><span>médios</span></div>
                <div className="rc-k"><b>{ok.peak}</b><span>pico</span></div>
                <div className="rc-k"><b style={{ color: oLoads ? "var(--idle)" : undefined }}>{oLoads}</b><span>carregam.</span></div>
              </div>
              <div className="rc-foot">predominante: {classLabel(ok.topClasse)}</div>
            </button>
          </div>
          <section className="insight"><b>Destaques</b> {[...tips.slice(0, 1), ...ftips.slice(0, 1), ...rtips.slice(0, 1)].filter(Boolean).join(" · ") || "Sem ocorrências relevantes no período."}</section>
          <p className="rep-foot">Toque num cartão para abrir o detalhe. Indicadores agregados, sem imagens (LGPD).</p>
        </>)}

        {!loading && !error && !noData && mode === "atividade" && (<>
          <div className="rep-lens">Visão: <b>{lens}</b></div>
          <div className="kpi-row">
            <div className="kpi big"><div className="v">{fmtMin(k.idleMin)}</div><div className="l">tempo parado <Delta v={deltaPct(k.idleMin, kPrev.idleMin)} /></div></div>
            <div className="kpi big"><div className="v">{k.alerts}</div><div className="l">alertas <Delta v={deltaPct(k.alerts, kPrev.alerts)} /></div></div>
            <div className="kpi big"><div className="v" style={{ fontSize: 17 }}>{k.topArea}</div><div className="l">área mais parada</div></div>
            <div className="kpi big"><div className="v">{String(k.peakHour).padStart(2, "0")}h</div><div className="l">horário crítico</div></div>
            <div className="kpi big"><div className="v" style={{ color: "var(--ok)" }}>{k.activePct}%</div><div className="l">tempo ativo</div></div>
          </div>
          <section className="insight"><b>💡 Oportunidades</b> {tips.join(" · ")}</section>
          <SegmentedControl value={tab} onChange={(v) => setTab(v as typeof tab)} ariaLabel="Seção" options={[{ value: "quando", label: "Quando para" }, { value: "onde", label: "Onde para" }, { value: "tendencia", label: "Tendência" }, { value: "eventos", label: `Eventos (${evt.length})` }]} />
          <div className="rep-tabpanel">
            {tab === "quando" && (
              <section className="panel">
                <h3>Quando para — horários críticos</h3>
                <div className="heatmap">
                  <div className="hm-axis"><span /> {HOURS.map((h) => <span key={h} className="hm-h">{h % 2 === 0 ? String(h).padStart(2, "0") : ""}</span>)}</div>
                  {hm.rows.map((row) => (
                    <div className="hm-row" key={row.area}>
                      <span className="hm-area" title={row.area}>{row.area}</span>
                      {row.hours.map((v, h) => <span key={h} className="hm-cell" style={{ background: heatColor(v, hm.max) }} title={`${row.area} · ${String(h).padStart(2, "0")}h · ${fmtMin(v)} parado`} />)}
                    </div>
                  ))}
                  <div className="hm-legend"><span>menos</span><i className="hm-scale" /><span>mais ocioso</span></div>
                </div>
              </section>
            )}
            {tab === "onde" && (
              <div className="rep-2col">
                <section className="panel">
                  <h3>Por área</h3>
                  {rank.rows.length === 0 && <p className="empty-note">Sem ociosidade no período.</p>}
                  {rank.rows.map((r) => (<div className="rank-row" key={r.area}><div className="rank-head"><span>{r.area}</span><span className="rank-val">{fmtMin(r.idleMin)} · {r.alerts} alertas</span></div><div className="rank-bar"><i style={{ width: `${Math.round((r.idleMin / rank.max) * 100)}%` }} /></div></div>))}
                </section>
                <section className="panel">
                  <h3>Por atividade</h3>
                  {byAtiv.rows.length === 0 && <p className="empty-note">Sem dados.</p>}
                  {byAtiv.rows.map((r) => (<div className="rank-row" key={r.atividade}><div className="rank-head"><span>{r.atividade}</span><span className="rank-val">{fmtMin(r.idleMin)} · {r.alerts} alertas</span></div><div className="rank-bar"><i style={{ width: `${Math.round((r.idleMin / byAtiv.max) * 100)}%` }} /></div></div>))}
                </section>
              </div>
            )}
            {tab === "tendencia" && (
              <div className="rep-2col">
                <section className="panel">
                  <h3>Tendência (14 dias)</h3>
                  <div className="evo">{evo.bars.map((b) => (<div className="evo-col" key={b.dayIndex} title={`${b.label} · ${fmtMin(b.idleMin)} parado`}><div className="evo-bar" style={{ height: `${Math.max(2, Math.round((b.idleMin / evo.max) * 100))}%` }} /><span className="evo-lbl">{b.label}</span></div>))}</div>
                </section>
                <section className="panel">
                  <h3>Por turno</h3>
                  {(["Manhã", "Tarde", "Noite"] as Shift[]).map((s) => (<div className="rank-row" key={s}><div className="rank-head"><span>{s}</span><span className="rank-val">{fmtMin(byShiftA.m[s])}</span></div><div className="rank-bar"><i style={{ width: `${Math.round((byShiftA.m[s] / byShiftA.max) * 100)}%` }} /></div></div>))}
                </section>
              </div>
            )}
            {tab === "eventos" && (
              <section className="panel panel-events">
                <h3>Eventos — alertas no período ({evt.length})</h3>
                <div className="rtable-wrap">
                  <table className="rtable">
                    <thead><tr><th>Data / hora</th><th>Área</th><th>Câmera</th><th>Duração</th><th>Turno</th></tr></thead>
                    <tbody>
                      {evt.map((r, i) => (<tr key={i}><td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td><td>{r.area}</td><td className="muted">{r.camera}</td><td className="mono">{fmtMin(r.durationMin)}</td><td>{r.shift}</td></tr>))}
                      {evt.length === 0 && <tr><td colSpan={5} className="empty-note">Nenhum alerta no período.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
          <div className="rep-foot">Histórico (Postgres) · indicadores agregados, sem imagens · <button onClick={onClear} disabled={busy} className="linkbtn">limpar histórico</button></div>
        </>)}

        {!loading && !error && !noData && isReading && (<>
          <div className="rep-lens">Visão: <b>{lens}</b></div>
          <div className="kpi-row">
            <div className="kpi big"><div className="v">{rk.boxes.toLocaleString("pt-BR")}</div><div className="l">caixas lidas <Delta v={deltaPct(rk.boxes, rkPrev.boxes)} goodWhenDown={false} /></div></div>
            <div className="kpi big"><div className="v" style={{ color: rk.ratePct >= 95 ? "var(--ok)" : rk.ratePct >= 80 ? "var(--idle)" : "var(--alert)" }}>{rk.ratePct}%</div><div className="l">taxa de leitura</div></div>
            <div className="kpi big"><div className="v" style={{ color: rk.noReads > 0 ? "var(--alert)" : undefined }}>{rk.noReads.toLocaleString("pt-BR")}</div><div className="l">no-reads</div></div>
            <div className="kpi big"><div className="v" style={{ fontSize: 15 }}>{rk.topPonto}</div><div className="l">ponto de maior volume</div></div>
            <div className="kpi big"><div className="v">{String(rk.peakHour).padStart(2, "0")}h</div><div className="l">horário de pico</div></div>
          </div>
          <section className="insight"><b>💡 Leitura</b> {rtips.join(" · ")}</section>
          <SegmentedControl value={tab} onChange={(v) => setTab(v as typeof tab)} ariaLabel="Seção" options={[{ value: "quando", label: "Quando lê" }, { value: "onde", label: "Onde lê" }, { value: "tendencia", label: "Tendência" }, { value: "eventos", label: `Leituras (${revt.length})` }]} />
          <div className="rep-tabpanel">
            {tab === "quando" && (
              <section className="panel">
                <h3>Quando lê — volume por hora</h3>
                <div className="heatmap">
                  <div className="hm-axis"><span /> {HOURS.map((h) => <span key={h} className="hm-h">{h % 2 === 0 ? String(h).padStart(2, "0") : ""}</span>)}</div>
                  {rhm.rows.map((row) => (
                    <div className="hm-row" key={row.ponto}>
                      <span className="hm-area" title={row.ponto}>{row.ponto}</span>
                      {row.hours.map((v, h) => <span key={h} className="hm-cell" style={{ background: readColor(v, rhm.max) }} title={`${row.ponto} · ${String(h).padStart(2, "0")}h · ${v} caixas`} />)}
                    </div>
                  ))}
                  <div className="hm-legend"><span>menos</span><i className="hm-scale read" /><span>mais volume</span></div>
                </div>
              </section>
            )}
            {tab === "onde" && (
              <div className="rep-2col">
                <section className="panel">
                  <h3>Por ponto</h3>
                  {rrank.rows.length === 0 && <p className="empty-note">Sem leituras no período.</p>}
                  {rrank.rows.map((r) => (<div className="rank-row" key={r.ponto}><div className="rank-head"><span>{r.ponto}</span><span className="rank-val">{r.boxes.toLocaleString("pt-BR")} caixas · taxa {r.ratePct}%{r.noReads > 0 ? ` · ${r.noReads} no-read` : ""}</span></div><div className="rank-bar"><i className="read" style={{ width: `${Math.round((r.boxes / rrank.max) * 100)}%` }} /></div></div>))}
                </section>
                <section className="panel">
                  <h3>Contribuição por câmera</h3>
                  {byCam.rows.length === 0 && <p className="empty-note">Sem dados.</p>}
                  {byCam.rows.map((r) => (<div className="rank-row" key={r.camera}><div className="rank-head"><span>{r.camera}</span><span className="rank-val">{r.reads.toLocaleString("pt-BR")} leituras</span></div><div className="rank-bar"><i className="read" style={{ width: `${Math.round((r.reads / byCam.max) * 100)}%` }} /></div></div>))}
                </section>
              </div>
            )}
            {tab === "tendencia" && (
              <div className="rep-2col">
                <section className="panel">
                  <h3>Tendência (14 dias)</h3>
                  <div className="evo">{revo.bars.map((b) => (<div className="evo-col" key={b.dayIndex} title={`${b.label} · ${b.boxes} caixas`}><div className="evo-bar read" style={{ height: `${Math.max(2, Math.round((b.boxes / revo.max) * 100))}%` }} /><span className="evo-lbl">{b.label}</span></div>))}</div>
                </section>
                <section className="panel">
                  <h3>Por turno</h3>
                  {(["Manhã", "Tarde", "Noite"] as Shift[]).map((s) => (<div className="rank-row" key={s}><div className="rank-head"><span>{s}</span><span className="rank-val">{byShiftR.m[s].toLocaleString("pt-BR")} caixas</span></div><div className="rank-bar"><i className="read" style={{ width: `${Math.round((byShiftR.m[s] / byShiftR.max) * 100)}%` }} /></div></div>))}
                </section>
              </div>
            )}
            {tab === "eventos" && (
              <section className="panel panel-events">
                <h3>Leituras — códigos no período ({revt.length})</h3>
                <div className="rtable-wrap">
                  <table className="rtable">
                    <thead><tr><th>Data / hora</th><th>Ponto</th><th>Código</th><th>Câmeras</th><th>Turno</th></tr></thead>
                    <tbody>
                      {revt.map((r, i) => (<tr key={i}><td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td><td>{r.ponto}</td><td className="mono">{r.code}</td><td className="mono">{r.cameras > 1 ? `${r.cameras}×` : "1"}</td><td>{r.shift}</td></tr>))}
                      {revt.length === 0 && <tr><td colSpan={5} className="empty-note">Nenhuma leitura no período.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
          <div className="rep-foot">Histórico (Postgres) · indicadores agregados, sem imagens · <button onClick={onClear} disabled={busy} className="linkbtn">limpar histórico</button></div>
        </>)}

        {!loading && !error && !noData && isObjects && (<>
          <div className="rep-lens">Visão: <b>{lens}</b></div>
          <div className="kpi-row">
            <div className="kpi big"><div className="v">{ok.avgCount}</div><div className="l">objetos médios em cena</div></div>
            <div className="kpi big"><div className="v">{ok.peak}</div><div className="l">pico simultâneo</div></div>
            <div className="kpi big"><div className="v" style={{ fontSize: 17 }}>{classLabel(ok.topClasse)}</div><div className="l">objeto predominante</div></div>
            <div className="kpi big"><div className="v" style={{ color: "var(--accent)" }}>{ok.presenceTopPct}%</div><div className="l">presença (predominante)</div></div>
            <div className="kpi big"><div className="v" style={{ color: oLoads ? "var(--idle)" : undefined }}>{oLoads}</div><div className="l">carregamentos</div></div>
          </div>
          <section className="insight"><b>💡 Objetos</b> {otips.join(" · ")}</section>
          <SegmentedControl value={tab} onChange={(v) => setTab(v as typeof tab)} ariaLabel="Seção" options={[{ value: "quando", label: "Quando" }, { value: "onde", label: "Setor × Classe" }, { value: "tendencia", label: "Tendência" }, { value: "eventos", label: `Eventos (${oevt.length})` }]} />
          <div className="rep-tabpanel">
            {tab === "quando" && (
              <section className="panel">
                <h3>Quando — contagem média por hora</h3>
                <div className="heatmap">
                  <div className="hm-axis"><span /> {HOURS.map((h) => <span key={h} className="hm-h">{h % 2 === 0 ? String(h).padStart(2, "0") : ""}</span>)}</div>
                  {ohm.rows.map((row) => (
                    <div className="hm-row" key={row.classe}>
                      <span className="hm-area" title={row.classe}>{classLabel(row.classe)}</span>
                      {row.hours.map((v, h) => <span key={h} className="hm-cell" style={{ background: readColor(v, ohm.max) }} title={`${classLabel(row.classe)} · ${String(h).padStart(2, "0")}h · ${v} em média`} />)}
                    </div>
                  ))}
                  <div className="hm-legend"><span>menos</span><i className="hm-scale read" /><span>mais objetos</span></div>
                </div>
              </section>
            )}
            {tab === "onde" && (
              <div className="rep-2col">
                <section className="panel">
                  <h3>Presença por Setor × Classe (% do tempo)</h3>
                  <div className="obj-matrix-wrap">
                    <table className="obj-matrix">
                      <thead><tr><th>Setor</th>{odataset.classes.map((cl) => <th key={cl} title={cl}>{objClass(cl)?.emoji ?? cl}</th>)}</tr></thead>
                      <tbody>
                        {presSetores.map((s) => (
                          <tr key={s}><td className="obj-setor">{s}</td>{odataset.classes.map((cl) => { const v = opres[s]?.[cl] ?? 0; return <td key={cl} className={v >= 50 ? "on" : v > 0 ? "" : "off"}>{v ? `${v}%` : "·"}</td>; })}</tr>
                        ))}
                        {presSetores.length === 0 && <tr><td colSpan={odataset.classes.length + 1} className="empty-note">Sem dados.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </section>
                <section className="panel">
                  <h3>Por setor (média em cena)</h3>
                  {orank.rows.length === 0 && <p className="empty-note">Sem objetos no período.</p>}
                  {orank.rows.map((r) => (<div className="rank-row" key={r.setor}><div className="rank-head"><span>{r.setor}</span><span className="rank-val">média {r.avg} · pico {r.peak}</span></div><div className="rank-bar"><i className="read" style={{ width: `${Math.round((r.avg / orank.max) * 100)}%` }} /></div></div>))}
                  <h3 style={{ marginTop: 12 }}>Por classe</h3>
                  {obyClass.rows.map((r) => (<div className="rank-row" key={r.classe}><div className="rank-head"><span>{classLabel(r.classe)}</span><span className="rank-val">média {r.avg}</span></div><div className="rank-bar"><i className="read" style={{ width: `${Math.round((r.avg / obyClass.max) * 100)}%` }} /></div></div>))}
                </section>
              </div>
            )}
            {tab === "tendencia" && (
              <section className="panel">
                <h3>Tendência (14 dias) — objetos médios/dia</h3>
                <div className="evo">{oevo.bars.map((b) => (<div className="evo-col" key={b.dayIndex} title={`${b.label} · ${b.avg} em média`}><div className="evo-bar read" style={{ height: `${Math.max(2, Math.round((b.avg / oevo.max) * 100))}%` }} /><span className="evo-lbl">{b.label}</span></div>))}</div>
              </section>
            )}
            {tab === "eventos" && (
              <section className="panel panel-events">
                <h3>Eventos — presença e carregamentos ({oevt.length})</h3>
                <div className="rtable-wrap">
                  <table className="rtable">
                    <thead><tr><th>Data / hora</th><th>Tipo</th><th>Setor</th><th>Classe</th><th>Turno</th></tr></thead>
                    <tbody>
                      {oevt.map((r, i) => (<tr key={i}><td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td><td>{r.type}</td><td>{r.setor}</td><td>{classLabel(r.classe)}</td><td>{r.shift}</td></tr>))}
                      {oevt.length === 0 && <tr><td colSpan={5} className="empty-note">Nenhum evento no período.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
          <div className="rep-foot">Histórico (Postgres) · indicadores agregados, sem imagens · <button onClick={onClear} disabled={busy} className="linkbtn">limpar histórico</button></div>
        </>)}

        {!loading && !error && !noData && isFadiga && (<>
          <div className="rep-lens">Visão: <b>{lens}</b></div>
          <div className="kpi-row">
            <div className="kpi big"><div className="v" style={{ color: fk.alertPct <= 2 ? "var(--ok)" : fk.alertPct <= 10 ? "var(--idle)" : "var(--alert)" }}>{fk.alertPct}%</div><div className="l">tempo em alerta</div></div>
            <div className="kpi big"><div className="v" style={{ color: fOccFadiga ? "var(--idle)" : undefined }}>{fOccFadiga}</div><div className="l">ocorrências de fadiga</div></div>
            <div className="kpi big"><div className="v" style={{ color: fOccCelular ? "var(--idle)" : undefined }}>{fOccCelular}</div><div className="l">ocorrências de celular</div></div>
            <div className="kpi big"><div className="v">{fBocejos}</div><div className="l">bocejos</div></div>
            <div className="kpi big"><div className="v">{String(fk.peakHour).padStart(2, "0")}h</div><div className="l">horário crítico</div></div>
          </div>
          <section className="insight"><b>💡 Operador</b> {ftips.join(" · ")}</section>
          <SegmentedControl value={tab} onChange={(v) => setTab(v as typeof tab)} ariaLabel="Seção" options={[{ value: "quando", label: "Quando" }, { value: "tendencia", label: "Tendência" }, { value: "eventos", label: `Ocorrências (${fevt.length})` }]} />
          <div className="rep-tabpanel">
            {(tab === "quando" || tab === "onde") && (
              <section className="panel">
                <h3>Quando — tempo de risco por hora (min)</h3>
                <div className="heatmap">
                  <div className="hm-axis"><span /> {HOURS.map((h) => <span key={h} className="hm-h">{h % 2 === 0 ? String(h).padStart(2, "0") : ""}</span>)}</div>
                  {fhm.rows.map((row) => (
                    <div className="hm-row" key={row.label}>
                      <span className="hm-area" title={row.label}>{row.label}</span>
                      {row.hours.map((v, h) => <span key={h} className="hm-cell" style={{ background: heatColor(v, fhm.max) }} title={`${row.label} · ${String(h).padStart(2, "0")}h · ${v} min`} />)}
                    </div>
                  ))}
                  <div className="hm-legend"><span>menos</span><i className="hm-scale" /><span>mais risco</span></div>
                </div>
              </section>
            )}
            {tab === "tendencia" && (
              <section className="panel">
                <h3>Tendência (14 dias) — % do tempo em alerta</h3>
                <div className="evo">{fevo.bars.map((b) => (<div className="evo-col" key={b.dayIndex} title={`${b.label} · ${b.pct}% em alerta`}><div className="evo-bar" style={{ height: `${Math.max(2, Math.round((b.pct / fevo.max) * 100))}%` }} /><span className="evo-lbl">{b.label}</span></div>))}</div>
              </section>
            )}
            {tab === "eventos" && (
              <section className="panel panel-events">
                <h3>Ocorrências de risco ({fevt.length})</h3>
                <div className="rtable-wrap">
                  <table className="rtable">
                    <thead><tr><th>Data / hora</th><th>Posto</th><th>Tipo</th><th>Turno</th></tr></thead>
                    <tbody>
                      {fevt.map((r, i) => (<tr key={i}><td className="mono">{new Date(r.ts).toLocaleString("pt-BR")}</td><td>{r.posto}</td><td>{r.type}</td><td>{r.shift}</td></tr>))}
                      {fevt.length === 0 && <tr><td colSpan={4} className="empty-note">Nenhuma ocorrência no período.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </div>
          <div className="rep-foot">Histórico (Postgres) · indicadores agregados, sem imagens · <button onClick={onClear} disabled={busy} className="linkbtn">limpar histórico</button></div>
        </>)}
      </div>
    </div>
  );
}
