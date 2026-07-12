// Gate das métricas de EVENTO (event-metrics.ts): roda o associador DE PRODUÇÃO sobre os
// FUSION_SCENARIOS, agrega a evidência por EPISÓDIO de aproximação (Fisher-z sobre os ticks) e
// compara, sobre EXATAMENTE os mesmos ticks, a precisão de EVENTO com a precisão POR TICK — o
// teste direto da tese do especialista científico (ver cabeçalho de event-metrics.ts).
//
// VEREDITO MEDIDO (2026-07-11, config default) — a tese é REFINADA pelos números, não forçada:
//   A agregação por episódio SUPERA o tick na PRECISÃO DE IDENTIDADE (eventPrecisionTagged: "dado
//   um evento numa pessoa COM tag, a tag estava certa?") em 9 dos 10 cenários decidíveis
//   (canonico 82,4→90,9%; bloco 80→100%; multidão 61,5→75%; ruído 69,2→87,5%). A ÚNICA exceção é
//   `cruzamento` (78,4→66,7%): id-switch do tracker contamina o episódio e o encurta — a agregação
//   NÃO conserta uma pista cuja identidade física trocou no meio. Já a precisão de evento GLOBAL
//   (incluindo falso-evento) fica perto/abaixo do tick, porque a agregação NÃO resolve o eixo
//   ORTOGONAL "rejeitar quem não tem tag": um falso-rótulo SUSTENTADO vira um falso-evento inteiro.
//   Cobertura: a régua de ~30% por tick vira ~30–58% por EVENTO (episódios curtos do sim + corte
//   conservador) — sobe de verdade, mas não os ~100% idealizados de uma aproximação contínua.
//
// FIDELIDADE do feed: alimenta o TagTrackAssociator igual ao replayFusion de produção (tick sem
// BLE pulado; push(buildFusionFrame(...)) + assign + diagnoseFunnel por tick), com a MESMA
// EXCLUSÃO de âncoras (excludeTags) do harness sintético. ÚNICA diferença deliberada e documentada
// vs replayFusion: NÃO computa distM (path-loss das âncoras). distM só é consumido pelos knobs de
// PESQUISA gate/blend (maxDistRatio/distWeight), DESLIGADOS por default — logo é INERTE aqui e a
// associação/correlação sai byte-idêntica ao replay de produção; o único efeito de âncora que
// importa (tirá-las das candidatas) É reproduzido. Este arquivo mede só com config default.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { TagTrackAssociator } from "./associate";
import { buildFusionFrame } from "./frame";
import { simulateFusionScenario } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import {
  computeEventConsistency,
  computeEventMetrics,
  formatEventTable,
} from "./event-metrics";
import type { EventCandidate, EventMetrics, EventTick, EventTrackObs } from "./event-metrics";
import { diagnoseFusionSession } from "./session-loader";

/** Alimenta o associador de produção com um cenário e devolve os EventTick (assignments + funil por
 *  tick). Ver nota de fidelidade no cabeçalho: distM omitido (inerte com gate/blend OFF). */
function eventTicksForScenario(entry: (typeof FUSION_SCENARIOS)[number]): EventTick[] {
  const sc = simulateFusionScenario(entry.opts, entry.seed);
  const assoc = new TagTrackAssociator();
  const excludeTags =
    sc.anchors && sc.anchors.length > 0
      ? new Set(sc.anchors.map((a) => a.mac.toUpperCase()))
      : undefined;
  const stationPx = sc.H && !entry.omitStationPx ? sc.stationPx : undefined;

  const out: EventTick[] = [];
  for (const tick of sc.ticks) {
    if (tick.readings.length === 0) continue; // produção pula o tick sem BLE (useTagFusion)
    assoc.push(buildFusionFrame(tick.tracks, tick.readings, sc.H, tick.ts, stationPx, excludeTags));
    const assignments = assoc.assign(tick.ts);
    const funnel = assoc.diagnoseFunnel(tick.ts);

    const candByTrack = new Map<number, EventCandidate[]>();
    for (const p of funnel) {
      if (p.corr === null) continue; // série constante → não é candidato aquele tick
      let arr = candByTrack.get(p.trackId);
      if (!arr) {
        arr = [];
        candByTrack.set(p.trackId, arr);
      }
      arr.push({ tag: p.tag, r: p.corr, n: p.alignedSamples });
    }

    const tracks: EventTrackObs[] = [];
    for (const a of assignments) {
      if (!(a.trackId in tick.truthTagByTrack)) continue; // pista-fantasma: fora do escopo
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

/** Roda a suíte inteira e devolve as métricas de evento por cenário (determinístico). `mode`
 *  repassa o modo de decisão (spoken=primário; raw=contraste do diagnóstico). */
function runEventBenchmark(mode?: "spoken" | "raw"): { scenario: string; m: EventMetrics }[] {
  return FUSION_SCENARIOS.map((entry) => ({
    scenario: entry.name,
    m: computeEventMetrics(eventTicksForScenario(entry), mode ? { mode } : undefined),
  }));
}

function metricsOf(rows: ReturnType<typeof runEventBenchmark>, scenario: string): EventMetrics {
  const row = rows.find((r) => r.scenario === scenario);
  if (!row) throw new Error(`cenário "${scenario}" não está na suíte`);
  return row.m;
}

// Pinos MEDIDOS (não desejados — doutrina de honestidade: rodou, olhou, pinou o real) em
// 2026-07-11 sobre FUSION_SCENARIOS (240 passos, config default, modo "spoken"). Piso da precisão
// de IDENTIDADE de evento (eventPrecisionTagged) por cenário. Margem absorve só o arredondamento
// (pipeline determinístico — não há "variação de execução").
const MARGIN = 0.02;
const EVENT_TAGGED_PRECISION_FLOOR: Record<string, number> = {
  canonico: 0.909,
  parado: 1.0, // 0 decididos → 1 por convenção (abster é honesto)
  bloco: 1.0,
  cruzamento: 0.667, // A EXCEÇÃO (id-switch churn) — abaixo do tick; pinada como está, honesta
  "ruido-alto": 0.875,
  multidao: 0.75,
  "sem-calibracao": 0.778,
  "grade-sem-station": 0.571,
  "ancoras-canonico": 0.909,
  "ancoras-multidao": 0.733,
  "ancoras-multidao-bias": 0.733,
  "ancoras-mismatch-n": 0.895,
};

describe("event-metrics (precisão de EVENTO vs precisão por TICK)", () => {
  it(
    "é determinístico: duas rodadas produzem números idênticos",
    () => {
      expect(runEventBenchmark()).toEqual(runEventBenchmark());
    },
    20000,
  );

  it("diagnóstico: TABELA tick × evento por cenário (leitura humana)", () => {
    const rows = runEventBenchmark();
    console.log(`\n${formatEventTable(rows)}\n`);
    // Agregado ponderado por episódios-com-tag: quanto a precisão de IDENTIDADE de evento supera a
    // de tick (o número-resumo da tese).
    let wTick = 0;
    let wEvent = 0;
    let wN = 0;
    for (const { m } of rows) {
      wTick += m.tickPrecision * m.episodesWithTag;
      wEvent += m.eventPrecisionTagged * m.episodesWithTag;
      wN += m.episodesWithTag;
    }
    console.log(
      `agregado (ponderado por episódios-com-tag, n=${wN}): tick-prec ${((wTick / wN) * 100).toFixed(1)}% ` +
        `→ EVENT-prec(identidade) ${((wEvent / wN) * 100).toFixed(1)}%`,
    );
    expect(rows).toHaveLength(12);
  });

  it("TESE: em cenários de deslocamento/aglomeração, a precisão de IDENTIDADE de evento supera a de tick", () => {
    // Números MEDIDOS: a agregação por episódio bate o tick na identidade em 9/10 cenários
    // decidíveis. Assere os confirmadores robustos e RELATA todos (honestidade: não força).
    const rows = runEventBenchmark();
    for (const { scenario, m } of rows) {
      console.log(
        `${scenario.padEnd(22)} tick ${(m.tickPrecision * 100).toFixed(1)}% | ` +
          `EVENT(identidade) ${(m.eventPrecisionTagged * 100).toFixed(1)}% | ` +
          `EVENT(global) ${(m.eventPrecision * 100).toFixed(1)}% | falso-ev ${m.falseEvents} | ` +
          `cob ${(m.tickCoverage * 100).toFixed(1)}%→${(m.eventCoverage * 100).toFixed(1)}%`,
      );
    }
    for (const name of ["canonico", "bloco", "multidao", "ruido-alto"]) {
      const m = metricsOf(rows, name);
      expect(
        m.eventPrecisionTagged,
        `${name}: precisão de identidade de evento deveria superar a de tick`,
      ).toBeGreaterThan(m.tickPrecision);
    }
  });

  it("HONESTIDADE: cruzamento é a EXCEÇÃO — id-switch churn derruba a agregação abaixo do tick", () => {
    // Pin da exceção medida: quando o tracker troca IDs no cruzamento, o episódio é contaminado e
    // encurtado; a agregação não conserta uma identidade que trocou no meio. Se um dia isso virar
    // (ganho), este teste quebra e alguém re-examina — o achado não some em silêncio.
    const m = metricsOf(runEventBenchmark(), "cruzamento");
    expect(m.eventPrecisionTagged).toBeLessThan(m.tickPrecision);
  });

  it("cobertura por tick baixa NÃO trava a cobertura de EVENTO (a 30% vira o quê)", () => {
    // O ponto comercial: cobertura-por-tick de ~37% (canonico) não é o teto — no nível de EVENTO a
    // mesma caminhada é decidida bem mais vezes (a evidência acumula). Não chega aos ~100% ideais:
    // episódios curtos do sim + corte conservador → ~55%. Sobe de verdade, medido.
    const m = metricsOf(runEventBenchmark(), "canonico");
    expect(m.tickCoverage).toBeLessThan(0.5); // régua antiga: baixa por tick
    expect(m.eventCoverage).toBeGreaterThan(m.tickCoverage); // no evento, sobe
  });

  it("gate: precisão de IDENTIDADE de evento respeita o piso medido por cenário", () => {
    const rows = runEventBenchmark();
    expect(rows.map((r) => r.scenario).sort()).toEqual(
      Object.keys(EVENT_TAGGED_PRECISION_FLOOR).sort(),
    );
    for (const [scenario, floor] of Object.entries(EVENT_TAGGED_PRECISION_FLOOR)) {
      const m = metricsOf(rows, scenario);
      expect(
        m.eventPrecisionTagged,
        `${scenario}: precisão de identidade de evento abaixo do piso`,
      ).toBeGreaterThanOrEqual(floor - MARGIN);
    }
  });

  it("contraste: re-derivar da correlação CRUA (modo raw) fabrica mais FALSO-EVENTO que agregar falas (spoken)", () => {
    // Mede POR QUE a leitura fiel é "spoken": o modo raw re-deriva de TODOS os candidatos sem a
    // guarda 1-1/top-2 do motor, então pessoas SEM tag pegam evento (falso-evento) com mais
    // frequência e a precisão GLOBAL de evento cai. Somado sobre a suíte, o efeito é robusto.
    const spoken = runEventBenchmark("spoken");
    const raw = runEventBenchmark("raw");
    const falseSpoken = spoken.reduce((s, r) => s + r.m.falseEvents, 0);
    const falseRaw = raw.reduce((s, r) => s + r.m.falseEvents, 0);
    console.log(`falso-eventos na suíte: spoken=${falseSpoken} raw=${falseRaw}`);
    expect(falseRaw).toBeGreaterThan(falseSpoken);
  });

  it("parado: sem movimento não há correlação — nenhum evento é DECIDIDO (abstenção honesta)", () => {
    // Espelha o invariante do dono no nível de evento: sem sinal, o honesto é não decidir.
    const m = metricsOf(runEventBenchmark(), "parado");
    expect(m.decided).toBe(0);
    expect(m.episodesWithTag).toBeGreaterThan(0); // e havia eventos a decidir (não é vácuo)
  });
});

// ——— BONUS: consistência de evento sobre a GRAVAÇÃO REAL da caminhada (sem verdade anotada) ———
// GATED pela EXISTÊNCIA do arquivo (runtime/gitignored — ausente no CI, então SKIP; CI intacto).
// LEITURA APENAS: a gravação de campo é artefato imutável (CLAUDE.md §3). Sem verdade, mede só
// CONSISTÊNCIA (o z_comb aponta uma tag dominante estável dentro do episódio?), nunca precisão.
const WALK_FILES = [
  "server/bt/fusion-session-2026-07-11_19.jsonl",
  "server/bt/fusion-session-2026-07-11_20.jsonl",
];
const WALK_FILE = WALK_FILES.find((f) => existsSync(f));

describe.skipIf(!WALK_FILE)("event-metrics — gravação REAL da caminhada (consistência, sem verdade)", () => {
  it("mede a consistência do z_comb por episódio (tag dominante estável?)", () => {
    const lines = readFileSync(WALK_FILE!, "utf8").split(/\r?\n/);
    const { funnels, scenario } = diagnoseFusionSession(lines);

    const ticks: EventTick[] = funnels.map((f) => {
      const candByTrack = new Map<number, EventCandidate[]>();
      const spokeByTrack = new Map<number, string>();
      const ids = new Set<number>();
      for (const p of f.pairs) {
        ids.add(p.trackId);
        if (p.verdict === "SPOKE") spokeByTrack.set(p.trackId, p.tag);
        if (p.corr === null) continue;
        let arr = candByTrack.get(p.trackId);
        if (!arr) {
          arr = [];
          candByTrack.set(p.trackId, arr);
        }
        arr.push({ tag: p.tag, r: p.corr, n: p.alignedSamples });
      }
      const tracks: EventTrackObs[] = [...ids].map((id) => ({
        trackId: id,
        truthTag: null,
        spokenTag: spokeByTrack.get(id) ?? null,
        candidates: candByTrack.get(id) ?? [],
      }));
      return { ts: f.ts, tracks };
    });

    const episodes = computeEventConsistency(ticks);
    // Só os episódios com evidência agregável (dominantTag != null) e sustentação mínima.
    const sustained = episodes
      .filter((e) => e.dominantTag !== null && e.nTicks >= 10)
      .sort((a, b) => b.nTicks - a.nTicks);

    const out: string[] = ["EVENT-CONSISTENCY-BEGIN", `arquivo: ${WALK_FILE}`];
    out.push(
      `ticks processados: ${funnels.length} | H: ${scenario.H ? "calibrada" : "NULA (proxy)"} | ` +
        `episódios (presença contígua): ${episodes.length} | sustentados (≥10 ticks c/ evidência): ${sustained.length}`,
    );
    for (const e of sustained.slice(0, 15)) {
      out.push(
        `  track ${String(e.trackId).padStart(3)}: ${String(e.nTicks).padStart(4)} ticks | ` +
          `dominante ${e.dominantTag} score=${e.dominantScore.toFixed(3)} | ` +
          `concordância tick-a-tick ${(e.tickAgreement * 100).toFixed(1)}%`,
      );
    }
    if (sustained.length > 0) {
      const meanAgree = sustained.reduce((s, e) => s + e.tickAgreement, 0) / sustained.length;
      out.push(`concordância média dos episódios sustentados: ${(meanAgree * 100).toFixed(1)}%`);
    }
    out.push("EVENT-CONSISTENCY-END");
    console.log(out.join("\n"));

    expect(funnels.length).toBeGreaterThan(0);
  });
});
