// Comparação entre DIAS ou TURNOS (calc/comparar.ts). Prova: o recorte filtra por dia e turno;
// a ocupação é ponderada por amostras; sem medida o delta é null (nunca 0% inventado); e o
// aviso de duração dispara quando os lados foram medidos em tempos muito diferentes.
import { describe, it, expect } from "vitest";
import {
  metricas,
  comparar,
  avisoDeDuracao,
  noRecorte,
  rotuloDia,
  RECORTE_PADRAO,
} from "./comparar";
import type { Cell, Dataset } from "./atividade";
import type { FlowCell, FlowDataset } from "./flow";

const cell = (over: Partial<Cell>): Cell => ({
  area: "Doca",
  dayIndex: 0,
  hour: 8,
  idleMin: 0,
  alerts: 0,
  activePct: 50,
  samples: 10,
  activeSamples: 5,
  shiftId: "manha",
  ...over,
});
const fcell = (over: Partial<FlowCell>): FlowCell => ({
  cameraId: "c",
  cameraLabel: "C",
  tripwireId: "t",
  dayIndex: 0,
  hour: 8,
  in: 0,
  out: 0,
  shiftId: "manha",
  ...over,
});
const ds = (cells: Cell[]): Dataset => ({
  days: 7,
  areas: ["Doca", "Portaria"],
  cameraOf: {},
  cells,
  startMs: 0,
});
const fds = (cells: FlowCell[]): FlowDataset => ({ days: 7, cells, startMs: 0 });

describe("noRecorte", () => {
  it("dia 'todos' + turno 'Todos' pega tudo", () => {
    expect(noRecorte(cell({ dayIndex: 3, shiftId: "tarde" }), RECORTE_PADRAO)).toBe(true);
  });
  it("filtra por dia e por turno", () => {
    expect(noRecorte(cell({ dayIndex: 2 }), { dia: 2, turno: "manha" })).toBe(true);
    expect(noRecorte(cell({ dayIndex: 1 }), { dia: 2, turno: "manha" })).toBe(false);
    expect(noRecorte(cell({ dayIndex: 2, shiftId: "tarde" }), { dia: 2, turno: "manha" })).toBe(
      false,
    );
  });
});

describe("metricas", () => {
  it("ocupação ponderada por amostras (não média de médias)", () => {
    const m = metricas(
      ds([
        cell({ samples: 90, activeSamples: 90, hour: 8 }),
        cell({ samples: 10, activeSamples: 0, hour: 9 }),
      ]),
      null,
      RECORTE_PADRAO,
    );
    expect(m.ocupacaoPct).toBe(90); // média simples daria 50
    expect(m.horasAnalisadas).toBe(2);
  });

  it("área mais ativa e alertas", () => {
    const m = metricas(
      ds([
        cell({ area: "Doca", activeSamples: 2, alerts: 1 }),
        cell({ area: "Portaria", activeSamples: 9, alerts: 2 }),
      ]),
      null,
      RECORTE_PADRAO,
    );
    expect(m.areaMaisAtiva).toBe("Portaria");
    expect(m.alertas).toBe(3);
  });

  it("fluxo: entradas/saídas, por hora analisada e pico", () => {
    const m = metricas(
      ds([cell({ hour: 8 }), cell({ hour: 9 })]),
      fds([fcell({ hour: 8, in: 10, out: 4 }), fcell({ hour: 9, in: 1, out: 1 })]),
      RECORTE_PADRAO,
    );
    expect(m).toMatchObject({
      entradas: 11,
      saidas: 5,
      travessias: 16,
      travessiasPorHora: 8,
      horaPico: 8,
    });
  });

  it("recorte vazio: ocupação null, por hora null (nada medido, não 0)", () => {
    const m = metricas(ds([]), fds([]), RECORTE_PADRAO);
    expect(m.ocupacaoPct).toBeNull();
    expect(m.travessiasPorHora).toBeNull();
    expect(m.temAtividade).toBe(false);
  });
});

describe("comparar", () => {
  const dados = ds([
    cell({ dayIndex: 0, shiftId: "manha", samples: 10, activeSamples: 4, alerts: 2 }),
    cell({ dayIndex: 1, shiftId: "manha", samples: 10, activeSamples: 6, alerts: 1 }),
  ]);
  const a = metricas(dados, null, { dia: 0, turno: "manha" });
  const b = metricas(dados, null, { dia: 1, turno: "manha" });

  it("delta = (B − A) / A", () => {
    const linhas = comparar(a, b);
    expect(linhas.find((l) => l.chave === "ocupacao")).toMatchObject({
      a: 40,
      b: 60,
      deltaPct: 50,
    });
    expect(linhas.find((l) => l.chave === "alertas")).toMatchObject({
      a: 2,
      b: 1,
      deltaPct: -50,
      subirEhRuim: true,
    });
  });

  it("um lado sem medição → delta null (nunca 0% inventado)", () => {
    const vazio = metricas(dados, null, { dia: 5, turno: "manha" });
    const oc = comparar(a, vazio).find((l) => l.chave === "ocupacao");
    expect(oc?.b).toBeNull();
    expect(oc?.deltaPct).toBeNull();
  });

  it("linhas de fluxo só aparecem se algum lado teve fluxo", () => {
    expect(comparar(a, b).some((l) => l.chave === "travessias")).toBe(false);
  });
});

describe("avisoDeDuracao", () => {
  const m = (h: number) =>
    metricas(ds(Array.from({ length: h }, (_, i) => cell({ hour: i }))), null, RECORTE_PADRAO);
  it("durações parecidas → sem aviso", () => expect(avisoDeDuracao(m(8), m(7))).toBeNull());
  it("durações muito diferentes → aviso apontando o valor por hora", () =>
    expect(avisoDeDuracao(m(8), m(24))).toMatch(/por hora/));
  it("um lado sem hora → sem aviso (o delta já é null)", () =>
    expect(avisoDeDuracao(m(0), m(8))).toBeNull());
});

describe("rotuloDia", () => {
  it("formata 'sem dd/mm'", () => {
    expect(rotuloDia(new Date(2026, 8, 22).getTime(), 0)).toBe("ter 22/09");
    expect(rotuloDia(new Date(2026, 8, 22).getTime(), 7)).toBe("ter 29/09");
  });
});

describe("fluxo sem carimbo de turno × turno CADASTRADO", () => {
  // Buckets de fluxo ainda não carregam o turno (flow.ts §8): filtrar por um turno do cadastro
  // nunca casaria e o fluxo daria ZERO com cara de medição. Tem de ser "—" (não medido).
  const dados = ds([cell({ dayIndex: 0, hour: 8, shiftId: "diurno" })]);
  const fluxo = fds([fcell({ dayIndex: 0, hour: 8, in: 10, out: 5, shiftId: undefined })]);

  it("marca fluxoSemCarimbo e as linhas de fluxo daquele lado viram null", () => {
    const a = metricas(dados, fluxo, { dia: 0, turno: "Todos" });
    const b = metricas(dados, fluxo, { dia: 0, turno: "diurno" });
    expect(b.fluxoSemCarimbo).toBe(true);
    const linhas = comparar(a, b);
    const ent = linhas.find((l) => l.chave === "entradas");
    expect(ent).toMatchObject({ a: 10, b: null, deltaPct: null });
  });

  it("turno LEGADO (derivado da hora) continua funcionando — não é afetado", () => {
    const m = metricas(dados, fluxo, { dia: 0, turno: "Manhã" });
    expect(m.fluxoSemCarimbo).toBe(false);
    expect(m.entradas).toBe(10);
  });

  it("fluxo JÁ carimbado com o turno cadastrado → mede normalmente", () => {
    const carimbado = fds([fcell({ dayIndex: 0, hour: 8, in: 7, out: 1, shiftId: "diurno" })]);
    const m = metricas(dados, carimbado, { dia: 0, turno: "diurno" });
    expect(m.fluxoSemCarimbo).toBe(false);
    expect(m.entradas).toBe(7);
  });
});
