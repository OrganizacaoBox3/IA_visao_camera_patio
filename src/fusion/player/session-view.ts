// Bancada de simulação (docs/cientifica/simulador.md) — Fase 1.5/§6: lógica PURA que o player
// precisa para abrir GRAVAÇÃO REAL (session-loader.ts) — nada aqui simula, associa ou desenha.
//
// Três responsabilidades pequenas e testáveis (sem DOM, sem canvas, sem React — mesma disciplina
// de derive-player-frame.ts/playback-transport.ts neste diretório):
//   • collectTrackIds — os trackIds VISTOS na gravação (a lista que o modo anotação apresenta);
//   • sessionWorldDomain — o domínio-mundo da planta. O sintético é sempre o chão 8×6 m de sim.ts
//     (SYNTH_WORLD_DOMAIN); gravação real não tem esse contrato, então o domínio é o bounding box
//     das posições-mundo projetadas dos primeiros N ticks (REUSANDO derivePlayerFrame — mesmo pé/
//     mesma projeção que a planta desenha, sem duplicar geometria), com folga e vão mínimo para
//     não degenerar. Sem H (ou nada projetável), cai no 8×6 — a planta fica vazia mas estável.
//   • parseSessionTruthJson — leitura defensiva do .json exportado pelo modo anotação (fronteira
//     de import: arquivo vem do disco do anotador, valida antes de virar estado).
import type { SimTick } from "../sim";
import type { SessionTruth } from "../session-loader";
import type { Matrix3, Vec2 } from "../../vision/homography";
import { pixelToWorld } from "../../vision/homography";
import { derivePlayerFrame } from "./derive-player-frame";

/** Retângulo-mundo (metros) que a planta top-down enquadra. */
export type WorldDomain = { minX: number; minY: number; maxX: number; maxY: number };

/** Domínio do simulador (FLOOR_PAIRS de sim.ts: chão 8×6 m) — e o fallback da gravação real. */
export const SYNTH_WORLD_DOMAIN: WorldDomain = { minX: 0, minY: 0, maxX: 8, maxY: 6 };

/** Primeiros N ticks amostrados no bounding box (500 ms/tick → ~16 min de gravação; barato e
 *  suficiente pro roteiro de campo de minutos — declarado, não escondido: quem andar além do
 *  enquadramento inicial numa sessão de horas desenha fora da borda, sem quebrar nada). */
const DEFAULT_SAMPLE_TICKS = 2000;
/** Folga (m) em volta do bounding box — pontos na borda não colam no limite do canvas. */
const DEFAULT_PAD_M = 0.5;
/** Vão mínimo (m) por eixo — pessoa parada/ponto único não degenera a escala em divisão por ~0. */
const DEFAULT_MIN_SPAN_M = 2;

/** trackIds vistos em QUALQUER tick da gravação, únicos e em ordem crescente — a lista que o
 *  modo anotação apresenta (anotar por track, não por aparição). */
export function collectTrackIds(ticks: readonly SimTick[]): number[] {
  const seen = new Set<number>();
  for (const tick of ticks) for (const t of tick.tracks) seen.add(t.id);
  return [...seen].sort((a, b) => a - b);
}

/**
 * Domínio-mundo da planta para uma gravação REAL: bounding box das posições-mundo projetadas
 * (pés dos tracks via derivePlayerFrame — o MESMO ponto que a planta desenha) dos primeiros
 * `sampleTicks` ticks, mais a estação BLE, com folga `padM` e vão mínimo `minSpanM` por eixo
 * (expandido em torno do centro). Fallback SYNTH_WORLD_DOMAIN quando não há H ou nada projeta.
 */
export function sessionWorldDomain(
  ticks: readonly SimTick[],
  H: Matrix3 | null,
  stationPx: Vec2,
  opts?: { sampleTicks?: number; padM?: number; minSpanM?: number },
): WorldDomain {
  if (!H) return SYNTH_WORLD_DOMAIN;
  const sampleTicks = opts?.sampleTicks ?? DEFAULT_SAMPLE_TICKS;
  const padM = opts?.padM ?? DEFAULT_PAD_M;
  const minSpanM = opts?.minSpanM ?? DEFAULT_MIN_SPAN_M;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (p: Vec2 | null): void => {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };

  add(pixelToWorld(H, stationPx)); // a estação também mora na planta (mesma projeção do frame)
  const n = Math.min(ticks.length, sampleTicks);
  for (let i = 0; i < n; i++) {
    const frame = derivePlayerFrame(ticks[i], H, stationPx);
    for (const t of frame.planta) add(t.worldPos);
  }

  if (!Number.isFinite(minX)) return SYNTH_WORLD_DOMAIN; // H presente mas nada projetou

  minX -= padM;
  minY -= padM;
  maxX += padM;
  maxY += padM;
  // Vão mínimo por eixo, expandido em torno do centro (escala nunca degenera).
  if (maxX - minX < minSpanM) {
    const cx = (minX + maxX) / 2;
    minX = cx - minSpanM / 2;
    maxX = cx + minSpanM / 2;
  }
  if (maxY - minY < minSpanM) {
    const cy = (minY + maxY) / 2;
    minY = cy - minSpanM / 2;
    maxY = cy + minSpanM / 2;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Parse defensivo do .json de SessionTruth (o export do modo anotação, reimportado noutra
 * sentada). `null` = arquivo inválido (não-JSON ou raiz não-objeto). Entradas individuais
 * inválidas (chave não-numérica, valor que não é string não-vazia nem null) são DESCARTADAS
 * em silêncio — mesmo espírito do session-loader: devolve o que deu pra ler, nunca lança.
 */
export function parseSessionTruthJson(text: string): SessionTruth | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const truth: SessionTruth = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    if (value === null) truth[id] = null;
    else if (typeof value === "string" && value.trim().length > 0) truth[id] = value;
  }
  return truth;
}
