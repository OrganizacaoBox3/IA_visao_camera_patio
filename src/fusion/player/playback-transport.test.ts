import { describe, expect, it } from "vitest";
import {
  advance,
  initialPlaybackState,
  pause,
  play,
  scrubTo,
  setSpeed,
  stepBy,
} from "./playback-transport";

const TICK_MS = 500;
const TOTAL = 10;

describe("playback-transport", () => {
  it("estado inicial: pausado, 1×, tick 0", () => {
    const s = initialPlaybackState();
    expect(s).toEqual({ playing: false, speed: 1, currentIdx: 0, carryMs: 0 });
  });

  it("advance() é no-op enquanto pausado", () => {
    const s = advance(initialPlaybackState(), 2000, TICK_MS, TOTAL);
    expect(s.currentIdx).toBe(0);
  });

  it("play() + advance() avança 1 tick por TICK_MS decorrido, em 1×", () => {
    let s = play(initialPlaybackState());
    s = advance(s, TICK_MS, TICK_MS, TOTAL);
    expect(s.currentIdx).toBe(1);
    expect(s.playing).toBe(true);
  });

  it("acumula tempo restante entre quadros (carryMs) sem perder precisão", () => {
    let s = play(initialPlaybackState());
    s = advance(s, 300, TICK_MS, TOTAL); // não completa 1 tick ainda
    expect(s.currentIdx).toBe(0);
    expect(s.carryMs).toBe(300);
    s = advance(s, 300, TICK_MS, TOTAL); // 300+300=600 → 1 tick, sobra 100
    expect(s.currentIdx).toBe(1);
    expect(s.carryMs).toBe(100);
  });

  it("velocidade 2× avança o dobro de ticks pro mesmo dt real", () => {
    let s = setSpeed(play(initialPlaybackState()), 2);
    s = advance(s, TICK_MS, TICK_MS, TOTAL);
    expect(s.currentIdx).toBe(2);
  });

  it("velocidade é clampada em [0.25, 8]", () => {
    expect(setSpeed(initialPlaybackState(), 100).speed).toBe(8);
    expect(setSpeed(initialPlaybackState(), 0).speed).toBe(0.25);
  });

  it("para no último tick sem fazer loop automático", () => {
    let s = play(scrubTo(initialPlaybackState(), TOTAL - 2, TOTAL));
    s = advance(s, TICK_MS * 5, TICK_MS, TOTAL); // dt bem maior que o restante da gravação
    expect(s.currentIdx).toBe(TOTAL - 1);
    expect(s.playing).toBe(false); // parou sozinho — não reinicia
  });

  it("scrubTo pula direto e zera o carry (sem 'pulo à frente' pós-arrasto)", () => {
    let s = play(initialPlaybackState());
    s = advance(s, 300, TICK_MS, TOTAL);
    s = scrubTo(s, 5, TOTAL);
    expect(s.currentIdx).toBe(5);
    expect(s.carryMs).toBe(0);
  });

  it("scrubTo clampa dentro de [0, totalTicks-1]", () => {
    expect(scrubTo(initialPlaybackState(), -5, TOTAL).currentIdx).toBe(0);
    expect(scrubTo(initialPlaybackState(), 999, TOTAL).currentIdx).toBe(TOTAL - 1);
  });

  it("stepBy sempre pausa (passo é ação de debug quadro-a-quadro)", () => {
    const s = stepBy(play(initialPlaybackState()), 1, TOTAL);
    expect(s.playing).toBe(false);
    expect(s.currentIdx).toBe(1);
  });

  it("pause() zera o carry acumulado", () => {
    let s = play(initialPlaybackState());
    s = advance(s, 300, TICK_MS, TOTAL);
    s = pause(s);
    expect(s.carryMs).toBe(0);
    expect(s.playing).toBe(false);
  });
});
