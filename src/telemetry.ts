// Telemetria de loop — FPS e latência média de processamento (buffer rolante).
// Portado do padrão do sensor_fadiga_mvp para uso compartilhado entre os modos.
export class FrameMeter {
  private frames = 0;
  private lastAt = 0;
  private _fps = 0;
  private lat: number[] = [];
  private _avg = 0;
  private readonly window: number;

  constructor(rollingSamples = 24) {
    this.window = rollingSamples;
  }

  /** Chame 1×/frame no loop (now = performance.now()). Atualiza o FPS a cada ~1s. */
  tick(now: number): void {
    this.frames++;
    if (this.lastAt === 0) {
      this.lastAt = now;
      return;
    }
    if (now - this.lastAt >= 1000) {
      this._fps = (this.frames * 1000) / (now - this.lastAt);
      this.frames = 0;
      this.lastAt = now;
    }
  }

  /** Empilhe a latência (ms) de uma inferência/decodificação. */
  pushProc(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.lat.push(ms);
    if (this.lat.length > this.window) this.lat.shift();
    this._avg = this.lat.reduce((a, b) => a + b, 0) / this.lat.length;
  }

  get fps(): number {
    return this._fps;
  }
  get avgProcMs(): number {
    return this._avg;
  }
}
