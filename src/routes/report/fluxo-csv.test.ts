// Gate da seção de FLUXO (linhas de contagem) no CSV/PDF exportado.
//
// POR QUE ESTE TESTE EXISTE: o CSV sai da empresa e é aberto sem quem o gerou por perto. Três
// coisas que o artefato NUNCA pode perder, e que o fluxo perdia enquanto era duas tabelas soltas
// dentro do CSV de Atividade:
//   1. o SALDO precisa viajar ROTULADO como conferência de instalação — sozinho, "saldo +180" é
//      lido como "180 pessoas ainda dentro", que é falso num ponto de passagem;
//   2. "não medido" nunca vira 0/0% — sem período anterior no histórico não há variação, e um
//      "0%" ali se lê como "estável", que é uma afirmação que ninguém mediu;
//   3. a linha aparece pelo NOME humano, o mesmo da tela — a chave `cameraId|tripwireId` não é
//      para olho humano, e nome divergente entre tela e planilha destrói a conferência.
import { describe, expect, it } from "vitest";
import { fluxoSections } from "./csv";
import { flowKpis, flowLineKey, type FlowCell, type FlowKpis } from "../../report/calc";

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

const texto = (s: ReturnType<typeof fluxoSections>) =>
  s.map((sec) => [sec.title, ...sec.rows.map((r) => r.join(" | "))].join("\n")).join("\n");

const VAZIO: FlowKpis = flowKpis([]);
const labelOf = (k: string) => (k === flowLineKey("cam-1", "w1") ? "Doca" : k);

const secoes = (over: Partial<Parameters<typeof fluxoSections>[0]> = {}) =>
  fluxoSections({
    k: flowKpis([fc({ hour: 14, in: 120, out: 100 })]),
    kPrev: flowKpis([fc({ in: 100, out: 100 })]),
    lineRows: [{ cameraId: "cam-1", cameraLabel: "Doca", tripwireId: "w1", in: 120, out: 100 }],
    evoBars: [{ label: "01/09", in: 120, out: 100 }],
    labelOf,
    ...over,
  });

describe("fluxoSections — o que viaja no artefato exportado", () => {
  it("leva entradas, saídas, total, pico e a comparação com o período anterior", () => {
    const t = texto(secoes());
    expect(t).toContain("Entradas | 120");
    expect(t).toContain("Saídas | 100");
    expect(t).toContain("Travessias (entradas + saídas) | 220");
    expect(t).toContain("14h"); // hora de pico
    expect(t).toContain("Travessias no período anterior | 200");
    expect(t).toContain("Variação vs. período anterior (%) | 10");
  });

  it("o SALDO viaja ROTULADO como conferência de linha, não como meta", () => {
    const t = texto(secoes());
    expect(t).toContain("Saldo (entradas − saídas) | 20");
    expect(t).toMatch(/Observação sobre o saldo \|.*não meta/);
    expect(t).toMatch(/mal posicionada|travessia perdida/);
  });

  it("sem período anterior no histórico: 'não medido', nunca 0% (que se leria 'estável')", () => {
    const t = texto(secoes({ kPrev: VAZIO }));
    expect(t).toContain("Variação vs. período anterior (%) | não medido");
    expect(t).not.toMatch(/Variação vs\. período anterior \(%\) \| 0$/m);
  });

  it("sem travessia nenhuma: hora de pico é 'não medido', não 00h", () => {
    const t = texto(secoes({ k: VAZIO, lineRows: [], evoBars: [] }));
    expect(t).toContain("Hora de pico | não medido");
    expect(t).not.toContain("00h");
  });

  it("cada linha sai pelo NOME humano (o mesmo da tela) COM a chave técnica ao lado", () => {
    const t = texto(secoes());
    expect(t).toContain("Doca | Doca | w1 | 120 | 100 | 220"); // rótulo, câmera, id, in, out, total
  });

  it("a tendência diária viaja junto — o total sozinho não diz se subiu ou caiu", () => {
    const t = texto(secoes({ evoBars: [{ label: "01/09", in: 5, out: 4 }] }));
    expect(t).toContain("TENDÊNCIA DIÁRIA");
    expect(t).toContain("01/09 | 5 | 4");
  });
});
