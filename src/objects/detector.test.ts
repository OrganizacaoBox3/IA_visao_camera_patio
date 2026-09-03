// Gate da REGRESSÃO medida em produção (2026-09-03): o worker do OWL-ViT travando NO MEIO de
// uma detecção matava o worker mas nunca resolvia a Promise pendente daquele pedido (o
// `new Promise` em detectObjects só tem `resolve`, sem `reject` acessível de fora) — isso
// deixava detectObjects() PENDURADO pra sempre, e como ObjetosProcessor.detecting só volta a
// `false` no `.finally()` dessa chamada, a câmera parava de detectar pessoa PERMANENTEMENTE
// (até reabrir a câmera/recarregar a página), sem nenhum aviso — "detecta uma vez e nunca
// mais". Este teste prova que um crash do worker DESTRAVA qualquer detecção em voo (resolve
// com [], via flushPending) em vez de pendurar.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../vision/model", () => ({
  loadDetector: () => Promise.reject(new Error("sem coco-ssd no teste — só o caminho OWL-ViT importa aqui")),
}));

type Posted = { type: string; id?: number };

let instances: MockWorker[] = [];

class MockWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  posted: Posted[] = [];
  constructor() {
    instances.push(this);
  }
  postMessage(msg: Posted, _transfer?: Transferable[]) {
    this.posted.push(msg);
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
  crash() {
    this.onerror?.(new Error("boom — simula o worker morrendo no meio de uma detecção"));
  }
}

function fakeCanvasCtx() {
  return {
    drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(1, w) * Math.max(1, h) * 4),
    }),
  };
}
function fakeCanvas() {
  return { width: 0, height: 0, getContext: () => fakeCanvasCtx() };
}

beforeEach(() => {
  instances = [];
  vi.resetModules();
  vi.stubGlobal("Worker", MockWorker);
  vi.stubGlobal("document", { createElement: () => fakeCanvas() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detector — worker travando no meio de uma detecção não trava detectObjects() pra sempre", () => {
  it("worker.onerror resolve com [] qualquer detecção em voo, em vez de pendurar (flushPending)", async () => {
    const { ensureObjectDetector, detectObjects } = await import("./detector");
    await ensureObjectDetector(); // cria o MockWorker (initWorker roda ANTES do 1º await, sync)
    const w = instances[0];
    w.emit({ type: "ready" }); // owlvitReady=true, backend="owlvit"

    const p = detectObjects({} as HTMLCanvasElement, 640, 480, ["pessoa"], 0.25);
    // sem o fix, `p` nunca resolveria (nenhum "result" chega e o worker morreu) — o teste
    // travaria até o timeout do vitest. Com o fix, o crash já destrava.
    w.crash();

    await expect(p).resolves.toEqual([]);
  });

  it("depois do crash, a PRÓXIMA detecção usa o fallback (coco indisponível no teste) sem travar", async () => {
    const { ensureObjectDetector, detectObjects, objectBackend } = await import("./detector");
    await ensureObjectDetector();
    const w = instances[0];
    w.emit({ type: "ready" });
    w.crash(); // marca workerFailed=true, worker=null — nenhuma detecção em voo desta vez

    const res = await detectObjects({} as HTMLCanvasElement, 640, 480, ["pessoa"], 0.25);
    expect(res).toEqual([]); // sem owl-vit (worker morto) e sem coco (mock rejeita) → vazio, não trava
    expect(objectBackend()).toBe("indisponível");
  });
});
