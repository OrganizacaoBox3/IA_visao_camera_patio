// Render do painel de LINHAS DE CONTAGEM (modo Fluxo) — asserts NEGATIVOS no que não pode
// aparecer na tela, no mesmo espírito de honest-empty.test.tsx.
//
// O RISCO ESPECÍFICO DESTE PAINEL é de LEITURA, não de cálculo: "saldo +180" sozinho se lê como
// "180 pessoas ainda lá dentro". Num ponto de passagem isso é falso — quem entra acaba saindo, e
// saldo alto denuncia linha mal posicionada ou travessia perdida de um lado. O painel só pode
// exibir o saldo COM esse rótulo. E o volume de passagem não é anormalidade (going-gray): nada
// aqui ganha cor de alerta por ser alto.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { FluxoPanel } from "./FluxoPanel";
import { flowKpis, flowByHour, flowByLine, type FlowCell } from "../../report/calc";

const text = (el: ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const fc = (over: Partial<FlowCell>): FlowCell => ({
  cameraId: "cam-1",
  cameraLabel: "Doca",
  tripwireId: "w1",
  dayIndex: 0,
  hour: 8,
  in: 0,
  out: 0,
  ...over,
});

const painel = (p: {
  cells: FlowCell[];
  prev?: FlowCell[];
  tips?: string[];
  bars?: { dayIndex: number; label: string; in: number; out: number }[];
}) => (
  <FluxoPanel
    lens="Últimos 7 dias · Todas as linhas · Turno: todos"
    k={flowKpis(p.cells)}
    kPrev={flowKpis(p.prev ?? [])}
    tips={p.tips ?? []}
    byHour={flowByHour(p.cells)}
    byLine={flowByLine(p.cells)}
    evo={{ bars: p.bars ?? [], max: 1 }}
    labelOf={(k) => (k === "cam-1|w1" ? "Doca" : k)}
  />
);

describe("FluxoPanel — o que a tela pode e não pode afirmar", () => {
  const cheio = [fc({ hour: 14, in: 120, out: 100 })];

  it("mostra entradas, saídas, travessias e a hora de pico", () => {
    const t = text(painel({ cells: cheio }));
    expect(t).toContain("120");
    expect(t).toContain("entradas");
    expect(t).toContain("220"); // travessias
    expect(t).toContain("14h");
  });

  it("o SALDO só aparece ROTULADO como conferência da linha — nunca como número solto", () => {
    const t = text(painel({ cells: cheio }));
    expect(t).toMatch(/Saldo \(entradas − saídas\)/);
    expect(t).toMatch(/não meta/);
    expect(t).toMatch(/quem entra acaba saindo/);
  });

  it("sem período anterior no histórico, NÃO escreve variação (0% se leria 'estável')", () => {
    const t = text(painel({ cells: cheio }));
    expect(t).not.toMatch(/vs\. anterior/);
  });

  it("com período anterior, a variação sai em texto NEUTRO ao lado das travessias", () => {
    const t = text(painel({ cells: cheio, prev: [fc({ in: 100, out: 100 })] }));
    expect(t).toContain("+10% vs. anterior");
  });

  it("sem travessia nenhuma: o KPI de pico é '—' (00h seria um pico inventado à meia-noite)", () => {
    // O "00h" do eixo do gráfico por hora é rótulo de eixo, não afirmação — o que não pode
    // existir é o VALOR do KPI. Por isso a asserção é ancorada no rótulo do próprio KPI.
    expect(text(painel({ cells: [] }))).toMatch(/— hora de pico/);
    expect(text(painel({ cells: [fc({ hour: 0, in: 3 })] }))).toMatch(/00h hora de pico/);
  });

  it("sem histórico para tendência, declara a ausência em vez de desenhar barras zeradas", () => {
    const t = text(painel({ cells: cheio, bars: [] }));
    expect(t).toContain("Histórico insuficiente");
    expect(renderToStaticMarkup(painel({ cells: cheio, bars: [] }))).not.toContain("flowevo-col");
  });

  it("going-gray: nenhum número de volume é pintado de alerta/crítico", () => {
    const out = renderToStaticMarkup(painel({ cells: [fc({ in: 9999, out: 1 })] }));
    expect(out).not.toContain("--state-alert");
    expect(out).not.toContain("--state-critical");
  });

  it("a linha aparece pelo NOME humano; o id técnico fica só no title", () => {
    const out = renderToStaticMarkup(painel({ cells: cheio }));
    expect(text(painel({ cells: cheio }))).toContain("Doca");
    expect(out).toContain('title="w1"');
  });
});
