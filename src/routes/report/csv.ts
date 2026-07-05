// Builders de seções CSV do Relatório, por modo (resumo/atividade/leitura/objetos/fadiga/
// alarmes). Extraídos do downloadCSV do ReportPage (antes ~205 linhas): a página passa a só
// ORQUESTRAR — monta a lista de seções e dispara o download. Reusam as primitivas de
// "../../report/csv" (buildCSV/downloadCSVFile/alarmSection), re-exportadas aqui p/ a página
// importar tudo de um só módulo. LGPD: só indicadores agregados, nunca imagens.

import { fmtMin } from "../../report/mock";
import type {
  Shift,
  Kpis,
  ReadingKpis,
  ObjectKpis,
  FadigaKpis,
  EventRow,
  ReadingEventRow,
  ObjectEventRow,
  FadigaEventRow,
} from "../../report/mock";
import type { FlowLineRow } from "../../report/store";
import type { AlarmEvent } from "../../types/alarm";
import { alarmSection, type CsvSection } from "../../report/csv";
import { classLabel } from "./ObjetosPanel";
import { SHIFTS } from "./chrome";

// Primitivas re-exportadas: a página monta/serializa/baixa importando só deste módulo.
export { buildCSV, downloadCSVFile, dateStamp, type CsvSection } from "../../report/csv";

// ── Cabeçalho (metadados do recorte, comum a todos os modos) ──
export function metaSection(p: {
  modeLabel: string;
  periodLabel: string;
  shift: string; // "Todos" ou o turno já resolvido
  filtroLabel: string;
  now: Date;
}): CsvSection {
  return {
    title: "RELATÓRIO OPERACIONAL — VISÃO DE PÁTIO",
    rows: [
      ["Dimensão", p.modeLabel],
      ["Período", p.periodLabel],
      ["Turno", p.shift],
      ["Filtro", p.filtroLabel],
      ["Gerado em", p.now.toLocaleString("pt-BR")],
      ["Privacidade", "Indicadores agregados, sem imagens (LGPD)"],
    ],
  };
}

// ── Resumo executivo (indicadores consolidados das 4 dimensões) ──
export function resumoSection(p: {
  k: Kpis;
  fk: FadigaKpis;
  fOccFadiga: number;
  fOccCelular: number;
  rk: ReadingKpis;
  ok: ObjectKpis;
}): CsvSection {
  const { k, fk, fOccFadiga, fOccCelular, rk, ok } = p;
  return {
    title: "INDICADORES CONSOLIDADOS",
    headers: ["Dimensão", "Indicador", "Valor"],
    rows: [
      ["Atividade", "Tempo ativo (%)", k.activePct],
      ["Atividade", "Tempo parado", fmtMin(k.idleMin)],
      ["Atividade", "Alertas", k.alerts],
      ["Atividade", "Área mais parada", k.topArea],
      ["Operador", "Tempo em alerta (%)", fk.alertPct],
      ["Operador", "Ocorrências de fadiga", fOccFadiga],
      ["Operador", "Ocorrências de celular", fOccCelular],
      ["Leitura", "Caixas lidas", rk.boxes],
      ["Leitura", "Taxa de leitura (%)", rk.ratePct],
      ["Leitura", "No-reads", rk.noReads],
      ["Leitura", "Ponto de maior volume", rk.topPonto],
      ["Objetos", "Objetos médios", ok.avgCount],
      ["Objetos", "Pico simultâneo", ok.peak],
      ["Objetos", "Predominante", classLabel(ok.topClasse)],
    ],
  };
}

// ── Atividade (indicadores + por área/atividade/turno + fluxo opcional + eventos) ──
export function atividadeSections(p: {
  k: Kpis;
  peoplePeak: number;
  rankRows: { area: string; idleMin: number; alerts: number }[];
  byAtivRows: { atividade: string; idleMin: number; alerts: number }[];
  byShiftA: Record<Shift, number>;
  // null = hub sem o kind "flow" → seções de fluxo omitidas (área não se aplica ao fluxo).
  flow: { k: { in: number; out: number; lines: number }; lineRows: FlowLineRow[] } | null;
  evt: EventRow[];
}): CsvSection[] {
  const { k, peoplePeak, rankRows, byAtivRows, byShiftA, flow, evt } = p;
  const out: CsvSection[] = [
    {
      title: "INDICADORES",
      headers: ["Indicador", "Valor"],
      rows: [
        ["Tempo parado", fmtMin(k.idleMin)],
        ["Alertas", k.alerts],
        ["Tempo ativo (%)", k.activePct],
        ["Pico de pessoas", peoplePeak],
        ["Área mais parada", k.topArea],
        ["Horário crítico", `${String(k.peakHour).padStart(2, "0")}h`],
      ],
    },
    {
      title: "POR ÁREA",
      headers: ["Área", "Tempo parado", "Alertas"],
      rows: rankRows.map((r) => [r.area, fmtMin(r.idleMin), r.alerts]),
    },
    {
      title: "POR ATIVIDADE",
      headers: ["Atividade", "Tempo parado", "Alertas"],
      rows: byAtivRows.map((r) => [r.atividade, fmtMin(r.idleMin), r.alerts]),
    },
    {
      title: "POR TURNO",
      headers: ["Turno", "Tempo parado"],
      rows: SHIFTS.map((s) => [s, fmtMin(byShiftA[s])]),
    },
  ];
  if (flow) {
    out.push({
      title: "FLUXO DE PESSOAS (linhas de contagem)",
      headers: ["Indicador", "Valor"],
      rows: [
        ["Entradas", flow.k.in],
        ["Saídas", flow.k.out],
        ["Saldo (entradas − saídas)", flow.k.in - flow.k.out],
        ["Linhas com cruzamento", flow.k.lines],
      ],
    });
    out.push({
      title: "FLUXO POR LINHA",
      headers: ["Câmera", "Linha (id)", "Entradas", "Saídas"],
      rows: flow.lineRows.map((r) => [r.cameraLabel || r.cameraId, r.tripwireId, r.in, r.out]),
    });
  }
  out.push({
    title: `EVENTOS (${evt.length})`,
    headers: ["Data/hora", "Área", "Câmera", "Duração (min)", "Turno"],
    rows: evt.map((r) => [
      new Date(r.ts).toLocaleString("pt-BR"),
      r.area,
      r.camera,
      r.durationMin,
      r.shift,
    ]),
  });
  return out;
}

// ── Leitura (indicadores + por ponto/câmera/turno + leituras) ──
export function leituraSections(p: {
  rk: ReadingKpis;
  rrankRows: { ponto: string; boxes: number; ratePct: number; noReads: number }[];
  byCamRows: { camera: string; reads: number }[];
  byShiftR: Record<Shift, number>;
  revt: ReadingEventRow[];
}): CsvSection[] {
  const { rk, rrankRows, byCamRows, byShiftR, revt } = p;
  return [
    {
      title: "INDICADORES",
      headers: ["Indicador", "Valor"],
      rows: [
        ["Caixas lidas", rk.boxes],
        ["Taxa de leitura (%)", rk.ratePct],
        ["No-reads", rk.noReads],
        ["Ponto de maior volume", rk.topPonto],
        ["Horário de pico", `${String(rk.peakHour).padStart(2, "0")}h`],
      ],
    },
    {
      title: "POR PONTO",
      headers: ["Ponto", "Caixas", "Taxa (%)", "No-reads"],
      rows: rrankRows.map((r) => [r.ponto, r.boxes, r.ratePct, r.noReads]),
    },
    {
      title: "POR CÂMERA",
      headers: ["Câmera", "Leituras"],
      rows: byCamRows.map((r) => [r.camera, r.reads]),
    },
    {
      title: "POR TURNO",
      headers: ["Turno", "Caixas"],
      rows: SHIFTS.map((s) => [s, byShiftR[s]]),
    },
    {
      title: `LEITURAS (${revt.length})`,
      headers: ["Data/hora", "Ponto", "Código", "Câmeras", "Turno"],
      rows: revt.map((r) => [
        new Date(r.ts).toLocaleString("pt-BR"),
        r.ponto,
        r.code,
        r.cameras,
        r.shift,
      ]),
    },
  ];
}

// ── Objetos (indicadores + presença setor×classe + por setor/classe + eventos) ──
export function objetosSections(p: {
  ok: ObjectKpis;
  oLoads: number;
  classes: string[];
  presSetores: string[];
  opres: Record<string, Record<string, number>>;
  orankRows: { setor: string; avg: number; peak: number }[];
  obyClassRows: { classe: string; avg: number }[];
  oevt: ObjectEventRow[];
}): CsvSection[] {
  const { ok, oLoads, classes, presSetores, opres, orankRows, obyClassRows, oevt } = p;
  return [
    {
      title: "INDICADORES",
      headers: ["Indicador", "Valor"],
      rows: [
        ["Objetos médios em cena", ok.avgCount],
        ["Pico simultâneo", ok.peak],
        ["Predominante", classLabel(ok.topClasse)],
        ["Presença predominante (%)", ok.presenceTopPct],
        ["Carregamentos", oLoads],
      ],
    },
    {
      title: "PRESENÇA SETOR × CLASSE (% do tempo)",
      headers: ["Setor", ...classes.map(classLabel)],
      rows: presSetores.map((s) => [s, ...classes.map((cl) => opres[s]?.[cl] ?? 0)]),
    },
    {
      title: "POR SETOR",
      headers: ["Setor", "Média", "Pico"],
      rows: orankRows.map((r) => [r.setor, r.avg, r.peak]),
    },
    {
      title: "POR CLASSE",
      headers: ["Classe", "Média"],
      rows: obyClassRows.map((r) => [classLabel(r.classe), r.avg]),
    },
    {
      title: `EVENTOS (${oevt.length})`,
      headers: ["Data/hora", "Tipo", "Setor", "Classe", "Turno"],
      rows: oevt.map((r) => [
        new Date(r.ts).toLocaleString("pt-BR"),
        r.type,
        r.setor,
        classLabel(r.classe),
        r.shift,
      ]),
    },
  ];
}

// ── Operador/Fadiga (indicadores + ocorrências) ──
export function fadigaSections(p: {
  fk: FadigaKpis;
  fOccFadiga: number;
  fOccCelular: number;
  fBocejos: number;
  fevt: FadigaEventRow[];
}): CsvSection[] {
  const { fk, fOccFadiga, fOccCelular, fBocejos, fevt } = p;
  return [
    {
      title: "INDICADORES",
      headers: ["Indicador", "Valor"],
      rows: [
        ["Tempo em alerta (%)", fk.alertPct],
        ["Ocorrências de fadiga", fOccFadiga],
        ["Ocorrências de celular", fOccCelular],
        ["Bocejos", fBocejos],
        ["Horário crítico", `${String(fk.peakHour).padStart(2, "0")}h`],
      ],
    },
    {
      title: `OCORRÊNCIAS (${fevt.length})`,
      headers: ["Data/hora", "Posto", "Tipo", "Turno"],
      rows: fevt.map((r) => [new Date(r.ts).toLocaleString("pt-BR"), r.posto, r.type, r.shift]),
    },
  ];
}

// ── Alarmes (indicadores + fila de eventos; reusa alarmSection, metadados sem imagens) ──
export function alarmesSections(p: {
  ak: { total: number; critical: number; high: number; advisory: number; news: number };
  alarmsView: AlarmEvent[];
}): CsvSection[] {
  const { ak, alarmsView } = p;
  return [
    {
      title: "INDICADORES",
      headers: ["Indicador", "Valor"],
      rows: [
        ["Total de alarmes", ak.total],
        ["Críticos", ak.critical],
        ["Alta", ak.high],
        ["Informativos", ak.advisory],
        ["Em aberto (novos)", ak.news],
      ],
    },
    alarmSection(alarmsView),
  ];
}
