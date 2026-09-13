// ─────────────────────────────────────────────────────────────────────────────
// intervals.js — VOCABULÁRIO DE INTERVALO de tempo das notificações, num lugar só.
//
// POR QUE EXISTE. Havia duas listas de duração no produto, escritas à mão em lugares
// diferentes e com opções diferentes: a do silenciamento (15/30/60/120/480 min, no front) e a
// renotificação de incidente (30 min, fixa, só por env — ou seja, inalcançável para quem usa o
// sistema). Quem opera não pensa "quero 1.800.000 ms": pensa "me lembra de hora em hora". E
// quando a operação quer 45 min, não existia 45 min — a lista fechada obrigava a escolher
// entre esperar demais ou ser lembrado demais.
//
// O QUE ESTE MÓDULO DÁ: presets em pt-BR, parse/validação de um valor PERSONALIZADO em
// minutos, e clamp dentro de limites explicados. É puro (sem relógio, sem I/O) e o front
// espelha a mesma lista (src/types/intervalos.ts) — mesma obrigação dos outros pares.
//
// OS LIMITES, e por que eles são o que são:
//   MIN 1 min  — abaixo disso a "renotificação" vira a inundação que a política existe para
//                evitar; e o tick de saúde do motor roda a cada 30s, então nada abaixo de 1min
//                seria honrado de qualquer forma (prometer 10s e entregar 30s é mentir).
//   MAX 24 h   — acima de um dia, um lembrete deixa de ser lembrete. Incidente que ninguém
//                tratou em 24h é assunto de relatório, não de notificação.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const MIN_MS = 60_000; // 1 min
const MAX_MS = 24 * 3_600_000; // 24 h

/** Presets oferecidos na UI. A lista é de PRODUTO (o que a operação pede), não técnica. */
const PRESETS = Object.freeze([
  { ms: 60_000, label: "1 minuto" },
  { ms: 5 * 60_000, label: "5 minutos" },
  { ms: 10 * 60_000, label: "10 minutos" },
  { ms: 15 * 60_000, label: "15 minutos" },
  { ms: 30 * 60_000, label: "30 minutos" },
  { ms: 60 * 60_000, label: "1 hora" },
  { ms: 2 * 3_600_000, label: "2 horas" },
  { ms: 4 * 3_600_000, label: "4 horas" },
  { ms: 8 * 3_600_000, label: "8 horas (turno)" },
  { ms: 12 * 3_600_000, label: "12 horas" },
  { ms: 24 * 3_600_000, label: "24 horas" },
]);

/** Prende um valor em ms dentro dos limites. `null` quando não dá para ler um número. */
function clampMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_MS, Math.max(MIN_MS, Math.round(n)));
}

/**
 * Lê um intervalo PERSONALIZADO em minutos (o que o usuário digita) e devolve ms.
 * Aceita número ou string ("45", "45 min", "45,5"); devolve `null` no que não é número —
 * campo em branco não vira 0 (0 seria "renotifica sempre", o oposto do que ninguém pediu).
 */
function fromMinutes(v) {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v).trim().replace(",", ".");
  // O SINAL é lido ANTES da limpeza. Sem isto, `/[^\d.]/g` engolia o "-" e "-30" virava 30 min
  // em silêncio — o pior tipo de defeito de formulário: o usuário pediu uma coisa impossível e
  // o sistema aceitou outra sem avisar. (Pego pelo teste desta linha.)
  if (/^-/.test(s)) return null;
  const n = Number(s.replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return clampMs(n * 60_000);
}

/** Texto humano de um intervalo em ms — o mesmo em tela, log e mensagem. */
function humanize(ms) {
  const v = clampMs(ms);
  if (v === null) return "—";
  const preset = PRESETS.find((p) => p.ms === v);
  if (preset) return preset.label;
  const min = Math.round(v / 60_000);
  if (min < 60) return `${min} minutos`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r === 0 ? `${h} hora${h > 1 ? "s" : ""}` : `${h}h ${r}min`;
}

/** É um dos presets? (a UI usa para decidir entre o Select e o campo "personalizado") */
const isPreset = (ms) => PRESETS.some((p) => p.ms === clampMs(ms));

module.exports = { PRESETS, MIN_MS, MAX_MS, clampMs, fromMinutes, humanize, isPreset };
