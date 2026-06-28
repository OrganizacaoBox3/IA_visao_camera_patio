// Ring buffer de quadros recentes p/ CONGELAR + CINE-LOOP (revisão de quadros) — Onda B.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ LGPD / PRIVACIDADE (OBRIGATÓRIO)                                          ║
// ║ Este buffer é 100% EM MEMÓRIA e EFÊMERO. Os quadros vivem SOMENTE no heap ║
// ║ do navegador do operador (ImageBitmap GPU-side) durante a sessão.         ║
// ║  • NUNCA é enviado, copiado ou persistido no servidor / disco.            ║
// ║  • É descartado (todos os bitmaps .close()) ao sair da revisão, ao        ║
// ║    desmontar o componente da câmera, ao recarregar a página ou ao         ║
// ║    estourar a janela/limites (FIFO).                                      ║
// ║  • A ÚNICA forma de "salvar" um quadro é um DOWNLOAD LOCAL iniciado        ║
// ║    manualmente pelo operador (ação explícita, ver CameraWorkspace).       ║
// ║    Nada é gravado automaticamente.                                        ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// Quadro guardado no buffer. `bmp` é um ImageBitmap LEVE (downscale) — barato em
// memória/GPU e rápido de desenhar. `ts` é o relógio monotônico (performance.now)
// usado para o tempo relativo do cine; `wallTs` é o relógio de parede (rótulo).
export type CineFrame = {
  bmp: ImageBitmap;
  w: number; // dimensão NATIVA do frame de origem (p/ referência/escala)
  h: number;
  ts: number; // performance.now() da captura
  wallTs: number; // Date.now() da captura (rótulo de relógio)
};

export type CineBufferOpts = {
  maxSeconds?: number; // janela temporal mantida (default 10s)
  maxFrames?: number; // teto absoluto de quadros (proteção de memória)
  maxBytes?: number; // orçamento de memória aproximado (proteção de memória)
  captureWidth?: number; // largura do downscale dos quadros guardados
};

const DEFAULTS = {
  maxSeconds: 10,
  maxFrames: 240,
  maxBytes: 96 * 1024 * 1024, // ~96 MB de teto p/ os bitmaps do cine
  captureWidth: 480,
};

export class CineBuffer {
  private frames: CineFrame[] = [];
  private bytes = 0; // soma aproximada de w*h*4 dos quadros guardados
  private inFlight = false; // 1 captura assíncrona por vez (evita pile-up e mantém ordem)
  private readonly opts: Required<CineBufferOpts>;

  constructor(opts: CineBufferOpts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /**
   * Captura o frame atual no buffer (assíncrono — não bloqueia o loop rAF).
   * Aproveita o frame que JÁ passa pelo loop (não há decode extra); só faz um
   * downscale leve via createImageBitmap. Para não duplicar custo, ignora a
   * captura se já houver uma em voo (descarta o frame — o cine fica com menos
   * quadros, nunca com backlog).
   */
  capture(source: CanvasImageSource, w: number, h: number, ts: number, wallTs: number): void {
    if (this.inFlight || !w || !h) return;
    const cw = Math.max(1, Math.min(this.opts.captureWidth, Math.round(w)));
    const ch = Math.max(1, Math.round((cw * h) / w));
    this.inFlight = true;
    // resizeQuality "low": cópia rápida; o cine é p/ revisão, não p/ arquivo mestre.
    createImageBitmap(source, { resizeWidth: cw, resizeHeight: ch, resizeQuality: "low" })
      .then((bmp) => {
        this.frames.push({ bmp, w, h, ts, wallTs });
        this.bytes += bmp.width * bmp.height * 4;
        this.evict(ts);
      })
      .catch(() => {
        /* frame de origem pode ter sido fechado pelo produtor — descarta silenciosamente */
      })
      .finally(() => {
        this.inFlight = false;
      });
  }

  // Descarte FIFO: respeita janela temporal, teto de quadros e orçamento de bytes.
  // Sempre fecha (.close()) o ImageBitmap removido p/ liberar memória de GPU.
  private evict(now: number): void {
    const cutoff = now - this.opts.maxSeconds * 1000;
    while (
      this.frames.length > 1 &&
      (this.frames[0].ts < cutoff ||
        this.frames.length > this.opts.maxFrames ||
        this.bytes > this.opts.maxBytes)
    ) {
      const old = this.frames.shift()!;
      this.bytes -= old.bmp.width * old.bmp.height * 4;
      old.bmp.close();
    }
  }

  size(): number {
    return this.frames.length;
  }

  /** Bytes aproximados em uso (p/ telemetria/diagnóstico). */
  approxBytes(): number {
    return this.bytes;
  }

  get(i: number): CineFrame | null {
    return this.frames[i] ?? null;
  }

  latest(): CineFrame | null {
    return this.frames.length ? this.frames[this.frames.length - 1] : null;
  }

  /** Tempo relativo (segundos, negativo) do quadro i em relação ao mais recente. */
  relativeSeconds(i: number): number {
    const last = this.latest();
    const f = this.get(i);
    if (!last || !f) return 0;
    return (f.ts - last.ts) / 1000;
  }

  /** Libera TODOS os quadros (fecha bitmaps) e zera o buffer. */
  clear(): void {
    for (const f of this.frames) f.bmp.close();
    this.frames = [];
    this.bytes = 0;
  }

  // dispose() === clear(): chamado no unmount do componente (efêmero por sessão).
  dispose(): void {
    this.clear();
  }
}
