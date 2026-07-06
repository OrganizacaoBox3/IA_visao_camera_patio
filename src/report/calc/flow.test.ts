// Agregações puras do fluxo de pessoas (movidas de store.ts para calc/flow.ts —
// store fica só com I/O). Cenários preservados 1:1.
import { describe, it, expect } from "vitest";
import { flowKpis, flowByHour, flowWindow, type FlowCell, type FlowDataset } from "./flow";

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
    expect(flowKpis(cells)).toEqual({ in: 11, out: 10, lines: 3 });
  });

  it("recorte vazio → zeros", () => {
    expect(flowKpis([])).toEqual({ in: 0, out: 0, lines: 0 });
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
