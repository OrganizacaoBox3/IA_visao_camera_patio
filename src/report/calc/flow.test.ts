// Agregações puras do fluxo de pessoas (movidas de store.ts para calc/flow.ts —
// store fica só com I/O). Cenários preservados 1:1.
import { describe, it, expect } from "vitest";
import {
  flowKpis,
  flowByHour,
  flowWindow,
  flowPrevWindow,
  flowEvolution,
  flowOfLine,
  flowLineOptions,
  flowLabelResolver,
  flowLineKey,
  type FlowCell,
  type FlowDataset,
} from "./flow";

const fc = (over: Partial<FlowCell>): FlowCell => ({
  cameraId: "cam-1",
  cameraLabel: "Cam 1",
  tripwireId: "w1",
  dayIndex: 0,
  hour: 8,
  in: 0,
  out: 0,
  ...over,
});

describe("flowKpis — totais de entrada/saída e nº de linhas distintas", () => {
  it("soma in/out e conta linhas únicas por (câmera|tripwire)", () => {
    const cells = [
      fc({ cameraId: "cam-1", tripwireId: "w1", in: 3, out: 1 }),
      fc({ cameraId: "cam-1", tripwireId: "w1", in: 2, out: 0 }), // mesma linha (hora diferente)
      fc({ cameraId: "cam-1", tripwireId: "w2", in: 1, out: 4 }), // outra linha da mesma câmera
      fc({ cameraId: "cam-2", tripwireId: "w1", in: 5, out: 5 }), // w1 de OUTRA câmera = linha distinta
    ];
    // saldo/total/peakHour entraram quando o fluxo virou relatório próprio (contrato ADITIVO:
    // in/out/lines seguem idênticos — o `fc` usa hour 8 por default, daí o pico às 8h).
    expect(flowKpis(cells)).toEqual({
      in: 11,
      out: 10,
      saldo: 1,
      total: 21,
      lines: 3,
      peakHour: 8,
    });
  });

  it("saldo negativo é saída em excesso — o número é DIAGNÓSTICO, não meta", () => {
    const k = flowKpis([fc({ in: 2, out: 9 })]);
    expect(k.saldo).toBe(-7);
    expect(k.total).toBe(11);
  });

  it("pico é a hora de mais TRAVESSIA (in+out), não a de mais entrada", () => {
    const k = flowKpis([
      fc({ hour: 7, in: 10, out: 0 }), // 10 travessias
      fc({ hour: 19, in: 1, out: 20 }), // 21 travessias ← o pico
    ]);
    expect(k.peakHour).toBe(19);
  });

  it("recorte vazio → zeros e pico NULO (não existe pico de nada)", () => {
    expect(flowKpis([])).toEqual({
      in: 0,
      out: 0,
      saldo: 0,
      total: 0,
      lines: 0,
      peakHour: null,
    });
  });
});

describe("flowByHour — série 0..23 com máximo p/ escala", () => {
  it("agrega in/out por hora do dia e devolve o pico entre in e out", () => {
    const cells = [
      fc({ hour: 8, in: 4, out: 1 }),
      fc({ hour: 8, in: 2, out: 3 }), // hora 8: in=6, out=4
      fc({ hour: 20, in: 1, out: 7 }), // hora 20: in=1, out=7
    ];
    const r = flowByHour(cells);
    expect(r.hours).toHaveLength(24);
    expect(r.hours[8]).toEqual({ in: 6, out: 4 });
    expect(r.hours[20]).toEqual({ in: 1, out: 7 });
    expect(r.hours[0]).toEqual({ in: 0, out: 0 }); // horas sem dado ficam zeradas
    expect(r.max).toBe(7); // maior in OU out entre todas as horas
  });

  it("sem células → max é 1 (evita divisão por zero na escala das barras)", () => {
    expect(flowByHour([]).max).toBe(1);
  });
});

describe("flowWindow — recorte período/turno (mesma janela de windows())", () => {
  it("período 'hoje' recorta o último dia; turno filtra pela hora", () => {
    const ds: FlowDataset = {
      days: 3,
      startMs: 0,
      cells: [
        fc({ dayIndex: 0, hour: 8, in: 1 }), // fora da janela (hoje = dia 2)
        fc({ dayIndex: 2, hour: 8, in: 2 }), // dentro, Manhã
        fc({ dayIndex: 2, hour: 15, in: 3 }), // dentro, Tarde
      ],
    };
    expect(flowWindow(ds, "hoje", "Todos").map((c) => c.in)).toEqual([2, 3]);
    expect(flowWindow(ds, "hoje", "Manhã").map((c) => c.in)).toEqual([2]);
  });
});


// ── O que o fluxo ganhou ao virar RELATÓRIO próprio ─────────────────────────────────────────
// Antes ele era a 4ª aba de Atividade — um modo cujo filtro (ÁREA) nem se aplica a cruzamento.
// Faltavam três coisas que todo outro modo já tinha: comparação com o período anterior,
// tendência diária e recorte próprio. Estes testes travam as três.

const ds = (cells: FlowCell[], days: number): FlowDataset => ({ cells, days, startMs: 0 });

describe("flowPrevWindow — a comparação que faltava", () => {
  it("pega a janela ANTERIOR de mesmo tamanho (7d: dias 7..13 atual, 0..6 anterior)", () => {
    const cells = Array.from({ length: 14 }, (_, d) => fc({ dayIndex: d, in: d, out: 0 }));
    const atual = flowWindow(ds(cells, 14), "7d", "Todos");
    const anterior = flowPrevWindow(ds(cells, 14), "7d", "Todos");
    expect(atual.map((c) => c.dayIndex)).toEqual([7, 8, 9, 10, 11, 12, 13]);
    expect(anterior.map((c) => c.dayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("histórico curto demais → janela anterior VAZIA (não inventa comparação)", () => {
    const cells = [fc({ dayIndex: 0, in: 5 })];
    expect(flowPrevWindow(ds(cells, 1), "7d", "Todos")).toEqual([]);
  });
});

describe("flowEvolution — a tendência diária", () => {
  it("uma barra por dia, com entradas e saídas separadas e rótulo dd/mm", () => {
    const cells = [
      fc({ dayIndex: 0, in: 3, out: 1 }),
      fc({ dayIndex: 0, in: 2, out: 0 }), // mesmo dia soma
      fc({ dayIndex: 2, in: 0, out: 7 }),
    ];
    const r = flowEvolution(ds(cells, 3), "Todos");
    expect(r.bars).toHaveLength(3);
    expect(r.bars[0]).toMatchObject({ dayIndex: 0, in: 5, out: 1 });
    expect(r.bars[1]).toMatchObject({ dayIndex: 1, in: 0, out: 0 }); // dia sem dado NÃO some
    expect(r.bars[2]).toMatchObject({ dayIndex: 2, in: 0, out: 7 });
    expect(r.bars[0].label).toMatch(/^\d{2}\/\d{2}$/);
    expect(r.max).toBe(7); // escala comum aos dois sentidos
  });

  it("respeita o recorte por LINHA (a tendência é da linha escolhida, não da frota)", () => {
    const cells = [
      fc({ dayIndex: 0, cameraId: "cam-1", tripwireId: "w1", in: 5 }),
      fc({ dayIndex: 0, cameraId: "cam-2", tripwireId: "w1", in: 99 }),
    ];
    const r = flowEvolution(ds(cells, 1), "Todos", flowLineKey("cam-1", "w1"));
    expect(r.bars[0].in).toBe(5);
  });

  it("lastN limita a janela sem quebrar histórico curto", () => {
    const cells = Array.from({ length: 30 }, (_, d) => fc({ dayIndex: d, in: 1 }));
    expect(flowEvolution(ds(cells, 30), "Todos", "Todas", 7).bars).toHaveLength(7);
    expect(flowEvolution(ds(cells.slice(0, 3), 3), "Todos", "Todas", 14).bars).toHaveLength(3);
  });
});

describe("flowOfLine / flowLineOptions — o recorte PRÓPRIO do fluxo", () => {
  const cells = [
    fc({ cameraId: "cam-1", cameraLabel: "Doca", tripwireId: "w1", in: 1 }),
    fc({ cameraId: "cam-1", cameraLabel: "Doca", tripwireId: "w2", in: 2 }),
    fc({ cameraId: "cam-2", cameraLabel: "Portaria", tripwireId: "w1", in: 3 }),
  ];

  it('"Todas" não filtra nada', () => {
    expect(flowOfLine(cells, "Todas")).toHaveLength(3);
  });

  it("filtra pela chave câmera×linha (w1 de câmeras diferentes NÃO se misturam)", () => {
    const so = flowOfLine(cells, flowLineKey("cam-2", "w1"));
    expect(so).toHaveLength(1);
    expect(so[0].in).toBe(3);
  });

  it("rotula com o nome da câmera; com 2+ linhas na mesma câmera, sufixa 'linha N'", () => {
    const ops = flowLineOptions(cells);
    expect(ops.map((o) => o.label)).toEqual(["Doca · linha 1", "Doca · linha 2", "Portaria"]);
  });

  it("câmera sem rótulo cai no id (nunca fica opção sem nome)", () => {
    const ops = flowLineOptions([fc({ cameraId: "cam-x", cameraLabel: "", tripwireId: "w1" })]);
    expect(ops[0].label).toBe("cam-x");
  });
});

describe("flowLabelResolver — o mesmo nome na tela, no PDF e no CSV", () => {
  const cells = [
    fc({ cameraId: "cam-1", cameraLabel: "Doca", tripwireId: "w1" }),
    fc({ cameraId: "cam-1", cameraLabel: "Doca", tripwireId: "w2" }),
  ];

  it("resolve a chave no rótulo humano", () => {
    const labelOf = flowLabelResolver(flowLineOptions(cells));
    expect(labelOf(flowLineKey("cam-1", "w2"))).toBe("Doca · linha 2");
  });

  it("linha que sumiu do dataset devolve a chave — o relatório não perde a fileira", () => {
    // Câmera removida do cadastro depois do período: a travessia MEDIDA continua no histórico.
    // Devolver "" (ou pular a linha) apagaria dado real do relatório; a chave ao menos identifica.
    const labelOf = flowLabelResolver(flowLineOptions(cells));
    expect(labelOf("cam-morta|w9")).toBe("cam-morta|w9");
  });
});
