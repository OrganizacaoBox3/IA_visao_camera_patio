// O GATE DE MOVIMENTO TEM DE HONRAR `points` (spec-zona-unificada §5 — o risco nº 1).
//
// A MORDIDA QUE ESTE ARQUIVO EXISTE PARA IMPEDIR: `buildMotionIgnore` mapeava a zona de exclusão
// para `{x,y,w,h}` e DESCARTAVA `points` em silêncio. Enquanto nenhuma exclusão era polígono, o
// dano era zero. Depois da unificação TODA exclusão é polígono — e uma exclusão em "L" viraria o
// RETÂNGULO ENVOLVENTE no mapa de ignore do gate. O gate passaria a ignorar TAMBÉM o VÃO do L, que
// é área de trabalho com gente de verdade.
//
// A DIREÇÃO DA FALHA É A PERIGOSA (e é por isso que o teste principal aqui NÃO checa bits, checa
// COMPORTAMENTO): movimento no vão não conta ⇒ ratio abaixo do limiar ⇒ o gate PULA a inferência
// ⇒ O MOTOR NÃO ACORDA. É vigilância: um gate que cega a câmera é pior que um gate que não economiza.
// É a MESMA CLASSE do bug do `calibration.stations` (consumidor descartando um campo calado) —
// contrato entre camadas sem teste é a regressão silenciosa nº 1.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const engine = require("./engine");
const motion = require("./motion");
const { PRECISION } = require("./precision");
const { createByteTracker } = require("./bytetrack"); // CT-4: movingOf contra o tracker REAL

// Fixtures COMPARTILHADAS (CA-4) — o mesmo "elle" côncavo que zones.test.js/zones.test.ts usam.
const FIX = require("../../src/zones-polygon-fixtures.json");
const ELLE = FIX.polygons.elle; // braço x∈[0.1,0.3] y∈[0.1,0.8] + pé x∈[0.1,0.6] y∈[0.6,0.8]

const W = motion.THUMB_W; // 64
const H = motion.THUMB_H; // 48

// PRÉ-CONDIÇÃO: o gate lê ANALYSIS_MOTION_GATE no load do módulo. Com ele desligado,
// buildMotionIgnore devolve null por contrato e nada aqui faz sentido — falhe alto, não calado.
if (!motion.GATE_ON) throw new Error("engine.test.js exige o gate de movimento LIGADO (ANALYSIS_MOTION_GATE)");

/** índice do pixel do thumbnail sob um ponto NORMALIZADO (mesma indexação do mapa de ignore) */
function px(nx, ny) {
  const c = Math.min(W - 1, Math.max(0, Math.floor(nx * W)));
  const r = Math.min(H - 1, Math.max(0, Math.floor(ny * H)));
  return r * W + c;
}
/** zona de exclusão POLIGONAL como o camcfg grava: points + bbox DERIVADA (nunca autorada) */
function polyZone(points) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { id: "zx", label: "Ex", modo: "exclusao", x: minX, y: minY, w: maxX - minX, h: maxY - minY, points };
}

describe("buildMotionIgnore — a exclusão POLIGONAL é rasterizada, não achatada na envolvente", () => {
  it("ignora SÓ o L, não a envolvente dele (o vão do L continua VIGIADO)", () => {
    const m = engine.buildMotionIgnore([polyZone(ELLE)]);
    expect(m).not.toBeNull();
    expect(m.length).toBe(W * H);

    // DENTRO do L → ignorado (é o que a zona de exclusão pede: hotspot não dispara o gate)
    expect(m[px(0.2, 0.3)]).toBe(1); // braço vertical
    expect(m[px(0.45, 0.7)]).toBe(1); // pé horizontal

    // NO VÃO do L → NÃO ignorado. Está DENTRO da bbox envolvente (0.1..0.6 × 0.1..0.8):
    // é exatamente o pixel que o bug entregava como "ignore". Aqui ele tem de valer 1 na
    // vigilância, isto é, 0 no mapa de ignore.
    expect(m[px(0.45, 0.3)]).toBe(0);
    expect(m[px(0.5, 0.2)]).toBe(0);

    // FORA da bbox → nunca foi ignorado (nem com o bug); pino de sanidade.
    expect(m[px(0.9, 0.9)]).toBe(0);
  });

  it("FAIL DIRECTION: movimento no vão do L AINDA ACORDA o motor (o gate não cega a câmera)", () => {
    const ignore = engine.buildMotionIgnore([polyZone(ELLE)]);

    // Cena estática (luma uniforme) + um blob que se mexe DENTRO DO VÃO do L: 7×7 células,
    // todas com centro em x∈(0.41,0.51) e y∈(0.26,0.39) — dentro da BBOX do L, FORA do L.
    const prev = new Uint8Array(W * H).fill(100);
    const cur = Uint8Array.from(prev);
    for (let r = 12; r < 19; r++)
      for (let c = 26; c < 33; c++) cur[r * W + c] = 100 + PRECISION.gate.pixelDelta + 10; // pixel MUDOU

    const { changed, ratio } = motion.motionRatio(cur, prev, ignore);
    expect(changed).toBe(49); // COM o bug (bbox achatada) estes 49 pixels seriam ignorados → 0
    expect(ratio).toBeGreaterThanOrEqual(PRECISION.gate.motionRatio);

    // sinceMs=0 → o piso de PROBE não salva; a única coisa que acorda o motor é o movimento
    // ter sido CONTADO. Este assert é o produto inteiro do conserto.
    const dec = motion.gateDecision({ ratio, sinceMs: 0, hasPrev: true });
    expect(dec).toEqual({ infer: true, reason: "motion" });
  });

  it("CA-5: zona SEM points segue no retângulo conservador (comportamento intocado)", () => {
    const rect = { id: "zr", label: "Grade", modo: "exclusao", x: 0.1, y: 0.1, w: 0.5, h: 0.7 };
    const m = engine.buildMotionIgnore([rect]);
    const esperado = motion.buildIgnoreMask(W, H, [{ x: 0.1, y: 0.1, w: 0.5, h: 0.7 }]);
    expect([...m]).toEqual([...esperado]); // bit a bit igual ao caminho de sempre
    expect(m[px(0.45, 0.3)]).toBe(1); // retângulo cheio: o "vão" NÃO existe aqui — é zona mesmo
  });

  it("mistura rect + polígono → UNIÃO (uma zona não apaga a outra)", () => {
    const rect = { id: "zr", label: "Relógio", modo: "exclusao", x: 0.8, y: 0.0, w: 0.2, h: 0.1 };
    const m = engine.buildMotionIgnore([rect, polyZone(ELLE)]);
    expect(m[px(0.9, 0.05)]).toBe(1); // do retângulo
    expect(m[px(0.2, 0.3)]).toBe(1); // do polígono
    expect(m[px(0.45, 0.3)]).toBe(0); // e o vão do L segue vigiado
  });

  it("sem zona de exclusão → null (caminho rápido preservado)", () => {
    expect(engine.buildMotionIgnore([])).toBeNull();
    expect(engine.buildMotionIgnore(null)).toBeNull();
    expect(engine.buildMotionIgnore(undefined)).toBeNull();
  });

  it("polígono DEGENERADO (área zero, nenhuma célula marcada) → null, como o rect vazio", () => {
    // 3 vértices colineares: sanitizeZonePoints deixa passar (documentado em zones.js) e
    // pointInPolygon devolve false p/ tudo → nenhuma célula marcada. Não pode virar máscara
    // toda-zero (custo por pixel no laço do motionRatio à toa) nem lançar.
    const linha = [
      { x: 0.2, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ];
    expect(engine.buildMotionIgnore([polyZone(linha)])).toBeNull();
  });

  it("CUSTO: rasterizar roda no REBUILD de config, não por frame — e é barato", () => {
    // 20 vértices (o TETO da casa) num círculo — o pior caso real de uma zona.
    const teto = Array.from({ length: 20 }, (_, i) => {
      const a = (i / 20) * Math.PI * 2;
      return { x: 0.5 + 0.35 * Math.cos(a), y: 0.5 + 0.35 * Math.sin(a) };
    });
    const z = [polyZone(teto)];
    engine.buildMotionIgnore(z); // aquece
    const t0 = process.hrtime.bigint();
    const N = 20;
    for (let i = 0; i < N; i++) engine.buildMotionIgnore(z);
    const msPorRebuild = Number(process.hrtime.bigint() - t0) / 1e6 / N;
    // Teto FOLGADO (50ms): o número real medido é ~0,3ms — o assert existe p/ pegar uma
    // regressão de ORDEM DE GRANDEZA (ex.: alguém rasterizar por FRAME), não p/ cronometrar
    // a máquina. 10ms flakeou em dev sob carga real (hub + pool D-FINE + vite rodando juntos:
    // mediu 12,5ms de pura contenção de CPU, 2026-07-22); 50ms segue 150× acima do real e
    // ainda reprova qualquer regressão de verdade. Isto roda 1× por mudança de zona.
    expect(msPorRebuild).toBeLessThan(50);
  });
});

// ── Fiação painel→tracker + piso do paralelismo da focada (spec-overlay-tempo-real, Onda 1) ──
//
// A MORDIDA (1a): os knobs 23-26 (estado estacionário) existiam no precision.js mas o engine NÃO
// os passava ao createByteTracker — o motor herdava os defaults internos do bytetrack.js (paridade
// por COINCIDÊNCIA de valor). Mudar o painel não mudava produção: a classe de bug "config que não
// manda" (a mesma do wiring do front, fechada em #F4-w). Este teste trava a fiação: TODO knob do
// tracker no painel tem de chegar às opts do tracker.
describe("byteTrackerOpts — o precision.js MANDA no tracker do motor (knobs 23-26 incluídos)", () => {
  it("todos os knobs do painel chegam às opts do createByteTracker", () => {
    const t = PRECISION.tracker;
    const opts = engine.byteTrackerOpts();
    expect(opts.iouThreshold).toBe(t.iouThreshold);
    expect(opts.birthIouThreshold).toBe(t.birthIouThreshold);
    expect(opts.birthContainment).toBe(t.birthContainment); // knob 8b (guarda por contenção)
    expect(opts.reassocDist).toBe(t.reassocDist);
    expect(opts.reassocMaxGapMs).toBe(t.reassocMaxGapMs);
    expect(opts.lostAfterMisses).toBe(t.lostAfterMisses);
    // Os 4 do estado ESTACIONÁRIO — o wiring que este teste existe p/ nunca mais soltar:
    expect(opts.stationaryTolerance).toBe(t.stationaryTolerance);
    expect(opts.stationaryEnterRounds).toBe(t.stationaryEnterRounds);
    expect(opts.stationaryMaxMisses).toBe(t.stationaryMaxMisses);
    expect(opts.stationaryMaxMs).toBe(t.stationaryMaxMs);
  });

  it("highScore e ttlMs derivados (cadência/gate) presentes e coerentes", () => {
    const opts = engine.byteTrackerOpts();
    expect(opts.highScore).toBe(PRECISION.detector.highScore);
    // TTL nunca-cego: com gate ligado tem de cobrir o probe + margem (precision.trackTtlMs).
    expect(opts.ttlMs).toBeGreaterThanOrEqual(PRECISION.tracker.ttlFloorMs);
  });
});

// A MORDIDA (1b): o default `poolSize-1` do focusInflight ZERAVA o paralelismo da focada no host
// pequeno — pool=2 (4-core, o homolog) dava maxInflight=1 e a feature da spec 09 ficava INERTE
// exatamente onde o overlay mais atrasa. CA-3: piso 2 quando o pool tem 2+ workers.
describe("focusInflightFor — piso 2 com pool≥2 (CA-3); env manda quando setado", () => {
  it("pool=1 → 1 (nunca acima do pool)", () => {
    expect(engine.focusInflightFor(1, undefined)).toBe(1);
  });
  it("pool=2 → 2 (o caso do homolog 4-core — era 1, feature inerte)", () => {
    expect(engine.focusInflightFor(2, undefined)).toBe(2);
  });
  it("pool=3 → 2 e pool=4 → 3 (volta a sobrar worker p/ as não-focadas)", () => {
    expect(engine.focusInflightFor(3, undefined)).toBe(2);
    expect(engine.focusInflightFor(4, undefined)).toBe(3);
  });
  it("env ANALYSIS_FOCUS_INFLIGHT manda, clampado ao pool", () => {
    expect(engine.focusInflightFor(4, "2")).toBe(2);
    expect(engine.focusInflightFor(2, "8")).toBe(2); // teto = pool
    expect(engine.focusInflightFor(4, "lixo")).toBe(3); // inválido → default
    expect(engine.focusInflightFor(4, "0")).toBe(3); // não-positivo → default
  });
});

// ── SENSOR DO GATE: quanto o pulo CEGA (não só quanto ele economiza) ─────────
//
// A LACUNA: o gate pula a inferência quando menos de PRECISION.gate.motionRatio (0,005
// ≈ 16 das 3072 células do thumbnail 64×48) mudou. Uma pessoa DISTANTE andando pode
// mudar MENOS que isso — a rodada é pulada e a câmera só volta a olhar no piso de
// probe. Até aqui o único sensor era `skipped1m` (o CUSTO economizado): pulo em cena
// vazia e pulo com gente andando iam no MESMO balde, e a pergunta "o gate está me
// cegando?" não tinha resposta com DADO. `movingOf` + `recordGateRound` alimentam
// perCamera[].gate.skipMoving1m, que separa os dois. NENHUM limiar mudou nesta frente
// — medir vem antes de mexer (mexer no painel passa por eval/, doutrina §6).
describe("movingOf — gente se movendo no instante da decisão (CT-4, leitura defensiva)", () => {
  it("CT-4: stats().alive - stationary (o caminho quando o tracker publica `alive`)", () => {
    const tracker = { stats: () => ({ reassociations: 0, lost: 1, stationary: 2, alive: 5 }) };
    expect(engine.movingOf(tracker)).toBe(3);
  });

  it("alive ≤ stationary nunca vira negativo (clamp em 0)", () => {
    expect(engine.movingOf({ stats: () => ({ stationary: 4, alive: 3 }) })).toBe(0);
  });

  it("FALLBACK exato: sem `alive`, usa o snapshot interno tracks().length - stationary", () => {
    // Frente do tracker ainda não integrada: `stats()` não traz `alive`, mas `tracks()`
    // é API do bytetrack.js e tem a MESMA semântica (inclui LOST oculto — pessoa oclusa
    // segue pessoa). Este degrau não degrada a medição, só a fonte.
    const tracker = {
      stats: () => ({ reassociations: 0, lost: 1, stationary: 1 }),
      tracks: () => [{}, {}, {}, {}], // 4 vivos internos, 1 estacionário
    };
    expect(engine.movingOf(tracker)).toBe(3);
  });

  it("FALLBACK limite-inferior: só stats().lost quando não há alive nem tracks()", () => {
    // Degrau que SUB-REPORTA (só os tracks ocultos entram) — e sub-reportar cegueira é
    // justamente a direção do FALSO-OK. Por isso ele é o ÚLTIMO recurso antes do 0 e
    // está declarado no engine: quem ler o número tem de saber qual degrau o produziu.
    expect(engine.movingOf({ stats: () => ({ lost: 2, stationary: 0 }) })).toBe(2);
  });

  it("NUNCA quebra: tracker ausente, sem stats(), stats que lança ou devolve lixo → 0", () => {
    expect(engine.movingOf(null)).toBe(0);
    expect(engine.movingOf(undefined)).toBe(0);
    expect(engine.movingOf({})).toBe(0);
    expect(engine.movingOf({ stats: () => { throw new Error("boom"); } })).toBe(0);
    expect(engine.movingOf({ stats: () => null })).toBe(0);
    expect(engine.movingOf({ stats: () => ({}) })).toBe(0);
    // tracks() que lança cai p/ o degrau seguinte (lost), não derruba a rodada
    expect(
      engine.movingOf({
        stats: () => ({ lost: 1, stationary: 0 }),
        tracks: () => { throw new Error("boom"); },
      }),
    ).toBe(1);
  });
});

// CT-4 CONTRA O TRACKER DE VERDADE (não contra um mock que confirma minha hipótese):
// `movingOf` roda sobre um createByteTracker real, com o bytetrack.js COMO ELE ESTÁ. Se
// a frente do tracker publicar `alive`, o degrau 1 assume e este teste tem de continuar
// verde — é o mesmo número por dois caminhos. Se REGREDIR (nem alive nem tracks()),
// aqui é onde se descobre.
describe("movingOf × createByteTracker REAL — o CT-4 medido, não presumido", () => {
  const det = (x, y, score = 0.9) => ({ bbox: [x, y, 0.08, 0.2], score });

  it("2 pessoas ANDANDO em quadro → moving 2 (pelo degrau que o tracker oferecer hoje)", () => {
    const tk = createByteTracker(engine.byteTrackerOpts()); // mesmos knobs do motor
    let t = 1000;
    for (let i = 0; i < 4; i++, t += 500) tk.update([det(0.1 + i * 0.03, 0.5), det(0.6 + i * 0.03, 0.5)], t);
    expect(engine.movingOf(tk)).toBe(2);
  });

  it("quadro VAZIO (tracks expirados) → moving 0", () => {
    const tk = createByteTracker(engine.byteTrackerOpts());
    tk.update([det(0.1, 0.5)], 1000);
    tk.update([], 1000 + engine.byteTrackerOpts().ttlMs + 60_000); // TTL estourado, some
    expect(engine.movingOf(tk)).toBe(0);
  });

  it("pessoa OCLUSA (LOST, fora do overlay) AINDA conta como gente em quadro", () => {
    // Escolha declarada: p/ um sensor de CEGUEIRA, quem sumiu do overlay por oclusão
    // não virou ausência — pular a rodada dela é justamente o pior caso. E é o ponto
    // onde os dois caminhos do CT-4 podem DIVERGIR: `alive` hoje é tracks.length (vivo,
    // LOST incluído) — se um dia virar "emitíveis", este número cai p/ 0. Aqui fica o
    // alarme: se cair, foi mudança de SEMÂNTICA, não regressão de código.
    const opts = engine.byteTrackerOpts();
    const tk = createByteTracker(opts);
    let t = 1000;
    for (let i = 0; i < 3; i++, t += 400) tk.update([det(0.1 + i * 0.05, 0.5)], t);
    for (let i = 0; i <= opts.lostAfterMisses; i++, t += 200) tk.update([], t); // oclusão, dentro do TTL
    expect(tk.stats().lost).toBe(1); // pré-condição medida: está LOST (fora da emissão)
    expect(tk.tracks()).toHaveLength(1); // …e VIVO internamente
    expect(engine.movingOf(tk)).toBe(1);
    // Equivalência dos degraus: publicar alive = nº de tracks VIVOS dá o MESMO número
    // (quando a frente do tracker integrar, o sensor não muda de valor).
    const comAlive = { stats: () => ({ ...tk.stats(), alive: tk.tracks().length }), tracks: tk.tracks };
    expect(engine.movingOf(comAlive)).toBe(engine.movingOf(tk));
  });

  it("pessoa PARADA vira ESTACIONÁRIA e SAI do moving (não é cegueira do gate)", () => {
    const opts = engine.byteTrackerOpts();
    const tk = createByteTracker(opts);
    let t = 1000;
    // Mesma bbox por rodadas suficientes p/ o tracker declarar estacionário (knob 24).
    for (let i = 0; i < opts.stationaryEnterRounds + 3; i++, t += 500) tk.update([det(0.4, 0.5)], t);
    expect(tk.stats().stationary).toBe(1); // pré-condição do teste, medida
    expect(engine.movingOf(tk)).toBe(0); // parada não conta como gente em movimento
  });
});

describe("recordGateRound — log rolante de 60s de TODA rodada gateada", () => {
  const trackerWith = (alive, stationary = 0) => ({ stats: () => ({ alive, stationary, lost: 0 }) });

  it("grava { t, ratio, infer, reason, moving } da rodada PULADA e da que RODOU", () => {
    const st = { gateLog: [], tracker: trackerWith(2) };
    engine.recordGateRound(st, 1000, { ratio: 0.001, infer: false, reason: "skip" });
    engine.recordGateRound(st, 2000, { ratio: 0.02, infer: true, reason: "motion" });
    expect(st.gateLog).toEqual([
      { t: 1000, ratio: 0.001, infer: false, reason: "skip", moving: 2 },
      { t: 2000, ratio: 0.02, infer: true, reason: "motion", moving: 2 },
    ]);
  });

  it("`moving` é amostrado NO INSTANTE da decisão (não no /status, depois)", () => {
    // O tracker muda entre as rodadas; cada linha do log tem de carregar o estado
    // daquele instante — medir depois mediria outro instante (regra 9: resolução).
    let alive = 0;
    const st = { gateLog: [], tracker: { stats: () => ({ alive, stationary: 0 }) } };
    engine.recordGateRound(st, 1000, { ratio: 0.0, infer: false, reason: "skip" }); // cena vazia
    alive = 3; // gente entrou em quadro
    engine.recordGateRound(st, 2000, { ratio: 0.001, infer: false, reason: "skip" }); // pulou COM gente
    expect(st.gateLog.map((g) => g.moving)).toEqual([0, 3]);
  });

  it("poda a janela no push (60s) — o log não cresce sob tráfego", () => {
    const st = { gateLog: [], tracker: trackerWith(0) };
    engine.recordGateRound(st, 1_000, { ratio: 0.001, infer: false, reason: "skip" });
    engine.recordGateRound(st, 30_000, { ratio: 0.001, infer: false, reason: "skip" });
    engine.recordGateRound(st, 62_000, { ratio: 0.001, infer: false, reason: "skip" }); // cutoff 2_000
    expect(st.gateLog.map((g) => g.t)).toEqual([30_000, 62_000]);
  });

  it("estado sem gateLog (parcial) materializa o log em vez de lançar", () => {
    const st = { tracker: trackerWith(1) };
    engine.recordGateRound(st, 1000, { ratio: 0, infer: true, reason: "baseline" });
    expect(st.gateLog).toHaveLength(1);
    expect(st.gateLog[0].moving).toBe(1);
  });
});

// FIM A FIM (engine grava → telemetry agrega): é aqui que a pergunta do dono é
// respondida. Um teste só do log ou só do agregado deixaria o contrato entre os dois
// sem sensor — a regressão silenciosa nº 1 desta casa.
describe("gate: pulo COM gente em movimento vira skipMoving1m no /api/analysis/status", () => {
  const { buildStatus } = require("./telemetry");
  const { createInflightSlots } = require("./inflight");

  function stWith(tracker) {
    return {
      id: "cam1",
      slots: createInflightSlots(),
      latest: null,
      rounds: [],
      detsLog: [],
      gateLog: [],
      skipped: 0,
      motionRatio: 0,
      lastMs: 0,
      longRange: false,
      fadiga: false,
      source: "relay",
      autoMask: null,
      tracker,
    };
  }
  function statusOf(st, now) {
    return buildStatus({
      now,
      states: new Map([["cam1", st]]),
      focusedCams: new Set(),
      targetFpsOf: () => 1,
      enabled: true,
      modelFile: "m.onnx",
      fps: { normal: 1, line: 2, focus: 6 },
      motionGate: { enabled: true, ratio: PRECISION.gate.motionRatio, probeMs: 6000, probeFocusMs: 2000, thumb: "64x48" },
      autoscale: {},
      worker: {},
      go2rtcPull: {},
    }).perCamera.cam1;
  }

  it("2 pessoas ANDANDO + ratio abaixo do limiar → 1 pulo, 1 CEGO", () => {
    // A cena que motiva a frente: pessoa distante andando move poucas células e o
    // ratio medido fica ABAIXO de PRECISION.gate.motionRatio → o gate pula.
    const st = stWith({ stats: () => ({ alive: 2, stationary: 0, lost: 0 }) });
    const ratio = PRECISION.gate.motionRatio / 2; // sub-limiar de verdade, não número mágico
    engine.recordGateRound(st, 70_000, { ratio, infer: false, reason: "skip" });
    st.skipped += 1;
    const cam = statusOf(st, 100_000);
    expect(cam.skipped1m).toBe(1); // custo (o sensor que já existia)
    expect(cam.gate.skipMoving1m).toBe(1); // CEGUEIRA (o sensor que faltava)
    expect(cam.gate.reasons1m.skip).toBe(1);
  });

  it("MESMO ratio, ninguém em quadro → 1 pulo, 0 CEGO (economia legítima)", () => {
    const st = stWith({ stats: () => ({ alive: 0, stationary: 0, lost: 0 }) });
    engine.recordGateRound(st, 70_000, { ratio: PRECISION.gate.motionRatio / 2, infer: false, reason: "skip" });
    const cam = statusOf(st, 100_000);
    expect(cam.skipped1m).toBe(1);
    expect(cam.gate.skipMoving1m).toBe(0);
  });

  it("pessoa PARADA (estacionária) não conta como cegueira — é o caso que o gate serve", () => {
    const st = stWith({ stats: () => ({ alive: 2, stationary: 2, lost: 0 }) });
    engine.recordGateRound(st, 70_000, { ratio: 0, infer: false, reason: "skip" });
    expect(statusOf(st, 100_000).gate.skipMoving1m).toBe(0);
  });

  it("percentis do ratio saem das rodadas da janela (calibrar o limiar COM dado)", () => {
    const st = stWith({ stats: () => ({ alive: 0, stationary: 0, lost: 0 }) });
    for (let i = 1; i <= 4; i++)
      engine.recordGateRound(st, 70_000 + i, { ratio: i / 1000, infer: i > 2, reason: i > 2 ? "motion" : "skip" });
    const cam = statusOf(st, 100_000);
    expect(cam.gate.ratioP50).toBe(0.002); // nearest-rank sobre [0.001..0.004]
    expect(cam.gate.ratioP95).toBe(0.004);
  });
});
