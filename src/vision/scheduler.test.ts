// Testes do SCHEDULER GLOBAL de inferência (scheduler.ts) — a fila única com prioridade que
// serializa a inferência entre N câmeras. Cobre o contrato do cabeçalho: coalescência por key
// (resolve o pendente anterior com `undefined`), prioridade "high" furando a fila, desempate FIFO,
// elevação de key + sub-tarefas derivadas, telemetria (schedulerStats) e concorrência configurável.
//
// O scheduler é um SINGLETON de módulo — cada teste DRENA sua fila (await de todas as promises) e
// restaura `maxConcurrent` p/ 1, deixando o estado limpo (queue vazia, running 0) p/ o próximo.
import { describe, it, expect, afterEach } from "vitest";
import {
  requestInference,
  setInferencePriority,
  schedulerStats,
  configureScheduler,
} from "./scheduler";

// Deixa a fila de microtasks/timers escoar (o run é agendado via Promise.resolve().then).
const tick = () => new Promise((r) => setTimeout(r, 0));

// Ocupa o ÚNICO slot (maxConcurrent=1) com uma tarefa que só resolve quando liberada — assim os
// pedidos seguintes ficam ENFILEIRADOS (e não começam a rodar), permitindo observar a ordenação.
function gateSlot(key = "gate") {
  let release!: () => void;
  const p = requestInference({
    key,
    run: () => new Promise<string>((res) => (release = () => res(key))),
  });
  return { p, release: () => release() };
}

afterEach(() => {
  configureScheduler({ maxConcurrent: 1 }); // restaura o default entre testes
});

describe("scheduler — prioridade e FIFO", () => {
  it("high fura a fila; empate de prioridade resolve por ordem de chegada (FIFO)", async () => {
    const order: string[] = [];
    const mk = (key: string, priority: "high" | "normal" | "low") =>
      requestInference(
        {
          key,
          run: async () => {
            order.push(key);
            return key;
          },
        },
        { priority },
      );
    const gate = gateSlot();
    const a = mk("a", "low");
    const b = mk("b", "normal");
    const c = mk("c", "high");
    const d = mk("d", "normal"); // mesma prioridade de "b", mas chegou depois → sai depois (FIFO)
    await tick(); // garante que o gate está RODANDO e a,b,c,d ENFILEIRADOS
    gate.release();
    await Promise.all([gate.p, a, b, c, d]);
    expect(order).toEqual(["c", "b", "d", "a"]);
  });
});

describe("scheduler — coalescência por key", () => {
  it("um pedido novo p/ a mesma key DESCARTA o pendente (resolve com undefined)", async () => {
    const gate = gateSlot();
    await tick();
    const first = requestInference({ key: "same", run: async () => "first" });
    const second = requestInference({ key: "same", run: async () => "second" });
    gate.release();
    const [f, s] = await Promise.all([first, second]);
    expect(f).toBeUndefined(); // preterido pela coalescência
    expect(s).toBe("second"); // o mais recente é o que roda
    await gate.p;
  });

  it("a tarefa EM EXECUÇÃO nunca é cancelada pela coalescência", async () => {
    let finish!: (v: string) => void;
    const running = requestInference({
      key: "k",
      run: () => new Promise<string>((res) => (finish = res)),
    });
    await tick(); // "k" está rodando (ocupa o slot)
    const queued = requestInference({ key: "k", run: async () => "novo" });
    finish("concluida"); // a que roda termina normalmente
    expect(await running).toBe("concluida"); // NÃO virou undefined
    expect(await queued).toBe("novo"); // a enfileirada roda em seguida
  });
});

describe("scheduler — setInferencePriority", () => {
  it("eleva a key exata E as sub-tarefas derivadas <key>:… (herança da elevação)", async () => {
    const order: string[] = [];
    const mk = (key: string, priority: "high" | "normal" | "low") =>
      requestInference(
        {
          key,
          run: async () => {
            order.push(key);
            return key;
          },
        },
        { priority },
      );
    const gate = gateSlot();
    const filler = mk("filler", "normal");
    const cam = mk("cam1", "low"); // câmera de tile (baixa)
    const tile = mk("cam1:t0", "low"); // sub-tarefa derivada do mesmo frame
    await tick();
    setInferencePriority("cam1", "high"); // abrir a câmera eleva ela E seus tiles
    gate.release();
    await Promise.all([gate.p, filler, cam, tile]);
    // cam1 e cam1:t0 elevados a high correm antes do filler (normal); entre eles, FIFO.
    expect(order).toEqual(["cam1", "cam1:t0", "filler"]);
  });
});

describe("scheduler — telemetria e concorrência", () => {
  it("schedulerStats reporta running e queued; zera ao drenar", async () => {
    const gate = gateSlot("s1");
    const q = requestInference({ key: "s2", run: async () => undefined });
    await tick();
    expect(schedulerStats()).toEqual({ running: 1, queued: 1 });
    gate.release();
    await Promise.all([gate.p, q]);
    expect(schedulerStats()).toEqual({ running: 0, queued: 0 });
  });

  it("configureScheduler({maxConcurrent}) roda N tarefas em paralelo", async () => {
    configureScheduler({ maxConcurrent: 2 });
    const resolvers: Array<() => void> = [];
    const run = () => new Promise<void>((res) => resolvers.push(res));
    const ps = [
      requestInference({ key: "x1", run }),
      requestInference({ key: "x2", run }),
      requestInference({ key: "x3", run }),
    ];
    await tick();
    expect(schedulerStats().running).toBe(2); // 2 rodando; a 3ª aguarda o slot
    expect(schedulerStats().queued).toBe(1);
    // drena: resolve o lote atual, deixa o pump promover o próximo, repete até esvaziar.
    for (let i = 0; i < 4 && resolvers.length; i++) {
      resolvers.splice(0).forEach((r) => r());
      await tick();
    }
    await Promise.all(ps);
    expect(schedulerStats()).toEqual({ running: 0, queued: 0 });
  });
});
