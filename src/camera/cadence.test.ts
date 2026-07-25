// Sensor da Onda 0 (spec-overlay-tempo-real CA-1): o medidor de cadência do HUD é PURO e
// deduplica por ts — re-ler o MESMO payload a cada rAF (~60×/s) não pode encolher o intervalo.
import { describe, it, expect } from "vitest";
import { createCadenceMeter } from "./cadence";

describe("createCadenceMeter", () => {
  it("null até o 2º payload distinto (1 amostra não é intervalo)", () => {
    const m = createCadenceMeter();
    expect(m.intervalMs()).toBeNull();
    m.observe(1000, 0);
    expect(m.intervalMs()).toBeNull();
  });

  it("mede o intervalo entre payloads DISTINTOS", () => {
    const m = createCadenceMeter();
    m.observe(1000, 0);
    m.observe(2000, 730);
    expect(m.intervalMs()).toBe(730);
  });

  it("DEDUPE por ts: re-ler o mesmo payload no rAF não desloca a medição", () => {
    const m = createCadenceMeter();
    m.observe(1000, 0);
    for (let t = 5; t < 700; t += 16) m.observe(1000, t); // o getter devolve a mesma ref a 60fps
    m.observe(2000, 730);
    expect(m.intervalMs()).toBe(730); // e não 730-684=46
  });

  it("EMA converge para a cadência nova (foco ligou: 1000ms → ~160ms)", () => {
    const m = createCadenceMeter(0.3);
    let now = 0;
    let ts = 0;
    m.observe(++ts, now);
    for (let i = 0; i < 5; i++) m.observe(++ts, (now += 1000)); // regime 1fps
    for (let i = 0; i < 20; i++) m.observe(++ts, (now += 160)); // focada de verdade
    const v = m.intervalMs();
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(150);
    expect(v as number).toBeLessThan(220); // convergiu p/ ~160, não ficou preso nos 1000
  });
});
