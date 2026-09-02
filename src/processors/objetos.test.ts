// Testes do ObjetosProcessor — dois pontos:
// 1) Contenção por SOBREPOSIÇÃO (não mais centro-in-polygon): uma caixa parcialmente dentro do
//    setor conta; uma caixa TOTALMENTE fora não conta mais (era o bug real por trás da contagem
//    "imprecisa" — com o processador chamado por ZONA, o fallback antigo `?? setores[0]` fazia
//    TODA detecção do frame contar em qualquer setor, sem filtro geométrico nenhum).
// 2) Lotação: setor com targetOccupancy dispara alarme só depois de occupancyToleranceMs de
//    desvio sustentado, e só uma vez por episódio de desvio.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjetosProcessor, type ObjetosSetor } from "./objetos";
import type { ObjDetection } from "../objects/detector";

const detectObjects = vi.fn<(...args: unknown[]) => Promise<ObjDetection[]>>();

vi.mock("../objects/detector", () => ({
  detectObjects: (...args: unknown[]) => detectObjects(...args),
  ensureObjectDetector: vi.fn().mockResolvedValue(undefined),
  objectBackend: () => "owlvit",
}));

const frame = { el: {} as HTMLVideoElement, w: 100, h: 100 };

// Popula this.dets: 1ª chamada dispara o detect (assíncrono), a 2ª já lê this.dets atualizado
// (mesmo padrão real: o resultado do detect chega 1 ciclo depois). `mockResolvedValue` (não
// `...Once`) porque chamadas seguintes de `step()` podem disparar um novo detect (throttle por
// tempo) e precisam continuar resolvendo com o mesmo array — sem isso, um 2º detect sem mock
// filho pendente devolveria `undefined` e o `.then()` do processador estouraria.
async function seed(
  proc: ObjetosProcessor,
  setores: ObjetosSetor[],
  classes: string[],
  now: number,
  dets: ObjDetection[],
) {
  detectObjects.mockResolvedValue(dets);
  proc.process(setores, classes, { frame, now });
  await Promise.resolve();
  await Promise.resolve();
  return proc.process(setores, classes, { frame, now });
}

// Avança o tempo sem trocar a detecção (this.dets fica como está — só o relógio muda, é o que
// a histerese de lotação observa). O resultado é o da chamada SÍNCRONA (captura antes do
// await); mas ainda drenamos as microtasks depois — senão, se este step() disparar um novo
// detect (throttle vencido) e não for aguardado, a flag `detecting` fica travada e o PRÓXIMO
// seed()/step() nem chega a chamar detectObjects de novo (foi o bug real deste teste).
async function step(proc: ObjetosProcessor, setores: ObjetosSetor[], classes: string[], now: number) {
  const r = proc.process(setores, classes, { frame, now });
  await Promise.resolve();
  await Promise.resolve();
  return r;
}

beforeEach(() => {
  detectObjects.mockReset();
});

describe("ObjetosProcessor — contenção por sobreposição", () => {
  const setor: ObjetosSetor = { id: "z1", label: "Depósito", x: 0.5, y: 0, w: 0.5, h: 1 };

  it("pessoa PARCIALMENTE dentro do setor (centro fora, corpo cruzando a borda) CONTA", async () => {
    const proc = new ObjetosProcessor();
    // bbox 0.4..0.6 × 0.4..0.6: centro em x=0.5 (na borda do setor, que começa em x=0.5) —
    // metade do corpo (0.5..0.6) está dentro do setor, metade fora.
    const pessoaNaBorda: ObjDetection = { key: "pessoa", score: 0.9, bbox: [0.4, 0.4, 0.2, 0.2] };
    const r = await seed(proc, [setor], ["pessoa"], 1000, [pessoaNaBorda]);
    expect(r.counts.pessoa).toBe(1);
    expect(r.matrix["Depósito"].pessoa).toBe(1);
  });

  it("pessoa TOTALMENTE fora do setor NÃO conta (antes do fix, contava por causa do fallback)", async () => {
    const proc = new ObjetosProcessor();
    const pessoaFora: ObjDetection = { key: "pessoa", score: 0.9, bbox: [0.0, 0.0, 0.2, 0.2] };
    const r = await seed(proc, [setor], ["pessoa"], 1000, [pessoaFora]);
    expect(r.counts.pessoa).toBeUndefined();
    expect(r.matrix["Depósito"].pessoa).toBeUndefined();
  });

  it("pessoa TOTALMENTE dentro do setor conta (comportamento já correto antes, preservado)", async () => {
    const proc = new ObjetosProcessor();
    const pessoaDentro: ObjDetection = { key: "pessoa", score: 0.9, bbox: [0.6, 0.4, 0.1, 0.1] };
    const r = await seed(proc, [setor], ["pessoa"], 1000, [pessoaDentro]);
    expect(r.counts.pessoa).toBe(1);
  });
});

describe("ObjetosProcessor — alarme de lotação (histerese)", () => {
  const setor: ObjetosSetor = {
    id: "z1",
    label: "Sala",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    targetOccupancy: 2,
    occupancyToleranceMs: 1000,
  };
  const umaPessoa: ObjDetection[] = [{ key: "pessoa", score: 0.9, bbox: [0.1, 0.1, 0.1, 0.1] }];
  const duasPessoas: ObjDetection[] = [
    { key: "pessoa", score: 0.9, bbox: [0.1, 0.1, 0.1, 0.1] },
    { key: "pessoa", score: 0.9, bbox: [0.5, 0.5, 0.1, 0.1] },
  ];

  it("não dispara antes de occupancyToleranceMs, dispara depois — uma vez só", async () => {
    const proc = new ObjetosProcessor();
    const r1 = await seed(proc, [setor], ["pessoa"], 1000, umaPessoa); // desvia (1 ≠ 2) agora
    expect(r1.occupancyAlerts).toHaveLength(0);
    // dali em diante, chamadas ÚNICAS (step): a leitura de estado é determinística numa só
    // avaliação por chamada — sem a ambiguidade de qual das duas chamadas do seed() disparou.
    const r2 = await step(proc, [setor], ["pessoa"], 1500); // 500ms de desvio < 1000ms
    expect(r2.occupancyAlerts).toHaveLength(0);
    const r3 = await step(proc, [setor], ["pessoa"], 2200); // 1200ms de desvio ≥ 1000ms
    expect(r3.occupancyAlerts).toEqual([{ setor: "Sala", count: 1, target: 2 }]);
    const r4 = await step(proc, [setor], ["pessoa"], 3000); // ainda desviando: não repete
    expect(r4.occupancyAlerts).toHaveLength(0);
  });

  it("voltar ao alvo reseta o estado — desviar de novo dispara outra vez", async () => {
    const proc = new ObjetosProcessor();
    await seed(proc, [setor], ["pessoa"], 1000, umaPessoa);
    const disparou = await step(proc, [setor], ["pessoa"], 2200);
    expect(disparou.occupancyAlerts).toHaveLength(1);
    // seed() de novo (troca a detecção) só depois de >700ms do último detect de fato disparado
    // (2200) — senão o throttle do processador não deixa a nova detecção substituir this.dets.
    const noAlvo = await seed(proc, [setor], ["pessoa"], 3000, duasPessoas); // 2 == target: reseta
    expect(noAlvo.occupancyAlerts).toHaveLength(0);
    const desviouDeNovo = await seed(proc, [setor], ["pessoa"], 3800, umaPessoa);
    expect(desviouDeNovo.occupancyAlerts).toHaveLength(0); // acabou de desviar, ainda dentro do tolMs
    const disparouDeNovo = await step(proc, [setor], ["pessoa"], 5000); // +1200ms desviando
    expect(disparouDeNovo.occupancyAlerts).toEqual([{ setor: "Sala", count: 1, target: 2 }]);
  });

  it("setor sem targetOccupancy nunca gera alarme de lotação", async () => {
    const proc = new ObjetosProcessor();
    const semAlvo: ObjetosSetor = { id: "z2", label: "Corredor", x: 0, y: 0, w: 1, h: 1 };
    const r = await seed(proc, [semAlvo], ["pessoa"], 5000, umaPessoa);
    expect(r.occupancyAlerts).toHaveLength(0);
  });
});
