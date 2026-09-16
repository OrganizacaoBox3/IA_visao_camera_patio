// FILTRO POR CÂMERA — o teste que importa é o do que o filtro NÃO alcança.
//
// Recortar atividade e fluxo por câmera é trivial (a célula tem `cameraId`). O risco real é o
// outro: objetos e fadiga gravam o bucket por setor/posto e não sabem de qual câmera vieram.
// Se a tela disser "Doca 1" no cabeçalho e mostrar os objetos do pátio inteiro, o número está
// certo sob um rótulo errado — e ninguém desconfia de um número certo. Por isso `cameraSuportadaEm`
// é fonte única e tem gate: mudar um modo de "nenhum" para "total" exige mudar o INGEST antes.
import { describe, it, expect } from "vitest";
import {
  TODAS_CAMERAS,
  cameraSuportadaEm,
  avisoDeAlcance,
  opcoesDeCamera,
  rotuloDaCamera,
  datasetDaCamera,
  fluxoDaCamera,
  eventosDaCamera,
  type ModoRelatorio,
} from "./camera";
import type { Cell, Dataset } from "./atividade";
import type { FlowCell, FlowDataset } from "./flow";

const cel = (over: Partial<Cell> & { cameraId: string; area: string }): Cell => ({
  dayIndex: 0,
  hour: 8,
  idleMin: 0,
  alerts: 0,
  activePct: 0,
  ...over,
});
const ds = (cells: Cell[]): Dataset => ({
  days: 3,
  areas: [...new Set(cells.map((c) => c.area))].sort(),
  cameraOf: {},
  cells,
  startMs: 1_700_000_000_000,
});

const fc = (over: Partial<FlowCell> & { cameraId: string }): FlowCell => ({
  cameraLabel: "X",
  tripwireId: "w1",
  dayIndex: 0,
  hour: 8,
  in: 1,
  out: 1,
  ...over,
});
const fds = (cells: FlowCell[]): FlowDataset => ({
  days: 3,
  cells,
  startMs: 1_700_000_000_000,
});

describe("cameraSuportadaEm — a verdade sobre o alcance, num lugar só", () => {
  it("atividade, fluxo e alarmes filtram DE VERDADE", () => {
    for (const m of ["atividade", "fluxo", "alarmes"] as ModoRelatorio[])
      expect(cameraSuportadaEm(m)).toBe("total");
  });

  it("objetos e fadiga NÃO filtram — o bucket não guarda a câmera", () => {
    expect(cameraSuportadaEm("objetos")).toBe("nenhum");
    expect(cameraSuportadaEm("fadiga")).toBe("nenhum");
  });

  it("leitura é PARCIAL: leituras são por câmera, caixas são por ponto", () => {
    expect(cameraSuportadaEm("leitura")).toBe("parcial");
  });

  it("GATE: promover um modo exige mudar o INGEST antes, não este switch", () => {
    // Mudou esta lista? Então o bucket daquele modo passou a gravar `cameraId` — confira o
    // produtor em server/pgstore.js ANTES de atualizar aqui. Sem isso, a tela volta a mentir.
    const semCamera = (["resumo", "atividade", "fluxo", "leitura", "objetos", "fadiga", "alarmes"] as ModoRelatorio[])
      .filter((m) => cameraSuportadaEm(m) === "nenhum")
      .sort();
    expect(semCamera).toEqual(["fadiga", "objetos"]);
  });
});

describe("avisoDeAlcance — quem não filtra, DIZ que não filtra", () => {
  it("sem recorte de câmera, nenhum modo precisa se explicar", () => {
    for (const m of ["atividade", "objetos", "fadiga", "leitura"] as ModoRelatorio[])
      expect(avisoDeAlcance(m, TODAS_CAMERAS)).toBeNull();
  });

  it("modo que filtra de verdade não mostra aviso nenhum", () => {
    expect(avisoDeAlcance("atividade", "cam-1")).toBeNull();
    expect(avisoDeAlcance("fluxo", "cam-1")).toBeNull();
  });

  it("objetos/fadiga avisam que os números são de TODAS as câmeras", () => {
    for (const m of ["objetos", "fadiga"] as ModoRelatorio[]) {
      const aviso = avisoDeAlcance(m, "cam-1");
      expect(aviso).toMatch(/TODAS as câmeras/);
      expect(aviso).toMatch(/não se aplica/);
    }
  });

  it("leitura explica a diferença entre leitura (câmera) e caixa (ponto)", () => {
    const aviso = avisoDeAlcance("leitura", "cam-1");
    expect(aviso).toMatch(/PONTO/);
    expect(aviso).toMatch(/não estão recortados por câmera/);
  });
});

describe("datasetDaCamera — recorte da atividade", () => {
  const base = ds([
    cel({ cameraId: "cam-1", area: "Doca" }),
    cel({ cameraId: "cam-1", area: "Expedição" }),
    cel({ cameraId: "cam-2", area: "Portaria" }),
  ]);

  it('"Todas" devolve o MESMO objeto (sem cópia, sem custo)', () => {
    expect(datasetDaCamera(base, TODAS_CAMERAS)).toBe(base);
  });

  it("recorta as células da câmera pedida", () => {
    const r = datasetDaCamera(base, "cam-1");
    expect(r.cells).toHaveLength(2);
    expect(r.cells.every((c) => c.cameraId === "cam-1")).toBe(true);
  });

  it("REFAZ a lista de áreas — senão o seletor ofereceria área de outra câmera", () => {
    // "Portaria" é da cam-2: deixá-la no seletor renderia uma tela vazia sem explicação.
    expect(base.areas).toEqual(["Doca", "Expedição", "Portaria"]);
    expect(datasetDaCamera(base, "cam-1").areas).toEqual(["Doca", "Expedição"]);
  });

  it("câmera sem célula nenhuma devolve recorte VAZIO (o vazio honesto da tela cuida disso)", () => {
    const r = datasetDaCamera(base, "cam-inexistente");
    expect(r.cells).toHaveLength(0);
    expect(r.areas).toEqual([]);
    expect(r.days).toBe(base.days); // a janela não muda: o histórico existe, o recorte é que é vazio
  });

  it("preserva days/startMs — o denominador do período não pode encolher com o filtro", () => {
    const r = datasetDaCamera(base, "cam-1");
    expect(r.days).toBe(base.days);
    expect(r.startMs).toBe(base.startMs);
  });
});

describe("fluxoDaCamera — recorte das linhas de contagem", () => {
  const base = fds([
    fc({ cameraId: "cam-1", tripwireId: "w1" }),
    fc({ cameraId: "cam-1", tripwireId: "w2" }),
    fc({ cameraId: "cam-2", tripwireId: "w1" }),
  ]);

  it("recorta por câmera e mantém a janela", () => {
    const r = fluxoDaCamera(base, "cam-1");
    expect(r.cells).toHaveLength(2);
    expect(r.days).toBe(base.days);
    expect(r.startMs).toBe(base.startMs);
  });

  it('"Todas" não copia nada', () => {
    expect(fluxoDaCamera(base, TODAS_CAMERAS)).toBe(base);
  });
});

describe("eventosDaCamera — alarmes e eventos", () => {
  const evs = [{ cameraId: "cam-1" }, { cameraId: "cam-2" }, {}];

  it("recorta pelos que declaram a câmera", () => {
    expect(eventosDaCamera(evs, "cam-1")).toHaveLength(1);
  });

  it("evento SEM cameraId não entra num recorte de câmera (não se atribui o que não se sabe)", () => {
    expect(eventosDaCamera(evs, "cam-2").every((e) => e.cameraId === "cam-2")).toBe(true);
    expect(eventosDaCamera(evs, "cam-9")).toHaveLength(0);
  });

  it('"Todas" devolve tudo, inclusive o sem câmera', () => {
    expect(eventosDaCamera(evs, TODAS_CAMERAS)).toHaveLength(3);
  });
});

describe("opções e rótulo do seletor", () => {
  const cams = [
    { id: "cam-2", label: "Portaria" },
    { id: "cam-1", label: "Doca 1" },
    { id: "cam-1", label: "Doca 1" }, // repetida
  ];

  it("ordena por rótulo em pt-BR e deduplica", () => {
    expect(opcoesDeCamera(cams).map((c) => c.label)).toEqual(["Doca 1", "Portaria"]);
  });

  it("câmera sem rótulo cai no id (nunca fica opção sem nome)", () => {
    expect(opcoesDeCamera([{ id: "cam-x", label: "" }])[0].label).toBe("cam-x");
  });

  it("rótulo da sentinela e de câmera que saiu do cadastro", () => {
    expect(rotuloDaCamera(TODAS_CAMERAS, cams)).toBe("Todas as câmeras");
    expect(rotuloDaCamera("cam-1", cams)).toBe("Doca 1");
    // Saiu do cadastro, mas o recorte continua valendo sobre o histórico: mostra a chave.
    expect(rotuloDaCamera("cam-morta", cams)).toBe("cam-morta");
  });
});
