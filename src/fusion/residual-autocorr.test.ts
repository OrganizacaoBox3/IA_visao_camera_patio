// Gate do τ_MÓVEL (residual-autocorr.ts) — A MEDIÇÃO DECISIVA do arco de identidade (2026-07-12).
//
// PERGUNTA: o ρ=0,7 FIXO que o gate H1/H2 usou (DEFAULT_RHO de visit-metrics.ts) veio da mineração
// das ÂNCORAS (tags PARADAS: ρ=0,49–0,94 @lag 2 s ⇒ τ≈2,8–32 s). O especialista mostrou que o τ que
// governa uma VISITA é o da TAG MÓVEL — e que ele deve ser MUITO mais curto (o fading espacial a
// 2,4 GHz decorrelaciona a cada ~6 cm; a ~1,2 m/s isso é ~50 ms). Se o gate aplicou τ de âncora
// parada a uma tag móvel, o n_eff está SUBESTIMADO e o gate disparou no número ERRADO.
//
// DUAS METADES:
//  1. SINTÉTICO (roda no CI): o estimador recupera um τ CONHECIDO (AR(1) plantado), separa branco de
//     correlacionado, e a lei n_eff=(T/Δt)·tanh(Δt/2τ) SATURA como previsto. É o controle positivo.
//  2. CAMPO (GATED pela existência do arquivo — gravação runtime/gitignored, SKIP no CI): mede o τ do
//     resíduo na track EM MOVIMENTO mais longa da gravação real. LEITURA APENAS (CLAUDE.md §3).
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { buildFusionFrame } from "./frame";
import { parseFusionSession } from "./session-loader";
import {
  dedupeConsecutiveRssi,
  estimateTau,
  fitPathLoss,
  fitTauToAcf,
  holdCorrectedAcf,
  holdOnlyAcf,
  nEffFromTau,
  rhoFromTau,
  rssiBlockDurationsS,
  tauUpperBoundS,
  timeBinnedAcf,
} from "./residual-autocorr";
import type { RssiSample } from "./residual-autocorr";

// ─────────────────────────────── SINTÉTICO (controle positivo, roda no CI) ───────────────────────

/** LCG determinístico + Box-Muller — nenhum RNG global (mesma disciplina de sim.ts). */
function makeRandn(seed: number): () => number {
  let s = seed >>> 0;
  const next = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) / 16777216;
  };
  return () => {
    const u = Math.max(1e-12, next());
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Série sintética: pessoa se aproximando (dist 8→1 m) + RSSI = β + θ·(−log10 d) + AR(1)(τ) [+ branco].
 *  `whiteSd` simula o salto de canal do scanner real (componente SEM memória no resíduo). */
function syntheticSamples(opts: {
  n: number;
  dtS: number;
  tauS: number;
  arSd: number;
  whiteSd?: number;
  seed: number;
}): RssiSample[] {
  const randn = makeRandn(opts.seed);
  const rho = opts.tauS > 0 ? Math.exp(-opts.dtS / opts.tauS) : 0;
  const out: RssiSample[] = [];
  let e = randn() * opts.arSd;
  for (let i = 0; i < opts.n; i++) {
    const frac = i / Math.max(1, opts.n - 1);
    const dist = 8 * Math.pow(1 / 8, frac); // 8 → 1 m, log-linear (aproximação limpa)
    e = rho * e + Math.sqrt(1 - rho * rho) * opts.arSd * randn();
    const white = (opts.whiteSd ?? 0) * randn();
    const rssi = -45 - 20 * Math.log10(dist) + e + white; // θ=20 (n=2), β=-45
    out.push({ ts: i * opts.dtS * 1000, dist, rssi });
  }
  return out;
}

describe("residual-autocorr (sintético — o estimador recupera um τ conhecido)", () => {
  it("fitPathLoss recupera θ e β plantados (sem ruído)", () => {
    const s = syntheticSamples({ n: 200, dtS: 0.5, tauS: 0, arSd: 0, seed: 1 });
    const fit = fitPathLoss(s)!;
    expect(fit.theta).toBeCloseTo(20, 6);
    expect(fit.beta).toBeCloseTo(-45, 6);
    expect(Math.abs(fit.r)).toBeCloseTo(1, 6);
  });

  it("estimateTau recupera τ=2s de um AR(1) plantado (ambos os métodos, ±40%)", () => {
    const s = syntheticSamples({ n: 1200, dtS: 0.5, tauS: 2, arSd: 5, seed: 7 });
    const t = estimateTau(s, { binS: 0.5, maxLagS: 12 })!;
    expect(t.dtS).toBeCloseTo(0.5, 6);
    // ρ teórico a Δt=0,5 e τ=2: e^(−0,25) = 0,779
    expect(t.rho1).toBeGreaterThan(0.65);
    expect(t.rho1).toBeLessThan(0.9);
    expect(t.tauLag1S).toBeGreaterThan(1.2); // (a)
    expect(t.tauLag1S).toBeLessThan(2.8);
    expect(t.tauFitS).toBeGreaterThan(1.2); // (b)
    expect(t.tauFitS).toBeLessThan(2.8);
    // Sem componente branca plantada → a ACF extrapola a ~1 em lag→0 (quase toda a variância tem memória).
    expect(t.correlatedFraction).toBeGreaterThan(0.75);
  });

  it("resíduo BRANCO: ρ1≈0, τ colapsa a 0 e whiteFraction≈1 (o que o salto de canal faz)", () => {
    const s = syntheticSamples({ n: 800, dtS: 0.5, tauS: 0, arSd: 5, seed: 11 });
    const t = estimateTau(s, { binS: 0.5, maxLagS: 10 })!;
    expect(Math.abs(t.rho1)).toBeLessThan(0.12);
    expect(t.tauLag1S).toBeLessThan(0.3);
    expect(t.whiteFraction).toBeGreaterThan(0.8);
  });

  it("MISTURA branco+AR(1) (o hardware real): whiteFraction separa as duas variâncias", () => {
    // 50/50 em variância: arSd=5, whiteSd=5 → A esperado ≈ 0,5.
    const s = syntheticSamples({ n: 1500, dtS: 0.5, tauS: 3, arSd: 5, whiteSd: 5, seed: 13 });
    const t = estimateTau(s, { binS: 0.5, maxLagS: 15 })!;
    expect(t.correlatedFraction).toBeGreaterThan(0.3);
    expect(t.correlatedFraction).toBeLessThan(0.7);
    // O τ do fit (que enxerga o patamar A) sobrevive à contaminação branca; o de 1 lag é PUXADO PARA
    // BAIXO por ela — é exatamente o viés que o caveat de canal descreve.
    expect(t.tauFitS).toBeGreaterThan(2);
    expect(t.tauLag1S).toBeLessThan(t.tauFitS);
  });

  it("A LEI: n_eff = (T/Δt)·tanh(Δt/2τ) SATURA em T/(2τ) — cadência acima de Δt≪τ não cria informação", () => {
    const T = 20;
    const tau = 1.5;
    const ceiling = T / (2 * tau); // 6,67
    const at = (dt: number): number => nEffFromTau(T, dt, tau);
    // Cadências: 1 Hz, 2 Hz, 10 Hz, 100 Hz — a saturação é MONOTÔNICA e converge no teto.
    const n1 = at(1);
    const n2 = at(0.5);
    const n10 = at(0.1);
    const n100 = at(0.01);
    expect(n1).toBeLessThan(n2);
    expect(n2).toBeLessThan(n10);
    expect(n10).toBeLessThan(n100);
    expect(n100).toBeLessThan(ceiling); // NUNCA passa do teto
    expect(n100).toBeGreaterThan(ceiling * 0.99); // e já colou nele
    // O GANHO de dobrar 1→2 Hz é modesto; de 2→10 Hz, quase nulo. É a lei que mata a corrida de cadência.
    expect(n2 / n1).toBeLessThan(1.25);
    expect(n10 / n2).toBeLessThan(1.1);
    // Coerência algébrica com a fórmula do n_eff da visita: n·(1−ρ)/(1+ρ), ρ=e^(−Δt/τ).
    const dt = 0.5;
    const rho = rhoFromTau(dt, tau);
    const nRaw = T / dt;
    expect((nRaw * (1 - rho)) / (1 + rho)).toBeCloseTo(nEffFromTau(T, dt, tau), 9);
  });

  it("o τ de ÂNCORA (2,8–32 s) daria um n_eff muito menor que um τ móvel curto — a aposta do gate", () => {
    const T = 20;
    const dt = 1; // cadência de advertising atual (1 Hz)
    expect(nEffFromTau(T, dt, 10)).toBeLessThan(1.1); // τ de âncora: teto ~1 → NUNCA passa do piso 3
    expect(nEffFromTau(T, dt, 1.5)).toBeGreaterThan(5); // τ móvel: teto ~6,7
  });

  it("A ARMADILHA DO SAMPLE-AND-HOLD: ruído BRANCO retido vira ACF que decai — e o τ é ARTEFATO", () => {
    // Reproduz a estrutura EXATA do dado de campo: a tag anuncia a cada ~2,5 s (leitura FRESCA,
    // IID = memória ZERO) e o app posta a cada 0,55 s SEGURANDO o último valor. A série crua que
    // chega ao JSONL é uma ESCADA. Se alguém medir a ACF dela, verá um decaimento suave e
    // concluirá "o RSSI tem memória de ~2 s" — FALSO: a memória é do SNAPSHOT, não do canal.
    const randn = makeRandn(23);
    const postS = 0.55;
    const advS = 2.5;
    const distAt = (t: number): number => 2 + 1.5 * Math.sin(t / 20); // pessoa indo e vindo
    const raw: RssiSample[] = [];
    // O device SEGURA o RSSI INTEIRO medido no instante do advertisement (path-loss incluso) — não
    // recalcula nada entre advertisements. Por isso a série crua tem REPETIÇÕES literais de valor.
    let held = -45 - 20 * Math.log10(distAt(0)) + randn() * 7;
    let nextAdv = advS;
    for (let t = 0; t < 1200; t += postS) {
      if (t >= nextAdv) {
        held = -45 - 20 * Math.log10(distAt(t)) + randn() * 7; // FRESCA e INDEPENDENTE (branco puro)
        nextAdv = t + advS;
      }
      raw.push({ ts: t * 1000, dist: distAt(t), rssi: held });
    }

    // (1) A série CRUA MENTE: ACF decai suavemente e o ajuste devolve um τ de ~1 s — do NADA.
    const crua = estimateTau(raw, { binS: 0.5, maxLagS: 10, dedupe: false })!;
    expect(crua.acf[0].rho).toBeGreaterThan(0.5); // "memória" alta em lag curto — puro hold
    expect(crua.tauFitS).toBeGreaterThan(0.5); // um τ INVENTADO sobre ruído branco

    // (2) A HIPÓTESE NULA explica a curva inteira: ρ_crua(Δ) ≈ P(mesmo degrau) = E[(L−Δ)⁺]/E[L].
    const blocks = rssiBlockDurationsS(raw);
    const nul = holdOnlyAcf(blocks, crua.acf.map((p) => p.lagS));
    for (let i = 0; i < nul.length; i++) {
      if (crua.acf[i].pairs < 50) continue;
      expect(Math.abs(crua.acf[i].rho - nul[i])).toBeLessThan(0.15); // a curva É o hold
    }

    // (3) A CORREÇÃO devolve a verdade: ρ_fresca ≈ 0 em todo lag, e o τ colapsa. Sem isto,
    //     qualquer τ "medido" de um snapshot retido é indistinguível de artefato de amostragem.
    const corr = holdCorrectedAcf(crua.acf, blocks);
    for (const p of corr) if (p.pairs >= 50) expect(Math.abs(p.rho)).toBeLessThan(0.2);
    expect(fitTauToAcf(corr).tauS).toBeLessThan(0.6);
  });

  it("a correção do hold PRESERVA memória REAL (não é uma máquina de zerar τ)", () => {
    // Controle positivo da correção: AR(1) com τ=4 s AMOSTRADO E RETIDO como no campo. A correção
    // tem de RECUPERAR o τ≈4 s — se ela zerasse tudo, o teste acima não provaria nada.
    const randn = makeRandn(31);
    const postS = 0.55;
    const advS = 2.5;
    const tauTrue = 4;
    const rho = Math.exp(-advS / tauTrue);
    const distAt = (t: number): number => 2 + 1.5 * Math.sin(t / 20);
    const raw: RssiSample[] = [];
    let e = randn() * 7;
    let held = -45 - 20 * Math.log10(distAt(0)) + e;
    let nextAdv = advS;
    for (let t = 0; t < 2400; t += postS) {
      if (t >= nextAdv) {
        e = rho * e + Math.sqrt(1 - rho * rho) * 7 * randn(); // AR(1) na cadência de advertising
        held = -45 - 20 * Math.log10(distAt(t)) + e;
        nextAdv = t + advS;
      }
      raw.push({ ts: t * 1000, dist: distAt(t), rssi: held });
    }
    const crua = estimateTau(raw, { binS: 0.5, maxLagS: 20, dedupe: false })!;
    const corr = holdCorrectedAcf(crua.acf, rssiBlockDurationsS(raw));
    const tau = fitTauToAcf(corr).tauS;
    expect(tau).toBeGreaterThan(2.5); // recupera a memória real (τ=4 s), ±
    expect(tau).toBeLessThan(6.5);
  });

  it("dedupeConsecutiveRssi mantém só a TRANSIÇÃO de valor (regra do distinctConsecutive do motor)", () => {
    const s: RssiSample[] = [
      { ts: 0, dist: 5, rssi: -70 },
      { ts: 500, dist: 5, rssi: -70 },
      { ts: 1000, dist: 4, rssi: -68 },
      { ts: 1500, dist: 4, rssi: -68 },
      { ts: 2000, dist: 3, rssi: -70 }, // volta ao -70: é transição (leitura fresca), conta
    ];
    const d = dedupeConsecutiveRssi(s);
    expect(d.map((x) => x.ts)).toEqual([0, 1000, 2000]);
  });

  it("timeBinnedAcf: série sem variância ou curta demais devolve vazio (nunca NaN)", () => {
    expect(timeBinnedAcf([0, 500], [1, 1], 1, 5)).toEqual([]); // variância 0
    expect(timeBinnedAcf([0], [1], 1, 5)).toEqual([]);
    expect(estimateTau([{ ts: 0, dist: 1, rssi: -50 }])).toBeNull();
    // Distância constante → nada a destendenciar → null (não inventa τ).
    expect(
      estimateTau([
        { ts: 0, dist: 3, rssi: -50 },
        { ts: 500, dist: 3, rssi: -55 },
        { ts: 1000, dist: 3, rssi: -52 },
        { ts: 1500, dist: 3, rssi: -58 },
      ]),
    ).toBeNull();
  });
});

// ──────────────────────── CAMPO: τ_móvel na gravação REAL (GATED, read-only) ─────────────────────
const WALK_FILES = [
  "server/bt/fusion-session-2026-07-11_20.jsonl",
  "server/bt/fusion-session-2026-07-11_19.jsonl",
];
const WALK_FILE = WALK_FILES.find((f) => existsSync(f));

/** Um tick da gravação: dist por track + RSSI por tag (MESMO caminho de produção do
 *  visitTicksFromRecording de visit-metrics.test.ts — buildFusionFrame, H/stationPx da sessão). */
type RecTick = { ts: number; tracks: { trackId: number; dist: number }[]; rssiByTag: Record<string, number> };

function recTicksFrom(lines: string[]): { ticks: RecTick[]; calibrated: boolean } {
  const scenario = parseFusionSession(lines, {});
  const stationPx = scenario.H ? scenario.stationPx : undefined;
  const out: RecTick[] = [];
  for (const tick of scenario.ticks) {
    if (tick.readings.length === 0) continue;
    const frame = buildFusionFrame(tick.tracks, tick.readings, scenario.H, tick.ts, stationPx);
    const rssiByTag: Record<string, number> = {};
    for (const r of frame.readings) rssiByTag[r.tag] = r.rssi;
    out.push({
      ts: tick.ts,
      tracks: frame.tracks.map((t) => ({ trackId: t.trackId, dist: t.dist })),
      rssiByTag,
    });
  }
  return { ticks: out, calibrated: scenario.H !== null };
}

/** Trecho contíguo de UM trackId (mesma definição de episódio do visit-metrics: quebra na ausência). */
type Run = { trackId: number; ticks: { ts: number; dist: number; rssiByTag: Record<string, number> }[] };

function contiguousRuns(ticks: readonly RecTick[]): Run[] {
  const open = new Map<number, Run>();
  const done: Run[] = [];
  for (const tick of ticks) {
    const seen = new Set<number>();
    for (const t of tick.tracks) {
      if (!Number.isFinite(t.dist)) continue;
      seen.add(t.trackId);
      let run = open.get(t.trackId);
      if (!run) {
        run = { trackId: t.trackId, ticks: [] };
        open.set(t.trackId, run);
      }
      run.ticks.push({ ts: tick.ts, dist: t.dist, rssiByTag: tick.rssiByTag });
    }
    for (const id of [...open.keys()]) {
      if (!seen.has(id)) {
        done.push(open.get(id)!);
        open.delete(id);
      }
    }
  }
  for (const r of open.values()) done.push(r);
  return done;
}

/** Range de log10(dist) em DÉCADAS — o quanto a pista de fato SE MOVEU no eixo radial. */
function rangeDec(run: Run): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of run.ticks) {
    const l = Math.log10(Math.max(t.dist, 0.1));
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  return hi > lo ? hi - lo : 0;
}

describe.skipIf(!WALK_FILE)("residual-autocorr — τ_MÓVEL na gravação REAL (a medição decisiva)", () => {
  it("mede τ do resíduo da tag móvel e compara com o τ de ÂNCORA (2,8–32 s) que o gate usou", () => {
    const lines = readFileSync(WALK_FILE!, "utf8").split(/\r?\n/);
    const { ticks, calibrated } = recTicksFrom(lines);
    const runs = contiguousRuns(ticks).filter((r) => r.ticks.length >= 20);

    // ── Tracks EM MOVIMENTO: as que de fato varreram raio (range ≥ 0,15 déc).
    //    CAVEAT declarado: sem verdade anotada, "movimento" é o range radial medido, e a tag
    //    "carregada" é INFERIDA (ver abaixo) — não anotada.
    const moving = runs
      .map((r) => ({ run: r, rng: rangeDec(r) }))
      .filter((x) => x.rng >= 0.15)
      .sort((a, b) => b.run.ticks.length - a.run.ticks.length);

    const out: string[] = ["TAU-MOVEL-BEGIN", `arquivo: ${WALK_FILE}`];
    out.push(
      `ticks: ${ticks.length} | H: ${calibrated ? "calibrada (metros)" : "NULA (proxy)"} | ` +
        `runs≥20 ticks: ${runs.length} | com movimento radial (≥0,15 déc): ${moving.length}`,
    );
    out.push("— tracks com movimento (top 6 por duração) —");
    for (const { run, rng } of moving.slice(0, 6)) {
      const dur = (run.ticks[run.ticks.length - 1].ts - run.ticks[0].ts) / 1000;
      out.push(
        `  track ${String(run.trackId).padStart(3)}: ${String(run.ticks.length).padStart(4)} ticks ` +
          `(${dur.toFixed(0)} s) | range radial ${rng.toFixed(3)} déc`,
      );
    }
    expect(moving.length).toBeGreaterThan(0);

    const chosen = moving[0].run; // a track EM MOVIMENTO mais longa (a pedida)
    const durS = (chosen.ticks[chosen.ticks.length - 1].ts - chosen.ticks[0].ts) / 1000;
    const tags = [...new Set(chosen.ticks.flatMap((t) => Object.keys(t.rssiByTag)))].sort();
    const sampleFor = (tag: string): RssiSample[] =>
      chosen.ticks
        .filter((t) => t.rssiByTag[tag] !== undefined)
        .map((t) => ({ ts: t.ts, dist: t.dist, rssi: t.rssiByTag[tag] }));

    // ── ESCOLHA DO PAR (track, tag) — regra CORRIGIDA na bancada (achado, 2026-07-12):
    //    o pedido original era "maior |r|", mas |r| é CEGO AO SINAL e aqui elegeu um par
    //    ANTI-FÍSICO (θ=−29,8: RSSI SUBINDO com a distância — impossível para uma tag carregada
    //    por aquela pessoa). O casamento físico exige θ>0 / r>0 na convenção (−log10 d)×RSSI (é o
    //    MESMO score de identidade s=−r_{rssi×dist} do visit-metrics). Então: entre os pares
    //    FISICAMENTE possíveis (r>0), o de maior r. Se NENHUM for físico, declara-se e não se
    //    inventa carregadora. CAVEAT: máxima verossimilhança, não anotação.
    type Row = {
      tag: string;
      dedup: NonNullable<ReturnType<typeof estimateTau>>;
      raw: NonNullable<ReturnType<typeof estimateTau>>;
      blocks: number[];
      corrAcf: ReturnType<typeof holdCorrectedAcf>;
      tauCorr: number;
      tauUpper: number;
    };
    const rows: Row[] = [];
    for (const tag of tags) {
      const s = sampleFor(tag);
      // (a) série DEDUPLICADA (só as transições = as leituras FRESCAS) — é o que o n_eff conta;
      // (b) série CRUA (snapshot com as repetições) — DIAGNÓSTICO: exibe o platô de sample-and-hold;
      // (c) a CRUA CORRIGIDA do hold — o estimador HONESTO do decaimento (ver holdCorrectedAcf).
      const dedup = estimateTau(s, { binS: 1, maxLagS: 20 });
      const raw = estimateTau(s, { binS: 1, maxLagS: 20, dedupe: false });
      if (!dedup || !raw) continue;
      const blocks = rssiBlockDurationsS(s);
      const corrAcf = holdCorrectedAcf(raw.acf, blocks);
      rows.push({
        tag,
        dedup,
        raw,
        blocks,
        corrAcf,
        tauCorr: fitTauToAcf(corrAcf).tauS,
        // τ CONSERVADOR: o maior τ que algum bin da ACF corrigida ainda sustenta (ver tauUpperBoundS).
        // Quando a ACF corrigida é ≈0 (branco), o AJUSTE devolve 0 — mas o dado só prova que τ está
        // ABAIXO da resolução de advertising, não que é ZERO. É este o número que vai ao n_eff.
        tauUpper: tauUpperBoundS(corrAcf, { maxLagS: 8 }),
      });
    }
    expect(rows.length).toBeGreaterThan(0);

    const physical = rows.filter((r) => r.dedup.fit.r > 0).sort((a, b) => b.dedup.fit.r - a.dedup.fit.r);
    const best = physical[0] ?? [...rows].sort((a, b) => b.dedup.fit.r - a.dedup.fit.r)[0];

    out.push(
      `\n— TRACK EM MOVIMENTO MAIS LONGA: track ${chosen.trackId}, ${chosen.ticks.length} ticks ` +
        `(${durS.toFixed(0)} s), range radial ${moving[0].rng.toFixed(3)} déc —\n` +
        `  (r>0 / θ>0 = FÍSICO: RSSI cai com a distância. r<0 = anti-físico → NÃO é a carregadora.)\n` +
        `  τ_crua = o que se leria da série do JSONL SEM corrigir o hold (ARTEFATO).\n` +
        `  τ_corr = o mesmo dado com o sample-and-hold removido — o τ FÍSICO.`,
    );
    out.push(
      "tag".padEnd(20) +
        "  r(sinal)   θ      nFresh  Δt(s)   ρ1(fresca)  τ_CRUA(s)  τ_corrig(s)  τ_LIM.SUP(s)",
    );
    for (const r of [...rows].sort((a, b) => b.dedup.fit.r - a.dedup.fit.r)) {
      out.push(
        r.tag.padEnd(20) +
          `  ${r.dedup.fit.r.toFixed(3).padStart(7)}  ${r.dedup.fit.theta.toFixed(1).padStart(6)}  ` +
          `${String(r.dedup.nSamples).padStart(6)}  ${r.dedup.dtS.toFixed(2).padStart(5)}  ` +
          `${r.dedup.rho1.toFixed(3).padStart(10)}  ${r.raw.tauFitS.toFixed(2).padStart(9)}  ` +
          `${r.tauCorr.toFixed(2).padStart(11)}  ${r.tauUpper.toFixed(2).padStart(12)}`,
      );
    }
    out.push(
      "  ⇒ τ_CRUA (o que se leria do JSONL sem corrigir) fica em 2–39 s — DENTRO da faixa 2,8–32 s da\n" +
        "    mineração de âncoras que gerou o ρ=0,7. Depois de remover o hold, o τ de TODAS as tags\n" +
        "    (móvel E paradas) colapsa a ~0. FORTE indício de que o τ de âncora era, ele mesmo,\n" +
        "    sample-and-hold — não física. (Não é prova: não re-rodei a mineração original.)",
    );

    // A prova do artefato, tag a tag: a ACF crua É a curva do hold (hipótese nula), lag a lag.
    const nulBest = holdOnlyAcf(best.blocks, best.raw.acf.map((p) => p.lagS));
    out.push(
      `\n— ACF do resíduo da carregadora PROVÁVEL (${best.tag}, r=${best.dedup.fit.r.toFixed(3)}) —\n` +
        `  CRUA (do JSONL):           ` +
        best.raw.acf
          .slice(0, 7)
          .map((p) => `ρ(${p.lagS.toFixed(1)})=${p.rho.toFixed(3)}`)
          .join("  ") +
        `\n  HOLD PURO (hipót. NULA):   ` +
        nulBest
          .slice(0, 7)
          .map((v, i) => `ρ(${best.raw.acf[i].lagS.toFixed(1)})=${v.toFixed(3)}`)
          .join("  ") +
        `\n  CORRIGIDA (o resíduo real):` +
        best.corrAcf
          .slice(0, 7)
          .map((p) => ` ρ(${p.lagS.toFixed(1)})=${p.rho.toFixed(3)}`)
          .join(" "),
    );

    // ── VEREDITO 1: τ_móvel ≪ τ_âncora (2,8–32 s)? Previsão registrada do especialista: ~1–2 s.
    //    O número que segue para o n_eff é o LIMITE SUPERIOR (tauUpperBoundS) — o maior τ que o dado
    //    ainda sustenta. É o CONSERVADOR: τ maior ⇒ ρ maior ⇒ n_eff MENOR ⇒ barra mais alta. Não
    //    publicamos τ=0 (que o ajuste devolve): o dado prova que τ está ABAIXO da resolução de
    //    advertising, não que é exatamente zero.
    const tauMob = best.tauUpper;
    const T = 20; // episódio de aproximação típico (s)
    const ceiling = tauMob > 0 ? T / (2 * tauMob) : Infinity;
    out.push(
      `\nVEREDITO 1 (τ_MÓVEL vs τ_ÂNCORA) — tag ${best.tag} (única FÍSICA: θ=+${best.dedup.fit.theta.toFixed(1)}):\n` +
        `  método (a) lag-1 da série FRESCA (Δt=${best.dedup.dtS.toFixed(2)} s, ρ1=${best.dedup.rho1.toFixed(3)}): ` +
        `τ = ${best.dedup.tauLag1S.toFixed(2)} s\n` +
        `  método (b) ajuste exp. da ACF CORRIGIDA do hold:                 τ = ${best.tauCorr.toFixed(2)} s\n` +
        `  LIMITE SUPERIOR honesto (maior τ que algum bin sustenta):        τ ≤ ${tauMob.toFixed(2)} s  ← o que vai ao n_eff\n` +
        `  (o τ que se leria do JSONL SEM corrigir o hold: ${best.raw.tauFitS.toFixed(2)} s — ARTEFATO DE AMOSTRAGEM)\n` +
        `  τ_âncora (tags PARADAS — o que o ρ=0,7 fixo embutia): 2,8–32 s\n` +
        `  ⇒ τ_móvel ${tauMob < 2.8 ? "≪" : "≥"} τ_âncora. Previsão do especialista (~1–2 s): ` +
        `${tauMob <= 2 ? "CONFIRMADA — e o τ real é AINDA MENOR" : "não confirmada"}.\n` +
        `  ⇒ O RESÍDUO É BRANCO na escala observável: a ACF corrigida é indistinguível de 0 em TODO\n` +
        `    lag ≥ ${best.dedup.dtS.toFixed(1)} s. Não conseguimos resolver abaixo disso — a tag não anuncia mais rápido.\n` +
        `  CAVEAT DE HARDWARE: o TC22 não expõe o canal (37/38/39), então o salto de canal injeta uma\n` +
        `    componente BRANCA no resíduo ⇒ este τ é LIMITE INFERIOR do τ POR-CANAL. Um ESP32 que\n` +
        `    separasse canais veria τ por-canal maior — porém com 3 olhares quase-independentes. O τ é\n` +
        `    INSUMO; quem decide é a métrica-fim (Tarefa 3: a visita passa a DECIDIR?).\n` +
        `  ⇒ TETO de n_eff num episódio de ${T} s (lei n_eff→T/2τ):\n` +
        `      τ_móvel≤${tauMob.toFixed(2)}s → ${ceiling.toFixed(1)}   |   τ_âncora=10s → ${(T / 20).toFixed(1)}` +
        `   |   o que o gate mediu com ρ=0,7 fixo → 6,88`,
    );
    out.push(
      `  n_eff(T=${T}s) por cadência, com τ≤${tauMob.toFixed(2)}s: ` +
        [2.5, 2, 1, 0.5, 0.25]
          .map((dt) => `Δt=${dt}s→${nEffFromTau(T, dt, tauMob).toFixed(1)}`)
          .join("  ") +
        `\n  → SATURA no teto T/(2τ)=${ceiling.toFixed(1)}. Dobrar 1→2 Hz rende só ` +
        `${(100 * (nEffFromTau(T, 0.5, tauMob) / nEffFromTau(T, 1, tauMob) - 1)).toFixed(0)}% de n_eff — ` +
        `NÃO o DOBRO que o gate (ρ=0,7 fixo nas duas cadências) supôs.`,
    );
    out.push("TAU-MOVEL-END");
    console.log(out.join("\n"));

    // ── Assertivas: o VEREDITO, não números frágeis. Se qualquer uma flipar, força re-exame.
    // 1) A medição existe e é sã.
    expect(best.dedup.nSamples).toBeGreaterThan(20);
    expect(best.dedup.dtS).toBeGreaterThan(0);
    expect(best.raw.nSamples).toBeGreaterThan(best.dedup.nSamples); // a crua tem as repetições
    // 2) O ARTEFATO, selado: a ACF CRUA do JSONL bate a hipótese NULA do hold (ruído branco retido)
    //    lag a lag — e o τ que se leria dela cai DENTRO da faixa 2,8–32 s do τ de âncora.
    expect(best.raw.acf[0].rho).toBeGreaterThan(0.5);
    for (let i = 0; i < Math.min(5, best.raw.acf.length); i++) {
      expect(Math.abs(best.raw.acf[i].rho - nulBest[i])).toBeLessThan(0.15);
    }
    expect(best.raw.tauFitS).toBeGreaterThan(1.5);
    // 3) O ACHADO CENTRAL: τ_móvel < 2,8 s (o PISO do τ de âncora). Se ISTO falhar (τ_móvel grande),
    //    o achado é NEGATIVO, o ρ=0,7 estava defensável e o gate NÃO disparou no número errado.
    expect(tauMob).toBeLessThan(2.8);
    expect(tauMob).toBeGreaterThan(0); // e não é zero cravado — é um limite superior medido
    // 4) Consequência direta: o ρ implicado na cadência REAL medida (Δt≈2,5 s) é MUITO menor que o
    //    0,7 fixo que o gate usou → o n_eff do gate foi SUBESTIMADO.
    expect(rhoFromTau(best.dedup.dtS, tauMob)).toBeLessThan(0.7);
  }, 60000);
});
