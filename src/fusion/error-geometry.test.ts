// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A GEOMETRIA DO ERRO — os erros CORRELACIONADOS (Regra 13: 41,2% de repetição contra 8,8% de teto
// de independência, 4,7× acima) se CONCENTRAM numa região geométrica identificável?
//
// A PREVISÃO DO REVISOR (registrada ANTES do número): SIM, e a tangencialidade é a 1ª suspeita.
// Se os erros se concentram, há um VETO barato (abster na região tóxica) que ataca a CAUSA e não a
// média — ao contrário de subir o piso de n_eff, que compra precisão CEGANDO o sistema em todo lugar.
//
// ‼ CIRCULARIDADE (declarada, doutrina §5) — a defesa é ESTRUTURAL, não retórica:
//   (1) Toda feature é de TRAJETÓRIA (pé no mundo via H⁻¹ + posição cadastrada da estação). Nenhuma
//       toca RSSI/r/z/n_eff. O veto é computável EM CAMPO, com a câmera que já existe, ANTES de o
//       motor falar.
//   (2) Os FUSION_SCENARIOS NÃO LIGAM `bodyBias` (nenhum deles) — o viés corporal direcional do sim
//       NEM EXISTE no gerador do experimento principal. Logo, o que se achar ali é geometria pura,
//       e é IMPOSSÍVEL que seja o modelo de sombra do sim voltando pela porta dos fundos. O braço
//       "bodyBias LIGADO" roda só como ROBUSTEZ (o veto sobrevive a uma física mais suja?), nunca
//       como derivação.
//
// POPULAÇÃO: a MESMA em que os 41,2% foram medidos — receptor no DESTINO, cadência 1 Hz
// (rssiPeriodTicks=2), τ→0 (ρ=0, o resíduo móvel é branco), piso n_eff=10, 8 sementes por cenário.
// (Réplicas de Monte-Carlo = pessoas DIFERENTES, não a mesma medida duas vezes.)
// ‼ Os números ABSOLUTOS (precisão/cobertura) são do SIMULADOR ⇒ INDICATIVOS. O que é honesto aqui é
//   a ESTRUTURA: os erros se concentram ou não numa geometria, e a que preço um veto os remove.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { REAL_TAG_PERIOD_TICKS, simulateFusionScenario } from "./sim";
import type { SimFusionScenario, SimOpts } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { buildFusionFrame } from "./frame";
import { computeVisitEpisodes, formatProportion, wilsonInterval } from "./visit-metrics";
import type { VisitEpisode, VisitTick, VisitTrackObs } from "./visit-metrics";
import { episodeDecisionAt } from "./anchor-policy";
import { pixelToWorld } from "../vision/homography";
import type { Pt } from "./receiver-geometry";
import {
  DEFAULT_VETO,
  binnedPrecision,
  episodeGeometry,
  errorAgreement,
  evaluateVeto,
  featureContrast,
  geometricVeto,
} from "./error-geometry";
import type {
  DecidedGeom,
  EpisodeGeometry,
  GeomFeature,
  GeomTick,
  VetoFn,
} from "./error-geometry";

// ─────────────────────────── 1) A GEOMETRIA, isolada (unidade pura) ───────────────────────────

/** Ticks de geometria a partir de posições cravadas à mão: `poss[i]` = posições no tick i. */
function handTicks(poss: Pt[][], ids: number[] = [1]): GeomTick[] {
  return poss.map((row, i) => ({
    ts: i * 500,
    obs: row.map((pos, k) => ({ trackId: ids[k] ?? k + 1, pos })),
  }));
}

const STATION: Pt = { x: 0, y: 0 };

describe("error-geometry — as features de trajetória (nenhuma toca em RSSI)", () => {
  it("trajetória RADIAL pura (reta em direção à estação): tangencialidade 0, netRadial 1", () => {
    const ticks = handTicks([[{ x: 8, y: 0 }], [{ x: 6, y: 0 }], [{ x: 4, y: 0 }], [{ x: 2, y: 0 }]]);
    const g = episodeGeometry(ticks, 1, 0, 1500, STATION)!;
    expect(g.tangentiality).toBeCloseTo(0, 6);
    expect(g.netRadialFrac).toBeCloseTo(1, 6);
    expect(g.rangeDecades).toBeCloseTo(Math.log10(8 / 2), 6);
    expect(g.bearingSpreadDeg).toBeCloseTo(0, 6); // aproximação em linha reta: bearing constante
  });

  it("trajetória TANGENCIAL pura (arco ao redor da estação): tangencialidade ~1, span radial ~0", () => {
    // 4 pontos num círculo de raio 5 — a distância à estação NUNCA muda (gradiente radial = 0).
    const arc = [0, 15, 30, 45].map((deg) => [
      { x: 5 * Math.cos((deg * Math.PI) / 180), y: 5 * Math.sin((deg * Math.PI) / 180) },
    ]);
    const g = episodeGeometry(handTicks(arc), 1, 0, 1500, STATION)!;
    expect(g.tangentiality).toBeGreaterThan(0.999); // Σ|Δd| ≈ 0 sobre um caminho de comprimento >0
    expect(g.rangeDecades).toBeLessThan(1e-9);
    expect(g.netRadialFrac).toBeCloseTo(0, 6);
    expect(g.bearingSpreadDeg).toBeCloseTo(45, 3); // varreu 45° de bearing sem mudar de raio
  });

  it("RIVAL espelhado (anda em paralelo, mesmo perfil radial) ⇒ rivalDistCorr ≈ +1", () => {
    // Duas pessoas se aproximando juntas: 8→2 m e 8,5→2,5 m. O RSSI da tag DELE cai igual ao meu.
    const ticks = handTicks(
      [
        [{ x: 8, y: 0 }, { x: 8, y: 1 }],
        [{ x: 6, y: 0 }, { x: 6, y: 1 }],
        [{ x: 4, y: 0 }, { x: 4, y: 1 }],
        [{ x: 2, y: 0 }, { x: 2, y: 1 }],
      ],
      [1, 2],
    );
    const g = episodeGeometry(ticks, 1, 0, 1500, STATION)!;
    expect(g.rivalDistCorr).toBeGreaterThan(0.99);
    expect(g.neighborMinM).toBeCloseTo(1, 6);
  });

  it("RIVAL em CONTRAMÃO (ele se afasta enquanto eu chego) ⇒ rivalDistCorr negativo (separável)", () => {
    const ticks = handTicks(
      [
        [{ x: 8, y: 0 }, { x: 2, y: 2 }],
        [{ x: 6, y: 0 }, { x: 4, y: 2 }],
        [{ x: 4, y: 0 }, { x: 6, y: 2 }],
        [{ x: 2, y: 0 }, { x: 8, y: 2 }],
      ],
      [1, 2],
    );
    const g = episodeGeometry(ticks, 1, 0, 1500, STATION)!;
    expect(g.rivalDistCorr).toBeLessThan(-0.9);
  });

  it("sem vizinho: neighbor* = Infinity e rivalDistCorr = −1 (AUSÊNCIA de dado, nunca NaN)", () => {
    const g = episodeGeometry(handTicks([[{ x: 8, y: 0 }], [{ x: 4, y: 0 }]]), 1, 0, 500, STATION)!;
    expect(g.neighborMinM).toBe(Infinity);
    expect(g.neighborMedianM).toBe(Infinity);
    expect(g.rivalDistCorr).toBe(-1);
  });

  it("janela com <2 pontos → null (nada a medir; nunca NaN mudo)", () => {
    expect(episodeGeometry(handTicks([[{ x: 8, y: 0 }]]), 1, 0, 0, STATION)).toBeNull();
    expect(episodeGeometry(handTicks([[{ x: 8, y: 0 }]]), 99, 0, 5000, STATION)).toBeNull();
  });

  it("PARADO (caminho degenerado): tangencialidade 0 por convenção, não 1 (0/0 não vira tóxico)", () => {
    const g = episodeGeometry(handTicks([[{ x: 4, y: 0 }], [{ x: 4, y: 0 }]]), 1, 0, 500, STATION)!;
    expect(g.tangentiality).toBe(0);
    expect(g.netRadialFrac).toBe(0);
    expect(g.headingToStationDeg).toBe(0); // sem heading real — não inventamos orientação
  });

  it("headingToStation: andar DE FRENTE p/ a estação ≈ 0°; andar EMBORA ≈ 180°", () => {
    const chegando = episodeGeometry(
      handTicks([[{ x: 8, y: 0 }], [{ x: 6, y: 0 }], [{ x: 4, y: 0 }]]),
      1,
      0,
      1000,
      STATION,
    )!;
    const indo = episodeGeometry(
      handTicks([[{ x: 4, y: 0 }], [{ x: 6, y: 0 }], [{ x: 8, y: 0 }]]),
      1,
      0,
      1000,
      STATION,
    )!;
    expect(chegando.headingToStationDeg).toBeCloseTo(0, 3);
    expect(indo.headingToStationDeg).toBeCloseTo(180, 3);
  });
});

describe("error-geometry — o contraste e o veto, isolados", () => {
  const mk = (tangentiality: number, rivalDistCorr: number, correct: boolean, op = "x"): DecidedGeom => ({
    operator: op,
    trackId: 1,
    startTs: 0,
    geom: {
      nPts: 10,
      durationS: 5,
      pathLenM: 5,
      speedMs: 1,
      distStartM: 5,
      distEndM: 3,
      distMinM: 3,
      distMaxM: 5,
      distMeanM: 4,
      rangeDecades: 0.2,
      tangentiality,
      netRadialFrac: 0.5,
      bearingMeanDeg: 45,
      bearingSpreadDeg: 10,
      headingToStationDeg: 30,
      neighborMinM: 2,
      neighborMedianM: 3,
      rivalDistCorr,
    },
    correct,
    repeatedError: false,
  });

  it("featureContrast: separação PERFEITA ⇒ AUC 1; nenhuma separação ⇒ AUC 0,5", () => {
    const perfeito = [mk(0.9, 0, false), mk(0.85, 0, false), mk(0.1, 0, true), mk(0.2, 0, true)];
    expect(featureContrast(perfeito, "tangentiality").auc).toBe(1);
    expect(featureContrast(perfeito, "tangentiality").separation).toBe(1);
    const nada = [mk(0.5, 0, false), mk(0.5, 0, true)];
    expect(featureContrast(nada, "tangentiality").auc).toBe(0.5); // empate ⇒ 0,5 (correção de ties)
  });

  it("evaluateVeto: contabiliza erro removido × acerto sacrificado × cobertura paga", () => {
    const pop = [mk(0.9, 0, false), mk(0.9, 0, false), mk(0.1, 0, true), mk(0.9, 0, true)];
    const out = evaluateVeto(pop, 10, (g) => g.tangentiality > 0.5);
    expect(out.decidedBefore).toBe(4);
    expect(out.errorsBefore).toBe(2);
    expect(out.vetoed).toBe(3);
    expect(out.errorsVetoed).toBe(2); // os DOIS erros
    expect(out.correctVetoed).toBe(1); // …ao custo de UM acerto
    expect(out.decidedAfter).toBe(1);
    expect(out.precisionAfter).toBe(1);
    expect(out.errorRecall).toBe(1);
    expect(out.coverageBefore).toBeCloseTo(0.4, 6); // 4/10 episódios-com-tag
    expect(out.coverageAfter).toBeCloseTo(0.1, 6);
  });

  it("geometricVeto: é a DISJUNÇÃO das duas causas (tangencial OU rival confundível)", () => {
    expect(geometricVeto(mk(0.9, 0, true).geom)).toBe(true); // causa A
    expect(geometricVeto(mk(0.1, 0.95, true).geom)).toBe(true); // causa B
    expect(geometricVeto(mk(0.1, 0, true).geom)).toBe(false); // nenhuma
  });

  it("errorAgreement: o 1º erra e o 2º REPETE o mesmo erro ⇒ concordância-no-erro 100% (n=1)", () => {
    const a = { ...mk(0.5, 0, false, "op1"), startTs: 0 };
    const b = { ...mk(0.5, 0, false, "op1"), startTs: 10000 };
    const r = errorAgreement([a, b], () => "BB:BB"); // ambos decidiram a MESMA tag errada
    expect(r.firstWrong).toBe(1);
    expect(r.firstWrongAndAgree).toBe(1);
    expect(r.agreementOnFailure).toBe(1);
    expect(r.lo95).toBeLessThan(1); // 1/1 NÃO é 100% (Wilson) — Regra 10
  });
});

// ══════════════════════════════ 2) A BANCADA — a região tóxica existe? ═══════════════════════════

const PERSON0_MAC = "AA:AA";
const DEST_LAST_N = 20;
const SEED_REPLICATES = 8;
const PISO = 10; // piso de n_eff onde os 41,2% da Regra 13 foram medidos
const CADENCE = 2; // rssiPeriodTicks=2 ⇒ 1 Hz (a cadência da medição da Regra 13)

type ScenarioEntry = (typeof FUSION_SCENARIOS)[number];

/** Mesmo escopo do experimento do receptor-no-destino: com movimento, calibrado e com stationPx. */
function inOverrideScope(entry: ScenarioEntry): boolean {
  return entry.opts.walk !== "parado" && !entry.opts.uncalibrated && entry.omitStationPx !== true;
}

/** Trajetória VERDADEIRA da pessoa 0 (pé por H⁻¹, pxJitter:0) — só para LOCALIZAR o destino. */
function person0Trajectory(opts: SimOpts, seed: number): Pt[] {
  const sc = simulateFusionScenario({ ...opts, pxJitter: 0, uncalibrated: false }, seed);
  const H = sc.H;
  const out: Pt[] = [];
  if (!H) return out;
  for (const tick of sc.ticks) {
    for (const trk of tick.tracks) {
      if (tick.truthTagByTrack[trk.id] !== PERSON0_MAC) continue;
      const w = pixelToWorld(H, { x: trk.bbox[0] + trk.bbox[2] / 2, y: trk.bbox[1] + trk.bbox[3] });
      if (w) out.push(w);
    }
  }
  return out;
}

function destinationOf(traj: Pt[]): Pt {
  const tail = traj.slice(Math.max(0, traj.length - DEST_LAST_N));
  return {
    x: tail.reduce((s, p) => s + p.x, 0) / tail.length,
    y: tail.reduce((s, p) => s + p.y, 0) / tail.length,
  };
}

/** Feed de VISITA (o que o motor consome) — buildFusionFrame de produção, âncoras excluídas. */
function visitTicksFromScenario(sc: SimFusionScenario): VisitTick[] {
  const excludeTags =
    sc.anchors && sc.anchors.length > 0
      ? new Set(sc.anchors.map((a) => a.mac.toUpperCase()))
      : undefined;
  const out: VisitTick[] = [];
  for (const tick of sc.ticks) {
    if (tick.readings.length === 0) continue;
    const frame = buildFusionFrame(tick.tracks, tick.readings, sc.H, tick.ts, sc.stationPx, excludeTags);
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

/**
 * Feed de GEOMETRIA — o que a CÂMERA vê: o pé de cada pista projetado ao mundo por H⁻¹. É o MESMO
 * pixel do track que o motor já usa (bbox bottom-center), com o MESMO ruído de detecção; nenhuma
 * verdade privilegiada do simulador entra aqui (não usamos as posições-verdade das pessoas). Isto é
 * o que torna o veto computável em CAMPO.
 */
function geomTicksFromScenario(sc: SimFusionScenario): GeomTick[] {
  const H = sc.H;
  if (!H) return [];
  return sc.ticks.map((tick) => ({
    ts: tick.ts,
    obs: tick.tracks.flatMap((trk) => {
      const w = pixelToWorld(H, { x: trk.bbox[0] + trk.bbox[2] / 2, y: trk.bbox[1] + trk.bbox[3] });
      return w ? [{ trackId: trk.id, pos: w }] : [];
    }),
  }));
}

/** Um episódio-com-tag colhido: a VERDADE + os candidatos (que o piso NÃO altera) + a GEOMETRIA. */
type HarvestRow = {
  operator: string;
  episode: VisitEpisode;
  geom: EpisodeGeometry | null;
};
type Harvest = { rows: HarvestRow[]; episodesWithTag: number };
type Decisions = { decided: DecidedGeom[]; episodesWithTag: number; tagOf: Map<DecidedGeom, string> };

/**
 * A COLHEITA (uma passada de simulação, INDEPENDENTE do piso): episódios-com-tag da suíte, com o
 * receptor no DESTINO, cada um com a GEOMETRIA da sua janela.
 *
 * O PISO NÃO ENTRA AQUI DE PROPÓSITO: r/z/n_eff de um candidato NÃO dependem do piso — só o GATE
 * depende (é exatamente para isso que `significantAt`/`episodeDecisionAt` existem em
 * anchor-policy.ts). Varrer pisos sobre UMA colheita é (a) a comparação HONESTA (a mesma população
 * em todos os pisos — nada de re-sortear trajetórias entre linhas da tabela) e (b) ~6× mais barato
 * que re-simular por piso. `extraOpts` permite o braço de ROBUSTEZ (bodyBias) sem tocar no principal.
 */
const harvestCache = new Map<string, Harvest>();
function harvest(key: string, extraOpts: Partial<SimOpts> = {}): Harvest {
  const hit = harvestCache.get(key);
  if (hit) return hit;
  const rows: HarvestRow[] = [];
  let episodesWithTag = 0;
  for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
    for (let r = 0; r < SEED_REPLICATES; r++) {
      const seed = entry.seed + 1000 * r;
      const base = { ...entry.opts, rssiPeriodTicks: CADENCE, ...extraOpts };
      const traj = person0Trajectory(base, seed);
      if (traj.length < 2) continue;
      const station = destinationOf(traj);
      const sc = simulateFusionScenario({ ...base, stationWorldOverride: station }, seed);
      const geomTicks = geomTicksFromScenario(sc);
      // ρ=0 (τ→0, o resíduo móvel é BRANCO). SEM minNEff: o gate é aplicado depois, por piso.
      for (const e of computeVisitEpisodes(visitTicksFromScenario(sc), { rho: 0 })) {
        if (e.truthTag === null || e.candidates.length === 0) continue;
        episodesWithTag++;
        rows.push({
          operator: `${entry.name}#${seed}|${e.truthTag}`,
          episode: e,
          geom: episodeGeometry(geomTicks, e.trackId, e.startTs, e.endTs, station),
        });
      }
    }
  }
  const out = { rows, episodesWithTag };
  harvestCache.set(key, out);
  return out;
}

/** As DECISÕES de uma colheita sob um piso de n_eff — o gate recomputado sem re-simular. */
const decisionCache = new Map<string, Decisions>();
function decisionsAt(key: string, piso: number, extraOpts: Partial<SimOpts> = {}): Decisions {
  const ck = `${key}|${piso}`;
  const hit = decisionCache.get(ck);
  if (hit) return hit;
  const { rows, episodesWithTag } = harvest(key, extraOpts);
  const decided: DecidedGeom[] = [];
  const tagOf = new Map<DecidedGeom, string>();
  for (const row of rows) {
    const d = episodeDecisionAt(row.episode, piso);
    if (d.tag === null) continue; // abstenção honesta do motor — não é decisão, não entra
    if (row.geom === null) continue; // sem trajetória mensurável (não ocorre com nTicks≥2)
    const dg: DecidedGeom = {
      operator: row.operator,
      trackId: row.episode.trackId,
      startTs: row.episode.startTs,
      geom: row.geom,
      correct: d.tag === row.episode.truthTag,
      repeatedError: false, // preenchido abaixo (precisa da população do operador)
    };
    decided.push(dg);
    tagOf.set(dg, d.tag);
  }
  // ERRO REPETIDO (a assinatura da Regra 13): erra E outro episódio do MESMO operador comete o
  // MESMO erro (mesma tag errada). É a subpopulação onde a causa ESTÁVEL tem de aparecer mais forte.
  const byOp = new Map<string, DecidedGeom[]>();
  for (const e of decided) {
    const l = byOp.get(e.operator) ?? [];
    l.push(e);
    byOp.set(e.operator, l);
  }
  for (const list of byOp.values()) {
    for (const e of list) {
      if (e.correct) continue;
      const mine = tagOf.get(e)!;
      if (list.some((o) => o !== e && !o.correct && tagOf.get(o) === mine)) e.repeatedError = true;
    }
  }
  const out = { decided, episodesWithTag, tagOf };
  decisionCache.set(ck, out);
  return out;
}

const pc = (x: number): string => (100 * x).toFixed(1);

/** As features testadas — TODAS de trajetória. A coluna OBS diz o que sobrevive fora do simulador. */
const FEATURES: { f: GeomFeature; obs: "CÂMERA" | "SEMI-CIRC" }[] = [
  { f: "tangentiality", obs: "CÂMERA" },
  { f: "rivalDistCorr", obs: "CÂMERA" },
  { f: "netRadialFrac", obs: "CÂMERA" },
  { f: "rangeDecades", obs: "CÂMERA" },
  { f: "distMeanM", obs: "CÂMERA" },
  { f: "distMinM", obs: "CÂMERA" },
  { f: "bearingSpreadDeg", obs: "CÂMERA" },
  { f: "bearingMeanDeg", obs: "CÂMERA" },
  { f: "neighborMinM", obs: "CÂMERA" },
  { f: "neighborMedianM", obs: "CÂMERA" },
  { f: "durationS", obs: "CÂMERA" },
  { f: "speedMs", obs: "CÂMERA" },
  { f: "headingToStationDeg", obs: "SEMI-CIRC" },
];

describe("A REGIÃO TÓXICA — os erros correlacionados se concentram numa geometria?", () => {
  it(
    "TAREFA 1+2 — as features geométricas dos episódios DECIDIDOS, e o contraste CERTO × ERRADO",
    () => {
      const { decided, episodesWithTag } = decisionsAt("principal", PISO);
      const wrong = decided.filter((e) => !e.correct);
      const repeated = decided.filter((e) => e.repeatedError);
      expect(decided.length).toBeGreaterThan(50); // a população existe

      const head =
        "feature".padEnd(22) +
        "OBS".padEnd(11) +
        "med(CERTO)".padStart(11) +
        "med(ERRO)".padStart(11) +
        "  AUC(erro>certo)  sep    AUC(só REPETIDO)";
      const lines = [head, "-".repeat(head.length)];
      for (const { f, obs } of FEATURES) {
        const c = featureContrast(decided, f);
        const rep = featureContrast(decided, f, true);
        lines.push(
          f.padEnd(22) +
            obs.padEnd(11) +
            c.medianCorrect.toFixed(3).padStart(11) +
            c.medianWrong.toFixed(3).padStart(11) +
            c.auc.toFixed(3).padStart(15) +
            c.separation.toFixed(3).padStart(7) +
            `${rep.auc.toFixed(3)} (n=${rep.nWrong})`.padStart(20),
        );
      }
      console.log(
        `\n═══ CONTRASTE GEOMÉTRICO — episódios DECIDIDOS (receptor no destino, 1 Hz, piso n_eff=${PISO}) ═══\n` +
          `população: ${decided.length} decisões (${wrong.length} ERROS, ${repeated.length} deles REPETIDOS) ` +
          `sobre ${episodesWithTag} episódios-com-tag\n` +
          `precisão base: ${formatProportion(decided.length - wrong.length, decided.length)}\n` +
          `AUC = P(um ERRO sorteado tem a feature MAIOR que um ACERTO sorteado). 0,5 = a feature não sabe de nada.\n` +
          `${lines.join("\n")}`,
      );

      // Ranking pela força de separação — a resposta a "EM QUAL geometria?"
      const ranked = [...FEATURES]
        .map(({ f, obs }) => ({ obs, c: featureContrast(decided, f) }))
        .sort((a, b) => b.c.separation - a.c.separation);
      console.log(
        `\nTOP-3 separadores: ` +
          ranked
            .slice(0, 3)
            .map((r) => `${r.c.feature} (AUC ${r.c.auc.toFixed(3)}, ${r.obs})`)
            .join("  |  "),
      );

      // ── A PREVISÃO DO REVISOR, testada: a TANGENCIALIDADE é a 1ª suspeita ──
      const tan = featureContrast(decided, "tangentiality");
      const rival = featureContrast(decided, "rivalDistCorr");
      console.log(
        `\nA PREVISÃO ("a tangencialidade é a 1ª suspeita"), confrontada:\n` +
          `  tangentiality: AUC ${tan.auc.toFixed(3)} (mediana certo ${tan.medianCorrect.toFixed(3)} → erro ${tan.medianWrong.toFixed(3)})\n` +
          `  rivalDistCorr: AUC ${rival.auc.toFixed(3)} (mediana certo ${rival.medianCorrect.toFixed(3)} → erro ${rival.medianWrong.toFixed(3)})`,
      );

      // Determinismo — a colheita repete números idênticos.
      expect(decisionsAt("principal", PISO).decided.length).toBe(decided.length);
      // Há erros a explicar (senão não há o que vetar) e eles NÃO são todos isolados.
      expect(wrong.length).toBeGreaterThan(5);
      // Ao menos UMA feature de trajetória separa erro de acerto de forma não-trivial. Se ISTO
      // falhar, a previsão do revisor está REFUTADA (erros difusos) — e o teste força re-exame.
      const best = ranked[0].c;
      expect(best.separation).toBeGreaterThan(0.1);
    },
    240000,
  );

  it(
    "TAREFA 2b — a PRECISÃO por faixa das duas suspeitas: existe uma REGIÃO tóxica (com n e IC95)?",
    () => {
      const { decided } = decisionsAt("principal", PISO);
      const show = (f: GeomFeature, edges: number[]): string => {
        const bins = binnedPrecision(decided, f, edges);
        return bins
          .map(
            (b) =>
              `  [${b.lo.toFixed(2)}, ${b.hi === Infinity ? "∞" : b.hi.toFixed(2)})`.padEnd(18) +
              `precisão ${formatProportion(b.correct, b.n)}`,
          )
          .join("\n");
      };
      console.log(
        `\n═══ PRECISÃO POR FAIXA (a região tóxica, se existe, aparece como um BURACO de precisão) ═══\n` +
          `TANGENCIALIDADE (0 = radial puro; 1 = anda em círculo ao redor da estação):\n` +
          show("tangentiality", [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1.0001]) +
          `\nRIVAL-DIST-CORR (perfil radial do vizinho espelha o meu ⇒ a tag dele "explica" minha dist):\n` +
          show("rivalDistCorr", [-1, 0, 0.5, 0.8, 0.9, 0.95, 1.0001]),
      );
      // A tabela é o produto; a assertiva é que ela EXISTE com bins povoados o suficiente p/ ler.
      expect(binnedPrecision(decided, "tangentiality", [0, 0.5, 1.0001]).length).toBe(2);
      expect(binnedPrecision(decided, "rivalDistCorr", [-1, 0.8, 1.0001]).length).toBe(2);
    },
    240000,
  );

  it(
    "TAREFA 3 — O VETO: quantos ERROS elimina × quanta COBERTURA custa — e vence subir o PISO?",
    () => {
      const { decided, episodesWithTag, tagOf } = decisionsAt("principal", PISO);
      const decisionOf = (e: DecidedGeom): string => tagOf.get(e)!;

      // ── Os candidatos a veto: cada causa isolada, e a disjunção (o veto de produção) ──
      const CANDIDATOS: { nome: string; veto: VetoFn }[] = [
        { nome: "A) tangencial > 0,5", veto: (g) => g.tangentiality > DEFAULT_VETO.maxTangentiality },
        { nome: "B) rival-corr > 0,8", veto: (g) => g.rivalDistCorr > DEFAULT_VETO.maxRivalDistCorr },
        { nome: "A ou B (DEFAULT_VETO)", veto: (g) => geometricVeto(g) },
      ];
      const head =
        "veto".padEnd(24) +
        "decisões".padStart(9) +
        "erros".padStart(7) +
        "  →  " +
        "decisões".padStart(9) +
        "erros".padStart(7) +
        "   precisão depois (IC95)".padEnd(30) +
        "  cobertura     erros-elim  acertos-perdidos";
      const lines = [head, "-".repeat(head.length)];
      const outs = CANDIDATOS.map((c) => ({ ...c, o: evaluateVeto(decided, episodesWithTag, c.veto) }));
      for (const { nome, o } of outs) {
        lines.push(
          nome.padEnd(24) +
            String(o.decidedBefore).padStart(9) +
            String(o.errorsBefore).padStart(7) +
            "  →  " +
            String(o.decidedAfter).padStart(9) +
            String(o.errorsAfter).padStart(7) +
            `   ${formatProportion(o.correctAfter, o.decidedAfter)}`.padEnd(33) +
            `${pc(o.coverageBefore)}%→${pc(o.coverageAfter)}%`.padStart(14) +
            `${pc(o.errorRecall)}%`.padStart(12) +
            `${pc(o.correctLoss)}%`.padStart(18),
        );
      }
      const base = outs[0].o;
      console.log(
        `\n═══ TAREFA 3 — O VETO GEOMÉTRICO (abster ANTES de falar, pela trajetória que a câmera já vê) ═══\n` +
          `precisão ANTES de qualquer veto: ${formatProportion(base.correctBefore, base.decidedBefore)} ` +
          `| cobertura ${pc(base.coverageBefore)}% (${base.decidedBefore}/${base.episodesWithTag} episódios-com-tag)\n` +
          `${lines.join("\n")}`,
      );

      // ── A ASSINATURA (Regra 13): o veto derruba a concordância-no-erro, ou os 41,2% sobrevivem? ──
      const agBefore = errorAgreement(decided, decisionOf);
      const vetoFn = outs[2].veto;
      const kept = decided.filter((e) => !vetoFn(e.geom));
      const agAfter = errorAgreement(kept, decisionOf);
      console.log(
        `\nA ASSINATURA DA REGRA 13, antes × depois do veto (o número que originou tudo isto):\n` +
          `  ANTES: 1º erra → 2º REPETE o mesmo erro: ${formatProportion(agBefore.firstWrongAndAgree, agBefore.firstWrong)}\n` +
          `  DEPOIS: ${formatProportion(agAfter.firstWrongAndAgree, agAfter.firstWrong)}`,
      );

      // ── A COMPARAÇÃO QUE IMPORTA: o veto (cirúrgico) × subir o piso de n_eff (cego) ──
      // Subir o piso TAMBÉM compra precisão — mas cega o sistema em TODA parte, inclusive onde ele
      // acertava. A comparação honesta é DOIS-LADOS, na MESMA colheita:
      //   • a PRECISÃO do veto na cobertura que o piso entrega  (mesma cobertura, quem acerta mais?)
      //   • a COBERTURA do veto na precisão que o piso entrega   (mesma precisão, quem fala mais?)
      // Só domina de verdade quem ganha nas DUAS pontas.
      const PISOS = [10, 12, 14, 16, 19, 22];
      const pisoRows = PISOS.map((piso) => {
        const h = decisionsAt("principal", piso);
        const cor = h.decided.filter((e) => e.correct).length;
        return {
          piso,
          dec: h.decided.length,
          cor,
          eps: h.episodesWithTag,
          prec: h.decided.length === 0 ? 1 : cor / h.decided.length,
          cov: h.decided.length / h.episodesWithTag,
        };
      });
      const vetoOut = outs[2].o;
      const pisoLines = pisoRows.map(
        (r) =>
          `  piso ${String(r.piso).padStart(2)}: precisão ${formatProportion(r.cor, r.dec).padEnd(40)} ` +
          `cobertura ${pc(r.cov)}% (${r.dec}/${r.eps})`,
      );
      // O piso MAIS BARATO que alcança a precisão do veto (o preço, em cobertura, de comprar a MESMA
      // precisão pelo caminho cego), e o piso de cobertura mais próxima da do veto.
      const pisoIgualPrec = pisoRows.find((r) => r.prec >= vetoOut.precisionAfter);
      const pisoIgualCob = [...pisoRows].sort(
        (a, b) => Math.abs(a.cov - vetoOut.coverageAfter) - Math.abs(b.cov - vetoOut.coverageAfter),
      )[0];
      console.log(
        `\n═══ O VETO × SUBIR O PISO DE n_eff (a comparação que decide: cirúrgico ou cego?) ═══\n` +
          `SUBIR O PISO (cego — cala em todo lugar, inclusive onde acertava):\n${pisoLines.join("\n")}\n` +
          `\nO VETO (cirúrgico — cala SÓ na geometria tóxica, no piso ${PISO}):\n` +
          `  A ou B:   precisão ${formatProportion(vetoOut.correctAfter, vetoOut.decidedAfter).padEnd(40)} ` +
          `cobertura ${pc(vetoOut.coverageAfter)}% (${vetoOut.decidedAfter}/${vetoOut.episodesWithTag})\n` +
          `\nOS DOIS CORTES (só domina quem ganha nas DUAS pontas):\n` +
          `  • MESMA PRECISÃO (~${pc(vetoOut.precisionAfter)}%): o piso precisa subir a ${pisoIgualPrec ? pisoIgualPrec.piso : "—"} e paga ` +
          `${pisoIgualPrec ? pc(pisoIgualPrec.cov) : "—"}% de cobertura — o veto entrega ${pc(vetoOut.coverageAfter)}% ` +
          `(${pisoIgualPrec ? (vetoOut.coverageAfter / pisoIgualPrec.cov).toFixed(1) : "—"}× mais fala, pela mesma precisão)\n` +
          `  • MESMA COBERTURA (~${pc(pisoIgualCob.cov)}%): o piso ${pisoIgualCob.piso} entrega precisão ${pc(pisoIgualCob.prec)}% — ` +
          `o veto entrega ${pc(vetoOut.precisionAfter)}% (${(100 * (vetoOut.precisionAfter - pisoIgualCob.prec)).toFixed(1)}pp acima)`,
      );

      // ── Assertivas ROBUSTAS (o VEREDITO, não números frágeis) ──
      // 1) Determinismo.
      expect(evaluateVeto(decided, episodesWithTag, vetoFn)).toEqual(vetoOut);
      // 2) O veto não pode ser um massacre: tem de sobrar decisão (senão "precisão 100%" é vácuo).
      expect(vetoOut.decidedAfter).toBeGreaterThan(10);
      // 3) O veto é MELHOR QUE ALEATÓRIO: elimina uma fração de ERROS MUITO maior do que a de
      //    ACERTOS. Se ISTO falhar, o veto não tem informação nenhuma — a região tóxica não existe,
      //    os erros são DIFUSOS, e o 41,2% é limite duro. É o gate do achado (positivo OU negativo).
      expect(vetoOut.errorRecall).toBeGreaterThan(vetoOut.correctLoss * 3);
      // 4) E ele PAGA: a precisão sobe materialmente sobre o que sobrou.
      expect(vetoOut.precisionAfter).toBeGreaterThan(vetoOut.precisionBefore);
      // 5) O VETO DOMINA O PISO NAS DUAS PONTAS — é o veredito da tarefa, e o gate contra regressão:
      //    (a) pela MESMA precisão, o veto fala MAIS (cobertura maior que a do piso equivalente);
      //    (b) pela MESMA cobertura, o veto ACERTA MAIS. Se um dia isto flipar, o veto perdeu a
      //        razão de existir e subir o piso passa a ser a escolha certa — o teste força re-exame.
      expect(pisoIgualPrec).toBeDefined();
      expect(vetoOut.coverageAfter).toBeGreaterThan(pisoIgualPrec!.cov * 1.5);
      expect(vetoOut.precisionAfter).toBeGreaterThan(pisoIgualCob.prec);
      // 6) A ASSINATURA (Regra 13) CAI: o veto ataca o MECANISMO, não a média — a concordância-no-
      //    erro dos sobreviventes fica ABAIXO da de antes. (n pequeno ⇒ o número exato é frágil; o
      //    que se sela é a DIREÇÃO.)
      expect(agAfter.agreementOnFailure).toBeLessThan(agBefore.agreementOnFailure);
    },
    600000,
  );

  it(
    "TAREFA 4 (CIRCULARIDADE) — o veto sobrevive com o viés corporal DIRECIONAL do sim LIGADO?",
    () => {
      // O experimento principal roda SEM bodyBias (nenhum FUSION_SCENARIO o liga) ⇒ o que ele achou é
      // geometria pura. Este braço LIGA o viés direcional (a física mais suja) e pergunta se o veto
      // — construído sem jamais ver o modelo de sombra — CONTINUA removendo erros. Não é derivação:
      // é ROBUSTEZ. Se o veto só funcionasse aqui, seria circular; se funciona nos DOIS, é geometria.
      const puro = decisionsAt("principal", PISO);
      const sujo = decisionsAt("bodybias", PISO, {
        bodyBias: { meanDb: 6, peakDb: 20, angWidthDeg: 60 }, // literatura (ver SimOpts.bodyBias)
        tagPlacement: { 0: "bolso-esq", 1: "bolso-dir", 2: "peito", 3: "bolso-esq" },
      });
      const oPuro = evaluateVeto(puro.decided, puro.episodesWithTag, geometricVeto);
      const oSujo = evaluateVeto(sujo.decided, sujo.episodesWithTag, geometricVeto);
      const linha = (nome: string, o: ReturnType<typeof evaluateVeto>): string =>
        `  ${nome.padEnd(28)} precisão ${formatProportion(o.correctBefore, o.decidedBefore).padEnd(38)} → ` +
        `${formatProportion(o.correctAfter, o.decidedAfter).padEnd(38)} ` +
        `(erros-elim ${pc(o.errorRecall)}%, acertos-perdidos ${pc(o.correctLoss)}%)`;
      console.log(
        `\n═══ TAREFA 4 — CIRCULARIDADE: o MESMO veto, nos dois geradores ═══\n` +
          `${linha("SEM bodyBias (principal)", oPuro)}\n` +
          `${linha("COM bodyBias direcional", oSujo)}\n` +
          `  → O veto foi DERIVADO no gerador SEM viés corporal (impossível ter copiado o modelo de\n` +
          `    sombra: ele não existia lá). Se ele segue removendo mais erro que acerto COM o viés\n` +
          `    ligado, o que ele captura é GEOMETRIA — não o simulador.`,
      );
      // O veto, derivado SEM o modelo de sombra, segue melhor que aleatório COM ele ligado.
      expect(oSujo.errorRecall).toBeGreaterThan(oSujo.correctLoss);
      // E a feature SEMI-CIRCULAR (headingToStation) é reportada, não usada: o veto de produção
      // (geometricVeto) não a consome. Este assert é o contrato — se alguém a colocar no veto,
      // quebra aqui e é forçado a re-declarar a circularidade.
      expect(geometricVeto({ ...puro.decided[0].geom, headingToStationDeg: 179 })).toBe(
        geometricVeto({ ...puro.decided[0].geom, headingToStationDeg: 1 }),
      );
    },
    600000,
  );
});

// Sanidade do arco: o teto de Wilson e a régua de proporção vêm de visit-metrics (fonte única).
describe("error-geometry — honestidade estatística (Regra 10)", () => {
  it("nenhuma proporção sai sem n e IC95 (a régua é a de visit-metrics, não uma nova)", () => {
    expect(formatProportion(13, 13)).toContain("IC95");
    expect(wilsonInterval(13, 13).lo).toBeLessThan(1);
  });
  it("REAL_TAG_PERIOD_TICKS existe e a cadência do experimento é declarada (1 Hz ≠ tag real 2,5 s)", () => {
    expect(REAL_TAG_PERIOD_TICKS).toBe(5);
    expect(CADENCE).toBe(2); // a cadência EM QUE os 41,2% foram medidos — a população da Regra 13
  });
});
