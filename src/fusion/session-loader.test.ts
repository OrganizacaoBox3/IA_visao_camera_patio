// Testes do loader da gravação de campo (session-loader.ts): JSONL construído à mão vira o
// SimFusionScenario que o replayFusion de produção consome. Cobre: filtro por câmera, cal→H/stationPx
// (último vence), resample FIEL à produção (snapshot vale até o próximo evento — sem staleness;
// batch BLE substitui o snapshot inteiro; nenhum tick antes do 1º "trk"), verdade GLOBAL por tick,
// linha suja + diag, saneamento de ts (outlier ±24h, teto de ticks) e o replay ponta a ponta sem NaN.
// Determinístico — nenhuma linha depende de relógio ou sorteio. console.warn é espionado (o loader
// sinaliza descarte/anomalia por warn — os testes de diag ASSERTAM isso; os demais só o silenciam).
// Também cobre a linha "meta" (versão do algoritmo/knobs) — aditiva, retrocompat com gravações
// antigas — e o minerador de referência `findPseudoLabelCandidates` (definição do episódio-candidato).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { findPseudoLabelCandidates, parseFusionSession, replayFusionSession } from "./session-loader";
import type { AssignmentTick, SessionTruth } from "./session-loader";

// ——— Construtores de linha (o formato FIXO do contrato entre as frentes) ———

function calLine(
  ts: number,
  cameraId: string,
  H: number[] | null,
  station: { x: number; y: number } | null,
): string {
  return JSON.stringify({ t: "cal", ts, cameraId, H, station });
}

function trkLine(
  ts: number,
  cameraId: string,
  tracks: { id: number; bbox: [number, number, number, number] }[],
): string {
  return JSON.stringify({ t: "trk", ts, cameraId, tracks });
}

function bleLine(
  ts: number,
  readings: { mac: string; rotulo?: string | null; rssi: number }[],
  stationId = "est-1",
): string {
  return JSON.stringify({ t: "ble", ts, stationId, readings });
}

function metaLine(ts: number, gitRev: string | null, fusionConfig: Record<string, unknown>): string {
  return JSON.stringify({ t: "meta", ts, gitRev, fusionConfig });
}

const IDENTITY_H = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const NO_TRUTH: SessionTruth = {};

let warnSpy: MockInstance;
beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("parseFusionSession (loader da gravação de campo)", () => {
  it("round-trip básico: filtra pela primeira câmera vista; cal define H e stationPx", () => {
    const lines = [
      calLine(0, "camA", IDENTITY_H, { x: 0.2, y: 0.9 }),
      trkLine(0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      trkLine(0, "camB", [{ id: 99, bbox: [0.1, 0.1, 0.1, 0.2] }]), // outra câmera → ignorada
      bleLine(0, [{ mac: "aa:bb", rotulo: null, rssi: -50 }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.H).toEqual(IDENTITY_H);
    expect(sc.stationPx).toEqual({ x: 0.2, y: 0.9 });
    expect(sc.ticks).toHaveLength(1); // todos os eventos no mesmo ts → um tick só
    expect(sc.ticks[0].tracks).toEqual([{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]); // só camA
    expect(sc.ticks[0].readings).toEqual([{ mac: "AA:BB", rotulo: null, rssi: -50 }]); // MAC maiúsculo

    // cameraId explícito troca a câmera do replay (camA passa a ser a ignorada).
    const scB = parseFusionSession(lines, NO_TRUTH, { cameraId: "camB" });
    expect(scB.ticks[0].tracks).toEqual([{ id: 99, bbox: [0.1, 0.1, 0.1, 0.2] }]);
    expect(scB.H).toBeNull(); // camB não tem cal → sem calibração (proxy de caixa, como produção)
  });

  it("cal com station null → stationPx default (0.5, 1.0); sem nenhum 'trk' não há tick algum", () => {
    const lines = [
      calLine(0, "camA", IDENTITY_H, null),
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -50 }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.stationPx).toEqual({ x: 0.5, y: 1.0 });
    // Antes do 1º "trk" a produção nem teria hd (useTagFusion retorna cedo) → zero ticks.
    expect(sc.ticks).toEqual([]);
  });

  it("dois 'cal' da câmera → o ÚLTIMO vence (recalibração sobrescreve H e stationPx)", () => {
    const H2 = [2, 0, 0, 0, 2, 0, 0, 0, 1];
    const lines = [
      calLine(0, "camA", IDENTITY_H, { x: 0.2, y: 0.9 }),
      trkLine(0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      calLine(1000, "camA", H2, { x: 0.7, y: 0.8 }),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.H).toEqual(H2);
    expect(sc.stationPx).toEqual({ x: 0.7, y: 0.8 });
  });

  it("resample: o último 'trk' vale ATÉ O PRÓXIMO (sem staleness); rodada VAZIA gravada zera", () => {
    // trk a cada 100 ms de ts 0 a 1000 (x cresce com o tempo → dá pra saber QUAL snapshot entrou);
    // em 3000 o recorder gravou uma rodada VAZIA (produção real: "sem detecção" é um payload []).
    // O hub getter devolve o último payload cru SEM gate de idade → o snapshot de ts 1000 segue
    // valendo em 1500/2000/2500 e só cai quando a rodada vazia chega. Base em epoch grande para
    // provar o REBASE (ticks saem com ts 0, 500, 1000, ...).
    const T0 = 1_700_000_000_000;
    const lines: string[] = [];
    for (let k = 0; k <= 10; k++)
      lines.push(trkLine(T0 + k * 100, "camA", [{ id: 1, bbox: [k / 100, 0.3, 0.1, 0.3] }]));
    lines.push(trkLine(T0 + 3000, "camA", [])); // rodada vazia = sem detecção (gravada, não inferida)
    for (let ts = 0; ts <= 5000; ts += 500)
      lines.push(bleLine(T0 + ts, [{ mac: "AA", rotulo: null, rssi: -50 }]));

    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.ticks).toHaveLength(11); // grade 0..5000 de 500 em 500
    expect(sc.ticks.map((t) => t.ts)).toEqual([...Array(11).keys()].map((k) => k * 500)); // rebase

    // Tick 500 carrega o trk de ts 500 (o mais recente ≤ 500), não o de ts 0 nem o de ts 600.
    expect(sc.ticks[1].tracks[0].bbox[0]).toBeCloseTo(0.05, 10);
    // Tick 1000 carrega o último trk não-vazio (ts 1000)…
    expect(sc.ticks[2].tracks[0].bbox[0]).toBeCloseTo(0.1, 10);
    // …que SEGUE valendo em 2500 (1,5 s depois — não há gate de idade na produção)…
    expect(sc.ticks[5].tracks).toHaveLength(1);
    expect(sc.ticks[5].tracks[0].bbox[0]).toBeCloseTo(0.1, 10);
    // …e só cai quando a rodada VAZIA de ts 3000 chega (e vale dali até o fim).
    expect(sc.ticks[6].tracks).toHaveLength(0);
    expect(sc.ticks[10].tracks).toHaveLength(0);
  });

  it("readings: cada evento 'ble' SUBSTITUI o snapshot inteiro (sem merge por MAC, sem staleness)", () => {
    const lines = [
      trkLine(0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      bleLine(0, [{ mac: "aa", rotulo: null, rssi: -40 }]),
      bleLine(400, [{ mac: "AA", rotulo: null, rssi: -60 }]),
      bleLine(500, [{ mac: "BB", rotulo: "empilhadeira", rssi: -50 }]), // rotulo nunca sobrevive
      bleLine(20000, []), // batch VAZIO também substitui (replayFusion pulará esse tick)
      trkLine(20000, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    const at = (ts: number) => sc.ticks.find((t) => t.ts === ts);

    // Tick 0: o batch de ts 0, tal-qual (MAC maiúsculo).
    expect(at(0)?.readings).toEqual([{ mac: "AA", rotulo: null, rssi: -40 }]);
    // Tick 500: aplicou ts 400 e ts 500 — o ÚLTIMO batch vale INTEIRO. AA sumiu porque o batch
    // de ts 500 não o traz (produção: useDashboardSocket substitui o snapshot, não faz merge).
    expect(at(500)?.readings).toEqual([{ mac: "BB", rotulo: null, rssi: -50 }]);
    // Tick 16000: 15,5 s depois do batch de ts 500 — SEGUE valendo (não há staleness no cliente;
    // o último batch vale até o próximo evento).
    expect(at(16000)?.readings).toEqual([{ mac: "BB", rotulo: null, rssi: -50 }]);
    // Tick 20000: o batch vazio substituiu → readings [] (replayFusion pula, como o
    // !readings.length do useTagFusion).
    expect(at(20000)?.readings).toEqual([]);
  });

  it("não emite tick antes do primeiro 'trk' da câmera (produção sem hd); BLE acumula até lá", () => {
    const lines = [
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -40 }]),
      bleLine(500, [{ mac: "AA", rotulo: null, rssi: -45 }]),
      bleLine(1000, [{ mac: "AA", rotulo: null, rssi: -50 }]),
      trkLine(1500, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      bleLine(2000, [{ mac: "AA", rotulo: null, rssi: -55 }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    // Grade ancorada no 1º evento (ts 0), mas os ticks 0/500/1000 NÃO existem (sem hd ainda).
    expect(sc.ticks.map((t) => t.ts)).toEqual([1500, 2000]);
    // No 1º tick emitido o snapshot BLE é o último batch visto até ali (ts 1000).
    expect(sc.ticks[0].readings).toEqual([{ mac: "AA", rotulo: null, rssi: -50 }]);
  });

  it("linhas embaralhadas (ts fora de ordem na gravação) → exatamente os mesmos ticks", () => {
    const ordered = [
      calLine(0, "camA", IDENTITY_H, { x: 0.2, y: 0.9 }),
      trkLine(0, "camA", [{ id: 1, bbox: [0.1, 0.3, 0.1, 0.3] }]),
      bleLine(250, [{ mac: "AA", rotulo: null, rssi: -40 }]),
      trkLine(500, "camA", [{ id: 1, bbox: [0.2, 0.3, 0.1, 0.3] }]),
      bleLine(750, [{ mac: "BB", rotulo: null, rssi: -50 }]),
      trkLine(1000, "camA", [{ id: 1, bbox: [0.3, 0.3, 0.1, 0.3] }]),
    ];
    const shuffled = [ordered[4], ordered[1], ordered[5], ordered[0], ordered[3], ordered[2]];
    const a = parseFusionSession(ordered, NO_TRUTH);
    const b = parseFusionSession(shuffled, NO_TRUTH);
    expect(b.ticks).toEqual(a.ticks);
    expect(b.H).toEqual(a.H);
    expect(b.stationPx).toEqual(a.stationPx);
  });

  it("cauda menor que um tick após o último tick da grade não afeta nada (produção não a veria)", () => {
    const lines = [
      trkLine(0, "camA", [{ id: 1, bbox: [0.1, 0.3, 0.1, 0.3] }]),
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -50 }]),
      trkLine(400, "camA", [{ id: 2, bbox: [0.9, 0.3, 0.1, 0.3] }]), // < 1 tick após o tick 0
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.ticks).toHaveLength(1); // grade 0..400 com passo 500 → só o tick 0
    expect(sc.ticks[0].tracks).toEqual([{ id: 1, bbox: [0.1, 0.3, 0.1, 0.3] }]); // o trk de 400 nunca entra
  });

  it("linha suja é pulada sem lançar (e contada no diag); item inválido é descartado sem derrubar a linha", () => {
    const lines = [
      "isto não é json",
      '{"t":"trk","ts":', // truncada
      JSON.stringify({ t: "zzz", ts: 0 }), // tipo desconhecido (contrato aditivo)
      JSON.stringify({ t: "trk", ts: 0, cameraId: "camA", tracks: "sujo" }), // tracks não é array
      JSON.stringify({ t: "cal", ts: 0, cameraId: "camA", H: [1, 2, 3], station: null }), // H com 3 números
      JSON.stringify({ t: "trk", cameraId: "camA", tracks: [] }), // sem ts
      // Linha VÁLIDA com um item de track sujo no meio — só o item cai.
      JSON.stringify({
        t: "trk",
        ts: 0,
        cameraId: "camA",
        tracks: [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }, { id: "x", bbox: [0, 0, 0, 0] }, { id: 2 }],
      }),
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -50 }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.H).toBeNull(); // o cal sujo não passou
    expect(sc.ticks).toHaveLength(1);
    expect(sc.ticks[0].tracks).toEqual([{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]);
    expect(sc.ticks[0].readings).toHaveLength(1);
    // Diagnóstico ADITIVO: 8 linhas, 6 não viraram evento (o descarte nunca é mudo).
    expect(sc.diag).toEqual({ linesTotal: 8, linesDropped: 6, cameras: { camA: 1 } });
  });

  it("verdade GLOBAL: a anotação inteira vai em TODO tick — inclusive rodada vazia (assign decide lá)", () => {
    const truth: SessionTruth = { 1: "aa:aa", 2: null }; // 3 não anotado (fantasma p/ métrica)
    const lines = [
      trkLine(0, "camA", [
        { id: 1, bbox: [0.1, 0.3, 0.1, 0.3] },
        { id: 2, bbox: [0.4, 0.3, 0.1, 0.3] },
        { id: 3, bbox: [0.7, 0.3, 0.1, 0.3] },
      ]),
      bleLine(0, [{ mac: "AA:AA", rotulo: null, rssi: -50 }]),
      trkLine(500, "camA", []), // rodada vazia: o assign() de produção ainda decide (janela)
    ];
    const sc = parseFusionSession(lines, truth);
    // MAC maiúsculo, null preservado, não anotado (3) fora — em TODOS os ticks, presentes ou não
    // os tracks: a métrica só avalia trackIds que aparecem nos assignments, então é inócuo — e
    // fecha o furo das decisões tomadas em ticks de rodada vazia (currentTrackIds da janela).
    expect(sc.ticks[0].truthTagByTrack).toEqual({ 1: "AA:AA", 2: null });
    expect(sc.ticks[1].tracks).toEqual([]);
    expect(sc.ticks[1].truthTagByTrack).toEqual({ 1: "AA:AA", 2: null });
  });

  it("reading de MAC fora da truth flui ao associador (fantasma p/ métrica, não p/ fusão)", () => {
    const truth: SessionTruth = { 1: "AA:AA" };
    const lines: string[] = [];
    for (let ts = 0; ts <= 2500; ts += 500) {
      lines.push(trkLine(ts, "camA", [{ id: 1, bbox: [0.4, 0.5, 0.1, 0.3] }]));
      lines.push(
        bleLine(ts, [
          { mac: "AA:AA", rotulo: null, rssi: -50 },
          { mac: "ZZ:ZZ", rotulo: null, rssi: -70 }, // não anotado — mas a produção o veria
        ]),
      );
    }
    const { metrics, scenario } = replayFusionSession(lines, truth, undefined, { warmupMs: 0 });
    // O MAC fora da truth chega INTACTO aos readings do tick (vai ao push do associador)…
    expect(scenario.ticks[0].readings.map((r) => r.mac)).toEqual(["AA:AA", "ZZ:ZZ"]);
    // …e o replay roda sem NaN (a métrica simplesmente nunca o cobra como verdade).
    // `reliabilityBins` é um array (histograma), não um número — fora do loop, checado à parte.
    for (const [key, value] of Object.entries(metrics)) {
      if (key === "reliabilityBins") continue;
      expect(Number.isFinite(value), `métrica ${key} não é finita`).toBe(true);
    }
    for (const bin of metrics.reliabilityBins ?? []) {
      expect(Number.isFinite(bin.accuracy), "reliabilityBins[].accuracy não é finita").toBe(true);
    }
  });

  it("saneamento de ts: evento além de ±24h do mediano é descartado com warn (nunca OOM)", () => {
    const T0 = 1_700_000_000_000;
    const lines = [
      trkLine(T0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      bleLine(T0, [{ mac: "AA", rotulo: null, rssi: -50 }]),
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -99 }]), // relógio zerado no meio da gravação
      trkLine(T0 + 1000, "camA", [{ id: 1, bbox: [0.5, 0.3, 0.1, 0.3] }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    // Sem o saneamento a grade iria de 0 a 1,7e12 (bilhões de ticks). Com ele: 0..1000 → 3 ticks.
    expect(sc.ticks.map((t) => t.ts)).toEqual([0, 500, 1000]);
    expect(sc.ticks[0].readings[0].rssi).toBe(-50); // o batch do outlier nunca entrou
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("mediano"));
  });

  it("teto duro da grade: mais de 500k posições → trunca com warn (nunca trava por tickMs pequeno)", () => {
    const lines = [
      trkLine(0, "camA", []),
      trkLine(50_010_000, "camA", []), // ~13,9h — dentro dos ±24h do mediano
    ];
    const sc = parseFusionSession(lines, NO_TRUTH, { tickMs: 100 }); // 500 101 posições
    expect(sc.ticks).toHaveLength(500_000);
    expect(sc.ticks[sc.ticks.length - 1].ts).toBe(49_999_900);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("truncada"));
  });

  it("diag: câmeras contadas por evento válido; >1 câmera e cameraId sem match geram warn", () => {
    const lines = [
      calLine(0, "camA", IDENTITY_H, null),
      trkLine(0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      trkLine(0, "camB", [{ id: 9, bbox: [0.1, 0.1, 0.1, 0.2] }]),
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -50 }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.diag.cameras).toEqual({ camA: 2, camB: 1 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("câmeras no arquivo"));

    // cameraId que não casa nada: métricas sairiam zeradas — o loader avisa e o diag mostra o porquê.
    warnSpy.mockClear();
    const scX = parseFusionSession(lines, NO_TRUTH, { cameraId: "camX" });
    expect(scX.ticks).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"camX"'));
  });

  it("gravação vazia/só sujeira → cenário vazio com diag honesto, sem lançar", () => {
    const sc = parseFusionSession(["lixo", ""], NO_TRUTH);
    expect(sc.ticks).toEqual([]);
    expect(sc.H).toBeNull();
    expect(sc.diag).toEqual({ linesTotal: 2, linesDropped: 2, cameras: {} });
  });

  it("gravação SEM linha 'meta' (formato antigo) continua funcionando idêntico; meta sai null", () => {
    const lines = [
      calLine(0, "camA", IDENTITY_H, { x: 0.2, y: 0.9 }),
      trkLine(0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -50 }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.meta).toBeNull();
    expect(sc.diag).toEqual({ linesTotal: 3, linesDropped: 0, cameras: { camA: 2 } }); // cal+trk contam (padrão já existente)
    expect(sc.ticks).toHaveLength(1); // resto do comportamento intacto
  });

  it("linha 'meta': parseada, exposta em sc.meta, NÃO conta em cameras/ticks; ÚLTIMA vence", () => {
    const cfg1 = { minMargin: 0.1, windowMs: 8000 };
    const cfg2 = { minMargin: 0.1, windowMs: 8000, optimal: true };
    const lines = [
      metaLine(0, "abc1234", cfg1),
      calLine(0, "camA", IDENTITY_H, { x: 0.2, y: 0.9 }),
      trkLine(0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
      bleLine(0, [{ mac: "AA", rotulo: null, rssi: -50 }]),
      metaLine(500, "def5678", cfg2), // meta re-emitida (ex.: recalibração de knob) — última vence
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.meta).toEqual({ gitRev: "def5678", fusionConfig: cfg2 });
    // meta não é cal/trk: não entra em diag.cameras nem é contada como linha suja (cal+trk = 2, padrão já existente).
    expect(sc.diag).toEqual({ linesTotal: 5, linesDropped: 0, cameras: { camA: 2 } });
    expect(sc.ticks).toHaveLength(1); // meta não afeta a grade de ticks
  });

  it("linha 'meta' com gitRev null (git indisponível na gravação) é válida", () => {
    const lines = [metaLine(0, null, { minMargin: 0.1 }), trkLine(0, "camA", [])];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.meta).toEqual({ gitRev: null, fusionConfig: { minMargin: 0.1 } });
  });

  it("linha 'meta' sem fusionConfig é suja (descartada, contada no diag) — não derruba o resto", () => {
    const lines = [
      JSON.stringify({ t: "meta", ts: 0, gitRev: "abc" }), // sem fusionConfig
      trkLine(0, "camA", [{ id: 1, bbox: [0.4, 0.3, 0.1, 0.3] }]),
    ];
    const sc = parseFusionSession(lines, NO_TRUTH);
    expect(sc.meta).toBeNull();
    expect(sc.diag.linesDropped).toBe(1);
    expect(sc.ticks).toHaveLength(1);
  });
});

describe("findPseudoLabelCandidates (definição do episódio-candidato a pseudo-label)", () => {
  const tick = (
    ts: number,
    trackId: number,
    tag: string | null,
    extra?: Partial<AssignmentTick>,
  ): AssignmentTick => ({ ts, trackId, tag, confidence: 0.9, ...extra });

  it("episódio sustentado (>= minDurationMs, margem alta, sem conflito) vira candidato", () => {
    const ticks: AssignmentTick[] = [];
    for (let ts = 0; ts <= 6000; ts += 500) ticks.push(tick(ts, 1, "AA:AA", { margin: 0.3 }));
    const out = findPseudoLabelCandidates(ticks);
    expect(out).toEqual([
      { trackId: 1, tag: "AA:AA", startTs: 0, endTs: 6000, durationMs: 6000, minMarginInEpisode: 0.3 },
    ]);
  });

  it("episódio CURTO demais (< minDurationMs) não vira candidato", () => {
    const ticks = [tick(0, 1, "AA:AA", { margin: 0.3 }), tick(1000, 1, "AA:AA", { margin: 0.3 })];
    expect(findPseudoLabelCandidates(ticks)).toEqual([]);
  });

  it("troca de tag no MESMO track corta o episódio (sem esticar através da troca)", () => {
    const ticks: AssignmentTick[] = [];
    for (let ts = 0; ts <= 6000; ts += 500) ticks.push(tick(ts, 1, "AA:AA", { margin: 0.3 }));
    for (let ts = 6500; ts <= 12500; ts += 500) ticks.push(tick(ts, 1, "BB:BB", { margin: 0.3 }));
    const out = findPseudoLabelCandidates(ticks);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ tag: "AA:AA", startTs: 0, endTs: 6000 });
    expect(out[1]).toMatchObject({ tag: "BB:BB", startTs: 6500, endTs: 12500 });
  });

  it("margem abaixo do piso interrompe o episódio; conflito também interrompe", () => {
    const ticks: AssignmentTick[] = [];
    for (let ts = 0; ts <= 6000; ts += 500) ticks.push(tick(ts, 1, "AA:AA", { margin: 0.3 }));
    ticks.push(tick(6500, 1, "AA:AA", { margin: 0.01 })); // margem baixa — quebra
    for (let ts = 7000; ts <= 13000; ts += 500) ticks.push(tick(ts, 1, "AA:AA", { margin: 0.3 }));
    ticks.push(tick(13500, 1, "AA:AA", { margin: 0.3, hadConflict: true })); // conflito — quebra
    for (let ts = 14000; ts <= 20000; ts += 500) ticks.push(tick(ts, 1, "AA:AA", { margin: 0.3 }));
    const out = findPseudoLabelCandidates(ticks);
    // 3 trechos sustentados separados pelas duas interrupções.
    expect(out).toHaveLength(3);
    expect(out.every((c) => c.durationMs >= 5000)).toBe(true);
  });

  it("tag null (associador disse 'não sei') nunca inicia nem estica episódio", () => {
    const ticks: AssignmentTick[] = [];
    for (let ts = 0; ts <= 6000; ts += 500) ticks.push(tick(ts, 1, null));
    expect(findPseudoLabelCandidates(ticks)).toEqual([]);
  });

  it("id-switch (novo trackId) nunca funde com o episódio de outro track", () => {
    const ticks: AssignmentTick[] = [];
    for (let ts = 0; ts <= 6000; ts += 500) ticks.push(tick(ts, 1, "AA:AA", { margin: 0.3 }));
    for (let ts = 0; ts <= 6000; ts += 500) ticks.push(tick(ts, 2, "AA:AA", { margin: 0.3 })); // mesmo intervalo, OUTRO track
    const out = findPseudoLabelCandidates(ticks);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.trackId).sort()).toEqual([1, 2]);
  });

  it("margin ausente (gravação sem essa info) não bloqueia o episódio; minMarginInEpisode sai null", () => {
    const ticks: AssignmentTick[] = [];
    for (let ts = 0; ts <= 6000; ts += 500) ticks.push(tick(ts, 1, "AA:AA")); // sem margin nem hadConflict
    const out = findPseudoLabelCandidates(ticks);
    expect(out).toEqual([
      { trackId: 1, tag: "AA:AA", startTs: 0, endTs: 6000, durationMs: 6000, minMarginInEpisode: null },
    ]);
  });

  it("opts customizados (minDurationMs/minMargin) são respeitados", () => {
    const ticks = [tick(0, 1, "AA:AA", { margin: 0.2 }), tick(1000, 1, "AA:AA", { margin: 0.2 })];
    expect(findPseudoLabelCandidates(ticks, { minDurationMs: 500 })).toHaveLength(1);
    expect(findPseudoLabelCandidates(ticks, { minDurationMs: 500, minMargin: 0.25 })).toEqual([]); // margem não bate o piso custom
  });
});

describe("replayFusionSession (ponta a ponta no associador de produção)", () => {
  it("mini-sessão sintética em JSONL roda no replayFusion real e devolve métricas sem NaN", () => {
    // 30 s de gravação, câmera SEM calibração (H null → proxy de caixa, como produção sem H):
    // track 1 se APROXIMA da câmera (caixa cresce) com RSSI subindo em fase — sinal correlacionado;
    // track 2 parado ao fundo, sem tag. Verdade: 1 → AA:AA, 2 → null.
    const lines: string[] = [calLine(0, "cam1", null, null)];
    for (let k = 0; k <= 60; k++) {
      const ts = k * 500;
      const bh = 0.12 + k * 0.004; // caixa crescendo = aproximando
      lines.push(
        trkLine(ts, "cam1", [
          { id: 1, bbox: [0.45, 0.8 - bh, 0.4 * bh, bh] },
          { id: 2, bbox: [0.7, 0.3, 0.04, 0.1] },
        ]),
      );
      lines.push(bleLine(ts, [{ mac: "aa:aa", rotulo: null, rssi: Math.round(-75 + k * 0.5) }]));
    }
    const truth: SessionTruth = { 1: "AA:AA", 2: null };

    const { metrics, scenario } = replayFusionSession(lines, truth);
    expect(scenario.ticks).toHaveLength(61);
    expect(scenario.H).toBeNull();

    // Nenhum campo NUMÉRICO pode ser NaN/Infinity — a régua de honestidade das métricas.
    // `reliabilityBins` é um array (histograma), não um número — verificado à parte, abaixo.
    for (const [key, value] of Object.entries(metrics)) {
      if (key === "reliabilityBins") continue;
      expect(Number.isFinite(value), `métrica ${key} não é finita`).toBe(true);
    }
    for (const bin of metrics.reliabilityBins ?? []) {
      expect(Number.isFinite(bin.accuracy), "reliabilityBins[].accuracy não é finita").toBe(true);
    }
    // Houve avaliação de verdade após o warmup default (8 s) — o replay realmente rodou.
    expect(metrics.ticksEvaluated).toBeGreaterThan(0);
    expect(metrics.opportunities + metrics.trueAbstain + metrics.falseLabels).toBeGreaterThan(0);
  });
});
