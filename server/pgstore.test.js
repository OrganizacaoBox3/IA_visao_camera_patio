// Teste do FLUSH ADAPTATIVO do fallback JSON (server/pgstore.js) — perf round 3, frente 3,
// achado h: o flush re-serializa o histórico inteiro e o custo cresce com ele
// (29 ms @1k · 78 ms @10k · 566 ms @50k eventos), então o intervalo entre flushes cresce junto:
// 2s até 5k eventos · 10s até 50k · 30s acima. Função pura: nº de eventos → intervalo.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { flushIntervalMs } = require("./pgstore");

describe("flushIntervalMs — intervalo adaptativo do flush JSON", () => {
  it("histórico pequeno (≤5k eventos, flush ~29ms): mantém o debounce base de 2s", () => {
    expect(flushIntervalMs(0)).toBe(2_000);
    expect(flushIntervalMs(1_000)).toBe(2_000);
    expect(flushIntervalMs(5_000)).toBe(2_000); // borda inclusa no degrau menor
  });

  it("histórico médio (5k–50k, flush ~78-566ms): espaça para 10s", () => {
    expect(flushIntervalMs(5_001)).toBe(10_000);
    expect(flushIntervalMs(10_000)).toBe(10_000);
    expect(flushIntervalMs(50_000)).toBe(10_000); // borda inclusa no degrau médio
  });

  it("histórico grande (>50k, flush >566ms): espaça para 30s", () => {
    expect(flushIntervalMs(50_001)).toBe(30_000);
    expect(flushIntervalMs(130_000)).toBe(30_000); // ~1 mês de tripwire ×3 câmeras (achado h)
  });

  it("é monótona: mais eventos nunca encurta o intervalo", () => {
    const sizes = [0, 100, 5_000, 5_001, 20_000, 50_000, 50_001, 500_000];
    for (let i = 1; i < sizes.length; i++) {
      expect(flushIntervalMs(sizes[i])).toBeGreaterThanOrEqual(flushIntervalMs(sizes[i - 1]));
    }
  });
});
