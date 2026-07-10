// Bancada de simulação (docs/cientifica/simulador.md) — Fase 0, Trilha P: transporte de reprodução
// (play/pause/scrub/velocidade/passo), PURO — nenhum timer real, nenhum DOM. O chamador (o
// componente do player, com rAF) informa `dtMs` real decorrido a cada quadro via `advance()`; este
// módulo só decide QUAL tick deveria estar visível agora. Determinístico dado (state, dtMs, tickMs,
// totalTicks) — testável sem esperar tempo de verdade (mesma disciplina do resto do domínio: zero
// Math.random/Date.now em lógica que precisa ser reproduzível).
//
// Responsabilidade única: o estado de reprodução. Não sabe de canvas, tracks, nem do que está sendo
// desenhado — só "em qual tick da gravação estamos".

export type PlaybackState = {
  playing: boolean;
  /** Multiplicador de velocidade (0.25×–8×, ver escopo §5). */
  speed: number;
  /** Índice do tick corrente na gravação (0-based). */
  currentIdx: number;
  /** Tempo real "sobrando" entre avanços de tick — permite velocidades fracionárias (0.25×) sem
   *  perder precisão acumulando erro de arredondamento a cada quadro. */
  carryMs: number;
};

const MIN_SPEED = 0.25;
const MAX_SPEED = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampIdx(idx: number, totalTicks: number): number {
  if (totalTicks <= 0) return 0;
  return Math.min(totalTicks - 1, Math.max(0, Math.round(idx)));
}

export function initialPlaybackState(): PlaybackState {
  return { playing: false, speed: 1, currentIdx: 0, carryMs: 0 };
}

export function play(s: PlaybackState): PlaybackState {
  return { ...s, playing: true };
}

export function pause(s: PlaybackState): PlaybackState {
  return { ...s, playing: false, carryMs: 0 };
}

export function setSpeed(s: PlaybackState, speed: number): PlaybackState {
  return { ...s, speed: clamp(speed, MIN_SPEED, MAX_SPEED) };
}

/** Pula direto pro tick `idx` (scrubbing manual) — pausa o carry acumulado (não "pula à frente"
 *  depois de arrastar a régua). NÃO pausa a reprodução — arrastar durante o play é um recurso, não
 *  um bug (mesma UX de qualquer player de vídeo). */
export function scrubTo(s: PlaybackState, idx: number, totalTicks: number): PlaybackState {
  return { ...s, currentIdx: clampIdx(idx, totalTicks), carryMs: 0 };
}

/** Passo manual (±1 tick, tecla de setas) — sempre PAUSA (passo é uma ação de debug quadro-a-
 *  quadro, não faz sentido continuar tocando por cima). */
export function stepBy(s: PlaybackState, delta: number, totalTicks: number): PlaybackState {
  return pause({ ...s, currentIdx: clampIdx(s.currentIdx + delta, totalTicks) });
}

/**
 * Avança o relógio REAL em `dtMs` (delta de rAF); se `playing`, avança `currentIdx` em passos de
 * `tickMs` proporcionalmente a `speed`. Para no ÚLTIMO tick sem fazer loop automático (v1 — reiniciar
 * é uma ação explícita do usuário, scrubTo(0, ...), não um comportamento surpresa). No-op se pausado
 * ou sem ticks.
 */
export function advance(
  s: PlaybackState,
  dtMs: number,
  tickMs: number,
  totalTicks: number,
): PlaybackState {
  if (!s.playing || totalTicks <= 0 || tickMs <= 0) return s;
  const budget = s.carryMs + dtMs * s.speed;
  const steps = Math.floor(budget / tickMs);
  if (steps <= 0) return { ...s, carryMs: budget };
  const nextIdx = s.currentIdx + steps;
  if (nextIdx >= totalTicks - 1) return { ...s, playing: false, currentIdx: totalTicks - 1, carryMs: 0 };
  return { ...s, currentIdx: nextIdx, carryMs: budget - steps * tickMs };
}
