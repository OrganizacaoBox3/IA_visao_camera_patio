// ── Medidor de CADÊNCIA de payloads do hub (spec-overlay-tempo-real, Onda 0/CA-1) ──────────────
// Mede o intervalo REAL entre payloads `analysis-tracks` DISTINTOS (dedupe por `ts` do hub, o
// mesmo critério do TrackInterpolator.ingest) — é a régua do "quantos updates/segundo o marcador
// recebe de verdade" (o alvo de 6fps da focada é inalcançável com S; medir é o que autoriza cada
// mexida — 07-diagnostico-overlay-lag). PURO (sem DOM/relógio próprio): o chamador injeta `now`
// (performance.now(), monotônico e LOCAL — durações por perna, nunca epoch entre máquinas).
//
// EMA em vez de média de janela: 1 número estável no HUD a ~1 payload/s, sem ring buffer.
// alpha 0.3 ≈ "os últimos ~6 payloads mandam" — responde a uma mudança de cadência (foco
// ligou/desligou) em poucos segundos sem serrilhar a leitura.

export type CadenceMeter = {
  /** Observa um payload. `ts` = carimbo do hub (dedupe); `now` = chegada local (monotônica). */
  observe(ts: number, now: number): void;
  /** Intervalo médio (EMA) entre payloads distintos, em ms. null até o 2º payload. */
  intervalMs(): number | null;
};

export function createCadenceMeter(alpha = 0.3): CadenceMeter {
  let lastTs = Number.NEGATIVE_INFINITY;
  let lastAt = 0;
  let ema: number | null = null;
  return {
    observe(ts, now) {
      if (ts === lastTs) return; // mesmo payload re-lido no rAF (getter devolve a mesma ref)
      if (lastTs !== Number.NEGATIVE_INFINITY) {
        const dt = now - lastAt;
        ema = ema == null ? dt : alpha * dt + (1 - alpha) * ema;
      }
      lastTs = ts;
      lastAt = now;
    },
    intervalMs() {
      return ema;
    },
  };
}
