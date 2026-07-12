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
import { simulateFusionScenario } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { parseFusionSession } from "./session-loader";
import { computeEventMetrics } from "./event-metrics";
import type { EventCandidate, EventTick, EventTrackObs } from "./event-metrics";
import {
  circularShiftTicks,
  computeVisitEpisodes,
  computeVisitMetrics,
  formatVisitTable,
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
