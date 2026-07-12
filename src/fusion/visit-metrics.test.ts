// Gate das métricas de VISITA (visit-metrics.ts) — a CORREÇÃO da unidade de medição (ADR-014):
// UMA correlação sobre a janela do EPISÓDIO INTEIRO + n_eff do ρ real + UMA decisão por visita,
// contra a agregação de TICKS de event-metrics.ts (soma de Fisher-z sobre ticks quase-idênticos).
//
// VEREDITO MEDIDO (2026-07-11, sobre FUSION_SCENARIOS) — a tese do especialista, CONFIRMADA e
// REFINADA pelos números (doutrina de honestidade: rodou, olhou, pinou o real):
//   1. A AGREGAÇÃO DE TICKS INFLAVA. event-metrics decide DEZENAS de episódios-com-tag "com
//      confiança"; a janela ÚNICA, com o desconto AR(1) honesto (ρ=0,7 — o medido em campo),
//      decide ZERO nos MESMOS episódios. O n aparente da soma de Fisher-z sobre ticks sobrepostos
//      (8 s de janela a 500 ms → 15/16 de amostra compartilhada) era o combustível da confiança.
//   2. O r CARREGA SINAL FÍSICO (não é artefato de autocorrelação). Controle negativo por
//      DESLOCAMENTO TEMPORAL CIRCULAR (preserva valores/distribuição/AUTOCORRELAÇÃO, destrói o
//      alinhamento com a trajetória): sem desconto (ρ=0), a precisão real de identidade é ~82,6%
//      e a do surrogate DESABA para ~7,7% (≈ acaso). Se o r viesse da autocorrelação, o surrogate
//      teria a MESMA precisão — não tem.
//   3. MAS o span radial do sim é MINÚSCULO (~0,08 década mediano, ~0,18 máx) — muito abaixo do
//      0,42 "passa por pouco" e do ~0,9 esperado com receptor NO DESTINO. Episódios de baixa
//      identificabilidade + desconto honesto ⇒ r fraco (|z|<limiar) ⇒ H1 NÃO se afirma no sim:
//      a identidade ESTÁ no r, mas não há span radial para torná-la SIGNIFICATIVA. É a própria
//      prescrição do ADR-014 (Onda 1: mover o receptor para o destino para fabricar o span).
//
// FIDELIDADE do feed: buildFusionFrame de produção monta dist (homografia/proxy) + rssi por tag,
// MESMA EXCLUSÃO de âncoras do harness sintético. A métrica de visita não usa o associador (mede a
// correlação bruta do episódio); o feed de EVENTO (comparação) usa associador + diagnoseFunnel,
// idêntico ao event-metrics.test.ts.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { TagTrackAssociator } from "./associate";
import { buildFusionFrame } from "./frame";
import { REAL_TAG_PERIOD_S, REAL_TAG_PERIOD_TICKS, simulateFusionScenario } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { parseFusionSession } from "./session-loader";
import { computeEventMetrics } from "./event-metrics";
import type { EventCandidate, EventTick, EventTrackObs } from "./event-metrics";
import {
  circularShiftTicks,
  computeVisitEpisodes,
  computeVisitMetrics,
  countingViolations,
  formatVisitTable,
  maxDistinctReadings,
} from "./visit-metrics";
import type { VisitMetrics, VisitTick, VisitTrackObs } from "./visit-metrics";

type ScenarioEntry = (typeof FUSION_SCENARIOS)[number];

/** Feed de VISITA de um cenário: dist+rssi crus por tick (buildFusionFrame), verdade do sim.
 *  Pistas fora de truthTagByTrack (fantasmas) ficam fora do escopo — como no event-metrics. */
function visitTicksForScenario(entry: ScenarioEntry): VisitTick[] {
  const sc = simulateFusionScenario(entry.opts, entry.seed);
  const excludeTags =
    sc.anchors && sc.anchors.length > 0
      ? new Set(sc.anchors.map((a) => a.mac.toUpperCase()))
      : undefined;
  const stationPx = sc.H && !entry.omitStationPx ? sc.stationPx : undefined;

  const out: VisitTick[] = [];
  for (const tick of sc.ticks) {
    if (tick.readings.length === 0) continue; // produção pula o tick sem BLE
    const frame = buildFusionFrame(tick.tracks, tick.readings, sc.H, tick.ts, stationPx, excludeTags);
    const rssiByTag: Record<string, number> = {};
    for (const r of frame.readings) rssiByTag[r.tag] = r.rssi;
    const tracks: VisitTrackObs[] = [];
    for (const t of frame.tracks) {
      if (!(t.trackId in tick.truthTagByTrack)) continue;
      tracks.push({ trackId: t.trackId, truthTag: tick.truthTagByTrack[t.trackId], dist: t.dist });
    }
    out.push({ ts: tick.ts, tracks, rssiByTag });
  }
  return out;
}

/** Feed de EVENTO (comparação): associador de produção + diagnoseFunnel por tick — CÓPIA fiel do
 *  eventTicksForScenario de event-metrics.test.ts (distM omitido, inerte com gate/blend OFF). */
function eventTicksForScenario(entry: ScenarioEntry): EventTick[] {
  const sc = simulateFusionScenario(entry.opts, entry.seed);
  const assoc = new TagTrackAssociator();
  const excludeTags =
    sc.anchors && sc.anchors.length > 0
      ? new Set(sc.anchors.map((a) => a.mac.toUpperCase()))
      : undefined;
  const stationPx = sc.H && !entry.omitStationPx ? sc.stationPx : undefined;

  const out: EventTick[] = [];
  for (const tick of sc.ticks) {
    if (tick.readings.length === 0) continue;
    assoc.push(buildFusionFrame(tick.tracks, tick.readings, sc.H, tick.ts, stationPx, excludeTags));
    const assignments = assoc.assign(tick.ts);
    const funnel = assoc.diagnoseFunnel(tick.ts);
    const candByTrack = new Map<number, EventCandidate[]>();
    for (const p of funnel) {
      if (p.corr === null) continue;
      let arr = candByTrack.get(p.trackId);
      if (!arr) {
        arr = [];
        candByTrack.set(p.trackId, arr);
      }
      arr.push({ tag: p.tag, r: p.corr, n: p.alignedSamples });
    }
    const tracks: EventTrackObs[] = [];
    for (const a of assignments) {
      if (!(a.trackId in tick.truthTagByTrack)) continue;
      tracks.push({
        trackId: a.trackId,
        truthTag: tick.truthTagByTrack[a.trackId],
        spokenTag: a.tag,
        candidates: candByTrack.get(a.trackId) ?? [],
      });
    }
    out.push({ ts: tick.ts, tracks });
  }
  return out;
}

function runVisitBenchmark(rho?: number): { scenario: string; m: VisitMetrics }[] {
  return FUSION_SCENARIOS.map((entry) => ({
    scenario: entry.name,
    m: computeVisitMetrics(visitTicksForScenario(entry), rho !== undefined ? { rho } : undefined),
  }));
}

describe("visit-metrics (janela ÚNICA do episódio vs agregação de ticks)", () => {
  it(
    "é determinístico: duas rodadas produzem números idênticos",
    () => {
      expect(runVisitBenchmark()).toEqual(runVisitBenchmark());
    },
    20000,
  );

  it("TABELA: visita (janela única, ρ=0,7) vs evento (agregação de ticks), por cenário", () => {
    const visit = runVisitBenchmark();
    const event = FUSION_SCENARIOS.map((entry) => ({
      scenario: entry.name,
      m: computeEventMetrics(eventTicksForScenario(entry)),
    }));
    console.log(`\n${formatVisitTable(visit)}\n`);

    const eventBy = new Map(event.map((r) => [r.scenario, r.m]));
    const lines = [
      "visitPrecision(JANELA-ÚNICA, ρ=0,7) vs event(AGREGAÇÃO-DE-TICKS) — a inflação da agregação:",
      "cenário".padEnd(22) +
        "VISIT-dec  VISIT-prec(c/tag)   EVENT-dec  EVENT-prec(c/tag)   span-med(déc)",
    ];
    let visitDecided = 0;
    let eventDecided = 0;
    for (const { scenario, m } of visit) {
      const e = eventBy.get(scenario)!;
      visitDecided += m.decidedWithTag;
      eventDecided += e.decidedWithTag ?? 0;
      lines.push(
        scenario.padEnd(22) +
          `${String(m.decidedWithTag).padStart(6)}     ` +
          `${(m.visitPrecisionTagged * 100).toFixed(1).padStart(6)}%          ` +
          `${String(e.decidedWithTag).padStart(6)}     ` +
          `${(e.eventPrecisionTagged * 100).toFixed(1).padStart(6)}%          ` +
          `${m.medianSpanDecades.toFixed(3)}`,
      );
    }
    console.log(lines.join("\n"));
    console.log(
      `\nAGREGADO (episódios-com-tag DECIDIDOS): janela-única ρ=0,7 = ${visitDecided} | agregação-de-ticks = ${eventDecided}` +
        `\n→ a agregação de ticks decide MUITO mais que a janela honesta: o n aparente inflado sustentava a confiança.`,
    );

    expect(visit).toHaveLength(12);
    // A INFLAÇÃO, medida: sob desconto AR(1) honesto (ρ=0,7) a janela única não alcança
    // significância em episódio ALGUM do sim (span radial minúsculo), enquanto a agregação de
    // ticks decide dezenas. Se um dia a janela única passar a decidir aqui, alguém re-examina.
    expect(visitDecided).toBe(0);
    expect(eventDecided).toBeGreaterThan(10);
  });

  it("CONTROLE NEGATIVO: r carrega SINAL FÍSICO — sob shift temporal circular a precisão DESABA ao acaso", () => {
    // O surrogate por tag PRESERVA a autocorrelação (o que alimenta n_eff) e DESTRÓI o alinhamento
    // físico. Medido em ρ=0 (SEM desconto AR(1)): é a única régua com decisões a colapsar — em
    // ρ=0,7 o sim decide zero (nada a colapsar). O ρ NÃO enviesa a comparação: o shift preserva a
    // autocorrelação, então real e surrogate veem o MESMO n_eff; a diferença é só o casamento
    // físico. Pooled sobre a suíte (evita ruído de cenário isolado).
    let realCorrect = 0;
    let realDecided = 0;
    let shiftCorrect = 0;
    let shiftDecided = 0;
    for (const entry of FUSION_SCENARIOS) {
      const ticks = visitTicksForScenario(entry);
      const real = computeVisitMetrics(ticks, { rho: 0 });
      const shifted = computeVisitMetrics(circularShiftTicks(ticks), { rho: 0 });
      realCorrect += real.decidedCorrect;
      realDecided += real.decidedWithTag;
      shiftCorrect += shifted.decidedCorrect;
      shiftDecided += shifted.decidedWithTag;
    }
    const realPrec = realDecided === 0 ? 0 : realCorrect / realDecided;
    const shiftPrec = shiftDecided === 0 ? 0 : shiftCorrect / shiftDecided;
    console.log(
      `CONTROLE NEGATIVO (pooled, ρ=0): real ${realCorrect}/${realDecided}=${(realPrec * 100).toFixed(1)}% ` +
        `vs shift ${shiftCorrect}/${shiftDecided}=${(shiftPrec * 100).toFixed(1)}%  ` +
        `→ Δ=${((realPrec - shiftPrec) * 100).toFixed(1)}pp (prova de que o r é casamento físico, não autocorrelação)`,
    );
    expect(realPrec).toBeGreaterThan(0.7); // sinal real forte
    expect(shiftPrec).toBeLessThan(0.35); // surrogate ≈ acaso
    expect(realPrec - shiftPrec).toBeGreaterThan(0.4); // o abismo entre sinal e artefato
  });

  it("SENSIBILIDADE a ρ: relaxar o desconto AR(1) faz a cobertura de visita subir (0,7→0,3→0)", () => {
    // O desconto honesto (ρ=0,7) é o que zera a cobertura no sim; ρ menor "acredita" em mais
    // amostras independentes e decide mais — a MESMA alavanca que a agregação de ticks puxava por
    // baixo dos panos. Relata a curva; asserta a monotonia da cobertura.
    const cov = (rho: number): number =>
      runVisitBenchmark(rho).reduce((s, r) => s + r.m.decidedWithTag, 0);
    const c07 = cov(0.7);
    const c03 = cov(0.3);
    const c00 = cov(0.0);
    console.log(`cobertura (visitas-com-tag decididas): ρ0,7=${c07}  ρ0,3=${c03}  ρ0=${c00}`);
    expect(c07).toBeLessThanOrEqual(c03);
    expect(c03).toBeLessThanOrEqual(c00);
    expect(c00).toBeGreaterThan(0);
  });

  it("parado: sem movimento não há span radial nem correlação — nada é DECIDIDO (abstenção honesta)", () => {
    const m = computeVisitMetrics(
      visitTicksForScenario(FUSION_SCENARIOS.find((s) => s.name === "parado")!),
      { rho: 0 }, // mesmo sem desconto: variância de distância ~0 → correlação indefinida/nula
    );
    expect(m.decided).toBe(0);
    expect(m.episodesWithTag).toBeGreaterThan(0);
  });
});

// ——— BONUS: gravação REAL da caminhada (sem verdade anotada) — span radial + r_episódio ———
// GATED pela existência do arquivo (runtime/gitignored — ausente no CI → SKIP; CI intacto).
// LEITURA APENAS (CLAUDE.md §3). Sem verdade → só span radial e r por par candidato, NUNCA precisão.
const WALK_FILES = [
  "server/bt/fusion-session-2026-07-11_20.jsonl",
  "server/bt/fusion-session-2026-07-11_19.jsonl",
];
const WALK_FILE = WALK_FILES.find((f) => existsSync(f));

/** Feed de VISITA da gravação de campo: parse fiel à produção + buildFusionFrame; verdade = null
 *  em TODA pista. Todas as pistas entram (sem truthTagByTrack para filtrar). */
function visitTicksFromRecording(lines: string[]): { ticks: VisitTick[]; calibrated: boolean } {
  const scenario = parseFusionSession(lines, {});
  const stationPx = scenario.H ? scenario.stationPx : undefined;
  const out: VisitTick[] = [];
  for (const tick of scenario.ticks) {
    if (tick.readings.length === 0) continue;
    const frame = buildFusionFrame(tick.tracks, tick.readings, scenario.H, tick.ts, stationPx);
    const rssiByTag: Record<string, number> = {};
    for (const r of frame.readings) rssiByTag[r.tag] = r.rssi;
    const tracks: VisitTrackObs[] = frame.tracks.map((t) => ({
      trackId: t.trackId,
      truthTag: null,
      dist: t.dist,
    }));
    out.push({ ts: tick.ts, tracks, rssiByTag });
  }
  return { ticks: out, calibrated: scenario.H !== null };
}

describe.skipIf(!WALK_FILE)("visit-metrics — gravação REAL da caminhada (span radial + r_episódio)", () => {
  it("mede span radial dos episódios e r_episódio por par candidato do episódio mais longo", () => {
    const lines = readFileSync(WALK_FILE!, "utf8").split(/\r?\n/);
    const { ticks, calibrated } = visitTicksFromRecording(lines);
    const episodes = computeVisitEpisodes(ticks); // ρ=0,7 default (o honesto)

    const withSamples = episodes.filter((e) => e.nTicks >= 2).sort((a, b) => b.nTicks - a.nTicks);
    const spans = withSamples.map((e) => e.spanDecades).sort((a, b) => a - b);
    const medSpan = spans.length ? spans[spans.length >> 1] : 0;
    const maxSpan = spans.length ? spans[spans.length - 1] : 0;

    const out: string[] = ["VISIT-REAL-BEGIN", `arquivo: ${WALK_FILE}`];
    out.push(
      `ticks processados: ${ticks.length} | H: ${calibrated ? "calibrada (metros)" : "NULA (proxy)"} | ` +
        `episódios (≥2 amostras): ${withSamples.length} | span radial mediano: ${medSpan.toFixed(3)} déc | máx: ${maxSpan.toFixed(3)} déc`,
    );
    out.push(
      "REFERÊNCIA (ADR-014): ~0,42 déc 'passa por pouco'; ~0,9 déc esperado com receptor NO DESTINO.",
    );
    out.push("— top episódios por duração (span radial em décadas) —");
    for (const e of withSamples.slice(0, 6)) {
      out.push(
        `  track ${String(e.trackId).padStart(4)}: ${String(e.nTicks).padStart(4)} ticks | ` +
          `span ${e.spanDecades.toFixed(3)} déc | decidido=${e.decided} tag=${e.decisionTag ?? "—"}`,
      );
    }
    const longest = withSamples[0];
    if (longest) {
      out.push(
        `— episódio MAIS LONGO: track ${longest.trackId}, ${longest.nTicks} ticks, ` +
          `span ${longest.spanDecades.toFixed(3)} déc — r_episódio por par candidato:`,
      );
      for (const c of [...longest.candidates].sort((a, b) => a.r - b.r)) {
        out.push(
          `  tag ${c.tag}: r=${c.r.toFixed(3)} | n=${c.n} nDist=${c.nDistinct} ` +
            `n_eff=${c.nEff.toFixed(1)} |z|=${Math.abs(c.z).toFixed(3)} sig=${c.significant}`,
        );
      }
    }
    out.push(
      `VEREDITO H1 (campo): span ${maxSpan.toFixed(3)} déc (máx) ≪ 0,42/0,9 e r_episódio ≈ 0 em todos os pares ` +
        `→ estes registros NÃO carregam span radial para identidade. Precisa do receptor no destino (Onda 1).`,
    );
    out.push("VISIT-REAL-END");
    console.log(out.join("\n"));

    expect(ticks.length).toBeGreaterThan(0);
    expect(withSamples.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REGRA 8 — O INVARIANTE DE CONTAGEM (2026-07-12, achado por revisão externa; assert PERMANENTE)
//
//     n_eff ≤ nDistinct ≤ ⌊T_episódio / Δt_tag⌋ + 1
//
// É CONTAGEM, não estatística: não pode existir mais evidência INDEPENDENTE do que medição
// DISTINTA, nem mais medição distinta do que a tag EMITIU no tempo do episódio. Estes testes
// FALHAM se alguém (a) reintroduzir contagem de duplicatas na métrica, (b) relaxar o clamp de
// nEff, ou (c) alimentar a métrica com uma fonte que anuncia mais rápido que a tag real.
// Ver "A LEI COMPLETA DO n_eff" no cabeçalho de visit-metrics.ts.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("REGRA 8 — invariante de CONTAGEM (n_eff ≤ nDistinct ≤ teto físico da tag)", () => {
  /** Feed de visita com uma cadência de advertising EXPLÍCITA (ticks do sim entre leituras frescas). */
  function ticksAtPeriod(entry: ScenarioEntry, rssiPeriodTicks: number): VisitTick[] {
    const sc = simulateFusionScenario({ ...entry.opts, rssiPeriodTicks }, entry.seed);
    const excludeTags =
      sc.anchors && sc.anchors.length > 0
        ? new Set(sc.anchors.map((a) => a.mac.toUpperCase()))
        : undefined;
    const stationPx = sc.H && !entry.omitStationPx ? sc.stationPx : undefined;
    const out: VisitTick[] = [];
    for (const tick of sc.ticks) {
      if (tick.readings.length === 0) continue;
      const frame = buildFusionFrame(tick.tracks, tick.readings, sc.H, tick.ts, stationPx, excludeTags);
      const rssiByTag: Record<string, number> = {};
      for (const r of frame.readings) rssiByTag[r.tag] = r.rssi;
      const tracks: VisitTrackObs[] = [];
      for (const t of frame.tracks) {
        if (!(t.trackId in tick.truthTagByTrack)) continue;
        tracks.push({ trackId: t.trackId, truthTag: tick.truthTagByTrack[t.trackId], dist: t.dist });
      }
      out.push({ ts: tick.ts, tracks, rssiByTag });
    }
    return out;
  }

  it("teto físico: nDistinct ≤ ⌈T/Δt_tag⌉+1 — aritmética pura, incluindo entradas degeneradas", () => {
    expect(maxDistinctReadings(0, 2.5)).toBe(1); // episódio instantâneo: só a leitura CARREGADA
    expect(maxDistinctReadings(7500, 2.5)).toBe(4); // 7,5 s / 2,5 s → 3 refreshes + a carregada
    expect(maxDistinctReadings(37500, 1)).toBe(39); // 37,5 s a 1 Hz → 39 = EXATAMENTE o n_eff do laudo
    expect(maxDistinctReadings(37500, 2.5)).toBe(16); // O MESMO episódio, tag REAL → 16, não 39
    // O que o n_eff=39 do laudo EXIGIRIA da tag real: ~97 s de episódio contínuo numa mesa.
    expect(maxDistinctReadings(97000, 2.5)).toBe(40);
    expect(maxDistinctReadings(-1, 2.5)).toBe(0); // degenerado → 0, nunca NaN
    expect(maxDistinctReadings(1000, 0)).toBe(0);
    expect(maxDistinctReadings(1000, Number.NaN)).toBe(0);
  });

  it("DEDUP: distinctConsecutive conta TRANSIÇÕES — o snapshot repetido não vira evidência nova", () => {
    // 12 ticks alinhados, mas o RSSI só MUDA a cada 3 ticks (sample-and-hold) → 4 leituras frescas.
    // Se alguém reintroduzir contagem de duplicatas, nDistinct vira 12 e este teste QUEBRA.
    const ticks: VisitTick[] = [];
    for (let i = 0; i < 12; i++) {
      ticks.push({
        ts: 10000 + i * 500,
        tracks: [{ trackId: 1, truthTag: "AA:AA", dist: 1 + i * 0.3 }],
        rssiByTag: { "AA:AA": -50 - Math.floor(i / 3) * 5 },
      });
    }
    const [ep] = computeVisitEpisodes(ticks, { rho: 0 });
    const c = ep.candidates.find((x) => x.tag === "AA:AA");
    expect(c).toBeDefined();
    expect(c!.n).toBe(12); // amostras ALINHADAS (com repetição) — o que entra na correlação
    expect(c!.nDistinct).toBe(4); // leituras FRESCAS — o que entra no n_eff
    expect(c!.nEff).toBeLessThanOrEqual(c!.nDistinct); // ρ=0 ⇒ n_eff = nDistinct (o teto)
    // E o teto físico: o "advertising" aqui é 1,5 s (3 ticks); span = 5,5 s ⇒ ⌈5,5/1,5⌉+1 = 5 ≥ 4.
    expect(c!.nDistinct).toBeLessThanOrEqual(maxDistinctReadings(ep.endTs - ep.startTs, 1.5));
    expect(countingViolations([ep], 1.5)).toEqual([]);
  });

  it("n_eff ≤ nDistinct SEMPRE — inclusive com ρ<0 (o clamp explícito, não a boa sorte da fórmula)", () => {
    const ticks: VisitTick[] = [];
    for (let i = 0; i < 12; i++) {
      ticks.push({
        ts: 10000 + i * 500,
        tracks: [{ trackId: 1, truthTag: "AA:AA", dist: 1 + i * 0.3 }],
        rssiByTag: { "AA:AA": -50 - i * 2 },
      });
    }
    // ρ = −0,9: a fórmula CRUA daria nDistinct·(1,9/0,1) = 19× nDistinct — mais evidência do que
    // medição. O clamp o impede. (ρ<0 não é físico aqui; o ponto é que o invariante NÃO depende disso.)
    for (const rho of [-0.9, -0.5, 0, 0.3, 0.7, 0.95]) {
      const [ep] = computeVisitEpisodes(ticks, { rho });
      for (const c of ep.candidates) expect(c.nEff).toBeLessThanOrEqual(c.nDistinct);
      expect(countingViolations([ep], 0.5)).toEqual([]);
    }
  });

  it("SUÍTE INTEIRA: nenhum episódio viola o teto — na cadência do SIM (1 s) e na da TAG REAL (2,5 s)", () => {
    let epsSim = 0;
    let epsReal = 0;
    let maxNdSim = 0;
    let maxNdReal = 0;
    for (const entry of FUSION_SCENARIOS) {
      // (a) cadência do simulador (default rssiPeriodTicks=2 ⇒ Δt=1 s)
      const sim = computeVisitEpisodes(visitTicksForScenario(entry), { rho: 0 });
      expect(countingViolations(sim, 1.0)).toEqual([]);
      epsSim += sim.length;
      for (const ep of sim) for (const c of ep.candidates) maxNdSim = Math.max(maxNdSim, c.nDistinct);

      // (b) cadência da TAG REAL (REAL_TAG_PERIOD_TICKS ⇒ Δt=2,5 s) — a física
      const real = computeVisitEpisodes(ticksAtPeriod(entry, REAL_TAG_PERIOD_TICKS), { rho: 0 });
      expect(countingViolations(real, REAL_TAG_PERIOD_S)).toEqual([]);
      epsReal += real.length;
      for (const ep of real) for (const c of ep.candidates) maxNdReal = Math.max(maxNdReal, c.nDistinct);
    }
    expect(epsSim).toBeGreaterThan(0);
    expect(epsReal).toBeGreaterThan(0);
    console.log(
      `REGRA 8 (suíte): 0 violações. nDistinct MÁX — sim(Δt=1 s)=${maxNdSim} (${epsSim} eps) | ` +
        `tag REAL(Δt=${REAL_TAG_PERIOD_S} s)=${maxNdReal} (${epsReal} eps).`,
    );
  }, 120000);

  it("O BUG, PINADO: o SIM a 1 Hz VIOLA o teto da tag REAL (2,5 s) — é a inflação de 2,5×", () => {
    // Este é o teste que prova a CAUSA. Os MESMOS episódios do simulador, medidos contra o teto
    // FÍSICO da tag real, estouram: o sim entrega leituras frescas que a tag não teria emitido.
    // Se um dia o default do sim virar a cadência real, este teste passa a não achar violação e
    // QUEBRA — de propósito: força reler a lei antes de mudar a física da bancada.
    let violations = 0;
    let episodes = 0;
    let worst = { nDistinct: 0, ceiling: 0 };
    for (const entry of FUSION_SCENARIOS) {
      const eps = computeVisitEpisodes(visitTicksForScenario(entry), { rho: 0 });
      episodes += eps.length;
      for (const v of countingViolations(eps, REAL_TAG_PERIOD_S)) {
        violations++;
        if (v.nDistinct - v.ceiling > worst.nDistinct - worst.ceiling) worst = v;
      }
    }
    console.log(
      `REGRA 8 (o BUG): ${violations} violações do teto da tag REAL em ${episodes} episódios do sim ` +
        `(default 1 Hz). Pior: nDistinct=${worst.nDistinct} contra teto físico ${worst.ceiling} ` +
        `(inflação ${(worst.nDistinct / Math.max(1, worst.ceiling)).toFixed(1)}×).`,
    );
    expect(violations).toBeGreaterThan(0); // o sim É otimista — declarado, não escondido
    expect(worst.nDistinct).toBeGreaterThan(worst.ceiling * 1.8); // ~2,4× de inflação observada
  }, 120000);
});
