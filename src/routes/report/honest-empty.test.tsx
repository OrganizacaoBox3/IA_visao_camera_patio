// "NÃO ESTOU MEDINDO" NÃO PODE SER RENDERIZADO COMO RESULTADO (auditoria 2026-07-26, A2/A6/A7).
// Testes de RENDER (renderToStaticMarkup — sem DOM, sem dependência nova) com ASSERTS NEGATIVOS:
// o que não pode aparecer na tela é tão contrato quanto o que aparece.
//   A2 · KPI sem amostra escreve "—" (nunca 100%/0%) e o insight CALA;
//   A2 · o gate de vazio olha a JANELA FILTRADA (20 dias de histórico + "hoje" vazio ⇒ vazio);
//   A6 · bucket com idleMs=0 e frames>0 NÃO renderiza "0m" — declara a indisponibilidade;
//   A7 · a coluna "Câmeras" (literal 1 em produção) não existe mais na tabela de leituras.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import {
  readingKpis,
  fadigaKpis,
  kpis,
  idleMeasurement,
  shiftRuler,
  insights,
  readingInsights,
  fadigaInsights,
  type Cell,
  type ReadingCell,
  type ReadingDataset,
} from "../../report/calc";
import { modeEmptyState, resumoEmptyState } from "../ReportPage";
import { useLeituraVM } from "./useLeituraVM";
import { LeituraPanel } from "./LeituraPanel";
import { FadigaPanel } from "./FadigaPanel";
import { AtividadePanel } from "./AtividadePanel";

const html = (el: ReactElement) => renderToStaticMarkup(el);
// TEXTO VISÍVEL (sem tags/atributos/CSS). Asserção negativa em cima do HTML cru é armadilha:
// "100%" existe em `min-width:100%` e "0m" em `duration-[120ms]` — o teste passaria/quebraria por
// classe utilitária, não pelo número na tela. Aqui se afirma sobre o que o operador LÊ.
const text = (el: ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Executa um hook fora do navegador (useMemo funciona no render de servidor). */
function hookValue<T>(useHook: () => T): T {
  let out: T | undefined;
  function Probe() {
    out = useHook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out as T;
}

// ── A2 · O GATE DE VAZIO OLHA A JANELA FILTRADA, NÃO O DATASET ────────────────────────────────
describe("gate de vazio — 20 dias de histórico + período 'Hoje' sem operação", () => {
  // 20 dias gravados (dayIndex 0..18); o dia corrente (19 = "hoje") não tem NENHUM bucket.
  const cells: ReadingCell[] = Array.from({ length: 19 }, (_, d) => ({
    ponto: "Expedição",
    dayIndex: d,
    hour: 8,
    boxes: 100,
    reads: 120,
    multiReads: 10,
    passages: 100,
    perCamera: { cam1: 120 },
  }));
  const ds: ReadingDataset = {
    days: 20,
    pontos: ["Expedição"],
    cameraLabels: { cam1: "Câmera 1" },
    cells,
    startMs: Date.UTC(2026, 6, 6),
  };

  const vm = () =>
    hookValue(() =>
      useLeituraVM({
        view: "full",
        ds,
        events: [],
        period: "hoje",
        shift: "Todos",
        ponto: "Todos",
        shifts: [],
      }),
    );

  it("a janela filtrada está vazia enquanto o dataset tem 19 buckets", () => {
    const v = vm();
    expect(v.dataset.cells.length).toBe(19);
    expect(v.windowCells).toBe(0);
  });

  it("o estado do corpo é EMPTY-WINDOW (não 'ready', não 'sem histórico')", () => {
    const v = vm();
    expect(
      modeEmptyState({ datasetCells: v.dataset.cells.length, windowCells: v.windowCells }),
    ).toBe("empty-window");
  });

  it("sem histórico nenhum, o vazio é o OUTRO (texto de ativação, não de recorte)", () => {
    expect(modeEmptyState({ datasetCells: 0, windowCells: 0 })).toBe("no-history");
  });

  it("view 'off' (windowCells null) NUNCA é vazio — 'não calculei' ≠ 'não há dado'", () => {
    expect(modeEmptyState({ datasetCells: 19, windowCells: null })).toBeNull();
  });

  it("com dado no recorte volta a renderizar (o gate não engoliu o caminho normal)", () => {
    const v = hookValue(() =>
      useLeituraVM({
        view: "full",
        ds,
        events: [],
        period: "30d",
        shift: "Todos",
        ponto: "Todos",
        shifts: [],
      }),
    );
    expect(v.windowCells).toBeGreaterThan(0);
    expect(
      modeEmptyState({ datasetCells: v.dataset.cells.length, windowCells: v.windowCells }),
    ).toBeNull();
  });

  it("Resumo: nenhuma dimensão com dado NO RECORTE ⇒ vazio de janela (não cartão de zeros)", () => {
    expect(
      resumoEmptyState({ dimsWithHistory: 3, hasAlarmHistory: true, anyDimensionInWindow: false }),
    ).toBe("empty-window");
    expect(
      resumoEmptyState({ dimsWithHistory: 0, hasAlarmHistory: false, anyDimensionInWindow: false }),
    ).toBe("no-history");
    expect(
      resumoEmptyState({ dimsWithHistory: 1, hasAlarmHistory: false, anyDimensionInWindow: true }),
    ).toBeNull();
  });

  it("ASSERT NEGATIVO: o painel montado com a janela vazia NÃO escreve '100%'", () => {
    // Mesmo que alguém volte a renderizar o painel num recorte vazio, o KPI não pode mentir.
    const rk = readingKpis([]);
    const out = text(
      <LeituraPanel
        lens="Hoje · Todos os pontos · Turno: todos"
        rk={rk}
        rkPrev={rk}
        rtips={readingInsights(rk)}
        rhm={{ rows: [], max: 1 }}
        rrank={{ rows: [], max: 1 }}
        byCam={{ rows: [], max: 1 }}
        revo={{ bars: [], max: 1 }}
        revt={[]}
        tab="quando"
        onTabChange={() => {}}
      />,
    );
    expect(out).not.toContain("100%");
    expect(out).not.toContain("excelente cobertura");
    expect(out).toContain("—");
  });
});

// ── A2 · KPI SEM AMOSTRA ESCREVE "—" E O INSIGHT CALA ─────────────────────────────────────────
describe("LeituraPanel — taxa sem passagem medida", () => {
  const rk = readingKpis([]);
  const panel = (
    <LeituraPanel
      lens="lente"
      rk={rk}
      rkPrev={rk}
      rtips={readingInsights(rk)}
      rhm={{ rows: [], max: 1 }}
      rrank={{ rows: [], max: 1 }}
      byCam={{ rows: [], max: 1 }}
      revo={{ bars: [], max: 1 }}
      revt={[]}
      tab="eventos"
      onTabChange={() => {}}
    />
  );
  const out = text(panel);

  it("escreve '—' e declara o motivo, sem inventar percentual", () => {
    expect(out).toContain("sem passagem no recorte");
    expect(out).not.toMatch(/\d+%/);
  });

  it("a faixa de Insight não existe com n=0 (nem o rótulo 'Leitura' dela)", () => {
    expect(html(panel)).not.toContain("rep-insight");
  });

  it("horário de pico não vira '00h' inventado", () => {
    expect(out).not.toContain("00h");
  });

  // A7 — coluna que fingia variar (`cameras > 1 ? "N×" : "1"`) sobre um literal 1 gravado.
  it("a tabela de leituras não tem mais a coluna 'Câmeras'", () => {
    expect(out).not.toContain("Câmeras");
  });
});

describe("FadigaPanel — 'Operação saudável' exige amostra", () => {
  const fk = fadigaKpis([]);
  const panel = (
    <FadigaPanel
      lens="lente"
      fk={fk}
      fOccFadiga={0}
      fOccCelular={0}
      ftips={fadigaInsights(fk, 0, 0)}
      fhm={{ rows: [], max: 1 }}
      fevo={{ bars: [], max: 1 }}
      fevt={[]}
      tab="quando"
      onTabChange={() => {}}
    />
  );
  const out = text(panel);

  it("sem amostra o KPI é '—' e não há 0%/100% na tela", () => {
    expect(out).toContain("sem amostra no recorte");
    expect(out).not.toMatch(/\d+%/);
  });

  it("nenhum insight — nada de 'Operação saudável' com n=0", () => {
    expect(out).not.toContain("Operação saudável");
    expect(html(panel)).not.toContain("rep-insight");
  });

  it("com amostra real o número volta (o gate não apagou o caminho normal)", () => {
    const k = fadigaKpis([
      {
        posto: "P1",
        dayIndex: 0,
        hour: 8,
        samples: 100,
        ok: 99,
        fadiga: 1,
        celular: 0,
        duplo: 0,
        earSum: 0,
        earSamples: 0,
      },
    ]);
    const withData = text(
      <FadigaPanel
        lens="lente"
        fk={k}
        fOccFadiga={1}
        fOccCelular={0}
        ftips={fadigaInsights(k, 1, 0)}
        fhm={{ rows: [], max: 1 }}
        fevo={{ bars: [], max: 1 }}
        fevt={[]}
        tab="quando"
        onTabChange={() => {}}
      />,
    );
    expect(withData).toContain("1%");
    expect(withData).toContain("Operação saudável: 99% do tempo sem alerta");
  });
});

// ── A6 · OCIOSIDADE NÃO MEDIDA: DECLARAR, NUNCA EXIBIR "0m" ───────────────────────────────────
describe("AtividadePanel — bucket com idleMs=0 e frames>0", () => {
  const cells: Cell[] = [
    {
      area: "Doca",
      dayIndex: 0,
      hour: 8,
      idleMin: 0,
      alerts: 2,
      activePct: 33,
      samples: 900,
      activeSamples: 300,
    },
    {
      area: "Doca",
      dayIndex: 0,
      hour: 9,
      idleMin: 0,
      alerts: 0,
      activePct: 10,
      samples: 900,
      activeSamples: 90,
    },
  ];
  const k = kpis(cells);
  const el = (tab: "quando" | "onde" | "tendencia") => (
    <AtividadePanel
      lens="lente"
      k={k}
      kPrev={k}
      ruler={shiftRuler(cells)}
      idle={idleMeasurement(cells)}
      tips={insights(cells, k)}
      hm={{ rows: [{ area: "Doca", hours: new Array(24).fill(0) }], max: 1 }}
      rank={{ rows: [], max: 1 }}
      byAtiv={{ rows: [], max: 1 }}
      evo={{ bars: [{ dayIndex: 0, label: "20/07", idleMin: 0 }], max: 1 }}
      evt={[]}
      flow={null}
      tab={tab}
      onTabChange={() => {}}
    />
  );
  const panel = (tab: "quando" | "onde" | "tendencia") => text(el(tab));

  it("o KPI de tempo parado NÃO renderiza '0m' — escreve '—' e diz 'não medido'", () => {
    const out = panel("quando");
    expect(out).not.toMatch(/\d+m\b/); // nem "0m", nem "0h 00m"
    expect(out).toContain("não medido");
  });

  it("o selo declara a indisponibilidade em vez do heatmap de zeros", () => {
    expect(panel("quando")).toContain("Ociosidade não medida");
    // o mapa de calor (grade de zeros) não é desenhado
    expect(html(el("quando"))).not.toContain("hm-axis");
  });

  it("'Onde para' não afirma 'Sem ociosidade no período.' (isso é uma medição que não houve)", () => {
    const out = panel("onde");
    expect(out).not.toContain("Sem ociosidade no período.");
    expect(out).toContain("Ociosidade não medida");
  });

  it("a tendência não desenha 14 barras zeradas com cara de 14 dias sem parada", () => {
    expect(panel("tendencia")).toContain("Ociosidade não medida");
    const out = html(el("tendencia"));
    expect(out).not.toContain("evo-col"); // nenhuma barra
    expect(out).not.toContain("parado&quot;"); // nem no title= das barras
  });

  it("os ALERTAS continuam visíveis — são outra medição, e essa existe", () => {
    expect(panel("quando")).toContain("alertas");
  });

  it("com ociosidade medida o número volta a aparecer", () => {
    const measured: Cell[] = [
      {
        area: "Doca",
        dayIndex: 0,
        hour: 8,
        idleMin: 45,
        alerts: 1,
        activePct: 20,
        samples: 900,
        activeSamples: 180,
      },
    ];
    const mk = kpis(measured);
    const out = text(
      <AtividadePanel
        lens="lente"
        k={mk}
        kPrev={mk}
        ruler={shiftRuler(measured)}
        idle={idleMeasurement(measured)}
        tips={insights(measured, mk)}
        hm={{ rows: [{ area: "Doca", hours: new Array(24).fill(0) }], max: 1 }}
        rank={{ rows: [], max: 1 }}
        byAtiv={{ rows: [], max: 1 }}
        evo={{ bars: [], max: 1 }}
        evt={[]}
        flow={null}
        tab="quando"
        onTabChange={() => {}}
      />,
    );
    expect(out).toContain("45m");
    expect(out).not.toContain("Ociosidade não medida");
  });
});
