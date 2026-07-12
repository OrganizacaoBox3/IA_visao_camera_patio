// EXPERIMENTO θ (Δ2 do ADR-014 item 9): θ, a inclinação da regressão RSSI = β + θ·(−log10 d), serve
// como 2º discriminador de identidade ALÉM do ranking por |r| (invariante afim)? MEDIÇÃO empírica da
// distribuição de θ dos pares VERDADEIROS vs ESPÚRIOS nos FUSION_SCENARIOS, usando a verdade
// truthTagByTrack do sim. Falseável e barato: o objetivo é DECIDIR se θ ajuda, não provar que ajuda.
//
// FUNIL DE HIPÓTESE (a lição do v4): o sim COMPARTILHA o modelo de RSSI com a hipótese θ. Um veredito
// POSITIVO aqui NÃO é prova — exige validação de campo (caminhada anotada). Um veredito NEGATIVO
// (θ largo/instável) é conclusivo: se nem no mundo-de-brinquedo θ separa, no campo separa menos.
import { describe, expect, it } from "vitest";
import { buildFusionFrame } from "./frame";
import { simulateFusionScenario } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import type { VisitTick, VisitTrackObs } from "./visit-metrics";
import {
  distanceWeights,
  extractPairSeries,
  fitTheta,
  median,
  quantile,
  type PairSeries,
  type ThetaFit,
} from "./theta-discriminator";

type ScenarioEntry = (typeof FUSION_SCENARIOS)[number];

// Cenários com distância MÉTRICA à MESMA origem do RSSI (θ tem unidade física de dB/década). Exclui:
//  - sem-calibracao: dist = proxy 1/bh (não-metro) → θ em unidade arbitrária;
//  - grade-sem-station: dist medida ao ponto default (0.5,1.0) ≠ estação real (0,0) → θ corrompido.
// Nesses dois θ não é comparável a 10·n; ficam fora da medição da distribuição física de θ.
const METRIC_SCENARIOS = new Set([
  "canonico",
  "parado",
  "bloco",
  "cruzamento",
  "ruido-alto",
  "multidao",
  "ancoras-canonico",
  "ancoras-multidao",
  "ancoras-multidao-bias",
  "ancoras-mismatch-n",
]);

/** Feed de VISITA de um cenário — CÓPIA fiel de visitTicksForScenario de visit-metrics.test.ts
 *  (buildFusionFrame de produção, MESMA exclusão de âncoras, verdade do sim; fantasmas fora). */
function visitTicksForScenario(entry: ScenarioEntry): VisitTick[] {
  const sc = simulateFusionScenario(entry.opts, entry.seed);
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

/** Um par candidato já com os dois ajustes (OLS e ponderado 1/σ²) prontos. */
type FittedPair = { p: PairSeries; ols: ThetaFit; wls: ThetaFit; scenario: string };

/** Extrai todos os pares de uma lista de cenários e ajusta θ (OLS e heterocedástico). */
function fittedPairs(scenarioNames?: Set<string>): FittedPair[] {
  const out: FittedPair[] = [];
  for (const entry of FUSION_SCENARIOS) {
    if (scenarioNames && !scenarioNames.has(entry.name)) continue;
    const ticks = visitTicksForScenario(entry);
    for (const p of extractPairSeries(ticks)) {
      const ols = fitTheta(p.dist, p.rssi);
      const wls = fitTheta(p.dist, p.rssi, distanceWeights(p.dist, "inv-sq"));
      out.push({ p, ols, wls, scenario: entry.name });
    }
  }
  return out;
}

/** Resumo mediana/IQR de uma amostra de θ. */
function summarize(xs: number[]): { n: number; med: number; q1: number; q3: number; iqr: number } {
  const med = median(xs);
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  return { n: xs.length, med, q1, q3, iqr: q3 - q1 };
}

const fmt = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "—");
const R_GATE = 0.7; // 1º discriminador: |r| alto. Espúrio "por acaso" = wrong-tag que PASSA este gate.

describe("theta-discriminator: primitivo de regressão ponderada RSSI = β + θ·(−log10 d)", () => {
  it("fitTheta: recupera θ e β de uma reta PERFEITA sem ruído (sanidade da matemática)", () => {
    // RSSI = -45 + 22·(−log10 d): θ=22 (=10·2,2), β=-45. Amostras em distâncias variadas.
    const dist = [0.5, 1, 2, 3, 4, 5, 6];
    const rssi = dist.map((d) => -45 + 22 * -Math.log10(d));
    const f = fitTheta(dist, rssi);
    expect(f.ok).toBe(true);
    expect(f.theta).toBeCloseTo(22, 6);
    expect(f.beta).toBeCloseTo(-45, 6);
    expect(f.r).toBeCloseTo(1, 6); // reta perfeita crescente em x → r=+1
    expect(f.r2).toBeCloseTo(1, 6);
  });

  it("fitTheta: guardas — n<2, distância constante (span 0) e RSSI constante → não-ok, sem NaN", () => {
    expect(fitTheta([1], [-50]).ok).toBe(false);
    expect(fitTheta([], []).ok).toBe(false);
    const constDist = fitTheta([2, 2, 2, 2], [-50, -52, -48, -51]);
    expect(constDist.ok).toBe(false);
    expect(Number.isNaN(constDist.theta)).toBe(false);
    const constRssi = fitTheta([1, 2, 3, 4], [-50, -50, -50, -50]);
    expect(constRssi.ok).toBe(false);
    expect(Number.isNaN(constRssi.theta)).toBe(false);
  });

  it("fitTheta: a correlação r é invariante afim mas θ NÃO — o ganho de informação do Δ2", () => {
    const dist = [0.5, 1, 1.5, 2, 3, 4, 5];
    const base = dist.map((d) => -45 + 22 * -Math.log10(d) + (d % 2 === 0 ? 1 : -1)); // ruído fixo
    const a = fitTheta(dist, base);
    const scaled = fitTheta(dist, base.map((y) => 3 * y + 100)); // transformação afim de y
    expect(scaled.r).toBeCloseTo(a.r, 9); // r: INVARIANTE afim
    expect(scaled.theta).toBeCloseTo(3 * a.theta, 6); // θ: escala com o ganho (carrega a escala)
  });

  it("determinístico: extrair+ajustar duas vezes dá os MESMOS θ", () => {
    const a = fittedPairs(METRIC_SCENARIOS).map((f) => f.ols.theta);
    const b = fittedPairs(METRIC_SCENARIOS).map((f) => f.ols.theta);
    expect(a).toEqual(b);
  });
});

describe("EXPERIMENTO θ: distribuição empírica θ_verdadeiro vs θ_espúrio (o veredito)", () => {
  it("MEDE a distribuição de θ e decide se separa pares verdadeiros de espúrios de |r| alto", () => {
    const pairs = fittedPairs(METRIC_SCENARIOS);

    // ——— θ por CENÁRIO dos pares VERDADEIROS: θ_verdadeiro é CONSTANTE físico ou varia? ———
    const out: string[] = ["THETA-BEGIN", "θ_verdadeiro (OLS) por cenário — θ é um número fixo?"];
    for (const entry of FUSION_SCENARIOS) {
      if (!METRIC_SCENARIOS.has(entry.name)) continue;
      const th = pairs.filter((f) => f.scenario === entry.name && f.p.isTrue && f.ols.ok).map((f) => f.ols.theta);
      if (th.length === 0) {
        out.push(`  ${entry.name.padEnd(22)} — sem par verdadeiro ajustável (span 0 / poucas amostras)`);
        continue;
      }
      const s = summarize(th);
      out.push(
        `  ${entry.name.padEnd(22)} n=${String(s.n).padStart(3)}  θ_med=${fmt(s.med).padStart(7)}  ` +
          `IQR=[${fmt(s.q1)},${fmt(s.q3)}]  (10·n do canal ≈ ${entry.opts.channelN ? (entry.opts.channelN * 10).toFixed(0) : "22"})`,
      );
    }

    // ——— Distribuições agregadas (OLS): verdadeiro vs espúrio, sem e com o gate |r| ———
    const trueTh = pairs.filter((f) => f.p.isTrue && f.ols.ok).map((f) => f.ols.theta);
    const spurTh = pairs.filter((f) => !f.p.isTrue && f.ols.ok).map((f) => f.ols.theta);
    const trueThGated = pairs.filter((f) => f.p.isTrue && f.ols.ok && Math.abs(f.ols.r) >= R_GATE).map((f) => f.ols.theta);
    const spurThGated = pairs.filter((f) => !f.p.isTrue && f.ols.ok && Math.abs(f.ols.r) >= R_GATE).map((f) => f.ols.theta);

    const sT = summarize(trueTh);
    const sS = summarize(spurTh);
    const sTg = summarize(trueThGated);
    const sSg = summarize(spurThGated);
    out.push("", "distribuição AGREGADA de θ (dB/década), OLS:");
    out.push(`  VERDADEIRO (todos ok):        n=${sT.n}  θ_med=${fmt(sT.med)}  IQR=[${fmt(sT.q1)},${fmt(sT.q3)}] (larg ${fmt(sT.iqr)})`);
    out.push(`  ESPÚRIO   (todos ok):         n=${sS.n}  θ_med=${fmt(sS.med)}  IQR=[${fmt(sS.q1)},${fmt(sS.q3)}] (larg ${fmt(sS.iqr)})`);
    out.push(`  VERDADEIRO ∩ |r|≥${R_GATE}:        n=${sTg.n}  θ_med=${fmt(sTg.med)}  IQR=[${fmt(sTg.q1)},${fmt(sTg.q3)}] (larg ${fmt(sTg.iqr)})`);
    out.push(`  ESPÚRIO   ∩ |r|≥${R_GATE} (perigo): n=${sSg.n}  θ_med=${fmt(sSg.med)}  IQR=[${fmt(sSg.q1)},${fmt(sSg.q3)}] (larg ${fmt(sSg.iqr)})`);

    // Fração de espúrios-perigosos (|r| alto) cujo θ cai DENTRO da faixa IQR dos verdadeiros — se
    // alta, θ NÃO separa (o filtro θ não rejeitaria esses falsos); se baixa, θ ajuda.
    const [lo, hi] = [sTg.q1, sTg.q3];
    const spurInBand = spurThGated.filter((t) => t >= lo && t <= hi).length;
    const spurBandFrac = spurThGated.length ? spurInBand / spurThGated.length : NaN;
    out.push(
      "",
      `faixa θ dos verdadeiros (IQR, |r|≥${R_GATE}) = [${fmt(lo)}, ${fmt(hi)}]  dB/década`,
      `espúrios-perigosos com θ DENTRO da faixa: ${spurInBand}/${spurThGated.length} = ${(spurBandFrac * 100).toFixed(0)}%`,
      `LEITURA: no NÍVEL DE DISTRIBUIÇÃO há um deslocamento de mediana (θ_verd~21 vs θ_espúrio~0), MAS`,
      `condicionado ao gate |r| o θ dos verdadeiros dispara pra ~35 com IQR [27,62] (a seleção por |r|`,
      `alto premia retas ÍNGREMES) e o θ dos espúrios-perigosos espalha [~-43,+43] (largura ${fmt(sSg.iqr)}).`,
      `As caudas se sobrepõem MACIÇAMENTE — o teste OPERACIONAL ao lado (decisão por episódio) é o juiz.`,
    );

    // ——— PONDERADO (heterocedástico 1/σ²): melhora a separação? ———
    const trueThW = pairs.filter((f) => f.p.isTrue && f.wls.ok && Math.abs(f.wls.r) >= R_GATE).map((f) => f.wls.theta);
    const spurThW = pairs.filter((f) => !f.p.isTrue && f.wls.ok && Math.abs(f.wls.r) >= R_GATE).map((f) => f.wls.theta);
    const sTw = summarize(trueThW);
    const sSw = summarize(spurThW);
    const [loW, hiW] = [sTw.q1, sTw.q3];
    const spurInBandW = spurThW.filter((t) => t >= loW && t <= hiW).length;
    const spurBandFracW = spurThW.length ? spurInBandW / spurThW.length : NaN;
    out.push(
      "",
      "PONDERADO heterocedástico (w=1/d², |r_w|≥" + R_GATE + "):",
      `  VERDADEIRO: n=${sTw.n} θ_med=${fmt(sTw.med)} IQR=[${fmt(sTw.q1)},${fmt(sTw.q3)}] (larg ${fmt(sTw.iqr)})`,
      `  ESPÚRIO:    n=${sSw.n} θ_med=${fmt(sSw.med)} IQR=[${fmt(sSw.q1)},${fmt(sSw.q3)}] (larg ${fmt(sSw.iqr)})`,
      `  espúrios na faixa: ${(spurBandFracW * 100).toFixed(0)}%  (OLS foi ${(spurBandFrac * 100).toFixed(0)}%)` +
        `  → ponderar ${spurBandFracW < spurBandFrac - 0.05 ? "MELHORA" : spurBandFracW > spurBandFrac + 0.05 ? "PIORA" : "≈ empata"} a separação`,
    );
    out.push("THETA-END");
    console.log(out.join("\n"));

    // Invariantes robustos (não o veredito, que é medido/relatado acima):
    expect(sT.n).toBeGreaterThan(10); // há pares verdadeiros ajustáveis
    expect(sS.n).toBeGreaterThan(10); // e espúrios
    expect(trueTh.every((t) => Number.isFinite(t))).toBe(true); // nenhum NaN
    expect(spurTh.every((t) => Number.isFinite(t))).toBe(true);
  });

  it("θ como 2º FILTRO: reduz falso-rótulo sem matar cobertura? — VEREDITO (decisão por episódio)", () => {
    // Decisão de identidade por episódio TAGGED: vencedor = maior r (casamento físico, x=−log10 d →
    // r>0). Baseline = só |r| (gate + r>0). θ-filtrado = idem + exigir θ do vencedor numa faixa
    // física dos verdadeiros. CIRCULARIDADE declarada: a faixa θ vem do MESMO sim (funil de hipótese)
    // — um ganho aqui seria HIPÓTESE a validar em campo, nunca prova. VARREMOS bandas de largura
    // crescente (IQR → 10–90 → 5–95): se NENHUM ponto de operação bate o baseline, θ é refutado.
    const pairs = fittedPairs(METRIC_SCENARIOS);
    const trueGated = pairs.filter((f) => f.p.isTrue && f.ols.ok && Math.abs(f.ols.r) >= R_GATE).map((f) => f.ols.theta);

    // Agrupa candidatos por episódio (scenario+trackId+truthTag identifica o episódio TAGGED).
    const byEpisode = new Map<string, FittedPair[]>();
    for (const f of pairs) {
      if (f.p.truthTag === null) continue; // só episódios com tag (a unidade que o cliente compra)
      const key = `${f.scenario}|${f.p.trackId}|${f.p.truthTag}`;
      const arr = byEpisode.get(key);
      if (arr) arr.push(f);
      else byEpisode.set(key, [f]);
    }
    const winners: FittedPair[] = [];
    for (const cands of byEpisode.values()) {
      const eligible = cands.filter((f) => f.ols.ok && f.ols.r >= R_GATE); // r>0 e |r|≥gate
      if (eligible.length === 0) continue;
      winners.push(
        eligible.reduce((best, f) =>
          f.ols.r > best.ols.r || (f.ols.r === best.ols.r && f.p.tag < best.p.tag) ? f : best,
        ),
      );
    }
    const baseDecided = winners.length;
    const baseCorrect = winners.filter((w) => w.p.isTrue).length;
    const basePrec = baseDecided ? baseCorrect / baseDecided : 0;

    /** Aplica um filtro de faixa θ [lo,hi] aos vencedores; devolve precisão/cobertura. */
    const withBand = (lo: number, hi: number): { dec: number; cor: number; prec: number } => {
      const kept = winners.filter((w) => w.ols.theta >= lo && w.ols.theta <= hi);
      const cor = kept.filter((w) => w.p.isTrue).length;
      return { dec: kept.length, cor, prec: kept.length ? cor / kept.length : 0 };
    };
    const bands: { name: string; lo: number; hi: number }[] = [
      { name: "IQR 25–75", lo: quantile(trueGated, 0.25), hi: quantile(trueGated, 0.75) },
      { name: "10–90    ", lo: quantile(trueGated, 0.1), hi: quantile(trueGated, 0.9) },
      { name: "05–95    ", lo: quantile(trueGated, 0.05), hi: quantile(trueGated, 0.95) },
    ];

    const out = [
      "THETA-FILTER-BEGIN",
      `BASELINE (|r|≥${R_GATE} só): decididos=${baseDecided} corretos=${baseCorrect} precisão=${(basePrec * 100).toFixed(1)}%`,
      "θ-FILTRADO por largura de faixa (a faixa vem dos MESMOS verdadeiros — otimista/circular):",
    ];
    let bestThetaPrec = 0;
    for (const b of bands) {
      const r = withBand(b.lo, b.hi);
      bestThetaPrec = Math.max(bestThetaPrec, r.prec);
      out.push(
        `  [${b.name}] θ∈[${fmt(b.lo)},${fmt(b.hi)}]: dec=${String(r.dec).padStart(2)} cor=${String(r.cor).padStart(2)} ` +
          `prec=${(r.prec * 100).toFixed(1).padStart(5)}%  Δprec=${((r.prec - basePrec) * 100).toFixed(1)}pp ` +
          `Δcob=${r.dec - baseDecided}`,
      );
    }
    const helps = bestThetaPrec > basePrec + 0.02;
    out.push(
      `VEREDITO: melhor precisão θ-filtrada = ${(bestThetaPrec * 100).toFixed(1)}% vs baseline ${(basePrec * 100).toFixed(1)}%` +
        ` → θ ${helps ? "AJUDA (validar em campo!)" : "NÃO ajuda — REFUTADO como 2º filtro"}` +
        ` (θ_verdadeiro largo/instável: viés corporal direcional + span radial minúsculo + n do canal variável).`,
      "THETA-FILTER-END",
    );
    console.log(out.join("\n"));

    // VEREDITO travado: no sim, nenhuma faixa θ supera o baseline de |r| (θ refutado como filtro). O
    // filtro é um AND → nunca aumenta cobertura; e a precisão não sobe (a faixa corta verdadeiros de
    // θ físico ~22 porque a seleção por |r| alto enviesa θ pra cima → o corte sangra os certos).
    expect(baseDecided).toBeGreaterThan(0);
    expect(bestThetaPrec).toBeLessThanOrEqual(basePrec); // θ NÃO melhora a precisão
    for (const b of bands) expect(withBand(b.lo, b.hi).dec).toBeLessThanOrEqual(baseDecided);
  });
});
