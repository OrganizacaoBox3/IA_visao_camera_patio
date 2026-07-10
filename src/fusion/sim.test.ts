// Testes do simulador indoor de fusão (sim.ts): determinismo absoluto, geometria real (homografia
// round-trip contra a trajetória-verdade), física dos cenários (parado/bloco/cruzamento), BLE
// quantizado/periodizado, ruído multiplicativo da altura da caixa (σ 5%, pé intacto), origem do
// RSSI (estação no canto × junto da câmera), dropout e id-switch. O simulador é o sensor do
// harness — se ele mentir, o harness inteiro mente.
import { describe, expect, it } from "vitest";
import { simulateFusionScenario } from "./sim";
import type { SimTick } from "./sim";
import { pixelToWorld } from "../vision/homography";
import type { Matrix3, Vec2 } from "../vision/homography";

/** Pé (bottom-center) de uma caixa [x,y,w,h] — mesma âncora do frame.ts da produção. */
function foot(bbox: readonly [number, number, number, number]): Vec2 {
  return { x: bbox[0] + bbox[2] / 2, y: bbox[1] + bbox[3] };
}

/** Posição no MUNDO do pé do track `id` num tick (exige o track presente e projeção válida). */
function worldOf(H: Matrix3, tick: SimTick, id: number): Vec2 {
  const t = tick.tracks.find((tr) => tr.id === id);
  expect(t, `track ${id} presente no tick ts=${tick.ts}`).toBeDefined();
  const g = pixelToWorld(H, foot(t!.bbox));
  expect(g).not.toBeNull();
  return g!;
}

describe("simulateFusionScenario", () => {
  it("mesmo seed → cenário IDÊNTICO (determinismo absoluto); seed diferente → diferente", () => {
    const opts = { walk: "cruzamento" as const, idSwitchOnCross: true, dropoutP: 0.1 };
    const a = simulateFusionScenario(opts, 42);
    const b = simulateFusionScenario(opts, 42);
    expect(a).toEqual(b);
    const c = simulateFusionScenario(opts, 43);
    expect(c.ticks).not.toEqual(a.ticks);
  });

  it("H sai do solver real; estação (0,0) projeta no px de calibração, dentro de [0,1]²", () => {
    const s = simulateFusionScenario({}, 1);
    expect(s.H).not.toBeNull();
    // (0,0) é um ponto de calibração → worldToPixel devolve exatamente o px marcado.
    expect(s.stationPx.x).toBeCloseTo(0.15, 4);
    expect(s.stationPx.y).toBeCloseTo(0.92, 4);
    expect(s.stationPx.x).toBeGreaterThanOrEqual(0);
    expect(s.stationPx.x).toBeLessThanOrEqual(1);
    expect(s.stationPx.y).toBeGreaterThanOrEqual(0);
    expect(s.stationPx.y).toBeLessThanOrEqual(1);
    // Tick de 500 ms começando em 0; steps default 120 (60 s).
    expect(s.ticks).toHaveLength(120);
    expect(s.ticks.map((t) => t.ts).slice(0, 4)).toEqual([0, 500, 1000, 1500]);
    // Default: 3 pessoas, 2 com tag → a terceira aparece na verdade como null.
    expect(s.ticks[0].truthTagByTrack).toEqual({ 0: "AA:AA", 1: "BB:BB", 2: null });
  });

  it("uncalibrated → H:null no cenário, mas stationPx calculado e câmera seguem existindo", () => {
    const s = simulateFusionScenario({ uncalibrated: true, dropoutP: 0 }, 1);
    expect(s.H).toBeNull();
    expect(s.stationPx.x).toBeCloseTo(0.15, 4);
    expect(s.ticks[0].tracks.length).toBeGreaterThan(0); // a geometria de projeção continua calibrada
  });

  it("pé sem ruído projeta de volta na posição-verdade (faixas y=3,0/3,2 do cruzamento)", () => {
    const s = simulateFusionScenario(
      { walk: "cruzamento", pxJitter: 0, dropoutP: 0, steps: 40, people: 2 },
      7,
    );
    const H = s.H!;
    for (const tick of s.ticks) {
      const g0 = worldOf(H, tick, 0);
      const g1 = worldOf(H, tick, 1);
      expect(g0.y).toBeCloseTo(3.0, 5); // pixelToWorld(H, pé) ≈ verdade
      expect(g1.y).toBeCloseTo(3.2, 5);
      expect(g0.x).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(g0.x).toBeLessThanOrEqual(7.5 + 1e-6);
    }
    // Velocidade-verdade: 1,2 m/s → 0,6 m por tick de 500 ms (longe da reflexão de borda).
    const x0 = worldOf(H, s.ticks[0], 0).x;
    const x1 = worldOf(H, s.ticks[1], 0).x;
    expect(Math.abs(x1 - x0)).toBeCloseTo(0.6, 5);
  });

  it("parado → pé (no mundo) quase constante com jitter default e EXATO com jitter 0", () => {
    const s = simulateFusionScenario({ walk: "parado", dropoutP: 0 }, 11); // ruído de pixel se aplica
    const H = s.H!;
    for (const id of [0, 1, 2]) {
      const pts = s.ticks.map((t) => worldOf(H, t, id));
      const ref = pts[0];
      for (const g of pts) expect(Math.hypot(g.x - ref.x, g.y - ref.y)).toBeLessThan(0.5);
    }
    const s0 = simulateFusionScenario({ walk: "parado", dropoutP: 0, pxJitter: 0 }, 11);
    for (const id of [0, 1, 2]) {
      const pts = s0.ticks.map((t) => worldOf(H, t, id));
      const ref = pts[0];
      for (const g of pts) expect(Math.hypot(g.x - ref.x, g.y - ref.y)).toBeLessThan(1e-6);
    }
  });

  it("bloco → pessoas 0 e 1 a menos de 1,2 m no mundo o tempo todo (offset fixo de 0,8 m)", () => {
    const s = simulateFusionScenario({ walk: "bloco", pxJitter: 0, dropoutP: 0 }, 3);
    const H = s.H!;
    for (const tick of s.ticks) {
      const g0 = worldOf(H, tick, 0);
      const g1 = worldOf(H, tick, 1);
      const d = Math.hypot(g0.x - g1.x, g0.y - g1.y);
      expect(d).toBeLessThan(1.2);
      expect(d).toBeGreaterThan(0.4); // e não colapsam no mesmo ponto
    }
  });

  it("RSSI é inteiro, segue a log-distância da verdade e REPETE entre períodos (snapshot 1 Hz)", () => {
    const s = simulateFusionScenario(
      { walk: "cruzamento", people: 2, pxJitter: 0, dropoutP: 0, rssiNoiseDb: 0 },
      5,
    );
    const H = s.H!;
    expect(s.ticks[0].readings.map((r) => r.mac)).toEqual(["AA:AA", "BB:BB"]);
    for (const tick of s.ticks) {
      for (const r of tick.readings) {
        expect(Number.isInteger(r.rssi)).toBe(true);
        expect(r.rotulo).toBeNull();
      }
    }
    // rssiPeriodTicks default 2 → tick ímpar repete o par anterior.
    for (let i = 0; i + 1 < s.ticks.length; i += 2)
      expect(s.ticks[i + 1].readings).toEqual(s.ticks[i].readings);
    // Física: com ruído 0, RSSI do tick de atualização = round(-45 − 22·log10(max(d, 0,3))) com a
    // distância-verdade pessoa↔estação (recuperada pela homografia, jitter 0).
    for (let i = 0; i < s.ticks.length; i += 2) {
      const g0 = worldOf(H, s.ticks[i], 0);
      const d = Math.hypot(g0.x, g0.y); // estação em (0,0)
      const exact = -45 - 22 * Math.log10(Math.max(d, 0.3));
      expect(Math.abs(s.ticks[i].readings[0].rssi - exact)).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    // E a série de fato varia entre períodos (senão o teste de repetição não prova nada).
    expect(new Set(s.ticks.map((t) => t.readings[0].rssi)).size).toBeGreaterThan(1);
  });

  it("altura da caixa é RUIDOSA (σ 5%): varia tick a tick, fica ≥0,02 e perto da exata; pé intacto", () => {
    // Pessoa 0 parada em (1; 1,5) → distância à câmera fixa → a bh "exata" é constante; toda
    // variação observada é o ruído multiplicativo. (O pé continua exato com jitter 0 — o teste
    // "parado → pé EXATO com jitter 0" acima é o guarda de que o ruído da bh NÃO move o pé.)
    const s = simulateFusionScenario({ walk: "parado", dropoutP: 0, pxJitter: 0 }, 11);
    const dCam = Math.hypot(1 - 4, 1.5 - -2);
    const exact = 0.5 / (1 + 0.35 * dCam);
    const bhs = s.ticks.map((t) => t.tracks.find((tr) => tr.id === 0)!.bbox[3]);
    expect(new Set(bhs).size).toBeGreaterThan(1); // não é mais função exata da distância
    for (const bh of bhs) {
      expect(bh).toBeGreaterThanOrEqual(0.02); // clamp inferior
      expect(Math.abs(bh - exact) / exact).toBeLessThan(0.25); // σ 5% → desvio pequeno (5σ)
    }
  });

  it("stationAtCamera → RSSI usa a distância pessoa↔CÂMERA (4,-2); default usa pessoa↔estação (0,0)", () => {
    // Pessoa 0 parada em (1; 1,5); ruído 0 → RSSI do tick 0 é exatamente round(-45 − 22·log10(d)).
    const base = { walk: "parado" as const, people: 1, tagged: 1, rssiNoiseDb: 0, dropoutP: 0 };
    const expected = (d: number): number => Math.round(-45 - 22 * Math.log10(Math.max(d, 0.3)));
    const sCam = simulateFusionScenario({ ...base, stationAtCamera: true }, 5);
    const sSta = simulateFusionScenario(base, 5);
    expect(sCam.ticks[0].readings[0].rssi).toBe(expected(Math.hypot(1 - 4, 1.5 - -2)));
    expect(sSta.ticks[0].readings[0].rssi).toBe(expected(Math.hypot(1 - 0, 1.5 - 0)));
    expect(sCam.ticks[0].readings[0].rssi).not.toBe(sSta.ticks[0].readings[0].rssi); // divergem de fato
    // stationPx segue sendo a projeção da estação do canto (0,0) — neste modo ele NÃO representa
    // a física do RSSI e não deve ser passado ao frame (cenários não-calibrados não o consomem).
    expect(sCam.stationPx.x).toBeCloseTo(0.15, 4);
    expect(sCam.stationPx.y).toBeCloseTo(0.92, 4);
  });

  it("anchors → 4 tags-âncora FIXAS: física exata, posições exportadas, verdade e tracks intactos", () => {
    // Retângulo 2,5×1,2 m centrado na estação (0,0) → as 4 âncoras a hypot(1,25; 0,6) ≈ 1,3865 m
    // (span ESTREITO deliberado — espelha o campo real; fitPathLoss cai no regime anchors-offset).
    const s = simulateFusionScenario({ walk: "parado", anchors: true, rssiNoiseDb: 0, dropoutP: 0 }, 5);
    expect(s.anchors).toHaveLength(4);
    const dAnchor = Math.hypot(1.25, 0.6);
    for (const a of s.anchors!) {
      expect(Math.hypot(a.world.x, a.world.y)).toBeCloseTo(dAnchor, 9);
    }
    const expected = Math.round(-45 - 22 * Math.log10(dAnchor));
    for (const tick of s.ticks) {
      // Leituras das âncoras vêm DEPOIS das tags de pessoa, com o MESMO modelo log-distância.
      const anchorReadings = tick.readings.filter((r) => r.mac.startsWith("FX:"));
      expect(anchorReadings.map((r) => r.mac)).toEqual(["FX:01", "FX:02", "FX:03", "FX:04"]);
      for (const r of anchorReadings) expect(r.rssi).toBe(expected); // estáticas + ruído 0 → exato
      // Âncora NÃO é pessoa: nunca vira track nem entra na verdade.
      expect(tick.tracks.every((t) => t.id < 3)).toBe(true);
      expect(Object.values(tick.truthTagByTrack)).not.toContain("FX:01");
    }
    // Sem a flag: nem âncoras nas leituras, nem o campo aditivo no retorno (contrato preservado).
    const plain = simulateFusionScenario({ walk: "parado", rssiNoiseDb: 0, dropoutP: 0 }, 5);
    expect(plain.anchors).toBeUndefined();
    expect(plain.ticks[0].readings.some((r) => r.mac.startsWith("FX:"))).toBe(false);
  });

  it("dropout derruba detecções em alguns ticks; dropout 0 detecta todo mundo sempre", () => {
    const withDrop = simulateFusionScenario({ walk: "parado", dropoutP: 0.3, pxJitter: 0 }, 9);
    const counts = withDrop.ticks.map((t) => t.tracks.length);
    expect(Math.min(...counts)).toBeLessThan(3);
    const noDrop = simulateFusionScenario({ walk: "parado", dropoutP: 0, pxJitter: 0 }, 9);
    expect(noDrop.ticks.every((t) => t.tracks.length === 3)).toBe(true);
  });

  it("idSwitchOnCross num cruzamento eventualmente TROCA o truthTagByTrack; sem a flag, nunca", () => {
    const opts = { walk: "cruzamento" as const, people: 2, tagged: 2 };
    const s = simulateFusionScenario({ ...opts, idSwitchOnCross: true }, 2);
    expect(s.ticks[0].truthTagByTrack).toEqual({ 0: "AA:AA", 1: "BB:BB" });
    const swapped = s.ticks.some(
      (t) => t.truthTagByTrack[0] === "BB:BB" && t.truthTagByTrack[1] === "AA:AA",
    );
    expect(swapped).toBe(true);
    const s2 = simulateFusionScenario(opts, 2);
    expect(s2.ticks.every((t) => t.truthTagByTrack[0] === "AA:AA")).toBe(true);
  });
});
