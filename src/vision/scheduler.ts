// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER GLOBAL DE INFERÊNCIA (singleton)  ·  CONTRATO p/ a Frente A2 (Dashboard)
// ─────────────────────────────────────────────────────────────────────────────
//
// PROBLEMA QUE RESOLVE
//   Antes, cada CameraWorkspace tinha sua própria guarda anti-sobreposição
//   (`detectingRef`) e disparava inferências direto no worker. Com N câmeras isso
//   produzia N filas paralelas sem prioridade: a câmera ABERTA (em foco) competia em
//   pé de igualdade com as tiles do mosaico. Aqui há UMA fila única, com prioridade,
//   que serializa a inferência (a GPU/worker é compartilhada de qualquer forma) e
//   sempre atende primeiro a câmera de foco.
//
// API (consumida pela Frente A2 / Dashboard)
//
//   requestInference<T>(source, opts?) => Promise<T | undefined>
//     • source: { key, run }
//         - key: identificador ESTÁVEL da origem (ex.: `${cameraId}:atividade`).
//           COALESCÊNCIA por key: se já houver uma tarefa PENDENTE para a mesma key,
//           a anterior é DESCARTADA (resolve com `undefined`) e substituída pela nova.
//           Isso evita backlog de frames velhos — processa-se sempre o mais recente.
//           A tarefa EM EXECUÇÃO nunca é cancelada.
//         - run: () => Promise<T> — a inferência em si (ex.: () => detectFrame(...)).
//       opts.priority: "high" | "normal" | "low"  (default "normal").
//         "high"  = câmera aberta/em foco;  "low" = tiles do mosaico.
//       RETORNO: Promise<T | undefined>. `undefined` => a tarefa foi preterida por
//       coalescência (chegou um pedido mais novo p/ a mesma key). O consumidor deve
//       ignorar resultados `undefined` (não sobrescrever o último estado válido).
//
//   setInferencePriority(key, priority): muda a prioridade de uma key já enfileirada
//       (ex.: ao ABRIR uma câmera, A2 pode elevar sua key p/ "high").
//
//   schedulerStats(): { running, queued } — telemetria/diagnóstico (profundidade da fila).
//
//   configureScheduler({ maxConcurrent }): ajusta a concorrência (default 1).
//
// GARANTIAS
//   • No máximo `maxConcurrent` (default 1) inferências rodando ao mesmo tempo.
//   • Seleção por prioridade; empate resolvido por ordem de chegada (FIFO).
//   • Falhas do `run` propagam via reject da Promise retornada (não derrubam a fila).
// ─────────────────────────────────────────────────────────────────────────────

export type InferencePriority = "high" | "normal" | "low";
export type InferenceSource<T> = { key: string; run: () => Promise<T> };

const PRIO_RANK: Record<InferencePriority, number> = { high: 0, normal: 1, low: 2 };

type QueueItem = {
  key: string;
  priority: InferencePriority;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  seq: number;
};

class InferenceScheduler {
  private queue: QueueItem[] = [];
  private running = 0;
  private maxConcurrent = 1;
  private seq = 0;

  request<T>(
    source: InferenceSource<T>,
    opts?: { priority?: InferencePriority },
  ): Promise<T | undefined> {
    const priority = opts?.priority ?? "normal";
    return new Promise<T | undefined>((resolve, reject) => {
      // coalescência: descarta a tarefa pendente anterior da mesma origem (frame velho)
      const idx = this.queue.findIndex((q) => q.key === source.key);
      if (idx >= 0) {
        const old = this.queue.splice(idx, 1)[0];
        old.resolve(undefined);
      }
      this.queue.push({
        key: source.key,
        priority,
        run: source.run as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        seq: ++this.seq,
      });
      this.pump();
    });
  }

  setPriority(key: string, priority: InferencePriority): void {
    const item = this.queue.find((q) => q.key === key);
    if (item) item.priority = priority;
  }

  stats(): { running: number; queued: number } {
    return { running: this.running, queued: this.queue.length };
  }

  configure(opts: { maxConcurrent?: number }): void {
    if (opts.maxConcurrent && opts.maxConcurrent > 0) {
      this.maxConcurrent = Math.floor(opts.maxConcurrent);
      this.pump();
    }
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      // escolhe a maior prioridade; desempata por ordem de chegada (FIFO)
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        const a = this.queue[i],
          b = this.queue[best];
        if (
          PRIO_RANK[a.priority] < PRIO_RANK[b.priority] ||
          (a.priority === b.priority && a.seq < b.seq)
        )
          best = i;
      }
      const item = this.queue.splice(best, 1)[0];
      this.running++;
      void Promise.resolve()
        .then(item.run)
        .then(
          (v) => item.resolve(v),
          (e) => item.reject(e),
        )
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }
}

const scheduler = new InferenceScheduler();

export function requestInference<T>(
  source: InferenceSource<T>,
  opts?: { priority?: InferencePriority },
): Promise<T | undefined> {
  return scheduler.request(source, opts);
}
export function setInferencePriority(key: string, priority: InferencePriority): void {
  scheduler.setPriority(key, priority);
}
export function schedulerStats(): { running: number; queued: number } {
  return scheduler.stats();
}
export function configureScheduler(opts: { maxConcurrent?: number }): void {
  scheduler.configure(opts);
}
