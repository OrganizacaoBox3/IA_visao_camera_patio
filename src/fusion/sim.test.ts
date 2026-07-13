// Testes do simulador indoor de fusão (sim.ts): determinismo absoluto, geometria real (homografia
// round-trip contra a trajetória-verdade), física dos cenários (parado/bloco/cruzamento), BLE
// quantizado/periodizado, ruído multiplicativo da altura da caixa (σ 5%, pé intacto), origem do
// RSSI (estação no canto × junto da câmera), dropout e id-switch. O simulador é o sensor do
// harness — se ele mentir, o harness inteiro mente.
import { describe, expect, it } from "vitest";
import {
  bodyBiasDb,
  regionOffsetAt,
  segmentIntersectsPolygon,
  simulateFusionScenario,
} from "./sim";
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

  it("anchorPosErrorM desloca SÓ o cadastro exportado (sc.anchors); física de RSSI intacta", () => {
    // Modela erro de INSTALAÇÃO/cadastro (posAssumed ≠ posReal, §3 de docs/cientifica/simulador.md):
    // o RSSI é gerado da posição REAL; o que muda é só o que o operador "cadastrou".
    const opts = { walk: "parado" as const, anchors: true, steps: 8 };
    const baseline = simulateFusionScenario(opts, 5);
    const comErro = simulateFusionScenario({ ...opts, anchorPosErrorM: 1.5 }, 5);

    // Física intacta: TODOS os ticks (tracks, readings — inclusive RSSI das âncoras — e verdade)
    // são byte-idênticos; o erro não toca a geração, só o cadastro.
    expect(comErro.ticks).toEqual(baseline.ticks);

    // Cadastro deslocado: cada âncora k é empurrada por EXATAMENTE 1,5 m, em direções fixas
    // alternadas por índice (+x, +y, −x, −y — determinístico, sem RNG).
    const dirs = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
    ];
    expect(comErro.anchors).toHaveLength(4);
    for (let k = 0; k < 4; k++) {
      const real = baseline.anchors![k];
      const cad = comErro.anchors![k];
      expect(cad.mac).toBe(real.mac);
      const dx = cad.world.x - real.world.x;
      const dy = cad.world.y - real.world.y;
      expect(Math.hypot(dx, dy)).toBeCloseTo(1.5, 9);
      expect(dx).toBeCloseTo(1.5 * dirs[k].x, 9);
      expect(dy).toBeCloseTo(1.5 * dirs[k].y, 9);
    }

    // Byte-compat: ausente (e explicitamente 0) → cenário INTEIRO idêntico, cadastro = real.
    expect(simulateFusionScenario(opts, 5)).toEqual(baseline);
    expect(simulateFusionScenario({ ...opts, anchorPosErrorM: 0 }, 5)).toEqual(baseline);
  });

  it("guarda de MARGEM do anchorPosErrorM: span de log10(d cadastro→estação) < 0,4 década no eixo 0..2 m", () => {
    // Varredura adversarial de 2026-07-11: o pior span do eixo é 0,3802 década (pico em e≈1,39 m)
    // — a só 5% do limiar de 0,4 década que troca o regime do fitPathLoss (anchors-offset ↔ fit
    // completo). Este teste sela que o regime NÃO flipa no meio da curva; se ANCHOR_HALF_W/H (aqui)
    // ou o SPAN_MIN_DECADES (do fit) mudarem e o span estourar, quebra aqui com aviso, não muda o
    // regime silenciosamente. Calculado das posições EXPORTADAS (o cadastro que o fit consome),
    // com a estação default em (0,0) — sem importar constante privada.
    for (const e of [0, 0.5, 1, 1.39, 1.5, 2]) {
      const sc = simulateFusionScenario(
        { walk: "parado", anchors: true, anchorPosErrorM: e, steps: 1 },
        5,
      );
      const logs = sc.anchors!.map((a) => Math.log10(Math.hypot(a.world.x, a.world.y)));
      const span = Math.max(...logs) - Math.min(...logs);
      expect(span, `anchorPosErrorM=${e}: span=${span.toFixed(4)}`).toBeLessThan(0.4);
    }
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

  it("forceSwitchAt troca trackIdOfPerson NO tick exato, sem sorteio, e é byte-compat quando ausente", () => {
    const opts = { walk: "waypoint" as const, people: 2, tagged: 2, steps: 20 };
    const withSwitch = simulateFusionScenario(
      { ...opts, forceSwitchAt: { tickIndex: 5, personA: 0, personB: 1 } },
      1,
    );
    expect(withSwitch.ticks[4].truthTagByTrack).toEqual({ 0: "AA:AA", 1: "BB:BB" });
    expect(withSwitch.ticks[5].truthTagByTrack).toEqual({ 0: "BB:BB", 1: "AA:AA" });
    expect(
      withSwitch.ticks.slice(5).every((t) => t.truthTagByTrack[0] === "BB:BB"),
    ).toBe(true); // a troca VALE dali em diante, não é um blip de 1 tick

    // ausente → idêntico ao comportamento de sempre (mesmo seed/opts, sem o campo).
    const without = simulateFusionScenario(opts, 1);
    expect(without).toEqual(simulateFusionScenario(opts, 1));
  });
});

describe("simulateFusionScenario — ruído AR(1) do RSSI (Fase 2 da bancada, τ medido nas 6h reais)", () => {
  /** Série de RSSI de UMA tag, amostrada só nos ticks de atualização real (rssiPeriodTicks=2,
   *  default) — evita reler o valor repetido dos ticks intermediários (sim.ts inteiro é 500ms/tick,
   *  RSSI atualiza a 1Hz por padrão). */
  function updateSeries(sc: ReturnType<typeof simulateFusionScenario>, mac: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < sc.ticks.length; i += 2) {
      const r = sc.ticks[i].readings.find((x) => x.mac === mac);
      if (r) out.push(r.rssi);
    }
    return out;
  }

  function lag1Autocorr(xs: number[]): number {
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    let num = 0;
    let den = 0;
    for (const x of xs) den += (x - mean) ** 2;
    for (let i = 0; i < xs.length - 1; i++) num += (xs[i] - mean) * (xs[i + 1] - mean);
    return num / den;
  }

  // "parado": distância à estação CONSTANTE → toda variação do RSSI é o ruído puro (isola o
  // mecanismo do resto da física, mesma tática de isolamento do resto do domínio).
  const PARADO_OPTS = { steps: 2000, people: 1, tagged: 1, walk: "parado" as const };

  it("CONTROLE POSITIVO (regra institucionalizada nº4): sem rssiNoiseTauS, autocorrelação ≈ 0 (IID)", () => {
    const sc = simulateFusionScenario(PARADO_OPTS, 1);
    const series = updateSeries(sc, "AA:AA");
    expect(Math.abs(lag1Autocorr(series))).toBeLessThan(0.1);
  });

  it("com rssiNoiseTauS, a autocorrelação empírica bate a teórica (ρ=exp(-Δt/τ)) — dentro de margem", () => {
    const tauS = 5;
    const sc = simulateFusionScenario({ ...PARADO_OPTS, rssiNoiseTauS: tauS }, 1);
    const series = updateSeries(sc, "AA:AA");
    const empirical = lag1Autocorr(series);
    const theoretical = Math.exp(-1 / tauS); // Δt = rssiPeriodTicks(2)×500ms = 1s
    expect(empirical).toBeGreaterThan(theoretical - 0.15);
    expect(empirical).toBeLessThan(theoretical + 0.15);
    // MUITO maior que o controle IID — a correlação é do mecanismo, não ruído de amostragem.
    expect(empirical).toBeGreaterThan(0.5);
  });

  it("determinismo preservado com o novo estado interno (rssiNoiseAr1/rssiAr1Seeded)", () => {
    // NOTA (revisão adversarial de 2026-07-11): duas execuções da MESMA versão do código só provam
    // determinismo, não byte-compat com o comportamento ANTERIOR. A byte-compat real (knob ausente
    // = stream de RNG/saída intactos) é garantida pelos 12 pinos do CI (replay-fusion.test.ts /
    // world-spec.test.ts), que travam a saída histórica.
    const opts = { walk: "cruzamento" as const, idSwitchOnCross: true, people: 2, tagged: 2 };
    const a = simulateFusionScenario(opts, 7);
    const b = simulateFusionScenario(opts, 7);
    expect(a).toEqual(b); // determinismo — não quebrado pelo novo estado interno
  });

  it("1ª atualização nasce no estado ESTACIONÁRIO: var do tick 0 entre seeds ≈ rssiNoiseDb², não (1-ρ²)·rssiNoiseDb²", () => {
    // τ=32s, Δt=1s → ρ=exp(-1/32)≈0,969; (1-ρ²)≈0,061. ANTES da correção (revisão adversarial de
    // 2026-07-11), o estado AR(1) partia de 0 e a 1ª atualização saía com var (1-ρ²)·σ² ≈ 0,97 dB²
    // (σ=4 default) — sub-ruidosa por ~16×, convergindo à var nominal só depois de vários τ
    // (var[k]=1-ρ^2k). Agora a 1ª atualização semeia ε puro: var ≈ σ² = 16 dB² desde o 1º sample
    // (a quantização a inteiro soma ~1/12 dB², desprezível nas margens abaixo).
    const tauS = 32;
    const seeds = 200;
    const first: number[] = [];
    for (let s = 1; s <= seeds; s++) {
      const sc = simulateFusionScenario(
        { walk: "parado", people: 1, tagged: 1, steps: 1, rssiNoiseTauS: tauS },
        s,
      );
      first.push(sc.ticks[0].readings[0].rssi);
    }
    const mean = first.reduce((a, b) => a + b, 0) / seeds;
    const variance = first.reduce((a, b) => a + (b - mean) ** 2, 0) / (seeds - 1);
    const sigma2 = 4 * 4; // rssiNoiseDb default 4 → σ² = 16 dB²
    const rho = Math.exp(-1 / tauS); // Δt = rssiPeriodTicks(2)×500ms = 1s
    const varAntiga = (1 - rho * rho) * sigma2; // ≈ 0,97 dB² — o transitório sub-ruidoso de antes
    expect(variance).toBeGreaterThan(sigma2 * 0.6); // ~1·σ², com folga p/ ruído de amostragem
    expect(variance).toBeLessThan(sigma2 * 1.6);
    expect(variance).toBeGreaterThan(varAntiga * 5); // e MUITO longe do comportamento antigo
  });
});

describe("regionOffsetAt — offset regional por polígono (Fase 2, física medida)", () => {
  const quadrado: Vec2[] = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ];

  it("dentro do polígono soma o offset; fora, fica 0", () => {
    expect(regionOffsetAt({ x: 1, y: 1 }, [{ poly: quadrado, offsetDb: -9 }])).toBe(-9);
    expect(regionOffsetAt({ x: 5, y: 5 }, [{ poly: quadrado, offsetDb: -9 }])).toBe(0);
  });

  it("regiões sobrepostas SOMAM (não é 'a primeira que bater')", () => {
    const outra: Vec2[] = [
      { x: 0.5, y: 0.5 },
      { x: 1.5, y: 0.5 },
      { x: 1.5, y: 1.5 },
      { x: 0.5, y: 1.5 },
    ];
    const regions = [
      { poly: quadrado, offsetDb: -9 },
      { poly: outra, offsetDb: 3 },
    ];
    expect(regionOffsetAt({ x: 1, y: 1 }, regions)).toBe(-6); // -9 + 3, ponto dentro das duas
  });

  it("sem regiões (array vazio) → sempre 0", () => {
    expect(regionOffsetAt({ x: 1, y: 1 }, [])).toBe(0);
  });
});

describe("bodyBiasDb — viés corporal direcional (Fase 2, física medida)", () => {
  const bias = { meanDb: 6, peakDb: 18, angWidthDeg: 60 };

  it("sem heading conhecido (pessoa parada) → só o piso (meanDb), nunca inventa orientação", () => {
    const zero: Vec2 = { x: 0, y: 0 };
    expect(bodyBiasDb(zero, { x: 5, y: 0 }, "peito", bias)).toBe(bias.meanDb);
  });

  it("pior caso (tag de costas pra estação) → perto do peakDb", () => {
    // heading (1,0): tag no peito encara (1,0). Estação atrás (dirToStation aponta pra -x) →
    // ângulo 180° entre a frente da tag e a direção da estação = pior caso, por construção.
    const heading: Vec2 = { x: 1, y: 0 };
    const dirToStation: Vec2 = { x: -1, y: 0 };
    const db = bodyBiasDb(heading, dirToStation, "peito", bias);
    expect(db).toBeCloseTo(bias.peakDb, 1);
  });

  it("melhor caso (tag encarando a estação) → perto do meanDb (piso)", () => {
    const heading: Vec2 = { x: 1, y: 0 };
    const dirToStation: Vec2 = { x: 1, y: 0 }; // mesma direção do heading — tag encara a estação
    const db = bodyBiasDb(heading, dirToStation, "peito", bias);
    expect(db).toBeCloseTo(bias.meanDb, 1);
  });

  it("tagPlacement rotaciona a direção efetiva — bolso-esq/dir diferem do peito p/ o mesmo heading", () => {
    const heading: Vec2 = { x: 1, y: 0 };
    const dirToStation: Vec2 = { x: 0, y: 1 }; // estação a 90° do heading
    const peito = bodyBiasDb(heading, dirToStation, "peito", bias);
    const bolsoEsq = bodyBiasDb(heading, dirToStation, "bolso-esq", bias);
    const bolsoDir = bodyBiasDb(heading, dirToStation, "bolso-dir", bias);
    expect(bolsoEsq).not.toBeCloseTo(peito, 1);
    expect(bolsoDir).not.toBeCloseTo(peito, 1);
    // bolso-esq (+90°) e bolso-dir (-90°) são espelhados em torno do heading — c/ a estação
    // exatamente a 90°, um dos dois cai no pior caso e o outro no melhor (simetria do modelo).
    expect(Math.abs(bolsoEsq - bolsoDir)).toBeGreaterThan(5);
  });

  it("está sempre em [meanDb, peakDb] (assumindo peakDb > meanDb) — nunca extrapola", () => {
    for (const deg of [0, 30, 60, 90, 120, 150, 180, 210, 270, 359]) {
      const rad = (deg * Math.PI) / 180;
      const dirToStation: Vec2 = { x: Math.cos(rad), y: Math.sin(rad) };
      const db = bodyBiasDb({ x: 1, y: 0 }, dirToStation, "peito", bias);
      expect(db).toBeGreaterThanOrEqual(bias.meanDb - 1e-9);
      expect(db).toBeLessThanOrEqual(bias.peakDb + 1e-9);
    }
  });
});

describe("simulateFusionScenario — física medida da Fase 2, ligada de ponta a ponta", () => {
  it("rssiRegions desloca o RSSI de quem está dentro, byte-compat quando ausente", () => {
    const opts = { walk: "parado" as const, people: 1, tagged: 1, steps: 4 };
    const baseline = simulateFusionScenario(opts, 1);
    // pessoa 0 em "parado" fica em (1, 1.5) — grade fixa de createMovers (ver sim.ts).
    const regiao: Vec2[] = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 3 },
      { x: 0, y: 3 },
    ];
    const comRegiao = simulateFusionScenario(
      { ...opts, rssiRegions: [{ poly: regiao, offsetDb: -9 }] },
      1,
    );
    const rssiBase = baseline.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    const rssiComRegiao = comRegiao.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    expect(rssiComRegiao).toBe(rssiBase - 9);

    // ausente (array vazio expresso via opts sem o campo) → idêntico ao baseline.
    expect(simulateFusionScenario(opts, 1)).toEqual(baseline);
  });

  it("bodyBias desloca o RSSI de uma pessoa parada pelo piso (meanDb) — sem heading, sem invenção", () => {
    const opts = { walk: "parado" as const, people: 1, tagged: 1, steps: 4 };
    const baseline = simulateFusionScenario(opts, 1);
    const comViés = simulateFusionScenario(
      { ...opts, bodyBias: { meanDb: 6, peakDb: 18, angWidthDeg: 60 } },
      1,
    );
    const rssiBase = baseline.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    const rssiComViés = comViés.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    // Atenuação corporal SUBTRAI (bodyBiasDb devolve dB positivos de atenuação — mesma convenção
    // do obstacleDb). Corrigido na revisão adversarial de 2026-07-11: o sinal original somava.
    expect(rssiComViés).toBe(rssiBase - 6); // pessoa parada → heading zero → só o piso (meanDb)
  });
});

describe("segmentIntersectsPolygon — primitivo de linha de visão/RF (Fase 2, oclusão estruturada)", () => {
  const box: Vec2[] = [
    { x: 2, y: -1 },
    { x: 3, y: -1 },
    { x: 3, y: 0.5 },
    { x: 2, y: 0.5 },
  ];

  it("segmento que atravessa o polígono → true", () => {
    expect(segmentIntersectsPolygon({ x: 1, y: 1.5 }, { x: 4, y: -2 }, box)).toBe(true);
  });

  it("segmento que NÃO chega perto do polígono → false", () => {
    expect(segmentIntersectsPolygon({ x: 10, y: 10 }, { x: 20, y: 20 }, box)).toBe(false);
  });

  it("polígono inválido (<3 pontos) → sempre false, nunca lança", () => {
    expect(segmentIntersectsPolygon({ x: 1, y: 1.5 }, { x: 4, y: -2 }, [])).toBe(false);
  });
});

describe("simulateFusionScenario — oclusão estruturada (obstáculos, Fase 2, último incremento)", () => {
  // "parado", pessoa 0 fica em (1, 1.5) — grade fixa de createMovers (mesma usada nos testes de
  // rssiRegions/bodyBias acima). CAMERA_WORLD=(4,-2), STATION_WORLD=(0,0) — ver constantes de sim.ts.
  const opts = { walk: "parado" as const, people: 1, tagged: 1, steps: 4 };

  it("occludesVision bloqueia a detecção (dropout ESTRUTURADO) — segmento pessoa→câmera cruza", () => {
    const boxNaLinhaDeVisao: Vec2[] = [
      { x: 2, y: -1 },
      { x: 3, y: -1 },
      { x: 3, y: 0.5 },
      { x: 2, y: 0.5 },
    ];
    const comObstaculo = simulateFusionScenario(
      { ...opts, obstacles: [{ poly: boxNaLinhaDeVisao, occludesVision: true }] },
      1,
    );
    expect(comObstaculo.ticks.every((t) => t.tracks.length === 0)).toBe(true);

    const semObstaculo = simulateFusionScenario(opts, 1);
    expect(semObstaculo.ticks.every((t) => t.tracks.length === 1)).toBe(true);
  });

  it("rfAttenDb atenua o RSSI quando o segmento pessoa→estação cruza (sem afetar a visão)", () => {
    const boxNaLinhaDeRf: Vec2[] = [
      { x: 0.3, y: 0.5 },
      { x: 0.7, y: 0.5 },
      { x: 0.7, y: 1.0 },
      { x: 0.3, y: 1.0 },
    ];
    const baseline = simulateFusionScenario(opts, 1);
    const comObstaculo = simulateFusionScenario(
      { ...opts, obstacles: [{ poly: boxNaLinhaDeRf, rfAttenDb: 10 }] },
      1,
    );
    const rssiBase = baseline.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    const rssiComObstaculo = comObstaculo.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    expect(rssiComObstaculo).toBe(rssiBase - 10);
    // sem occludesVision, a caixa não mexe na detecção da câmera.
    expect(comObstaculo.ticks.every((t) => t.tracks.length === 1)).toBe(true);
  });

  it("múltiplos obstáculos cruzados SOMAM a atenuação de RF (mesma convenção de rssiRegions)", () => {
    const boxA: Vec2[] = [
      { x: 0.3, y: 0.5 },
      { x: 0.7, y: 0.5 },
      { x: 0.7, y: 1.0 },
      { x: 0.3, y: 1.0 },
    ];
    const boxB: Vec2[] = [
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.1 },
      { x: 0.4, y: 0.4 },
      { x: 0.1, y: 0.4 },
    ];
    const baseline = simulateFusionScenario(opts, 1);
    const comDois = simulateFusionScenario(
      {
        ...opts,
        obstacles: [
          { poly: boxA, rfAttenDb: 10 },
          { poly: boxB, rfAttenDb: 4 },
        ],
      },
      1,
    );
    const rssiBase = baseline.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    const rssiComDois = comDois.ticks[0].readings.find((r) => r.mac === "AA:AA")!.rssi;
    expect(rssiComDois).toBe(rssiBase - 14);
  });

  it("sem obstáculos (ausente) → byte-compat total", () => {
    expect(simulateFusionScenario(opts, 1)).toEqual(simulateFusionScenario(opts, 1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// MULTI-ANTENA (SimOpts.stations — H4/F5, 2026-07-13): N estações com posição PRÓPRIA, cada tag
// emitindo uma leitura POR ESTAÇÃO, carimbada com `stationId`. O simulador é o sensor do torneio
// da 2ª antena (eval/multi-antena.mjs) — se ele mentir, o torneio mente. As duas coisas que
// PRECISAM ser verdade: (1) o caminho novo NÃO re-sorteia nada (byte-compat do stream de RNG) e
// (2) as duas estações medem GEOMETRIAS DIFERENTES (senão não há 2ª antena, há eco da 1ª).
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("multi-antena (stations)", () => {
  const BASE = { steps: 40, people: 3, tagged: 2, walk: "waypoint" as const };
  const A = { id: "est-a", world: { x: 0, y: 0 } }; // o canto default (STATION_WORLD)
  const B = { id: "est-b", world: { x: 8, y: 6 } }; // o canto OPOSTO — outro eixo radial

  it("CONTROLE: 1 estação em `stations` na posição default → RSSI BIT-A-BIT igual ao legado", () => {
    // A sentinela que prova que o caminho novo não consome RNG a mais nem em ordem diferente:
    // mesma origem física, mesmo seed → os MESMOS inteiros de RSSI, tick a tick. (A única
    // diferença permitida é a chave `stationId`, que o mundo de 1 antena nem tem.)
    const legado = simulateFusionScenario(BASE, 42);
    const uma = simulateFusionScenario({ ...BASE, stations: [A] }, 42);
    expect(uma.ticks.length).toBe(legado.ticks.length);
    for (let i = 0; i < legado.ticks.length; i++) {
      expect(uma.ticks[i].readings.map((r) => [r.mac, r.rssi])).toEqual(
        legado.ticks[i].readings.map((r) => [r.mac, r.rssi]),
      );
      expect(uma.ticks[i].tracks).toEqual(legado.ticks[i].tracks); // trajetórias intactas
    }
    expect(uma.ticks[0].readings.every((r) => r.stationId === "est-a")).toBe(true);
    expect(legado.ticks[0].readings.every((r) => r.stationId === undefined)).toBe(true);
  });

  it("2 estações → 2 leituras por tag por tick, cada uma com o SEU stationId", () => {
    const sc = simulateFusionScenario({ ...BASE, stations: [A, B] }, 42);
    const t0 = sc.ticks[0];
    expect(t0.readings.length).toBe(2 * 2); // 2 tags × 2 estações
    const daTagA = t0.readings.filter((r) => r.mac === "AA:AA");
    expect(daTagA.map((r) => r.stationId).sort()).toEqual(["est-a", "est-b"]);
  });

  it("as duas antenas medem RSSI DIFERENTE p/ a mesma tag (eixos radiais distintos)", () => {
    // Se os dois valores fossem iguais, a "2ª antena" seria um eco — nenhuma informação nova.
    const sc = simulateFusionScenario({ ...BASE, stations: [A, B] }, 42);
    let diferentes = 0;
    for (const t of sc.ticks) {
      const [a, b] = t.readings.filter((r) => r.mac === "AA:AA");
      if (a.rssi !== b.rssi) diferentes++;
    }
    expect(diferentes).toBeGreaterThan(sc.ticks.length * 0.9);
  });

  it("exporta stationsPx (o espelho de calibration.stations) e a principal em stationPx", () => {
    const sc = simulateFusionScenario({ ...BASE, stations: [A, B] }, 42);
    expect(Object.keys(sc.stationsPx ?? {}).sort()).toEqual(["est-a", "est-b"]);
    expect(sc.stationsPx!["est-a"]).toEqual(sc.stationPx); // stations[0] É a principal
    // Round-trip pela homografia REAL: o ponto de imagem volta ao mundo cadastrado.
    const w = pixelToWorld(sc.H as Matrix3, sc.stationsPx!["est-b"]);
    expect(w!.x).toBeCloseTo(8, 6);
    expect(w!.y).toBeCloseTo(6, 6);
  });

  it("sem `stations` → nem stationsPx nem stationId existem (retrocompat dura)", () => {
    const sc = simulateFusionScenario(BASE, 42);
    expect(sc.stationsPx).toBeUndefined();
    expect("stationsPx" in sc).toBe(false);
  });

  it("estação que projeta FORA da imagem → erro EXPLÍCITO (nunca NaN mudo)", () => {
    expect(() =>
      simulateFusionScenario({ ...BASE, stations: [A, { id: "x", world: { x: 400, y: 900 } }] }, 1),
    ).toThrow(/est/);
  });

  it("determinístico: mesmo seed, mesmo cenário multi-antena", () => {
    const o = { ...BASE, stations: [A, B] };
    expect(simulateFusionScenario(o, 9)).toEqual(simulateFusionScenario(o, 9));
  });
});
