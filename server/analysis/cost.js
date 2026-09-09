// ─────────────────────────────────────────────────────────────────────────────
// cost.js — janela rolante do CUSTO por rodada de análise. PURO/determinístico.
//
// POR QUE EXISTE: o worker JÁ media `decodeMs` (JPEG → tensor, via sharp) e `inferMs` (ONNX
// Runtime) e mandava os dois na resposta — mas o host guardava só `st.lastMs = inferMs`, o
// ÚLTIMO valor de UMA câmera. O `decodeMs` era descartado inteiro. Resultado: era impossível
// responder "onde vão os ~1100ms de uma rodada?" sem adivinhar, e portanto impossível otimizar
// sem chutar — que é exatamente o erro que esta sessão já cometeu duas vezes (mecanismo
// embarcado sem efeito medido, revertido depois).
//
// A DECOMPOSIÇÃO é o ponto: decode e inferência têm remédios OPOSTOS.
//   • inferência dominante → o custo é o MODELO (tier/input/threads do ORT);
//   • decode dominante → o custo é o TRANSPORTE (resolução do JPEG, tiling, sharp).
// Sem separar, "está lento" leva a mexer no lugar errado.
//
// Percentil e não média: a média esconde a cauda, e é a CAUDA que enche a fila do worker (uma
// rodada de 3s atrasa todas as câmeras atrás dela). p50 diz o custo típico; p95 diz o que
// realmente dimensiona a capacidade.
//
// Janela por TEMPO (não por contagem): a frota tem cadências muito diferentes entre câmeras;
// uma janela de N amostras representaria minutos numa câmera e segundos em outra.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";

const JANELA_MS = 60_000;

/** Percentil (nearest-rank) de uma lista JÁ ordenada. Vazia → null (não inventa zero). */
function percentil(ordenada, p) {
  if (!ordenada.length) return null;
  const i = Math.min(ordenada.length - 1, Math.max(0, Math.ceil((p / 100) * ordenada.length) - 1));
  return ordenada[i];
}

/**
 * Acumulador de custo por rodada. Uma instância por worker (e uma agregada, se o caller quiser).
 * @param {{janelaMs?: number}} [opts]
 */
function createCostWindow(opts = {}) {
  const janelaMs = Math.max(1000, opts.janelaMs || JANELA_MS);
  const amostras = []; // { t, decodeMs, inferMs }

  function poda(now) {
    const corte = now - janelaMs;
    while (amostras.length && amostras[0].t < corte) amostras.shift();
  }

  return {
    /** Registra UMA rodada concluída. Valores ausentes/inválidos entram como 0 (não quebram). */
    observe(now, decodeMs, inferMs) {
      poda(now);
      amostras.push({
        t: now,
        decodeMs: Math.max(0, Number(decodeMs) || 0),
        inferMs: Math.max(0, Number(inferMs) || 0),
      });
    },
    /**
     * Resumo da janela. `n` é o nº de rodadas medidas — sem ele os percentis são opinião
     * (Regra da casa: proporção sem n não se publica).
     */
    resumo(now) {
      poda(now);
      const n = amostras.length;
      if (!n) return { n: 0, decodeMs: null, inferMs: null, totalMs: null, rodadasPorS: 0 };
      const dec = amostras.map((a) => a.decodeMs).sort((a, b) => a - b);
      const inf = amostras.map((a) => a.inferMs).sort((a, b) => a - b);
      const tot = amostras.map((a) => a.decodeMs + a.inferMs).sort((a, b) => a - b);
      return {
        n,
        rodadasPorS: Math.round((n / (janelaMs / 1000)) * 100) / 100,
        decodeMs: { p50: percentil(dec, 50), p95: percentil(dec, 95) },
        inferMs: { p50: percentil(inf, 50), p95: percentil(inf, 95) },
        totalMs: { p50: percentil(tot, 50), p95: percentil(tot, 95) },
      };
    },
    /**
     * Amostras da janela (cópia rasa, já podada) — usada para AGREGAR várias janelas numa só.
     * Somar percentis de janelas separadas seria errado (percentil não é aditivo); quem agrega
     * precisa das amostras cruas para reordená-las juntas.
     */
    amostras(now) {
      poda(Number.isFinite(now) ? now : Date.now());
      return amostras.map((a) => ({ ...a }));
    },
    reset() {
      amostras.length = 0;
    },
  };
}

module.exports = { createCostWindow, percentil, JANELA_MS };
