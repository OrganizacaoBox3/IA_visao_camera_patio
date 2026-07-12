// ═══════════════════════════════════════════════════════════════════════════════════════════════
// MEDIÇÃO DECISIVA DE PIVÔ DA ONDA 1 (ADR-014) — a metade CIRCULAR/INDICATIVA do experimento do
// receptor no destino. O complemento geométrico PURO já mora em receiver-geometry.test.ts (mede que
// mover o receptor da co-locação para o destino leva o span radial de ~0,09 → ~0,29 déc — geometria
// pura, NÃO-circular). ESTE arquivo fecha o funil: no span maior, a SIGNIFICÂNCIA HONESTA
// (computeVisitMetrics, ρ=0,7, desconto AR(1) do n_eff) passa a DECIDIR — e CORRETAMENTE — a
// identidade tag↔pessoa onde hoje (estação no canto) ABSTÉM?
//
// ‼ HONESTIDADE / CIRCULARIDADE (declaração no cabeçalho, doutrina §5) ‼
//   Esta é a metade INDICATIVA, não um juiz. O simulador GERA o RSSI como
//     RSSI = -45 − 10·n·log10(dist→ESTAÇÃO) + ruído(AR(1) ρ, viés corporal direcional, offsets
//            regionais, oclusão, quantização a inteiro),
//   então |r| entre RSSI e dist→estação é alto POR CONSTRUÇÃO. O que este teste realmente mede é:
//   no span radial MAIOR (fabricado ao mover a origem do RSSI para o destino), o RUÍDO do modelo +
//   o desconto n_eff (ρ=0,7) ainda deixam a significância PASSAR o gate |z| ≥ z_crit·√(1/(n_eff−3))?
//   É FUNIL DE HIPÓTESE — se NEM aqui (otimista) decidir, é PIVÔ forte (abandonar o receptor de zona
//   antes de comprar ESP32). Se decidir, é INDICAÇÃO de seguir para hardware — a prova final é CAMPO.
//
// COMO O KNOB FUNCIONA (o aditivo em sim.ts, propriedade exclusiva desta frente):
//   `stationWorldOverride` (Vec2, metros) move (a) a origem física do RSSI (log10 passa a ser a
//   dist→override) e (b) o stationPx EXPORTADO (worldToPixel(H, override)), de modo que o `dist` da
//   correlação em frame.ts (pé→stationWorld) meça pessoa→override. Origem do RSSI e origem do `dist`
//   ficam no MESMO ponto (o receptor) — exatamente a instalação que a Onda 1 propõe. Não consome RNG:
//   as trajetórias/o stream ficam byte-idênticos (só a POSIÇÃO do log10/projeção muda).
//
// TRAJETÓRIA VERDADEIRA em metros (mesmo método sancionado de receiver-geometry.test.ts): regenero o
// cenário com pxJitter:0 (não muda o caminho — randn é sempre sorteado; só limpa o ruído de pixel),
// inverto H sobre o PÉ de cada track e agrupo por truthTagByTrack (MAC = pessoa, robusto a id-switch).
// O override NÃO altera trajetórias (não consome RNG), então extraio do cenário BASELINE.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ‼‼ AVISO DE 2026-07-12 — TUDO ABAIXO QUE RODA NA CADÊNCIA DO SIMULADOR (rssiPeriodTicks ∈ {1,2},
// Δt ∈ {0,5; 1,0} s) ESTÁ INFLADO. A tag REAL anuncia a cada ~2,5 s (REAL_TAG_PERIOD_TICKS=5). O
// simulador entregava 2,5× mais leituras DISTINTAS do que a física permite ⇒ n_eff inflado ⇒
// cobertura inflada. Os testes antigos ficam (são o registro do que reportamos, e pinam a régua
// antiga); a MEDIÇÃO HONESTA é o último teste deste arquivo ("CADÊNCIA REAL DA TAG"). Ver "A LEI
// COMPLETA DO n_eff" em visit-metrics.ts.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { REAL_TAG_PERIOD_S, REAL_TAG_PERIOD_TICKS, simulateFusionScenario } from "./sim";
import type { SimFusionScenario, SimOpts } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { buildFusionFrame } from "./frame";
import { parseFusionSession } from "./session-loader";
import {
  computeVisitEpisodes,
  computeVisitMetrics,
  countingViolations,
  formatProportion,
  maxDistinctReadings,
  wilsonInterval,
} from "./visit-metrics";
import type { VisitEpisode, VisitMetrics, VisitTick, VisitTrackObs } from "./visit-metrics";
import {
  agreementBySeparation,
  agreementOnFailure,
  computeAnchorMetrics,
  computeAnchors,
  falseAnchors,
  formatAnchorProportion,
  sharedDataRisk,
} from "./anchor-policy";
import type { AnchorMetrics, OperatorEpisode, PolicyVariant } from "./anchor-policy";
import { pixelToWorld } from "../vision/homography";
import { DEFAULT_ROOM_GRID, optimalReceiver, radialSpan, type Pt } from "./receiver-geometry";

type ScenarioEntry = (typeof FUSION_SCENARIOS)[number];

/** MAC da pessoa 0 — a caminhada representativa cujo DESTINO ancora o receptor. */
const PERSON0_MAC = "AA:AA";
/** Estação do canto (0,0) = o BASELINE do gate H1 (onde a métrica honesta decide ZERO), espelhada de
 *  sim.ts (não exportada de lá; se mudar, muda aqui). É um CANTO DO CHÃO CALIBRADO — a co-locação
 *  "junto da câmera" (4,-2) NÃO entra na varredura do override: está ATRÁS da borda próxima do chão,
 *  projeta FORA da imagem, e a guarda de sim.ts a rejeita (não é posição instalável no piso). O
 *  baseline no canto é a referência co-localizada honesta. */
const STATION_WORLD: Pt = { x: 0, y: 0 };
/** Quantos ticks-verdade finais definem o "destino" da caminhada (10 s a 500 ms/tick). */
const DEST_LAST_N = 20;

/**
 * ESCOPO do experimento do override: só cenários COM movimento, CALIBRADOS (H real) e cujo feed usa
 * o ponto de estação (stationPx). Fora ficam: "parado" (span 0 em toda posição — nada a decidir),
 * "sem-calibracao" (uncalibrated:true → frame.ts usa o PROXY de caixa = dist→câmera, que o override
 * NÃO move → RSSI e dist ficariam em origens DIFERENTES, medição inválida) e "grade-sem-station"
 * (omitStationPx → frame.ts idem, default 0.5,1.0). Nesses dois o receptor-no-destino não é
 * exprimível sem quebrar o casamento origem-do-RSSI = origem-do-dist; declarado, não escondido.
 */
function inOverrideScope(entry: ScenarioEntry): boolean {
  return (
    entry.opts.walk !== "parado" && !entry.opts.uncalibrated && entry.omitStationPx !== true
  );
}

/** Trajetória VERDADEIRA da pessoa 0 em metros (pé projetado por H⁻¹, pxJitter:0, agrupado por MAC). */
function person0Trajectory(opts: SimOpts, seed: number): Pt[] {
  const sc = simulateFusionScenario({ ...opts, pxJitter: 0, uncalibrated: false }, seed);
  const H = sc.H;
  const out: Pt[] = [];
  if (!H) return out;
  for (const tick of sc.ticks) {
    for (const trk of tick.tracks) {
      if (tick.truthTagByTrack[trk.id] !== PERSON0_MAC) continue;
      const world = pixelToWorld(H, {
        x: trk.bbox[0] + trk.bbox[2] / 2,
        y: trk.bbox[1] + trk.bbox[3],
      });
      if (world) out.push(world);
    }
  }
  return out;
}

/** "Destino" = média das últimas N posições-verdade (localiza a região final da caminhada; mais
 *  robusto que um único ponto final ruidoso). Cai no ponto final se a trajetória for curta. */
function destinationOf(traj: Pt[]): Pt {
  const tail = traj.slice(Math.max(0, traj.length - DEST_LAST_N));
  const sx = tail.reduce((s, p) => s + p.x, 0);
  const sy = tail.reduce((s, p) => s + p.y, 0);
  return { x: sx / tail.length, y: sy / tail.length };
}

/** Centroide de toda a trajetória — o "meio do caminho / meio da sala", posição intermediária. */
function centroidOf(traj: Pt[]): Pt {
  const sx = traj.reduce((s, p) => s + p.x, 0);
  const sy = traj.reduce((s, p) => s + p.y, 0);
  return { x: sx / traj.length, y: sy / traj.length };
}

/** Feed de VISITA a partir de um cenário JÁ simulado — cópia fiel do visitTicksForScenario de
 *  visit-metrics.test.ts (buildFusionFrame de produção, MESMA exclusão de âncoras, verdade do sim).
 *  Como o escopo já garante H calibrada e stationPx presente, o `dist` = pé→(estação/override). */
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

/** VisitTicks de um cenário com a estação em `receiver` (undefined = BASELINE, canto (0,0)). */
function ticksAt(entry: ScenarioEntry, receiver?: Pt): VisitTick[] {
  const opts = receiver ? { ...entry.opts, stationWorldOverride: receiver } : entry.opts;
  return visitTicksFromScenario(simulateFusionScenario(opts, entry.seed));
}

/** Métrica de visita para um cenário com a estação em `receiver`. `visitOpts` ausente ⇒ ρ=0,7 fixo
 *  (o comportamento de sempre); com {tau,dtS} ⇒ ρ=e^(−dtS/tau); com {rho} ⇒ ρ cravado. */
function metricsAt(
  entry: ScenarioEntry,
  receiver?: Pt,
  visitOpts?: { tau?: number; dtS?: number; rho?: number },
): VisitMetrics {
  return computeVisitMetrics(ticksAt(entry, receiver), visitOpts);
}

/** Diagnóstico do GARGALO: por que a decisão não segue o span? Sobre os episódios COM tag de um
 *  cenário na posição `receiver`, quantos sequer alcançam a PRÉ-CONDIÇÃO de significância n_eff>3
 *  (Fisher precisa de n_eff>3 antes de qualquer |z|). Se ~0, o gargalo é o n_eff (cadência/duração
 *  do episódio), NÃO o span radial — o span pode subir à vontade que a decisão não vem. */
function neffDiag(entry: ScenarioEntry, receiver?: Pt): { withTag: number; reachNeff: number; maxNeff: number } {
  const eps = computeVisitEpisodes(ticksAt(entry, receiver)).filter((e) => e.truthTag !== null);
  let reachNeff = 0;
  let maxNeff = 0;
  for (const e of eps) {
    let best = 0;
    for (const c of e.candidates) if (c.nEff > best) best = c.nEff;
    if (best > 3) reachNeff++;
    if (best > maxNeff) maxNeff = best;
  }
  return { withTag: eps.length, reachNeff, maxNeff };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// τ_MÓVEL MEDIDO EM CAMPO (residual-autocorr.ts, gravação server/bt/fusion-session-2026-07-11_20,
// 2026-07-12) — o insumo que CORRIGE a varredura de cadência.
//
// Medido: a ACF do resíduo de RSSI da tag móvel, depois de remover (a) a tendência de path-loss e
// (b) o artefato de sample-and-hold do snapshot, é INDISTINGUÍVEL DE ZERO em todo lag observável
// (≥2,5 s = o intervalo de advertising real). O ajuste devolve τ=0; o LIMITE SUPERIOR honesto que
// algum bin ainda sustenta é τ ≤ 1,68 s. Usamos o LIMITE SUPERIOR — é o CONSERVADOR (τ maior ⇒ ρ
// maior ⇒ n_eff MENOR ⇒ barra de significância mais alta): não escolhemos o número que nos favorece.
//
// Contra o que o gate usava: ρ=0,7 FIXO, derivado de τ_ÂNCORA = 2,8–32 s (tags PARADAS no chão).
// Constante hard-coded de propósito: a gravação é runtime/gitignored (ausente no CI), então o CI não
// pode re-medir. Se a medição de campo mudar, este número muda AQUI (e o teste de campo em
// residual-autocorr.test.ts é quem guarda a evidência).
const TAU_MOVEL_S = 1.68;

type PosKey = "meio" | "destino" | "otimo";
type Row = {
  scenario: string;
  nPts: number;
  spanBaseGeo: number; // span radial geométrico do BASELINE (estação no canto)
  spanDestGeo: number; // span radial geométrico do destino (cross-check c/ receiver-geometry ~0,29)
  base: VisitMetrics;
  at: Record<PosKey, { pos: Pt; m: VisitMetrics }>;
};

function analyze(entry: ScenarioEntry): Row | null {
  const traj = person0Trajectory(entry.opts, entry.seed);
  if (traj.length < 2) return null;
  const destino = destinationOf(traj);
  const meio = centroidOf(traj);
  const otimo = optimalReceiver(traj, DEFAULT_ROOM_GRID).receiver;
  const positions: Record<PosKey, Pt> = { meio, destino, otimo };
  const at = {} as Row["at"];
  for (const k of Object.keys(positions) as PosKey[]) {
    at[k] = { pos: positions[k], m: metricsAt(entry, positions[k]) };
  }
  return {
    scenario: entry.name,
    nPts: traj.length,
    spanBaseGeo: radialSpan(traj, STATION_WORLD).spanDecades,
    spanDestGeo: radialSpan(traj, destino).spanDecades,
    base: metricsAt(entry),
    at,
  };
}

const pct = (x: number): string => (x * 100).toFixed(1);

// ─────────────────────── VARREDURA DE CADÊNCIA (compartilhada por dois testes) ───────────────────
// Hoisted para que a MESMA varredura rode com o ρ FIXO (a medição ANTIGA, inflada) e com o ρ POR
// CADÊNCIA (ρ=e^(−Δt/τ), a física) — a comparação lado a lado é o produto da Tarefa 3.
const TICK_S = 0.5; // tick do simulador (500 ms) — rssiPeriodTicks=2 ⇒ Δt=1 s (1 Hz); =1 ⇒ 0,5 s (2 Hz)

const medianOf = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

type CadRow = {
  period: number;
  hz: number;
  dtS: number;
  rho: number;
  withTag: number;
  medNTicks: number;
  medNeff: number;
  maxNeff: number;
  reachNeff: number;
  dec: number;
  cor: number;
  eps: number;
  rBarAtMax: number;
  byDur: { label: string; medNeff: number; count: number }[];
};

/** `visitOpts` ausente ⇒ ρ=0,7 FIXO (o comportamento da medição ANTIGA, byte-idêntico).
 *  `visitOpts` com {tau, dtS} ⇒ ρ=e^(−dtS/tau) (a física — o n_eff SATURA). */
function sweepCadence(
  period: number,
  visitOpts?: { tau: number; dtS: number },
): CadRow {
  let withTag = 0;
  let reachNeff = 0;
  let maxNeff = 0;
  let dec = 0;
  let cor = 0;
  let eps = 0;
  const nTicksAll: number[] = [];
  const neffAll: number[] = [];
  // buckets de DURAÇÃO do episódio (ticks): uma aproximação real dura ~3-8s = 6-16 ticks.
  const buckets: { label: string; lo: number; hi: number; neffs: number[] }[] = [
    { label: "curto <6t (<3s)", lo: 0, hi: 6, neffs: [] },
    { label: "aprox. 6-16t (3-8s)", lo: 6, hi: 16, neffs: [] },
    { label: "longo 16-32t (8-16s)", lo: 16, hi: 32, neffs: [] },
    { label: "muito longo ≥32t (≥16s)", lo: 32, hi: Infinity, neffs: [] },
  ];
  for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
    const trajOpts = { ...entry.opts, rssiPeriodTicks: period };
    const traj = person0Trajectory(trajOpts, entry.seed);
    if (traj.length < 2) continue;
    const destino = destinationOf(traj);
    const sc = simulateFusionScenario(
      { ...entry.opts, rssiPeriodTicks: period, stationWorldOverride: destino },
      entry.seed,
    );
    const ticks = visitTicksFromScenario(sc);
    const episodes = computeVisitEpisodes(ticks, visitOpts).filter((e) => e.truthTag !== null);
    const m = computeVisitMetrics(ticks, visitOpts);
    dec += m.decidedWithTag;
    cor += m.decidedCorrect;
    eps += m.episodesWithTag;
    for (const e of episodes) {
      withTag++;
      let best = 0;
      for (const c of e.candidates) if (c.nEff > best) best = c.nEff;
      if (best > 3) reachNeff++;
      if (best > maxNeff) maxNeff = best;
      nTicksAll.push(e.nTicks);
      neffAll.push(best);
      for (const b of buckets) if (e.nTicks >= b.lo && e.nTicks < b.hi) b.neffs.push(best);
    }
  }
  const rBarAtMax = maxNeff > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (maxNeff - 3))) : 1;
  const dtS = period * TICK_S;
  return {
    period,
    hz: 1 / dtS,
    dtS,
    rho: visitOpts ? Math.exp(-dtS / visitOpts.tau) : 0.7,
    withTag,
    medNTicks: medianOf(nTicksAll),
    medNeff: medianOf(neffAll),
    maxNeff,
    reachNeff,
    dec,
    cor,
    eps,
    rBarAtMax,
    byDur: buckets.map((b) => ({ label: b.label, medNeff: medianOf(b.neffs), count: b.neffs.length })),
  };
}

const fmtCadRow = (r: CadRow): string =>
  `${r.hz.toFixed(0)} Hz (period=${r.period})`.padEnd(20) +
  `${r.rho.toFixed(3).padStart(6)}   ` +
  `${String(r.withTag).padStart(5)}   ` +
  `${r.medNTicks.toFixed(0).padStart(6)}   ` +
  `${r.medNeff.toFixed(2).padStart(7)}   ` +
  `${r.maxNeff.toFixed(2).padStart(7)}   ` +
  `${String(r.reachNeff).padStart(9)}   ` +
  `${String(r.dec).padStart(4)}/${String(r.eps).padStart(4)}   ` +
  `${(r.eps === 0 ? 0 : (100 * r.dec) / r.eps).toFixed(1).padStart(6)}%   ` +
  `${(r.dec === 0 ? 0 : (100 * r.cor) / r.dec).toFixed(1).padStart(6)}%   ` +
  `${r.rBarAtMax.toFixed(2)}`;

const CAD_HEAD =
  "cadência RSSI".padEnd(20) +
  "    ρ     eps   medDur   medNeff   maxNeff   reachN>3   dec/eps    cob%     prec%   |r|@maxNeff";

describe("receiver-at-destino — a significância HONESTA passa a decidir com o receptor no destino?", () => {
  it("determinístico: a varredura repete números idênticos", () => {
    const first = FUSION_SCENARIOS.filter(inOverrideScope).slice(0, 2).map(analyze);
    const second = FUSION_SCENARIOS.filter(inOverrideScope).slice(0, 2).map(analyze);
    expect(first).toEqual(second);
  }, 30000);

  it(
    "TABELA + VEREDITO: span/decididos/precisão baseline vs destino (varredura câmera→meio→destino→ótimo)",
    () => {
      const rows: Row[] = [];
      for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
        const r = analyze(entry);
        if (r) rows.push(r);
      }
      expect(rows.length).toBeGreaterThan(0);

      // ── Tabela por cenário: span geométrico (baseline vs destino) + decididos/precisão/cobertura ──
      const header =
        "cenário".padEnd(22) +
        "spanGeo(base→dest)   " +
        "BASE dec/cor".padEnd(14) +
        "DEST dec/cor  DEST-prec%  DEST-cob%  spanMed(base→dest)";
      const lines = [header, "-".repeat(header.length)];
      // Pools por posição (a régua honesta: agregado sobre a suíte, evita ruído de cenário isolado).
      const pool = {
        base: { dec: 0, cor: 0, eps: 0 },
        meio: { dec: 0, cor: 0, eps: 0 },
        destino: { dec: 0, cor: 0, eps: 0 },
        otimo: { dec: 0, cor: 0, eps: 0 },
      };
      for (const r of rows) {
        pool.base.dec += r.base.decidedWithTag;
        pool.base.cor += r.base.decidedCorrect;
        pool.base.eps += r.base.episodesWithTag;
        for (const k of ["meio", "destino", "otimo"] as PosKey[]) {
          pool[k].dec += r.at[k].m.decidedWithTag;
          pool[k].cor += r.at[k].m.decidedCorrect;
          pool[k].eps += r.at[k].m.episodesWithTag;
        }
        const d = r.at.destino.m;
        lines.push(
          r.scenario.padEnd(22) +
            `${r.spanBaseGeo.toFixed(3)}→${r.spanDestGeo.toFixed(3)}`.padEnd(21) +
            `${r.base.decidedWithTag}/${r.base.decidedCorrect}`.padEnd(14) +
            `${d.decidedWithTag}/${d.decidedCorrect}`.padEnd(14) +
            `${pct(d.visitPrecisionTagged)}`.padStart(6) +
            `      ${pct(d.visitCoverage)}`.padStart(9) +
            `      ${r.base.medianSpanDecades.toFixed(3)}→${d.medianSpanDecades.toFixed(3)}`,
        );
      }
      console.log(`\n${lines.join("\n")}\n`);

      const prec = (p: { dec: number; cor: number }): string =>
        p.dec === 0 ? "—" : `${pct(p.cor / p.dec)}%`;
      const cov = (p: { dec: number; eps: number }): string =>
        p.eps === 0 ? "—" : `${pct(p.dec / p.eps)}%`;
      console.log(
        "POOL (visitas-com-tag, ρ=0,7 HONESTO) por posição do receptor:\n" +
          `  BASELINE(canto 0,0): dec=${pool.base.dec}/${pool.base.eps} cob=${cov(pool.base)} prec=${prec(pool.base)}\n` +
          `  meio (centroide):    dec=${pool.meio.dec}/${pool.meio.eps} cob=${cov(pool.meio)} prec=${prec(pool.meio)}\n` +
          `  DESTINO (últ. ${DEST_LAST_N}):   dec=${pool.destino.dec}/${pool.destino.eps} cob=${cov(pool.destino)} prec=${prec(pool.destino)}\n` +
          `  ÓTIMO (grade sala):  dec=${pool.otimo.dec}/${pool.otimo.eps} cob=${cov(pool.otimo)} prec=${prec(pool.otimo)}`,
      );

      // ── DIAGNÓSTICO DO GARGALO: span sobe mas a decisão não segue — é o span ou o n_eff que trava? ──
      let destWithTag = 0;
      let destReachNeff = 0;
      let destMaxNeff = 0;
      for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
        const traj = person0Trajectory(entry.opts, entry.seed);
        if (traj.length < 2) continue;
        const d = neffDiag(entry, destinationOf(traj));
        destWithTag += d.withTag;
        destReachNeff += d.reachNeff;
        if (d.maxNeff > destMaxNeff) destMaxNeff = d.maxNeff;
      }
      // Limiar de |r| exigido no MELHOR n_eff observado: |z|≥1,96·√(1/(n_eff−3)) ⇒ |r|≥tanh(·).
      const rBarAtMax =
        destMaxNeff > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (destMaxNeff - 3))) : 1;
      console.log(
        `\nGARGALO (config DESTINO): episódios-com-tag que alcançam a pré-condição n_eff>3: ` +
          `${destReachNeff}/${destWithTag} (${pct(destReachNeff / destWithTag)}%) | n_eff MÁXIMO em toda a suíte: ${destMaxNeff.toFixed(2)}\n` +
          `  → com ρ=0,7, n_eff = nDistinct·0,176; mesmo os episódios que passam do piso 3 mal o superam\n` +
          `    (máx ${destMaxNeff.toFixed(2)}). A variância de Fisher √(1/(n_eff−3)) então EXPLODE: no melhor\n` +
          `    n_eff da suíte o gate exige |r| ≥ ${rBarAtMax.toFixed(2)} — barra brutal que o ganho de span\n` +
          `    (|r| um pouco maior) não vence senão por um episódio perdido. O gargalo é o n_eff MAGRO\n` +
          `    (independência temporal: cadência 1/2 ticks + episódios curtos), NÃO o span radial.`,
      );

      const meanBaseSpan = rows.reduce((s, r) => s + r.spanBaseGeo, 0) / rows.length;
      const meanDestSpan = rows.reduce((s, r) => s + r.spanDestGeo, 0) / rows.length;
      const otimoCov = pool.otimo.eps === 0 ? 0 : pool.otimo.dec / pool.otimo.eps;
      // Limiar de VEREDITO: mesmo na MELHOR posição on-floor (ótimo da sala, otimista), a cobertura
      // honesta continua colada no CHÃO (~0). Um punhado de decisões em centenas de visitas é ruído,
      // não "passou a decidir". 5% é folgadamente acima do observado (0,6%) e bem abaixo de qualquer
      // cobertura que sustentasse a Onda 1.
      const decidesForReal = otimoCov >= 0.05;
      const verdict = decidesForReal
        ? "INDICAÇÃO: mesmo com o desconto honesto, a MELHOR posição on-floor leva a cobertura a um\n" +
          "  patamar material — a Onda 1 tem indicação de seguir para hardware COM validação de campo\n" +
          "  (esta metade é INDICATIVA/circular; a prova final é campo)."
        : "PIVÔ (achado NEGATIVO, doutrina §5 — vale igual ao positivo): o span radial SOBE exatamente\n" +
          "  como a geometria previu (0,13→0,27 déc, cross-check com receiver-geometry ~0,29), MAS a\n" +
          "  cobertura honesta permanece colada no CHÃO — destino ~0,3% e ATÉ o ótimo da sala ~0,6%\n" +
          "  (vs 0% do baseline). O ganho de span NÃO se converte em decisão porque o gargalo é o n_eff,\n" +
          "  não o span. Este é o critério de pivô do ADR-014: nem no simulador OTIMISTA a Onda 1 fecha\n" +
          "  — indicação forte de abandonar o receptor de zona ANTES de comprar ESP32. (Ver GARGALO acima.)";
      console.log(
        "\nVEREDITO (metade CIRCULAR/INDICATIVA — |r| é alto por construção; o teste é se o RUÍDO+n_eff\n" +
          `deixam a significância passar no span maior):\n` +
          `  span geométrico médio (pessoa 0): baseline(canto)=${meanBaseSpan.toFixed(3)} → destino=${meanDestSpan.toFixed(3)} déc\n` +
          `  cobertura honesta (ρ=0,7): baseline=${pct(pool.base.eps === 0 ? 0 : pool.base.dec / pool.base.eps)}% ` +
          `→ destino=${pct(pool.destino.eps === 0 ? 0 : pool.destino.dec / pool.destino.eps)}% ` +
          `→ ótimo=${pct(otimoCov)}%\n` +
          `  ${verdict}\n`,
      );

      // ── Assertivas ROBUSTAS (o VEREDITO, não números frágeis) ──
      // 1) BASELINE reproduz o gate H1: a estação no canto decide ZERO visitas-com-tag (span minúsculo).
      expect(pool.base.dec).toBe(0);
      // 2) Mover o receptor para o destino FABRICA span (cross-check c/ receiver-geometry ~0,29):
      //    o span geométrico do destino supera o do baseline em TODO cenário com movimento.
      for (const r of rows) expect(r.spanDestGeo).toBeGreaterThan(r.spanBaseGeo);
      expect(meanDestSpan).toBeGreaterThan(meanBaseSpan);
      expect(meanDestSpan).toBeGreaterThan(0.2); // ordem de grandeza do 0,29 do ADR/receiver-geometry
      // 3) O ACHADO NEGATIVO, selado robustamente: mesmo na MELHOR posição on-floor (ótimo, otimista),
      //    a cobertura honesta fica colada no chão (<5% — observado 0,6%). O span sobe, a decisão não
      //    segue. Se um dia isto FLIPAR (ótimo passar de 5%), o teste quebra e força re-exame — é o gate.
      expect(otimoCov).toBeLessThan(0.05);
      // 4) A CAUSA-RAIZ selada: mesmo os episódios que passam do piso n_eff>3 mal o superam — o n_eff
      //    MÁXIMO da suíte inteira fica bem abaixo de 10 (observado ~6,9), então √(1/(n_eff−3)) mantém
      //    o gate de |z| brutal. É o n_eff magro (independência temporal), não o span, que trava.
      expect(destMaxNeff).toBeLessThan(10);
      expect(rBarAtMax).toBeGreaterThan(0.6); // no melhor caso a barra ainda exige |r|≳0,6
      // 5) Toda decisão que ACONTECER tem de ser honesta (sem falso-evento): precisão pooled do destino
      //    bem definida quando decide (aqui 1/1=100%). Não crava número; só que não é lixo se decidir.
      if (pool.destino.dec > 0) expect(pool.destino.cor / pool.destino.dec).toBeGreaterThan(0.5);
    },
    120000,
  );

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // VARREDURA DE CADÊNCIA × estação NO DESTINO — o gargalo é a cadência de advertising OU o episódio
  // curto demais? O teto n_eff=6,88 acima foi com rssiPeriodTicks=2 (refresh REAL de RSSI a 1 Hz = o
  // intervalo de advertising da tag). A correção Δ4 (2000→500ms) foi só no POST do app; POSTar mais
  // rápido que a tag anuncia NÃO cria leituras distintas (distinctConsecutive deduplica). Aqui movo o
  // refresh de RSSI de fato: rssiPeriodTicks ∈ {2,1} = 1 Hz (atual) e 2 Hz (o máximo no tick de 500ms).
  // NOTA: rssiPeriodTicks MUDA o consumo de RNG (o eps do RSSI é sorteado em mais/menos ticks), então
  // é um CENÁRIO NOVO por cadência (trajetórias divergem) — não toca os pinos dos FUSION_SCENARIOS
  // (opts fixas). Comparo DISTRIBUIÇÕES de n_eff/decisão, robustas à divergência de trajetória.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  it(
    "CADÊNCIA × DESTINO: dobrar o refresh de RSSI (1→2 Hz) abre o gate de significância per-visita?",
    () => {
      const cad2 = sweepCadence(2); // 1 Hz — cadência atual (advertising real)
      const cad1 = sweepCadence(1); // 2 Hz — refresh dobrado (máximo no tick de 500ms)

      console.log(
        `\nVARREDURA DE CADÊNCIA (estação NO DESTINO, ρ=0,7 FIXO, pooled sobre a suíte):\n` +
          `‼ ESTA TABELA ESTÁ INFLADA — ρ FIXO nas DUAS cadências. Ver a CORRIGIDA no teste seguinte.\n` +
          `${CAD_HEAD}\n${"-".repeat(CAD_HEAD.length)}\n${fmtCadRow(cad2)}\n${fmtCadRow(cad1)}`,
      );

      console.log(
        `\nn_eff MEDIANO por DURAÇÃO de episódio (config 2 Hz — a mais favorável):\n` +
          cad1.byDur
            .map(
              (b) =>
                `  ${b.label.padEnd(24)} medNeff=${b.medNeff.toFixed(2).padStart(6)}  (n=${b.count})`,
            )
            .join("\n") +
          `\n  → n_eff>3 exige nDistinct>${Math.ceil(3 / ((1 - 0.7) / (1 + 0.7)))} leituras DISTINTAS. A 2 Hz,` +
          ` isso é ~${Math.ceil(17 / 2)}s de episódio; a 1 Hz, ~17s. Uma aproximação real (3-8s) é` +
          ` estruturalmente CURTA demais.`,
      );

      // Ganho de cadência: dobrar o refresh ~dobra o n_eff (nDistinct dobra). A cobertura sobe de fato,
      // MAS é o EPISÓDIO LONGO que decide — a aproximação típica (3-8s) segue abaixo do piso n_eff>3.
      const cov2 = cad2.eps ? cad2.dec / cad2.eps : 0;
      const cov1 = cad1.eps ? cad1.dec / cad1.eps : 0;
      const approachBucket = cad1.byDur[1]; // "aprox. 6-16t (3-8s)" — a duração da aproximação real
      console.log(
        `\nVEREDITO CADÊNCIA (nuance — a cadência ABRE parcialmente, mas por DURAÇÃO, não por aproximação):\n` +
          `  n_eff MÁX: 1 Hz=${cad2.maxNeff.toFixed(2)} → 2 Hz=${cad1.maxNeff.toFixed(2)} (≈dobra: nDistinct dobra)\n` +
          `  cobertura honesta: 1 Hz=${(100 * cov2).toFixed(1)}% → 2 Hz=${(100 * cov1).toFixed(1)}% (prec ${(cad1.dec ? (100 * cad1.cor) / cad1.dec : 0).toFixed(1)}%)\n` +
          `  → DOBRAR A CADÊNCIA É ALAVANCA REAL DE HARDWARE: a 2 Hz o gate abre a ${(100 * cov1).toFixed(0)}% de cobertura\n` +
          `    com precisão alta — mas SÓ nos episódios LONGOS (dwell): bucket ≥16t (≥8s) tem n_eff mediano\n` +
          `    ${cad1.byDur[2].medNeff.toFixed(2)}/${cad1.byDur[3].medNeff.toFixed(2)}. A APROXIMAÇÃO típica (6-16t ≈ 3-8s) fica em n_eff mediano\n` +
          `    ${approachBucket.medNeff.toFixed(2)} — ABAIXO do piso 3, e os episódios <6t (${cad1.byDur[0].count} deles) decidem NUNCA.\n` +
          `  → SÍNTESE: cadência mais alta fecha identidade PER-VISITA onde o operador PERMANECE (>8s); a\n` +
          `    passagem/aproximação breve é estruturalmente curta demais a QUALQUER cadência representável\n` +
          `    → para ela, a identidade RSSI precisa ACUMULAR ENTRE visitas (camadas 3-5 do ADR-014:\n` +
          `    conservação por zona + HSMM + conformance), não fechar por UMA aproximação. Recomendação de\n` +
          `    hardware: se o caso de uso é DWELL na estação, cadência de advertising alta vale; se é fluxo\n` +
          `    de passagem, o receptor de zona sozinho não fecha — priorizar as camadas de acúmulo.`,
      );

      // ── Assertivas ROBUSTAS ──
      // 1) Determinismo do sweep.
      expect(sweepCadence(2)).toEqual(cad2);
      // 2) A cadência 1 Hz (atual) segue COLADA no chão — reproduz o achado da 1ª medição.
      expect(cov2).toBeLessThan(0.05);
      // 3) Dobrar a cadência ~dobra o n_eff (nDistinct dobra) E abre o gate a patamar MATERIAL: a
      //    cadência de advertising é uma alavanca de HARDWARE real (não marginal). Robusto (15,5% obs.).
      expect(cad1.maxNeff).toBeGreaterThan(cad2.maxNeff * 1.3);
      expect(cov1).toBeGreaterThan(0.08);
      expect(cov1).toBeGreaterThan(cov2 * 3);
      // 4) MAS o ganho é por DURAÇÃO, não por aproximação: o episódio TÍPICO segue abaixo do piso
      //    (n_eff mediano geral < 3) e o bucket da aproximação real (6-16t ≈ 3-8s) idem. O gargalo
      //    per-aproximação é estrutural. Se ISTO flipar, força re-exame — é o gate do achado.
      expect(cad1.medNeff).toBeLessThan(3);
      expect(approachBucket.medNeff).toBeLessThan(3);
      // 5) Quando decide (2 Hz), decide com precisão alta — honesto, não lixo.
      expect(cad1.dec > 0 ? cad1.cor / cad1.dec : 1).toBeGreaterThan(0.8);
    },
    120000,
  );

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // A VARREDURA CORRIGIDA — ρ POR CADÊNCIA (ρ=e^(−Δt/τ), τ_móvel MEDIDO), 2026-07-12.
  //
  // O ERRO DA VARREDURA ANTERIOR (o teste acima): usou ρ=0,7 FIXO nas DUAS cadências. Isso é
  // internamente INCONSISTENTE — ρ é função de Δt. A 2 Hz as amostras estão MAIS PRÓXIMAS no tempo,
  // logo MAIS correlacionadas: ρ tinha de SUBIR, não ficar em 0,7. Ao congelar ρ, o n_eff (∝ n) DOBRA
  // de graça quando a cadência dobra — uma alavanca de hardware FICTÍCIA. Daí saiu o "2 Hz abre a
  // cobertura para 15,5%".
  //
  // A CORREÇÃO tem DOIS efeitos que se OPÕEM, e por isso o resultado não era óbvio a priori:
  //   (+) τ_móvel medido (≤1,68 s) é MUITO menor que o τ de âncora embutido no ρ=0,7 (2,8–32 s) ⇒ a
  //       1 Hz o ρ REAL (e^(−1/1,68)=0,55) é MENOR que 0,7 ⇒ n_eff SOBE ⇒ o gate H1/H2 foi injusto.
  //   (−) mas o ρ CRESCE com a cadência ⇒ o ganho de 2 Hz quase some (SATURAÇÃO).
  // Este teste mede os dois de uma vez, na métrica-fim (a visita DECIDE?), que é quem manda.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  it(
    "CADÊNCIA CORRIGIDA (ρ=e^(−Δt/τ), τ_móvel medido): a cadência SATURA — e o gate H1/H2 foi injusto",
    () => {
      // ρ FIXO (a régua ANTIGA, inflada) — mesmos números do teste acima.
      const old2 = sweepCadence(2);
      const old1 = sweepCadence(1);
      // ρ POR CADÊNCIA (a física): Δt = period·500 ms; τ = τ_móvel medido em campo.
      const new2 = sweepCadence(2, { tau: TAU_MOVEL_S, dtS: 2 * TICK_S }); // 1 Hz → Δt=1,0 s
      const new1 = sweepCadence(1, { tau: TAU_MOVEL_S, dtS: 1 * TICK_S }); // 2 Hz → Δt=0,5 s

      console.log(
        `\n═══ TABELA CORRIGIDA — ρ POR CADÊNCIA (τ_móvel=${TAU_MOVEL_S}s medido em campo) ═══\n` +
          `${CAD_HEAD}\n${"-".repeat(CAD_HEAD.length)}\n${fmtCadRow(new2)}\n${fmtCadRow(new1)}`,
      );
      console.log(
        `\n═══ ANTIGA (ρ=0,7 FIXO — INFLADA) vs CORRIGIDA, lado a lado ═══\n` +
          "métrica".padEnd(30) +
          "1 Hz(antiga)  2 Hz(antiga)  |  1 Hz(CORR)  2 Hz(CORR)\n" +
          "-".repeat(88) +
          "\n" +
          [
            ["ρ usado", old2.rho.toFixed(3), old1.rho.toFixed(3), new2.rho.toFixed(3), new1.rho.toFixed(3)],
            [
              "n_eff MÁX",
              old2.maxNeff.toFixed(2),
              old1.maxNeff.toFixed(2),
              new2.maxNeff.toFixed(2),
              new1.maxNeff.toFixed(2),
            ],
            [
              "n_eff MEDIANO",
              old2.medNeff.toFixed(2),
              old1.medNeff.toFixed(2),
              new2.medNeff.toFixed(2),
              new1.medNeff.toFixed(2),
            ],
            [
              "episódios c/ n_eff>3",
              String(old2.reachNeff),
              String(old1.reachNeff),
              String(new2.reachNeff),
              String(new1.reachNeff),
            ],
            [
              "COBERTURA (dec/eps)",
              `${pct(old2.eps ? old2.dec / old2.eps : 0)}%`,
              `${pct(old1.eps ? old1.dec / old1.eps : 0)}%`,
              `${pct(new2.eps ? new2.dec / new2.eps : 0)}%`,
              `${pct(new1.eps ? new1.dec / new1.eps : 0)}%`,
            ],
            [
              "PRECISÃO",
              `${pct(old2.dec ? old2.cor / old2.dec : 1)}%`,
              `${pct(old1.dec ? old1.cor / old1.dec : 1)}%`,
              `${pct(new2.dec ? new2.cor / new2.dec : 1)}%`,
              `${pct(new1.dec ? new1.cor / new1.dec : 1)}%`,
            ],
            [
              "|r| exigido @maxNeff",
              old2.rBarAtMax.toFixed(2),
              old1.rBarAtMax.toFixed(2),
              new2.rBarAtMax.toFixed(2),
              new1.rBarAtMax.toFixed(2),
            ],
          ]
            .map(
              (r) =>
                r[0].padEnd(30) +
                r[1].padStart(12) +
                r[2].padStart(14) +
                "  |" +
                r[3].padStart(12) +
                r[4].padStart(12),
            )
            .join("\n"),
      );

      const covOld2 = old2.eps ? old2.dec / old2.eps : 0; // 1 Hz, régua antiga (o "0,3%")
      const covOld1 = old1.eps ? old1.dec / old1.eps : 0; // 2 Hz, régua antiga (o "15,5%")
      const covNew2 = new2.eps ? new2.dec / new2.eps : 0; // 1 Hz, régua corrigida
      const covNew1 = new1.eps ? new1.dec / new1.eps : 0; // 2 Hz, régua corrigida
      const gainOld = old2.maxNeff > 0 ? old1.maxNeff / old2.maxNeff : 0;
      const gainNew = new2.maxNeff > 0 ? new1.maxNeff / new2.maxNeff : 0;

      console.log(
        `\nVEREDITO CADÊNCIA (CORRIGIDO — as duas perguntas, respondidas com o número, não com a torcida):\n` +
          `  (a) A CADÊNCIA SATURA, como a lei prevê? SIM, no n_eff — que é onde a lei fala.\n` +
          `      Dobrar 1→2 Hz multiplica o n_eff MÁX por ${gainNew.toFixed(2)}× (régua antiga: ${gainOld.toFixed(2)}× — o "dobro" era\n` +
          `      artefato do ρ congelado), e o nº de episódios que cruzam n_eff>3 fica PLANO\n` +
          `      (${new2.reachNeff}→${new1.reachNeff}, contra ${old2.reachNeff}→${old1.reachNeff} da régua antiga). É a lei n_eff=(T/Δt)·tanh(Δt/2τ)→T/(2τ).\n` +
          `      NUANCE HONESTA: a COBERTURA ainda sobe ${covNew2 > 0 ? `${(covNew1 / covNew2).toFixed(2)}×` : "—"} (${pct(covNew2)}%→${pct(covNew1)}%) — não porque nasçam\n` +
          `      episódios novos acima do piso, mas porque os que JÁ passavam ganham n_eff e a barra\n` +
          `      |r|≥tanh(1,96/√(n_eff−3)) cede (${new2.rBarAtMax.toFixed(2)}→${new1.rBarAtMax.toFixed(2)}). Cadência NÃO é alavanca NULA — é uma\n` +
          `      alavanca MUITO menor do que vendemos (2× de cobertura, não 5×; e satura em seguida).\n` +
          `  (b) Com o τ real, a cobertura SALTA acima dos 15,5%? NÃO — e os 15,5% eram FALSOS.\n` +
          `      A 2 Hz a cobertura HONESTA é ${pct(covNew1)}% (não 15,5%: aquele número nascia do ρ congelado).\n` +
          `      O que SALTA é a cadência ATUAL: a 1 Hz, ${pct(covOld2)}% → ${pct(covNew2)}% (${covOld2 > 0 ? `${(covNew2 / covOld2).toFixed(0)}×` : "—"}), sem comprar NADA.\n` +
          `  ⇒ O GATE DISPAROU NO NÚMERO ERRADO — nas DUAS pontas, e para lados opostos:\n` +
          `      • SUBESTIMOU o n_eff da cadência atual (τ de âncora parada aplicado a tag móvel):\n` +
          `        n_eff máx ${old2.maxNeff.toFixed(2)} → ${new2.maxNeff.toFixed(2)} (${(new2.maxNeff / old2.maxNeff).toFixed(1)}×); a barra |r| cai de ${old2.rBarAtMax.toFixed(2)} para ${new2.rBarAtMax.toFixed(2)}.\n` +
          `      • SUPERESTIMOU o ganho de dobrar a cadência (ρ congelado): 15,5% → ${pct(covNew1)}%.\n` +
          `  ⇒ A RECOMENDAÇÃO SE INVERTE: "comprar tag de 2 Hz" era a conclusão do número inflado. A\n` +
          `    cadência satura; a única alavanca que move o teto T/(2τ) é a DURAÇÃO T do episódio\n` +
          `    (permanência) — e, do lado do hardware, um receptor que separe CANAIS (3 olhares\n` +
          `    quase-independentes) em vez de um que anuncie mais rápido.\n` +
          `  ⚠ MAS H1 SEGUE NÃO FECHANDO: mesmo com a física certa e no simulador OTIMISTA, a cobertura\n` +
          `    por visita é ${pct(covNew2)}% (1 Hz) / ${pct(covNew1)}% (2 Hz). O gate estava com o NÚMERO errado, não com a\n` +
          `    CONCLUSÃO errada: a identidade por UMA aproximação continua sem fechar. As camadas de\n` +
          `    acúmulo do ADR-014 (conservação por zona + HSMM + conformance) seguem sendo o caminho.`,
      );

      // ── Assertivas ROBUSTAS (o VEREDITO, não números frágeis) ──
      // 1) Determinismo.
      expect(sweepCadence(2, { tau: TAU_MOVEL_S, dtS: 2 * TICK_S })).toEqual(new2);
      // 2) ADITIVIDADE: sem tau/dtS, a varredura é BYTE-IDÊNTICA à antiga (ρ=0,7 fixo). É o contrato
      //    da Tarefa 2 — os testes que não passam `tau` não podem mudar de resultado.
      expect(old2.rho).toBe(0.7);
      expect(old1.rho).toBe(0.7);
      // 3) O ρ CORRETO SOBE com a cadência (o que o ρ fixo negava) — e a 1 Hz é MENOR que 0,7.
      expect(new2.rho).toBeLessThan(0.7); // e^(−1/1,68) = 0,552
      expect(new1.rho).toBeGreaterThan(new2.rho); // e^(−0,5/1,68) = 0,743 — MAIS correlacionado
      // 4) SATURAÇÃO (a lei, no n_eff): o ganho de dobrar a cadência DESABA de ~2,3× (artefato do ρ
      //    congelado) para ~1,2× (a física). E os episódios que cruzam o piso n_eff>3 ficam PLANOS.
      expect(gainOld).toBeGreaterThan(1.6);
      expect(gainNew).toBeLessThan(1.25);
      expect(old1.reachNeff).toBeGreaterThan(old2.reachNeff * 2); // artefato: "dobra" quem cruza o piso
      expect(new1.reachNeff).toBeLessThan(new2.reachNeff * 1.2); // física: fica PLANO
      // 5) O GATE SUBESTIMOU o n_eff da cadência ATUAL: com o τ certo, n_eff máx sobe ≥1,4× a 1 Hz e a
      //    cobertura a 1 Hz sobe MUITO (0,3% → ~4,6%) — sem trocar hardware nenhum.
      expect(new2.maxNeff).toBeGreaterThan(old2.maxNeff * 1.4);
      expect(covNew2).toBeGreaterThan(covOld2 * 3);
      // 6) E o gate SUPERESTIMOU o ganho de cadência: a cobertura HONESTA a 2 Hz fica ABAIXO dos 15,5%
      //    que reportamos. O "15,5%" era o ρ congelado falando. Achado NEGATIVO — vale igual.
      expect(covNew1).toBeLessThan(covOld1);
      // 7) MAS H1 NÃO FECHA nem com a física certa: a cobertura por visita segue baixa (<25%) mesmo no
      //    simulador otimista. Se ISTO flipar um dia, força re-exame — é o gate do achado.
      expect(covNew1).toBeLessThan(0.25);
      // 8) E o que decide, decide honesto (não é lixo comprado com barra baixa).
      expect(new2.dec > 0 ? new2.cor / new2.dec : 1).toBeGreaterThan(0.8);
      expect(new1.dec > 0 ? new1.cor / new1.dec : 1).toBeGreaterThan(0.8);
    },
    120000,
  );

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // O INTERVALO DE τ — fechar a incerteza que a varredura acima deixou aberta (2026-07-12).
  //
  // A medição de campo (residual-autocorr.test.ts) devolve DUAS coisas diferentes:
  //   • ESTIMATIVA PONTUAL: o resíduo é BRANCO — ρ(Δ) indistinguível de 0 em TODO lag observável
  //     (≥2,5 s, o intervalo de advertising). O ajuste devolve τ = 0.
  //   • LIMITE SUPERIOR conservador: τ ≤ 1,68 s (o maior τ que algum bin ainda sustenta).
  // A varredura acima usou o LIMITE SUPERIOR (1,68 s) — a ponta PESSIMISTA. Se a estimativa PONTUAL
  // (τ→0) estiver certa, ρ→0, o n_eff NÃO sofre desconto nenhum (n_eff = nDistinct inteiro) e a barra
  // |r| cai ainda mais. A verdade está em τ ∈ [0; 1,68] e o produto desta varredura é o INTERVALO,
  // não um ponto — quem for decidir hardware precisa ver as duas pontas.
  //
  // NOTA sobre τ=0: `effectiveRho` guarda contra tau≤0 (defensivo). O limite da lei quando τ→0 é
  // ρ→0, então o caso BRANCO é expresso como {rho: 0} — o mesmo número que a lei daria.
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  it(
    "INTERVALO DE τ ∈ [0; 1,68]: onde a cobertura por visita REALMENTE cai (1 Hz, baseline vs destino)",
    () => {
      const DT_1HZ = 2 * TICK_S; // cadência ATUAL: rssiPeriodTicks=2 ⇒ Δt = 1,0 s
      // τ=0 (BRANCO — a estimativa PONTUAL) … τ=1,68 (o LIMITE SUPERIOR conservador).
      const TAUS = [0, 0.25, 0.5, 1.0, TAU_MOVEL_S];

      type TRow = {
        tau: number;
        rho: number;
        base: { dec: number; cor: number; eps: number };
        dest: { dec: number; cor: number; eps: number };
        maxNeff: number;
        medNeff: number;
        reach: number;
        withTag: number;
        rBar: number;
      };

      const rows: TRow[] = [];
      for (const tau of TAUS) {
        // τ=0 ⇒ ρ=0 (o limite da lei: e^(−Δt/τ) → 0). Ver nota no cabeçalho do teste.
        const vo = tau > 0 ? { tau, dtS: DT_1HZ } : { rho: 0 };
        const rho = tau > 0 ? Math.exp(-DT_1HZ / tau) : 0;
        const base = { dec: 0, cor: 0, eps: 0 };
        const dest = { dec: 0, cor: 0, eps: 0 };
        let maxNeff = 0;
        let reach = 0;
        let withTag = 0;
        const neffs: number[] = [];

        for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
          const opts1Hz = { ...entry.opts, rssiPeriodTicks: 2 };
          const traj = person0Trajectory(opts1Hz, entry.seed);
          if (traj.length < 2) continue;
          const destino = destinationOf(traj);

          // BASELINE (estação no canto) e DESTINO — mesma cadência (1 Hz), só muda o receptor.
          const b = computeVisitMetrics(
            visitTicksFromScenario(simulateFusionScenario(opts1Hz, entry.seed)),
            vo,
          );
          base.dec += b.decidedWithTag;
          base.cor += b.decidedCorrect;
          base.eps += b.episodesWithTag;

          const scD = simulateFusionScenario(
            { ...opts1Hz, stationWorldOverride: destino },
            entry.seed,
          );
          const ticksD = visitTicksFromScenario(scD);
          const d = computeVisitMetrics(ticksD, vo);
          dest.dec += d.decidedWithTag;
          dest.cor += d.decidedCorrect;
          dest.eps += d.episodesWithTag;

          for (const e of computeVisitEpisodes(ticksD, vo).filter((x) => x.truthTag !== null)) {
            withTag++;
            let best = 0;
            for (const c of e.candidates) if (c.nEff > best) best = c.nEff;
            if (best > 3) reach++;
            if (best > maxNeff) maxNeff = best;
            neffs.push(best);
          }
        }
        rows.push({
          tau,
          rho,
          base,
          dest,
          maxNeff,
          medNeff: medianOf(neffs),
          reach,
          withTag,
          rBar: maxNeff > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (maxNeff - 3))) : 1,
        });
      }

      const head =
        "τ (s)".padEnd(14) +
        "  ρ@1Hz   n_eff máx  n_eff med  eps n_eff>3   |r| exigido   BASE cob%   DEST cob%   DEST prec%";
      const lines = [head, "-".repeat(head.length)];
      for (const r of rows) {
        lines.push(
          `${r.tau === 0 ? "0 (BRANCO)" : r.tau.toFixed(2)}${r.tau === TAU_MOVEL_S ? " (bound)" : ""}`.padEnd(14) +
            `  ${r.rho.toFixed(3).padStart(5)}   ` +
            `${r.maxNeff.toFixed(2).padStart(9)}  ${r.medNeff.toFixed(2).padStart(9)}  ` +
            `${`${r.reach}/${r.withTag}`.padStart(11)}   ` +
            `${r.rBar.toFixed(2).padStart(11)}   ` +
            `${pct(r.base.eps ? r.base.dec / r.base.eps : 0).padStart(9)}%   ` +
            `${pct(r.dest.eps ? r.dest.dec / r.dest.eps : 0).padStart(9)}%   ` +
            `${pct(r.dest.dec ? r.dest.cor / r.dest.dec : 1).padStart(9)}%`,
        );
      }
      console.log(
        `\n═══ INTERVALO DE τ — cobertura por visita na cadência ATUAL (1 Hz), pooled ═══\n` +
          `(o gate H1/H2 rodou com ρ=0,7 FIXO, equivalente a τ≈2,8 s @1 Hz — FORA deste intervalo)\n` +
          `${lines.join("\n")}`,
      );

      const white = rows[0];
      const bound = rows[rows.length - 1];
      const covW = white.dest.eps ? white.dest.dec / white.dest.eps : 0;
      const covB = bound.dest.eps ? bound.dest.dec / bound.dest.eps : 0;
      const covWbase = white.base.eps ? white.base.dec / white.base.eps : 0;

      console.log(
        `\nVEREDITO (o INTERVALO, não um ponto):\n` +
          `  Na cadência ATUAL (1 Hz), com o receptor no DESTINO, a cobertura por visita fica em\n` +
          `  [${pct(covB)}% ; ${pct(covW)}%] — ponta PESSIMISTA (τ=1,68 s, o bound) a ponta OTIMISTA (τ=0, o BRANCO,\n` +
          `  que é a estimativa PONTUAL). O gate reportou 0,3%. Até no BASELINE (estação no canto, sem\n` +
          `  mover nada) a ponta branca dá ${pct(covWbase)}%.\n` +
          `  ⇒ Os 15,5% de "2 Hz" que reportamos ${covW > 0.155 ? "SÃO SUPERADOS" : "NÃO são superados"} pela ponta τ→0 a 1 Hz (${pct(covW)}%).\n` +
          `\n  QUAL τ EU DEFENDO como estimativa central, e com que incerteza:\n` +
          `  • A estimativa PONTUAL é τ ≈ 0 (branco): a ACF do resíduo, depois de tirada a tendência de\n` +
          `    path-loss e o sample-and-hold, é indistinguível de zero em TODO lag ≥2,5 s. Nada no dado\n` +
          `    sustenta memória. E a re-mineração das ÂNCORAS mostrou que até a tag PARADA é branca no\n` +
          `    lag de 2 s — o ρ=0,7 era o hold. Não há mais nenhuma medição apoiando τ na casa dos segundos.\n` +
          `  • MAS o dado NÃO PODE provar τ=0: só prova τ ABAIXO da resolução de amostragem (2,5 s, o\n` +
          `    intervalo de advertising). Nada exclui memória em 100–500 ms, que a tag não deixa ver.\n` +
          `  • Então: defendo τ ∈ [0; 1,68] s com a MASSA perto de 0, e RECOMENDO reportar o INTERVALO\n` +
          `    de cobertura [${pct(covB)}%; ${pct(covW)}%], não um ponto. Cravar 4,6% (o bound) é tão desonesto\n` +
          `    quanto cravar ${pct(covW)}% (o branco).\n` +
          `  • O que FECHARIA o intervalo: uma tag que anuncie a ≥10 Hz por alguns minutos (resolve a ACF\n` +
          `    abaixo de 500 ms), ou um receptor que separe os canais 37/38/39 (mede o τ POR canal, sem a\n` +
          `    componente branca que o salto de canal injeta). Isso é medição, não compra de hardware.\n` +
          `  ⚠ E o que NÃO muda em NENHUMA ponta do intervalo: a cadência continua SATURANDO (é a lei), e\n` +
          `    a precisão se mantém alta. O que muda é QUANTO da visita se fecha — e é material.`,
      );

      // ── Assertivas ROBUSTAS ──
      // 1) A física: ρ CRESCE com τ (mais memória = mais desconto) e o n_eff CAI.
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].rho).toBeGreaterThan(rows[i - 1].rho);
        expect(rows[i].maxNeff).toBeLessThanOrEqual(rows[i - 1].maxNeff + 1e-9);
      }
      // 2) A ponta BRANCA (τ=0, a estimativa PONTUAL) não sofre desconto: ρ=0 ⇒ n_eff = nDistinct.
      expect(white.rho).toBe(0);
      expect(white.maxNeff).toBeGreaterThan(bound.maxNeff);
      // 3) A COBERTURA é MONOTÔNICA em τ (mais memória ⇒ menos visita decidida) — o intervalo é bem
      //    ordenado, então reportar [bound; branco] é reportar o intervalo INTEIRO.
      expect(covW).toBeGreaterThan(covB);
      // 4) O INTERVALO é MATERIAL (não é um detalhe): a ponta branca decide MUITO mais que o bound.
      //    Se isto flipar, a incerteza em τ deixou de importar e a varredura pode ser aposentada.
      expect(covW).toBeGreaterThan(covB * 2);
      // 5) Em TODA ponta do intervalo a decisão segue HONESTA (não se compra cobertura com lixo).
      for (const r of rows) {
        if (r.dest.dec > 0) expect(r.dest.cor / r.dest.dec).toBeGreaterThan(0.75);
      }
      // 6) O gate (ρ=0,7 ≡ τ≈2,8 s @1 Hz) fica FORA do intervalo medido — por isso ele errou o número.
      expect(rhoFromTauLocal(DT_1HZ, TAU_MOVEL_S)).toBeLessThan(0.7);
    },
    180000,
  );
});

/** ρ = e^(−Δt/τ) — espelho local da lei (evita importar o módulo de medição só para uma assertiva). */
function rhoFromTauLocal(dtS: number, tauS: number): number {
  return tauS > 0 ? Math.exp(-dtS / tauS) : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// A MEDIÇÃO HONESTA — CADÊNCIA REAL DA TAG (Δt ≈ 2,5 s), 2026-07-12.
//
// O BUG (confirmado por medição, não por argumento): TODA a varredura acima roda com o default do
// simulador, `rssiPeriodTicks=2` ⇒ RSSI fresco a cada 1,0 s. A tag REAL anuncia a cada ~2,5 s
// (medido em campo; é o mesmo dado que revelou o sample-and-hold — residual-autocorr.ts). O sim
// entrega 2,5× mais leituras GENUINAMENTE DISTINTAS do que a física permite. Como
// n_eff ≤ nDistinct ≤ ⌈T/Δt_tag⌉+1 (CONTAGEM, não estatística — Regra 8, visit-metrics.ts), o n_eff
// vinha inflado ~2,5×, e com ele a cobertura por visita.
//
// O NÚMERO QUE CAI: reportamos n_eff MÁX = 39 e cobertura de 45,2% (destino, τ→0). Um n_eff de 39
// exige 39 leituras distintas — o que, com a tag real, exige um episódio de ~97 s CONTÍNUOS na mesma
// aproximação. Nenhuma visita a uma mesa dura isso. O 39 era o sim falando, não a tag.
//
// Este teste RE-RODA a varredura de τ com `rssiPeriodTicks: REAL_TAG_PERIOD_TICKS` e reporta as duas
// tabelas LADO A LADO — a inflada (1 s) e a honesta (2,5 s). Achado negativo tem o mesmo peso.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("CADÊNCIA REAL DA TAG (2,5 s) — a cobertura HONESTA, e a aritmética que mata a aproximação", () => {
  type SweepRow = {
    dtS: number;
    tau: number;
    rho: number;
    base: { dec: number; cor: number; eps: number };
    dest: { dec: number; cor: number; eps: number };
    maxNeff: number;
    medNeff: number;
    maxNDistinct: number;
    reach: number;
    withTag: number;
    rBar: number;
  };

  /** Varredura pooled (baseline vs destino) numa cadência (`period` em ticks do sim) e num τ. */
  function sweepAt(period: number, tau: number): SweepRow {
    const dtS = period * TICK_S;
    // τ=0 (o BRANCO — a estimativa PONTUAL de campo) ⇒ ρ=0, o limite da lei. Ver effectiveRho.
    const vo = tau > 0 ? { tau, dtS } : { rho: 0 };
    const rho = tau > 0 ? Math.exp(-dtS / tau) : 0;
    const base = { dec: 0, cor: 0, eps: 0 };
    const dest = { dec: 0, cor: 0, eps: 0 };
    let maxNeff = 0;
    let maxNDistinct = 0;
    let reach = 0;
    let withTag = 0;
    const neffs: number[] = [];

    for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
      const opts = { ...entry.opts, rssiPeriodTicks: period };
      const traj = person0Trajectory(opts, entry.seed);
      if (traj.length < 2) continue;
      const destino = destinationOf(traj);

      const b = computeVisitMetrics(
        visitTicksFromScenario(simulateFusionScenario(opts, entry.seed)),
        vo,
      );
      base.dec += b.decidedWithTag;
      base.cor += b.decidedCorrect;
      base.eps += b.episodesWithTag;

      const ticksD = visitTicksFromScenario(
        simulateFusionScenario({ ...opts, stationWorldOverride: destino }, entry.seed),
      );
      const d = computeVisitMetrics(ticksD, vo);
      dest.dec += d.decidedWithTag;
      dest.cor += d.decidedCorrect;
      dest.eps += d.episodesWithTag;

      for (const e of computeVisitEpisodes(ticksD, vo).filter((x) => x.truthTag !== null)) {
        withTag++;
        let best = 0;
        let bestNd = 0;
        for (const c of e.candidates) {
          if (c.nEff > best) best = c.nEff;
          if (c.nDistinct > bestNd) bestNd = c.nDistinct;
        }
        if (best > 3) reach++;
        if (best > maxNeff) maxNeff = best;
        if (bestNd > maxNDistinct) maxNDistinct = bestNd;
        neffs.push(best);
      }
    }
    return {
      dtS,
      tau,
      rho,
      base,
      dest,
      maxNeff,
      medNeff: medianOf(neffs),
      maxNDistinct,
      reach,
      withTag,
      rBar: maxNeff > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (maxNeff - 3))) : 1,
    };
  }

  const TAUS = [0, 0.5, 1.0, TAU_MOVEL_S];

  it(
    "TABELA HONESTA: cobertura por visita com a tag REAL (2,5 s) vs a INFLADA do sim (1 s), por τ",
    () => {
      const real = TAUS.map((t) => sweepAt(REAL_TAG_PERIOD_TICKS, t)); // Δt = 2,5 s — A FÍSICA
      const infl = TAUS.map((t) => sweepAt(2, t)); // Δt = 1,0 s — o default do sim (INFLADO)

      const head =
        "τ (s)".padEnd(13) +
        "  ρ      n_eff máx  n_eff med  ndist máx  eps n_eff>3  |r| exigido  BASE cob%  BASE prec%  DEST cob%  DEST prec%";
      const fmt = (r: SweepRow): string =>
        `${r.tau === 0 ? "0 (BRANCO)" : r.tau.toFixed(2)}${r.tau === TAU_MOVEL_S ? "*" : ""}`.padEnd(13) +
        `  ${r.rho.toFixed(3)}  ` +
        `${r.maxNeff.toFixed(2).padStart(9)}  ${r.medNeff.toFixed(2).padStart(9)}  ` +
        `${String(r.maxNDistinct).padStart(9)}  ` +
        `${`${r.reach}/${r.withTag}`.padStart(10)}  ` +
        `${r.rBar.toFixed(2).padStart(11)}  ` +
        `${pct(r.base.eps ? r.base.dec / r.base.eps : 0).padStart(8)}%  ` +
        `${(r.base.dec ? `${pct(r.base.cor / r.base.dec)}%` : "—").padStart(9)}  ` +
        `${pct(r.dest.eps ? r.dest.dec / r.dest.eps : 0).padStart(8)}%  ` +
        `${(r.dest.dec ? `${pct(r.dest.cor / r.dest.dec)}%` : "—").padStart(9)}`;

      console.log(
        `\n═══ HONESTA — TAG REAL (Δt=${REAL_TAG_PERIOD_S} s, rssiPeriodTicks=${REAL_TAG_PERIOD_TICKS}) ═══\n` +
          `${head}\n${"-".repeat(head.length)}\n${real.map(fmt).join("\n")}\n` +
          `\n═══ INFLADA — CADÊNCIA DO SIM (Δt=1,0 s, o default rssiPeriodTicks=2) — O QUE REPORTAMOS ═══\n` +
          `${head}\n${"-".repeat(head.length)}\n${infl.map(fmt).join("\n")}\n` +
          `(* = τ=1,68 s, o LIMITE SUPERIOR conservador medido em campo; τ=0 = a estimativa PONTUAL.)`,
      );

      const rW = real[0]; // tag real, τ=0 (a ponta MAIS otimista que a física permite)
      const iW = infl[0]; // sim 1 Hz, τ=0 — a linha que gerou o "n_eff 39 / cobertura 45,2%"
      const covRealDest = rW.dest.eps ? rW.dest.dec / rW.dest.eps : 0;
      const covInflDest = iW.dest.eps ? iW.dest.dec / iW.dest.eps : 0;
      const covRealBase = rW.base.eps ? rW.base.dec / rW.base.eps : 0;
      const covInflBase = iW.base.eps ? iW.base.dec / iW.base.eps : 0;

      console.log(
        `\nVEREDITO (o número que sustenta a decisão de COMPRA, corrigido):\n` +
          `  n_eff MÁX na suíte:  sim(1 s)=${iW.maxNeff.toFixed(2)}  →  TAG REAL(2,5 s)=${rW.maxNeff.toFixed(2)}  ` +
          `(razão ${(iW.maxNeff / Math.max(1e-9, rW.maxNeff)).toFixed(2)}× — a inflação da cadência)\n` +
          `  COBERTURA no DESTINO (τ→0, a ponta otimista):  ${pct(covInflDest)}% (inflada)  →  ` +
          `${pct(covRealDest)}% (HONESTA)\n` +
          `  COBERTURA no BASELINE (τ→0): ${pct(covInflBase)}% (inflada)  →  ${pct(covRealBase)}% (HONESTA), ` +
          `prec ${rW.base.dec ? `${pct(rW.base.cor / rW.base.dec)}%` : "—"}\n` +
          `  ⇒ O "45,2%" que reportamos era o SIMULADOR anunciando a 1 Hz. A tag que existe anuncia a\n` +
          `    cada 2,5 s, e a mesma suíte, mesma geometria, mesmo τ, entrega ${pct(covRealDest)}%.\n` +
          `  ⚠ UMA INVERSÃO APARENTE, E O QUE ELA REALMENTE DIZ: com a tag REAL a COBERTURA do DESTINO\n` +
          `    fica ABAIXO da do baseline (${pct(covRealDest)}% vs ${pct(covRealBase)}%) — o oposto da régua de 1 Hz (45,2% vs\n` +
          `    24,9%). MAS olhar só a cobertura ENGANA: a PRECISÃO do baseline DESABA para ` +
          `${rW.base.dec ? pct(rW.base.cor / rW.base.dec) : "—"}%\n` +
          `    (quase cara-ou-coroa na identidade), enquanto o DESTINO decide a ` +
          `${rW.dest.dec ? pct(rW.dest.cor / rW.dest.dec) : "—"}%. O baseline não\n` +
          `    "cobre mais": ele FALA ERRADO mais — e falar errado viola a invariante do dono (rótulo\n` +
          `    errado é pior que nenhum). Sem span, o vencedor do ranking é ruído com |r| que cruzou a\n` +
          `    barra por acaso; o span do destino é o que separa o verdadeiro do espúrio.\n` +
          `    ⇒ LEITURA PARA A COMPRA: o receptor no destino compra QUALIDADE (precisão), NÃO cobertura.\n` +
          `      O salto de cobertura que justificava o ESP32 (24,9%→45,2%) era artefato da cadência\n` +
          `      inflada e NÃO sobrevive à tag real. (Achado NEGATIVO — mesmo peso, doutrina §5.)\n` +
          `  ⇒ O que NÃO muda: o que o destino decide, decide certo (${pct(rW.dest.dec ? rW.dest.cor / rW.dest.dec : 1)}%). A abstenção honesta\n` +
          `    segue de pé — o motor não passou a mentir; ele passou a se calar mais.\n` +
          `  ⇒ E A CADÊNCIA VOLTA A SER ALAVANCA LINEAR: com τ→0 (resíduo branco) NÃO há saturação —\n` +
          `    quem morde o n_eff é o 1º termo da lei (T/Δt_tag), a TAXA DA TAG. Uma tag 2,5× mais\n` +
          `    rápida devolve ~2,5× de n_eff. Não para vencer autocorrelação (não há) — para TER PONTOS.`,
      );

      // ── Assertivas ROBUSTAS ──
      // 1) Determinismo.
      expect(sweepAt(REAL_TAG_PERIOD_TICKS, 0)).toEqual(rW);
      // 2) O TETO DE CONTAGEM morde: com a tag real, nDistinct não passa do que a tag EMITE.
      expect(rW.maxNDistinct).toBeLessThan(iW.maxNDistinct);
      expect(rW.maxNeff).toBeLessThan(iW.maxNeff);
      // 3) O n_eff=39 do laudo é IMPOSSÍVEL com a tag real nesta suíte — é o coração do bug.
      expect(iW.maxNeff).toBeGreaterThan(35); // reproduz o "39" reportado (régua INFLADA)
      expect(rW.maxNeff).toBeLessThan(30); // a física não chega lá
      // 4) A COBERTURA HONESTA DESABA vs a inflada — o achado NEGATIVO, selado. Se isto flipar
      //    (a real alcançar a inflada), alguém mexeu na física da bancada: re-examinar.
      expect(covRealDest).toBeLessThan(covInflDest * 0.75);
      expect(covRealDest).toBeLessThan(0.1); // a cobertura honesta no destino é MARGINAL (<10%)
      // 4b) A INVERSÃO que a régua inflada escondia: com a tag REAL o destino NÃO bate o baseline em
      //     COBERTURA (com 1 Hz ele quase DOBRAVA). O salto que justificava o ESP32 era artefato.
      expect(covInflDest).toBeGreaterThan(covInflBase); // régua inflada: destino VENCIA em cobertura
      expect(covRealDest).toBeLessThan(covRealBase); // régua honesta: destino PERDE em cobertura
      // 4c) MAS a cobertura do baseline é COMPRADA COM RÓTULO ERRADO: a precisão dele desaba para
      //     ~perto do acaso, enquanto a do destino se mantém. O receptor no destino compra
      //     QUALIDADE, não cobertura — é o que o span faz quando faltam pontos. Selado nos dois lados.
      expect(rW.base.cor / rW.base.dec).toBeLessThan(0.7); // baseline decide MAL com a tag real
      expect(rW.dest.cor / rW.dest.dec).toBeGreaterThan(0.9); // destino decide BEM
      expect(rW.dest.cor / rW.dest.dec).toBeGreaterThan(rW.base.cor / rW.base.dec);
      // 5) MAS o que decide, decide HONESTO — a precisão não desaba junto (não é lixo).
      for (const r of real) if (r.dest.dec > 0) expect(r.dest.cor / r.dest.dec).toBeGreaterThan(0.75);
      // 6) A monotonia da física sobrevive à correção: mais τ ⇒ mais ρ ⇒ menos n_eff.
      for (let i = 1; i < real.length; i++) {
        expect(real[i].rho).toBeGreaterThan(real[i - 1].rho);
        expect(real[i].maxNeff).toBeLessThanOrEqual(real[i - 1].maxNeff + 1e-9);
      }
    },
    300000,
  );

  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  // A ARITMÉTICA QUE MATA A APROXIMAÇÃO — e que sobrevive a qualquer modelo (é CONTAGEM).
  //
  // O teste de Fisher tem √(n_eff − 3) no DENOMINADOR. Com n_eff ≤ 3 ele não é "difícil": é
  // INDEFINIDO — não existe. Com a tag real (2,5 s), uma aproximação típica a uma mesa (3–8 s)
  // produz ⌈T/2,5⌉+1 = 3 a 5 leituras distintas. É estruturalmente insuficiente. Não há knob de
  // software, posição de receptor ou τ que conserte: faltam PONTOS PARA AJUSTAR A RETA.
  //
  // Este teste produz a ESPECIFICAÇÃO DE PROJETO: (T, Δt_tag) → nDistinct → barra |r| → veredito.
  // É quem responde "onde o receptor precisa estar" e "vale comprar tag rápida?".
  // ═══════════════════════════════════════════════════════════════════════════════════════════════
  it("REQUISITOS: (T, Δt_tag) → nDistinct → barra |r| → veredito; e o T MÍNIMO para o teste EXISTIR", () => {
    /** n_eff pela lei, com o teto de CONTAGEM: n_eff = min(nDistinct·(1−ρ)/(1+ρ), nDistinct). */
    const neffOf = (tS: number, dtS: number, tau: number): number => {
      const nd = maxDistinctReadings(tS * 1000, dtS);
      const rho = tau > 0 ? Math.exp(-dtS / tau) : 0;
      return Math.min((nd * (1 - rho)) / (1 + rho), nd);
    };
    /** Barra de |r| exigida pelo gate; NaN quando o teste NÃO EXISTE (n_eff ≤ 3). */
    const rBarOf = (neff: number): number =>
      neff > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (neff - 3))) : Number.NaN;
    /** Menor T (passo 0,5 s) que satisfaz uma condição sobre a barra de |r|. */
    const minTFor = (dtS: number, tau: number, ok: (rBar: number) => boolean): number => {
      for (let t = 0.5; t <= 600; t += 0.5) if (ok(rBarOf(neffOf(t, dtS, tau)))) return t;
      return Number.POSITIVE_INFINITY;
    };
    const exists = (rBar: number): boolean => Number.isFinite(rBar); // n_eff > 3
    const viable = (rBar: number): boolean => Number.isFinite(rBar) && rBar <= 0.7; // |r| plausível

    // ── (a) A APROXIMAÇÃO TÍPICA (3–8 s), com a tag real: quantas leituras DISTINTAS? ──
    const approach = [3, 4, 5, 6, 7, 8].map((t) => ({
      t,
      nd: maxDistinctReadings(t * 1000, REAL_TAG_PERIOD_S),
      neffWhite: neffOf(t, REAL_TAG_PERIOD_S, 0),
      neffBound: neffOf(t, REAL_TAG_PERIOD_S, TAU_MOVEL_S),
    }));
    console.log(
      `\n═══ (a) APROXIMAÇÃO TÍPICA a uma mesa, com a TAG REAL (Δt=${REAL_TAG_PERIOD_S} s) ═══\n` +
        "T (s)   nDistinct   n_eff(τ=0)   n_eff(τ=1,68)   teste de Fisher\n" +
        "-".repeat(76) +
        "\n" +
        approach
          .map(
            (a) =>
              `${a.t.toFixed(0).padStart(5)}   ${String(a.nd).padStart(9)}   ` +
              `${a.neffWhite.toFixed(2).padStart(10)}   ${a.neffBound.toFixed(2).padStart(13)}   ` +
              `${a.neffWhite > 3 ? `existe (exige |r| ≥ ${rBarOf(a.neffWhite).toFixed(2)})` : "INDEFINIDO (n_eff ≤ 3)"}`,
          )
          .join("\n"),
    );

    // ── (b) T MÍNIMO para o teste EXISTIR (n_eff>3) e para ser VIÁVEL (|r| exigido ≤ 0,7) ──
    const cadences: { label: string; dtS: number }[] = [
      { label: "TAG REAL (2,5 s)", dtS: REAL_TAG_PERIOD_S },
      { label: "tag 1 Hz (1,0 s)", dtS: 1.0 },
      { label: "tag 2 Hz (0,5 s)", dtS: 0.5 },
      { label: "tag 10 Hz (0,1 s)", dtS: 0.1 },
    ];
    console.log(
      `\n═══ (b) T MÍNIMO DO EPISÓDIO — o que a GEOMETRIA DE INSTALAÇÃO tem de entregar ═══\n` +
        "cadência da tag".padEnd(20) +
        "──────── τ=0 (BRANCO) ────────  ────── τ=1,68 s (bound) ──────\n" +
        "".padEnd(20) +
        "existe(n_eff>3)  viável(|r|≤0,7)  existe(n_eff>3)  viável(|r|≤0,7)\n" +
        "-".repeat(86) +
        "\n" +
        cadences
          .map((c) => {
            const f = (x: number): string => (Number.isFinite(x) ? `${x.toFixed(1)} s` : "NUNCA");
            return (
              c.label.padEnd(20) +
              f(minTFor(c.dtS, 0, exists)).padStart(15) +
              f(minTFor(c.dtS, 0, viable)).padStart(17) +
              f(minTFor(c.dtS, TAU_MOVEL_S, exists)).padStart(17) +
              f(minTFor(c.dtS, TAU_MOVEL_S, viable)).padStart(17)
            );
          })
          .join("\n"),
    );

    // ── (c) A TABELA DE REQUISITOS: (T, Δt) → nDistinct → barra |r| → veredito ──
    const reqs: { t: number; dt: number }[] = [
      { t: 8, dt: REAL_TAG_PERIOD_S },
      { t: 20, dt: REAL_TAG_PERIOD_S },
      { t: 40, dt: REAL_TAG_PERIOD_S },
      { t: 97, dt: REAL_TAG_PERIOD_S },
      { t: 20, dt: 1 },
      { t: 40, dt: 1 },
      { t: 8, dt: 0.5 },
      { t: 20, dt: 0.5 },
    ];
    const verdictOf = (rBar: number): string =>
      !Number.isFinite(rBar)
        ? "INDEFINIDO — o teste nem existe (√(n_eff−3) imaginário)"
        : rBar > 0.9
          ? "INÚTIL — exige |r| quase perfeito"
          : rBar > 0.7
            ? "MARGINAL — exige |r| alto; só com span grande"
            : rBar > 0.5
              ? "VIÁVEL — barra plausível no destino"
              : "CONFORTÁVEL";
    console.log(
      `\n═══ (c) TABELA DE REQUISITOS — a ESPECIFICAÇÃO DE PROJETO (τ=0, a ponta OTIMISTA) ═══\n` +
        "T (s)  Δt_tag (s)  nDistinct  n_eff  |r| exigido   veredito\n" +
        "-".repeat(100) +
        "\n" +
        reqs
          .map(({ t, dt }) => {
            const nd = maxDistinctReadings(t * 1000, dt);
            const ne = neffOf(t, dt, 0);
            const rb = rBarOf(ne);
            return (
              `${t.toFixed(0).padStart(5)}  ${dt.toFixed(1).padStart(10)}  ${String(nd).padStart(9)}  ` +
              `${ne.toFixed(1).padStart(5)}  ${(Number.isFinite(rb) ? rb.toFixed(2) : "—").padStart(11)}   ` +
              verdictOf(rb)
            );
          })
          .join("\n"),
    );

    const tExistReal = minTFor(REAL_TAG_PERIOD_S, 0, exists);
    const tViableReal = minTFor(REAL_TAG_PERIOD_S, 0, viable);
    const tExist2Hz = minTFor(0.5, 0, exists);
    const tViable2Hz = minTFor(0.5, 0, viable);
    console.log(
      `\nVEREDITO DE ESPECIFICAÇÃO (a conclusão de ENGENHARIA, que sobrevive a todo modelo):\n` +
        `  • Com a tag REAL (2,5 s), uma aproximação de 3–8 s produz ${approach[0].nd}–${approach[approach.length - 1].nd} leituras DISTINTAS.\n` +
        `    O teste de Fisher tem √(n_eff−3) no denominador ⇒ com n_eff ≤ 3 ele é INDEFINIDO, não\n` +
        `    "difícil". A identidade por UMA aproximação breve NÃO é um problema de ajuste fino: é uma\n` +
        `    IMPOSSIBILIDADE ARITMÉTICA. Nenhum τ, span, receptor ou knob a conserta.\n` +
        `  • T MÍNIMO (tag real, τ→0): o teste EXISTE a partir de ${tExistReal.toFixed(1)} s; fica VIÁVEL (|r|≤0,7) a\n` +
        `    partir de ${tViableReal.toFixed(1)} s. Ou seja: só PERMANÊNCIA fecha — o receptor precisa cobrir a janela\n` +
        `    em que o operador FICA, não a em que ele PASSA.\n` +
        `  • VALE TAG RÁPIDA? SIM, e a lei diz por quê: com τ→0 (resíduo BRANCO, o medido) NÃO há\n` +
        `    saturação — quem morde é o 1º termo, T/Δt_tag. A 2 Hz o teste passa a EXISTIR com ${tExist2Hz.toFixed(1)} s e a\n` +
        `    ser VIÁVEL com ${tViable2Hz.toFixed(1)} s (contra ${tExistReal.toFixed(1)}/${tViableReal.toFixed(1)} s da tag real): ~5× menos permanência exigida.\n` +
        `    Isto RETIFICA o laudo anterior ("a cadência satura; não compre tag rápida") — aquilo valia\n` +
        `    para τ LONGO (tag parada). Para a tag MÓVEL (τ→0), a cadência é alavanca LINEAR.`,
    );

    // ── Assertivas ROBUSTAS (a ARITMÉTICA — se isto quebrar, a lei mudou) ──
    // 1) A aproximação típica é estruturalmente indecidível com a tag real.
    expect(maxDistinctReadings(3000, REAL_TAG_PERIOD_S)).toBe(3); // T=3 s → 3 leituras
    expect(maxDistinctReadings(8000, REAL_TAG_PERIOD_S)).toBe(5); // T=8 s → 5 leituras
    expect(neffOf(3, REAL_TAG_PERIOD_S, 0)).toBeLessThanOrEqual(3); // INDEFINIDO
    expect(rBarOf(neffOf(3, REAL_TAG_PERIOD_S, 0))).toBeNaN(); // o teste NÃO EXISTE
    expect(neffOf(5, REAL_TAG_PERIOD_S, TAU_MOVEL_S)).toBeLessThanOrEqual(3); // com o τ do bound, idem
    // 2) O T MÍNIMO com a tag real (τ→0, a ponta OTIMISTA — inclui a leitura CARREGADA): o teste
    //    EXISTE a partir de 5,5 s; fica VIÁVEL (|r|≤0,7) só a partir de 18 s. Uma aproximação de
    //    3–5 s não chega nem a EXISTIR.
    expect(tExistReal).toBe(5.5);
    expect(tViableReal).toBe(18);
    // 3) A CADÊNCIA É ALAVANCA LINEAR com τ→0 (NÃO satura): acelerar a tag corta o T exigido na
    //    MESMA proporção — é o 1º termo da lei (T/Δt_tag) mordendo, não o 2º (autocorrelação).
    //    Prova da LINEARIDADE: o T viável escala com Δt_tag (razão dos T ≈ razão dos Δt).
    expect(tExist2Hz).toBeLessThan(tExistReal);
    expect(tViable2Hz).toBeLessThanOrEqual(tViableReal / 4); // 2,5 s→0,5 s (5×) corta o T ≥4×
    const tViable1Hz = minTFor(1.0, 0, viable);
    expect(tViable1Hz / tViableReal).toBeCloseTo(1.0 / REAL_TAG_PERIOD_S, 1); // LINEAR em Δt_tag
    // 3b) CONTRA-PROVA (a lei tem DOIS termos): com τ LONGO o 2º termo domina e a cadência SATURA —
    //     acelerar a tag NÃO ajuda mais. É por isso que o laudo antigo (τ de âncora) via saturação.
    const satReal = minTFor(REAL_TAG_PERIOD_S, TAU_MOVEL_S, viable);
    const sat10Hz = minTFor(0.1, TAU_MOVEL_S, viable);
    expect(sat10Hz).toBeGreaterThan(satReal * 0.8); // 25× de cadência quase não move o T exigido
    // 4) O n_eff=39 do laudo, traduzido em requisito físico: ~97 s de episódio com a tag real.
    expect(maxDistinctReadings(97000, REAL_TAG_PERIOD_S)).toBeGreaterThanOrEqual(39);
    expect(maxDistinctReadings(40000, REAL_TAG_PERIOD_S)).toBeLessThan(39); // 40 s NÃO basta
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// O "PORTAL DE IDENTIFICAÇÃO" — a cobertura CONDICIONADA À DURAÇÃO do episódio (2026-07-12).
//
// A RELEITURA que este bloco testa. Reportamos "cobertura 2,5%" (destino, tag real) — mas isso é uma
// taxa INCONDICIONAL, diluída por dezenas de episódios CURTOS que JAMAIS PODERIAM disparar: com a tag
// real (Δt=2,5 s), um episódio de 3-8 s produz 3-5 leituras DISTINTAS ⇒ n_eff ≤ 3 ⇒ o teste de Fisher
// é INDEFINIDO (√(n_eff−3) imaginário — Regra 8/CLAUDE.md). Medir a cobertura sobre eles é medir a
// nossa própria aritmética, não o rádio.
//
// O DOMÍNIO (respostas do dono, jul/12): os postos são mesas VIZINHAS e o operador circula LIVRE.
// O movimento cotidiano é mesa→mesa (3-5 m, T≈2-4 s) — o rádio NÃO dispara nele, por CONTAGEM. O que
// existe é a caminhada LONGA (entrada de turno, volta de intervalo: ~20 m, T≈18 s a 1,2 m/s), 2-4×
// por turno. A pergunta CERTA para o desenho do produto ("portal": câmera cobrindo o corredor de
// entrada + receptor no fim dele) é:
//
//        Qual a cobertura CONDICIONADA a T ≥ 18 s? E com que precisão?
//
// Não se precisa de MUITAS identificações — precisa de UMA ÂNCORA CONFIÁVEL por turno; as camadas 3-5
// (conservação por zona + HSMM + conformance) carregam a identidade pelo resto.
//
// ‼ CIRCULARIDADE (declarada, doutrina §5): a cobertura/precisão saem do SIMULADOR (que gera
//   RSSI = f(dist→estação) + ruído ⇒ |r| alto POR CONSTRUÇÃO). São INDICATIVAS. O que É campo, e
//   entra sem simulador nenhum, é a DISTRIBUIÇÃO DE T do item 3 (gravação real) — e ela é quem diz se
//   o portal teria THROUGHPUT.
// ‼ τ: uso τ→0 (ρ=0) — a estimativa PONTUAL de campo (resíduo da tag móvel é BRANCO). É a ponta
//   OTIMISTA do intervalo [0; 1,68 s] e a única defensável como estimativa central (ver retratações).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("PORTAL — cobertura CONDICIONADA à duração T do episódio (a releitura do 2,5%)", () => {
  /** Um episódio, reduzido ao que a estratificação por duração precisa. */
  type EpStat = {
    tS: number; // T = duração de PAREDE do episódio (endTs−startTs), em segundos
    nDistinct: number; // leituras DISTINTAS do melhor candidato (o teto de contagem em ação)
    nEff: number;
    decided: boolean;
    correct: boolean;
  };

  type Bin = { label: string; lo: number; hi: number };
  /** Faixas de T pedidas pela decisão de produto. ≥18 s = a caminhada longa (20 m a 1,2 m/s). */
  const BINS: Bin[] = [
    { label: "T < 5 s", lo: 0, hi: 5 },
    { label: "5 ≤ T < 10 s", lo: 5, hi: 10 },
    { label: "10 ≤ T < 18 s", lo: 10, hi: 18 },
    { label: "18 ≤ T < 30 s", lo: 18, hi: 30 },
    { label: "T ≥ 30 s", lo: 30, hi: Infinity },
  ];

  /** Episódios-COM-TAG de toda a suíte, numa cadência de tag e numa posição de receptor. τ→0 (ρ=0). */
  function collect(period: number, at: "base" | "dest"): { eps: EpStat[]; viol: number } {
    const vo = { rho: 0 }; // τ→0 (BRANCO — a estimativa pontual de campo)
    const out: EpStat[] = [];
    const dtTagS = period * TICK_S;
    let viol = 0;
    for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
      const opts = { ...entry.opts, rssiPeriodTicks: period };
      const traj = person0Trajectory(opts, entry.seed);
      if (traj.length < 2) continue;
      const simOpts = at === "dest" ? { ...opts, stationWorldOverride: destinationOf(traj) } : opts;
      const ticks = visitTicksFromScenario(simulateFusionScenario(simOpts, entry.seed));
      const episodes: VisitEpisode[] = computeVisitEpisodes(ticks, vo);
      // REGRA 8 (assert, não comentário): nDistinct ≤ ⌈T/Δt_tag⌉+1 e nEff ≤ nDistinct. Violou = BUG.
      viol += countingViolations(episodes, dtTagS).length;
      for (const e of episodes) {
        if (e.truthTag === null) continue;
        let nEff = 0;
        let nDistinct = 0;
        for (const c of e.candidates) {
          if (c.nEff > nEff) nEff = c.nEff;
          if (c.nDistinct > nDistinct) nDistinct = c.nDistinct;
        }
        out.push({
          tS: (e.endTs - e.startTs) / 1000,
          nDistinct,
          nEff,
          decided: e.decided,
          correct: e.correct === true,
        });
      }
    }
    return { eps: out, viol };
  }

  type BinStat = { label: string; n: number; medND: number; medNeff: number; dec: number; cor: number };
  const binize = (eps: EpStat[], bins: Bin[]): BinStat[] =>
    bins.map((b) => {
      const inBin = eps.filter((e) => e.tS >= b.lo && e.tS < b.hi);
      return {
        label: b.label,
        n: inBin.length,
        medND: medianOf(inBin.map((e) => e.nDistinct)),
        medNeff: medianOf(inBin.map((e) => e.nEff)),
        dec: inBin.filter((e) => e.decided).length,
        cor: inBin.filter((e) => e.decided && e.correct).length,
      };
    });
  /** Cobertura/precisão CONDICIONADAS a T ≥ tMin — o número que decide o portal. */
  const condAt = (
    eps: EpStat[],
    tMin: number,
  ): { n: number; dec: number; cor: number; cov: number; prec: number } => {
    const s = eps.filter((e) => e.tS >= tMin);
    const dec = s.filter((e) => e.decided).length;
    const cor = s.filter((e) => e.decided && e.correct).length;
    return { n: s.length, dec, cor, cov: s.length ? dec / s.length : 0, prec: dec ? cor / dec : 1 };
  };

  const BIN_HEAD = "faixa de T".padEnd(15) + "eps   ndist_med   n_eff_med   decid   cobertura   precisão";
  const fmtBin = (b: BinStat): string =>
    b.label.padEnd(15) +
    `${String(b.n).padStart(3)}   ` +
    `${b.medND.toFixed(1).padStart(9)}   ` +
    `${b.medNeff.toFixed(2).padStart(9)}   ` +
    `${String(b.dec).padStart(5)}   ` +
    `${(b.n ? `${pct(b.dec / b.n)}%` : "—").padStart(9)}   ` +
    `${(b.dec ? `${pct(b.cor / b.dec)}%` : "—").padStart(8)}`;

  it(
    "TAREFA 1+2 — cobertura/precisão ESTRATIFICADAS por T (tag REAL 2,5 s e tag RÁPIDA 0,5 s)",
    () => {
      // ── (1) TAG REAL (Δt = 2,5 s) — baseline (canto) e destino ──
      const realBase = collect(REAL_TAG_PERIOD_TICKS, "base");
      const realDest = collect(REAL_TAG_PERIOD_TICKS, "dest");
      // ── (2) TAG RÁPIDA (Δt = 0,5 s, rssiPeriodTicks=1) — o corredor encolhe? ──
      const fastBase = collect(1, "base");
      const fastDest = collect(1, "dest");

      // REGRA 8: nenhuma violação de contagem em NENHUMA das quatro configurações.
      expect(realBase.viol).toBe(0);
      expect(realDest.viol).toBe(0);
      expect(fastBase.viol).toBe(0);
      expect(fastDest.viol).toBe(0);

      const show = (title: string, c: { eps: EpStat[] }): string =>
        `\n${title}\n${BIN_HEAD}\n${"-".repeat(BIN_HEAD.length)}\n` +
        binize(c.eps, BINS).map(fmtBin).join("\n");

      console.log(
        `\n═══ TAREFA 1 — TAG REAL (Δt=${REAL_TAG_PERIOD_S} s), τ→0, pooled sobre a suíte ═══` +
          show(`BASELINE (estação no canto 0,0) — ${realBase.eps.length} episódios-com-tag`, realBase) +
          show(
            `DESTINO (receptor no fim da caminhada) — ${realDest.eps.length} episódios-com-tag`,
            realDest,
          ),
      );

      const r18b = condAt(realBase.eps, 18);
      const r18d = condAt(realDest.eps, 18);
      const rAllb = condAt(realBase.eps, 0);
      const rAlld = condAt(realDest.eps, 0);
      console.log(
        `\n★★ O NÚMERO QUE DECIDE O PORTAL — cobertura CONDICIONADA a T ≥ 18 s (tag real 2,5 s) ★★\n` +
          `  INCONDICIONAL (o que reportamos):  BASE ${pct(rAllb.cov)}% (prec ${pct(rAllb.prec)}%, n=${rAllb.n})   ` +
          `DESTINO ${pct(rAlld.cov)}% (prec ${pct(rAlld.prec)}%, n=${rAlld.n})\n` +
          `  CONDICIONADA a T≥18 s:             BASE ${pct(r18b.cov)}% (prec ${pct(r18b.prec)}%, n=${r18b.n})   ` +
          `DESTINO ${pct(r18d.cov)}% (prec ${pct(r18d.prec)}%, n=${r18d.n})\n` +
          `  ⇒ ganho de condicionar (destino): ${pct(rAlld.cov)}% → ${pct(r18d.cov)}% ` +
          `(${rAlld.cov > 0 ? `${(r18d.cov / rAlld.cov).toFixed(1)}×` : "—"}). A taxa incondicional estava\n` +
          `    DILUÍDA por episódios curtos que não podiam disparar por CONTAGEM (n_eff ≤ 3 ⇒ Fisher indefinido).`,
      );

      console.log(
        `\n═══ TAREFA 2 — TAG RÁPIDA (Δt=0,5 s / 2 Hz), τ→0 — o corredor exigido encolhe ═══` +
          show(`BASELINE (canto) — ${fastBase.eps.length} episódios-com-tag`, fastBase) +
          show(`DESTINO — ${fastDest.eps.length} episódios-com-tag`, fastDest),
      );
      const f8b = condAt(fastBase.eps, 8);
      const f8d = condAt(fastDest.eps, 8);
      const f18d = condAt(fastDest.eps, 18);
      const nd8fast = maxDistinctReadings(8000, 0.5);
      console.log(
        `\n★ TAG RÁPIDA — cobertura CONDICIONADA a T ≥ 8 s (o T que a tag de 0,5 s exige p/ |r| plausível):\n` +
          `  BASE    ${pct(f8b.cov)}% (prec ${pct(f8b.prec)}%, n=${f8b.n})\n` +
          `  DESTINO ${pct(f8d.cov)}% (prec ${pct(f8d.prec)}%, n=${f8d.n})   [T≥18 s: ${pct(f18d.cov)}%, n=${f18d.n}]\n` +
          `  ⇒ com Δt=0,5 s, T=8 s já dá nDistinct=${nd8fast} ⇒ |r| exigido ` +
          `${Math.tanh(1.96 * Math.sqrt(1 / (nd8fast - 3))).toFixed(2)} — o corredor cai de\n` +
          `    ~${(18 * 1.2).toFixed(0)} m (tag real) para ~${(8 * 1.2).toFixed(0)} m. É a diferença entre "não dá pra instalar" e "dá".`,
      );

      // ── Assertivas ROBUSTAS (o VEREDITO, não números frágeis) ──
      // 1) Determinismo.
      expect(collect(REAL_TAG_PERIOD_TICKS, "dest").eps.length).toBe(realDest.eps.length);
      // 2) A ARITMÉTICA (Regra 8) morde nas faixas curtas: com a tag real, T<5 s NUNCA decide — não
      //    por fraqueza de sinal, por CONTAGEM (nDistinct ≤ 3 ⇒ n_eff ≤ 3 ⇒ Fisher indefinido).
      const shortReal = binize(realDest.eps, BINS)[0];
      expect(shortReal.dec).toBe(0);
      expect(shortReal.medNeff).toBeLessThanOrEqual(3);
      // 3) CONDICIONAR SOBE A COBERTURA: T≥18 s decide MUITO mais que a média incondicional. Se isto
      //    flipar, a releitura do portal cai — é o gate do achado.
      expect(r18d.cov).toBeGreaterThan(rAlld.cov);
      // 4) E o que decide em T≥18 s decide HONESTO (não é cobertura comprada com rótulo errado).
      if (r18d.dec > 0) expect(r18d.prec).toBeGreaterThan(0.75);
      // 5) A TAG RÁPIDA antecipa o gate: a 0,5 s o episódio médio-curto ganha n_eff que a tag real
      //    não pode dar (teto de contagem). É a alavanca LINEAR da lei (1º termo, T/Δt_tag).
      const midFast = binize(fastDest.eps, BINS)[1]; // 5 ≤ T < 10 s
      const midReal = binize(realDest.eps, BINS)[1];
      expect(midFast.medNeff).toBeGreaterThan(midReal.medNeff);
      expect(f8d.cov).toBeGreaterThan(condAt(realDest.eps, 8).cov);
    },
    300000,
  );

  // ── TAREFA 4 — a TABELA DE DECISÃO (insumo de instalação e de compra da tag) ──
  it(
    "TAREFA 4 — (T mínimo, Δt_tag) → corredor exigido a 1,2 m/s → cobertura condicionada → veredito",
    () => {
      const WALK_MS = 1.2; // m/s — passo de operador em corredor (o mesmo que dá 20 m ≈ 18 s)
      const realDest = collect(REAL_TAG_PERIOD_TICKS, "dest").eps;
      const fastDest = collect(1, "dest").eps;
      const ndOf = (tS: number, dt: number): number => maxDistinctReadings(tS * 1000, dt);
      const rBar = (ne: number): number =>
        ne > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (ne - 3))) : Number.NaN;

      const rows: { tMin: number; dt: number; eps: EpStat[] }[] = [
        { tMin: 4, dt: REAL_TAG_PERIOD_S, eps: realDest }, // mesa→mesa vizinha (o cotidiano)
        { tMin: 8, dt: REAL_TAG_PERIOD_S, eps: realDest },
        { tMin: 18, dt: REAL_TAG_PERIOD_S, eps: realDest },
        { tMin: 30, dt: REAL_TAG_PERIOD_S, eps: realDest },
        { tMin: 4, dt: 0.5, eps: fastDest },
        { tMin: 8, dt: 0.5, eps: fastDest },
        { tMin: 18, dt: 0.5, eps: fastDest },
      ];
      const head =
        "T mín (s)  Δt_tag (s)  corredor (m)  nDist  |r| exigido  cob. cond.  prec.    n    veredito";
      const lines = [head, "-".repeat(head.length + 12)];
      for (const { tMin, dt, eps } of rows) {
        const nd = ndOf(tMin, dt);
        const rb = rBar(nd);
        const c = condAt(eps, tMin);
        const verdict = !Number.isFinite(rb)
          ? "INDEFINIDO — Fisher não existe (faltam PONTOS)"
          : rb > 0.9
            ? "INÚTIL — exige |r| quase perfeito"
            : rb > 0.7
              ? "MARGINAL"
              : c.cov >= 0.5
                ? "PORTAL VIÁVEL (barra ok + cobertura alta)"
                : "VIÁVEL — barra ok, cobertura parcial";
        lines.push(
          `${tMin.toFixed(0).padStart(9)}  ${dt.toFixed(1).padStart(10)}  ` +
            `${(tMin * WALK_MS).toFixed(1).padStart(12)}  ${String(nd).padStart(5)}  ` +
            `${(Number.isFinite(rb) ? rb.toFixed(2) : "—").padStart(11)}  ` +
            `${`${pct(c.cov)}%`.padStart(10)}  ${(c.dec ? `${pct(c.prec)}%` : "—").padStart(6)}  ` +
            `${String(c.n).padStart(3)}    ${verdict}`,
        );
      }
      console.log(
        `\n═══ TAREFA 4 — TABELA DE DECISÃO DO PORTAL (τ→0; cobertura/precisão = SIMULADOR, indicativas) ═══\n` +
          `${lines.join("\n")}\n` +
          `  (corredor = T × 1,2 m/s = o comprimento que a CÂMERA precisa OBSERVAR; o receptor fica no FIM dele.)`,
      );

      // ── Assertivas: a ARITMÉTICA da tabela (não os números do sim) ──
      expect(ndOf(18, REAL_TAG_PERIOD_S)).toBeGreaterThanOrEqual(8); // 18 s c/ tag real: teste VIÁVEL
      expect(rBar(ndOf(18, REAL_TAG_PERIOD_S))).toBeLessThanOrEqual(0.7);
      expect(rBar(ndOf(8, 0.5))).toBeLessThanOrEqual(0.5); // 8 s c/ tag rápida: CONFORTÁVEL
      expect(rBar(ndOf(4, REAL_TAG_PERIOD_S))).toBeNaN(); // mesa→mesa vizinha: o teste NEM EXISTE
    },
    300000,
  );

  // ── TAREFA 3 — a DISTRIBUIÇÃO REAL de T (CAMPO, não simulador): o portal teria THROUGHPUT? ──
  // Gravação READ-ONLY (CLAUDE.md §3), gitignored → ausente no CI → it.skipIf pula.
  // SEM verdade anotada ⇒ SÓ duração/contagem. NUNCA precisão. (Mesmo gate de visit-metrics.test.ts.)
  const WALK_FILES = [
    "server/bt/fusion-session-2026-07-11_20.jsonl",
    "server/bt/fusion-session-2026-07-11_19.jsonl",
  ];
  const WALK_FILE = WALK_FILES.find((f) => existsSync(f));

  it.skipIf(!WALK_FILE)(
    "TAREFA 3 — distribuição REAL da duração dos episódios (campo): quantos alcançam T ≥ 18 s?",
    () => {
      const lines = readFileSync(WALK_FILE!, "utf8").split(/\r?\n/);
      const scenario = parseFusionSession(lines, {});
      const stationPx = scenario.H ? scenario.stationPx : undefined;
      const ticks: VisitTick[] = [];
      for (const tick of scenario.ticks) {
        if (tick.readings.length === 0) continue;
        const frame = buildFusionFrame(tick.tracks, tick.readings, scenario.H, tick.ts, stationPx);
        const rssiByTag: Record<string, number> = {};
        for (const r of frame.readings) rssiByTag[r.tag] = r.rssi;
        ticks.push({
          ts: tick.ts,
          tracks: frame.tracks.map((t) => ({ trackId: t.trackId, truthTag: null, dist: t.dist })),
          rssiByTag,
        });
      }
      const episodes = computeVisitEpisodes(ticks, { rho: 0 });
      const durs = episodes.map((e) => (e.endTs - e.startTs) / 1000).sort((a, b) => a - b);
      const q = (p: number): number =>
        durs.length ? durs[Math.min(durs.length - 1, Math.floor(p * durs.length))] : 0;
      const over = (t: number): number => durs.filter((d) => d >= t).length;

      const histBins = [0, 2, 5, 8, 10, 18, 30, 60];
      const hist = histBins.map((lo, i) => {
        const hi = histBins[i + 1] ?? Infinity;
        return { lo, hi, n: durs.filter((d) => d >= lo && d < hi).length };
      });
      console.log(
        `\n═══ TAREFA 3 — DISTRIBUIÇÃO REAL DE T (CAMPO: ${WALK_FILE}; sem verdade ⇒ só duração) ═══\n` +
          `episódios: ${durs.length} | mediana ${q(0.5).toFixed(1)} s | p75 ${q(0.75).toFixed(1)} s | ` +
          `p90 ${q(0.9).toFixed(1)} s | p99 ${q(0.99).toFixed(1)} s | MÁX ${(durs[durs.length - 1] ?? 0).toFixed(1)} s\n` +
          hist
            .map(
              (b) =>
                `  ${`${b.lo}–${b.hi === Infinity ? "∞" : b.hi} s`.padEnd(10)} ${String(b.n).padStart(4)}  ` +
                `${"#".repeat(Math.round((40 * b.n) / Math.max(1, durs.length)))}`,
            )
            .join("\n") +
          `\n  T ≥ 5 s: ${over(5)} | T ≥ 8 s: ${over(8)} (o gate da TAG RÁPIDA) | ` +
          `T ≥ 18 s: ${over(18)} (o gate da TAG REAL) | T ≥ 30 s: ${over(30)}\n` +
          `  ⇒ THROUGHPUT bruto do setup ATUAL: ${over(18)} episódios ≥18 s e ${over(8)} ≥8 s nesta gravação.\n` +
          `    RESSALVA HONESTA: esta gravação NÃO é um corredor de portal — é a câmera de hoje, FOV curto,\n` +
          `    sem caminhada longa encenada. A distribuição diz o que o SETUP DE HOJE produz, não o teto do\n` +
          `    portal: T é ARTEFATO DE FOV (a alavanca nº1 do laudo) — e é exatamente o que o portal muda.`,
      );

      expect(durs.length).toBeGreaterThan(0);
    },
    120000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// REGRA 10 — O PISO OPERACIONAL, MEDIDO. E o FURO que ele abre no nosso próprio laudo do "portal".
//
// O FURO (achado por revisão externa, CONFIRMADO aqui): o gate `n_eff > 3` é o piso da FÓRMULA de
// Fisher (abaixo dele √(n_eff−3) é imaginário — o teste NÃO EXISTE). Nós o usamos como se fosse o
// piso onde o teste FUNCIONA. Não é: a distribuição amostral de r é fortemente assimétrica para n
// pequeno, atanh só corrige em parte, e o nível nominal de 95% é FANTASIA abaixo de ~8–10.
//
// CONSEQUÊNCIA DIRETA NO QUE REPORTAMOS: o "portal" foi medido com T ≥ 18 s e a TAG REAL (Δt=2,5 s)
// ⇒ n_eff ≈ 8, na zona que a própria curva condena. Aquela cobertura saiu de um regime não-confiável.
//
// Este bloco: (1) TRAÇA a curva precisão × n_eff e localiza o PISO OPERACIONAL (onde a precisão
// estabiliza em alto); (2) testa a PREVISÃO REGISTRADA do revisor (tag 1 Hz + T≥15 s ⇒ cobertura
// >70% a alta precisão); (3) produz a TABELA DE DIMENSIONAMENTO da compra (Δt_tag → T → corredor →
// cobertura → precisão), toda com IC de WILSON e n.
//
// ‼ CIRCULARIDADE (declarada, doutrina §5): cobertura e precisão saem do SIMULADOR, que gera
//   RSSI = f(dist→estação) + ruído ⇒ |r| é alto POR CONSTRUÇÃO e a precisão é OTIMISTA. O que este
//   bloco mede honestamente é (a) a ARITMÉTICA (contagem de leituras — sobrevive a qualquer modelo)
//   e (b) o COMPORTAMENTO DO TESTE (a precisão DESABA a n_eff pequeno mesmo com |r| plantado alto —
//   se nem no sim otimista ele acerta, em campo é pior). Números absolutos: INDICATIVOS.
// ‼ τ→0 (ρ=0) em todo o bloco — a estimativa PONTUAL de campo (resíduo da tag móvel é BRANCO).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("REGRA 10 — piso operacional de n_eff, a previsão do 1 Hz, e a tabela de dimensionamento", () => {
  /** Um episódio-com-tag reduzido ao que a Regra 10 precisa; nEff/nDistinct são do VENCEDOR (a tag
   *  de maior score = −r, a MESMA regra de decideEpisode), não o máximo sobre candidatos. */
  type Ep = {
    tS: number;
    nDistinct: number;
    nEff: number;
    decided: boolean;
    correct: boolean;
  };

  /** As três cadências que a decisão de compra tem sobre a mesa. */
  const CADENCES = [
    { period: REAL_TAG_PERIOD_TICKS, dtS: REAL_TAG_PERIOD_S, label: "2,5 s (tag REAL)" },
    { period: 2, dtS: 1.0, label: "1,0 s (1 Hz)" },
    { period: 1, dtS: 0.5, label: "0,5 s (2 Hz)" },
  ] as const;

  const WALK_MS_LO = 1.1; // m/s — passo de operador, ponta baixa
  const WALK_MS_HI = 1.2; // m/s — ponta alta
  const PREC_TARGET = 0.9; // "precisão alta" = ≥90%…
  const MIN_DEC = 10; // …sustentada por amostra que permita ao IC dizer algo.

  /** Episódios-com-tag da suíte numa cadência × posição de receptor, decididos com o piso `minNEff`.
   *  Memoizado (a suíte × 3 cadências × 2 posições é cara). REGRA 8 checada em cada colheita. */
  const cache = new Map<string, { eps: Ep[]; viol: number }>();
  function collectEps(
    period: number,
    at: "base" | "dest",
    minNEff: number,
  ): { eps: Ep[]; viol: number } {
    const key = `${period}|${at}|${minNEff}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const vo = { rho: 0, minNEff }; // τ→0 (BRANCO, a estimativa pontual de campo)
    const dtTagS = period * TICK_S;
    const eps: Ep[] = [];
    let viol = 0;
    for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
      const opts = { ...entry.opts, rssiPeriodTicks: period };
      const traj = person0Trajectory(opts, entry.seed);
      if (traj.length < 2) continue;
      const simOpts = at === "dest" ? { ...opts, stationWorldOverride: destinationOf(traj) } : opts;
      const episodes = computeVisitEpisodes(
        visitTicksFromScenario(simulateFusionScenario(simOpts, entry.seed)),
        vo,
      );
      viol += countingViolations(episodes, dtTagS).length; // Regra 8: violou = BUG, não ruído
      for (const e of episodes) {
        if (e.truthTag === null || e.candidates.length === 0) continue;
        // O VENCEDOR: maior score (−r) — a mesma regra do motor (empate → menor tag lex, já ordenado).
        let w = e.candidates[0];
        for (const c of e.candidates) if (c.score > w.score) w = c;
        eps.push({
          tS: (e.endTs - e.startTs) / 1000,
          nDistinct: w.nDistinct,
          nEff: w.nEff,
          decided: e.decided,
          correct: e.correct === true,
        });
      }
    }
    const out = { eps, viol };
    cache.set(key, out);
    return out;
  }

  /** Pool de TODAS as cadências × posições — a população em que a curva precisão×n_eff é traçada.
   *  Decidida com o piso da FÓRMULA (3) DE PROPÓSITO: é preciso DEIXAR o teste falar em n_eff baixo
   *  para poder MEDIR que ele mente lá. (Traçar a curva com o piso já aplicado seria circular.) */
  function curvePopulation(): Ep[] {
    const out: Ep[] = [];
    for (const c of CADENCES) {
      for (const at of ["base", "dest"] as const) {
        const got = collectEps(c.period, at, 3);
        expect(got.viol).toBe(0); // REGRA 8 — n_eff ≤ nDistinct ≤ ⌈T/Δt_tag⌉+1
        out.push(...got.eps);
      }
    }
    return out;
  }

  const wl = (k: number, n: number): number => wilsonInterval(k, n).lo;
  const wh = (k: number, n: number): number => wilsonInterval(k, n).hi;

  /** O PISO OPERACIONAL, derivado da MESMA regra em toda tarefa: o menor k tal que a precisão
   *  ACUMULADA (n_eff ≥ k) tem LIMITE INFERIOR de Wilson ≥ 90% com ≥10 decisões. Usa-se o limite
   *  INFERIOR, não a estimativa pontual — 13/13 não é 100%. NaN = indeterminado (a medição DIZ). */
  function operationalFloor(pop: Ep[]): number {
    for (let k = 3; k <= 20; k++) {
      const dec = pop.filter((e) => e.nEff >= k && e.decided);
      const cor = dec.filter((e) => e.correct).length;
      if (dec.length >= MIN_DEC && wl(cor, dec.length) >= PREC_TARGET) return k;
    }
    return Number.NaN;
  }

  it(
    "TAREFA 1 — A CURVA precisão × n_eff: onde o teste de Fisher deixa de mentir (o PISO OPERACIONAL)",
    () => {
      const pop = curvePopulation();
      expect(pop.length).toBeGreaterThan(500);

      const bins: { lo: number; hi: number }[] = [];
      for (let k = 3; k < 20; k++) bins.push({ lo: k, hi: k + 1 });
      bins.push({ lo: 20, hi: Infinity });

      /** A curva sobre uma população: uma linha por bin de n_eff, com IC de Wilson e n. */
      const curveOf = (eps: Ep[]): string[] => {
        const head =
          "n_eff".padEnd(10) +
          "eps    decid   precisão (IC95 de Wilson)                 cobertura";
        const ls = [head, "-".repeat(head.length)];
        for (const b of bins) {
          const inBin = eps.filter((e) => e.nEff >= b.lo && e.nEff < b.hi);
          if (inBin.length === 0) continue;
          const dec = inBin.filter((e) => e.decided);
          const cor = dec.filter((e) => e.correct).length;
          ls.push(
            `${(b.hi === Infinity ? "≥20" : `[${b.lo},${b.hi})`).padEnd(10)}` +
              `${String(inBin.length).padStart(4)}   ${String(dec.length).padStart(5)}   ` +
              `${(dec.length ? formatProportion(cor, dec.length) : "— (nada decidido)").padEnd(42)}` +
              `${pct(dec.length / inBin.length).padStart(6)}%`,
          );
        }
        return ls;
      };
      const lines = curveOf(pop);

      // ── A MESMA curva, SEPARADA por geometria — porque há DUAS causas de erro e elas não se
      //    consertam com o mesmo remédio: (a) n_eff pequeno = o teste de Fisher mentindo (o piso
      //    conserta); (b) span nulo (receptor no canto) = não há sinal para achar (nenhum piso
      //    conserta). Reportar só o pooled esconderia qual está mordendo.
      const popDest: Ep[] = [];
      const popBase: Ep[] = [];
      for (const c of CADENCES) {
        popDest.push(...collectEps(c.period, "dest", 3).eps);
        popBase.push(...collectEps(c.period, "base", 3).eps);
      }

      // ── A TABELA QUE DECIDE O PISO. Subir o piso para k só REMOVE decisões abaixo de k ⇒ a linha
      //    "n_eff ≥ k" É EXATAMENTE o desempenho do sistema rodando com `minNEff = k`. Ou seja: esta
      //    é a curva de TRADE-OFF do parâmetro (precisão que se compra × cobertura que se paga), não
      //    um gráfico descritivo. O piso é a escolha de PRODUTO sobre ela.
      const cum: { k: number; dec: number; cor: number; lo: number }[] = [];
      for (let k = 3; k <= 20; k++) {
        const dec = pop.filter((e) => e.nEff >= k && e.decided);
        const cor = dec.filter((e) => e.correct).length;
        cum.push({ k, dec: dec.length, cor, lo: wl(cor, dec.length) });
      }
      const chead =
        "minNEff = k".padEnd(13) + "PRECISÃO do sistema (IC95, n=decisões)".padEnd(44) + "COBERTURA (IC95, n=eps)";
      const clines = [chead, "-".repeat(chead.length)];
      for (const c of cum) {
        clines.push(
          `${String(c.k).padEnd(13)}` +
            `${(c.dec ? formatProportion(c.cor, c.dec) : "— (nada decidido)").padEnd(44)}` +
            `${formatProportion(c.dec, pop.length)}`,
        );
      }

      // ── SENSIBILIDADE do piso ao ALVO de precisão: o piso NÃO é uma constante da natureza — é o
      //    preço que se aceita pagar. Reportar a curva do preço é mais honesto que cravar um número.
      const floorFor = (target: number): number => {
        for (let k = 3; k <= 20; k++) {
          const c = cum.find((x) => x.k === k)!;
          if (c.dec >= MIN_DEC && wl(c.cor, c.dec) >= target) return k;
        }
        return Number.NaN;
      };
      const sens = [0.8, 0.85, 0.9, 0.95]
        .map((t) => {
          const k = floorFor(t);
          return `  alvo de precisão ≥${(100 * t).toFixed(0)}% (IC95-inf) ⇒ piso n_eff ≥ ${Number.isFinite(k) ? k : "NUNCA ALCANÇADO até 20"}`;
        })
        .join("\n");

      const floor = operationalFloor(pop);
      const floorDest = operationalFloor(popDest);
      const floorBase = operationalFloor(popBase);
      const ndPortal = maxDistinctReadings(18000, REAL_TAG_PERIOD_S); // o "portal" que reportamos

      console.log(
        `\n═══ TAREFA 1 — CURVA precisão × n_eff (pooled: 3 cadências × 2 posições, τ→0) ═══\n` +
          `população: ${pop.length} episódios-com-tag | decisão com o piso da FÓRMULA (3) — é preciso\n` +
          `DEIXAR o teste falar em n_eff baixo para MEDIR que ele mente lá.\n\n` +
          `${lines.join("\n")}\n\n` +
          `── A MESMA curva, SÓ RECEPTOR NO DESTINO (a geometria do portal — ${popDest.length} eps) ──\n` +
          `${curveOf(popDest).join("\n")}\n\n` +
          `── A MESMA curva, SÓ BASELINE (receptor no canto, span ~0 — ${popBase.length} eps) ──\n` +
          `${curveOf(popBase).join("\n")}\n\n` +
          `${clines.join("\n")}\n\n` +
          `SENSIBILIDADE do piso ao alvo (o piso é uma ESCOLHA DE PRODUTO, não uma constante):\n${sens}\n` +
          `pisos por população, alvo ${(100 * PREC_TARGET).toFixed(0)}%: pooled=${floor} | destino=${floorDest} | ` +
          `baseline=${Number.isFinite(floorBase) ? floorBase : "NUNCA (nem a n_eff=20 o canto sustenta 90%)"}\n\n` +
          `★ PISO OPERACIONAL MEDIDO (pooled — a suíte inteira, a população que a produção vê): n_eff ≥ ${floor}\n` +
          `  (menor k cuja precisão do SISTEMA tem IC95-inferior ≥ ${(100 * PREC_TARGET).toFixed(0)}%, com ≥${MIN_DEC} decisões)\n\n` +
          `★ O QUE A CURVA REALMENTE MOSTRA (e onde ela DIVERGE da previsão do revisor):\n` +
          `  • CONFIRMADO — o piso da FÓRMULA (3) NÃO é o piso operacional. Rodando com minNEff=3 (o\n` +
          `    que o código faz HOJE), a precisão do sistema é ${formatProportion(cum[0].cor, cum[0].dec)} —\n` +
          `    NÃO os 95% nominais do teste. O nível de significância é FANTASIA em n pequeno: exatamente\n` +
          `    o furo apontado.\n` +
          `  • REFUTADO — a curva NÃO é a que o revisor citou (n_eff 4 → 0% · 6 → 15,4% · 10 → 100%).\n` +
          `    Medido: em n_eff ∈ [3,5) o teste NÃO DECIDE NADA (0 decisões em ${pop.filter((e) => e.nEff >= 3 && e.nEff < 5).length} episódios) — a barra\n` +
          `    |r| ≥ tanh(1,96/√(n_eff−3)) é ~0,97 lá, e nada a cruza. Não há "0% de precisão": não há\n` +
          `    precisão nenhuma. E a precisão NÃO estabiliza em 100% a partir de 10: em n_eff=10 ela é\n` +
          `    ${formatProportion(cum.find((c) => c.k === 10)!.cor, cum.find((c) => c.k === 10)!.dec)} e o teto é ~94% mesmo a n_eff ≥ 20.\n` +
          `  • A curva é uma RAMPA RUIDOSA, não um degrau: precisão do sistema sobe monotonicamente de\n` +
          `    ~85% (k=3) para ~94% (k=20). NÃO EXISTE joelho — o "piso" é onde se CORTA, e o corte é uma\n` +
          `    decisão de produto (ver sensibilidade acima), não uma descoberta física.\n` +
          `  • ⇒ O FURO NO NOSSO PORTAL, CONFIRMADO: T≥18 s com a tag real (2,5 s) dá n_eff = ${ndPortal}, que é\n` +
          `    ${ndPortal < floor ? `ABAIXO do piso ${floor}` : `≥ o piso ${floor}`}. A precisão naquele regime é ~${formatProportion(
            cum.find((c) => c.k === 9)!.cor,
            cum.find((c) => c.k === 9)!.dec,
          )},\n` +
          `    não os 95% que o teste promete. A cobertura de 39,4% que reportamos veio de um regime que\n` +
          `    a própria curva condena.`,
      );

      // ── Assertivas ROBUSTAS (o VEREDITO, não os números frágeis) ──
      // 1) Determinismo.
      expect(curvePopulation().length).toBe(pop.length);
      // 2) O FURO, selado: com o piso de HOJE (3), o sistema NÃO entrega o nível nominal do teste.
      //    O IC95-inferior da precisão fica LONGE de 95% — o alfa nominal é fantasia em n pequeno.
      const now = cum[0]; // k=3 = o comportamento atual do código
      expect(now.lo).toBeLessThan(0.9);
      // 3) …e SUBIR o piso COMPRA precisão (a rampa é real, não ruído): o topo bate o fundo.
      const top = cum[cum.length - 1];
      expect(top.cor / top.dec).toBeGreaterThan(now.cor / now.dec);
      // 4) EXISTE um piso operacional, e ele é MUITO maior que o da fórmula (3).
      expect(Number.isFinite(floor)).toBe(true);
      expect(floor).toBeGreaterThan(3);
      // 5) A HONESTIDADE que o revisor não previu: o piso medido é MAIOR que os 8–10 postulados —
      //    a rampa é lenta. Se isto flipar (piso ≤10), a compra fica mais barata: re-examinar.
      expect(floor).toBeGreaterThan(10);
      // 6) Abaixo do piso o sistema decide PIOR que acima — a separação que justifica o parâmetro.
      const below = pop.filter((e) => e.decided && e.nEff < floor);
      const belowCor = below.filter((e) => e.correct).length;
      const atFloor = cum.find((c) => c.k === floor)!;
      expect(belowCor / below.length).toBeLessThan(atFloor.cor / atFloor.dec);
      expect(wl(belowCor, below.length)).toBeLessThan(PREC_TARGET); // e não sustenta o alvo
      // 7) O piso qualifica pela regra declarada (IC-inferior, não estimativa pontual).
      expect(atFloor.lo).toBeGreaterThanOrEqual(PREC_TARGET);
      expect(atFloor.dec).toBeGreaterThanOrEqual(MIN_DEC);
      // 8) O REGIME DO NOSSO "PORTAL" (T≥18 s, tag real ⇒ n_eff=9) está ABAIXO do piso — o furo.
      expect(ndPortal).toBeLessThan(floor);
    },
    900000,
  );

  it(
    "TAREFA 2 — A PREVISÃO DO REVISOR: tag 1 Hz + T ≥ 15 s ⇒ cobertura >70% a alta precisão?",
    () => {
      const floor = operationalFloor(curvePopulation());
      expect(Number.isFinite(floor)).toBe(true);

      const T_GRID = [8, 10, 12, 15, 18, 20, 25, 30];
      type Cell = { n: number; dec: number; cor: number };
      const cellAt = (eps: Ep[], tMin: number): Cell => {
        const s = eps.filter((e) => e.tS >= tMin);
        const dec = s.filter((e) => e.decided);
        return { n: s.length, dec: dec.length, cor: dec.filter((e) => e.correct).length };
      };

      const out: string[] = [];
      let predCell: Cell = { n: 0, dec: 0, cor: 0 }; // o ponto da previsão: Δt=1,0 s, T≥15 s

      for (const c of CADENCES) {
        const { eps, viol } = collectEps(c.period, "dest", floor); // DESTINO = a instalação do portal
        expect(viol).toBe(0); // Regra 8
        const head =
          `\n── Δt_tag = ${c.label} — receptor no DESTINO, PISO n_eff ≥ ${floor} ──\n` +
          "T ≥ (s)".padEnd(9) +
          "n_eff(T)".padEnd(10) +
          "eps".padEnd(6) +
          "COBERTURA (IC95, n=eps)".padEnd(40) +
          "PRECISÃO (IC95, n=decid)";
        const rows: string[] = [head, "-".repeat(head.length)];
        for (const t of T_GRID) {
          const cell = cellAt(eps, t);
          const nd = maxDistinctReadings(t * 1000, c.dtS); // n_eff teórico daquele T (τ→0)
          if (c.dtS === 1.0 && t === 15) predCell = cell;
          rows.push(
            `${String(t).padEnd(9)}${String(nd).padEnd(10)}${String(cell.n).padEnd(6)}` +
              `${(cell.n ? formatProportion(cell.dec, cell.n) : "— (n=0)").padEnd(40)}` +
              `${cell.dec ? formatProportion(cell.cor, cell.dec) : "— (nada decidido)"}`,
          );
        }
        out.push(rows.join("\n"));
      }

      const cov = predCell.n ? predCell.dec / predCell.n : 0;
      const covLo = wl(predCell.dec, predCell.n);
      const covHi = wh(predCell.dec, predCell.n);
      const prec = predCell.dec ? predCell.cor / predCell.dec : 0;
      // CRITÉRIO DECLARADO ANTES DE OLHAR: a previsão ("cobertura >70% a alta precisão") se confirma
      // se a estimativa pontual passa de 70% E a precisão é alta (≥90%). Binário, sem suavizar.
      const confirmed = cov > 0.7 && prec >= PREC_TARGET;

      // ── O VEREDITO NÃO PODE SER ARTEFATO DA MINHA ESCOLHA DE PISO. O mesmo ponto da previsão,
      //    avaliado nos TRÊS pisos defensáveis: o POSTULADO pelo revisor (10), o derivado da curva
      //    SÓ-DESTINO (14) e o da suíte inteira (19, o operacional). Se a previsão só se confirma no
      //    piso mais frouxo, isso TEM de aparecer.
      const floorsProbe = [10, 14, floor];
      const probe = floorsProbe.map((f) => {
        const cell = cellAt(collectEps(2, "dest", f).eps, 15);
        return {
          f,
          cell,
          cov: cell.n ? cell.dec / cell.n : 0,
          prec: cell.dec ? cell.cor / cell.dec : 0,
        };
      });

      console.log(
        `\n═══ TAREFA 2 — COBERTURA/PRECISÃO CONDICIONADAS A T, COM O PISO OPERACIONAL (n_eff ≥ ${floor}) ═══` +
          `${out.join("\n")}\n` +
          `\n★★ A PREVISÃO REGISTRADA DO REVISOR (tag 1 Hz, T ≥ 15 s ⇒ n_eff ≤ ${maxDistinctReadings(15000, 1)}):\n` +
          `   "a cobertura em caminhadas de entrada sobe para >70% a alta precisão"\n\n` +
          `   MEDIDO no piso operacional (n_eff ≥ ${floor}):\n` +
          `     cobertura ${predCell.n ? formatProportion(predCell.dec, predCell.n) : "— (n=0)"}   [IC95 ${pct(covLo)}%–${pct(covHi)}%]\n` +
          `     precisão  ${predCell.dec ? formatProportion(predCell.cor, predCell.dec) : "— (nada decidido)"}\n\n` +
          `   O MESMO PONTO, VARRENDO O PISO (para o veredito não ser artefato da minha escolha):\n` +
          probe
            .map(
              (p) =>
                `     piso ${String(p.f).padStart(2)} ${p.f === 10 ? "(o POSTULADO pelo revisor)" : p.f === 14 ? "(curva só-destino)   " : "(operacional, suíte) "} ⇒ ` +
                `cobertura ${(p.cell.n ? formatProportion(p.cell.dec, p.cell.n) : "— (n=0)").padEnd(36)} ` +
                `precisão ${p.cell.dec ? formatProportion(p.cell.cor, p.cell.dec) : "— (nada decidido)"}`,
            )
            .join("\n") +
          `\n\n   ⇒ VEREDITO BINÁRIO: a previsão ${confirmed ? "**SE CONFIRMA**" : "**NÃO SE CONFIRMA**"}.\n` +
          `   ${
            confirmed
              ? "O PORTAL FECHA: com tag de 1 Hz e um corredor que dê T ≥ 15 s de observação, a visita de\n" +
                "   entrada decide a identidade ACIMA DO PISO e com precisão alta. A compra está dimensionada.\n" +
                "   (A cobertura é do SIMULADOR — circular por construção. O que NÃO é circular, e é o que\n" +
                "   dimensiona a compra, é o T exigido: aritmética de contagem. Ver Tarefa 3.)"
              : "O PORTAL NÃO FECHA a T ≥ 15 s com tag de 1 Hz: aplicado o piso MEDIDO, um episódio de\n" +
                "   15 s a 1 Hz não junta pontos suficientes (n_eff máx = 16 < piso) e o motor SE CALA.\n" +
                "   Não é fraqueza de sinal — é CONTAGEM. Para fechar, ou o corredor cresce (T maior) ou a\n" +
                "   tag acelera. Ver a Tarefa 3: é ela que diz quanto de cada um. Achado NEGATIVO, sem suavizar."
          }`,
      );

      // ── Assertivas ROBUSTAS ──
      expect(floor).toBeGreaterThan(3); // a Tarefa 2 roda COM o piso da Tarefa 1
      expect(predCell.n).toBeGreaterThan(0); // amostra do ponto da previsão, declarada
      // O VEREDITO, selado no sentido que a medição encontrou. Se um dia flipar, o laudo tem de ser
      // re-lido — é o gate do achado, não um número frágil.
      expect(confirmed).toBe(false);
      // A CAUSA do veredito é CONTAGEM, não sinal: a 1 Hz, T=15 s tem teto de 16 leituras distintas,
      // ABAIXO do piso 19. Nenhum episódio de exatamente 15 s PODE decidir — por aritmética.
      expect(maxDistinctReadings(15000, 1.0)).toBeLessThan(floor);
      // E a previsão SE CONFIRMARIA no piso que o revisor POSTULOU (10) — a diferença entre confirmar
      // e não confirmar é o PISO, e o piso é medido, não postulado. É o coração do achado.
      const atPostulated = probe.find((p) => p.f === 10)!;
      expect(atPostulated.cov).toBeGreaterThan(0.7);
    },
    900000,
  );

  it(
    "TAREFA 3 — TABELA DE DIMENSIONAMENTO: Δt_tag → T exigido → corredor → cobertura → precisão",
    () => {
      const floor = operationalFloor(curvePopulation());
      expect(Number.isFinite(floor)).toBe(true);

      /** MENOR T (passo 0,5 s) cujo teto de CONTAGEM alcança o PISO (τ→0 ⇒ n_eff = nDistinct). */
      const tForFloor = (dtS: number): number => {
        for (let t = 0.5; t <= 600; t += 0.5) {
          if (maxDistinctReadings(t * 1000, dtS) >= floor) return t;
        }
        return Number.POSITIVE_INFINITY;
      };

      const head =
        "Δt_tag".padEnd(18) +
        "T exigido".padEnd(11) +
        "corredor @1,1–1,2 m/s".padEnd(23) +
        "|r| exigido".padEnd(13) +
        "COBERTURA cond. (IC95, n)".padEnd(40) +
        "PRECISÃO (IC95, n)";
      const lines = [head, "-".repeat(head.length)];
      const summary: { label: string; t: number; corr: number; cov: number; n: number }[] = [];

      for (const c of CADENCES) {
        const tReq = tForFloor(c.dtS);
        const nd = maxDistinctReadings(tReq * 1000, c.dtS);
        const rBar = nd > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (nd - 3))) : Number.NaN;
        const eps = collectEps(c.period, "dest", floor).eps.filter((e) => e.tS >= tReq);
        const dec = eps.filter((e) => e.decided);
        const cor = dec.filter((e) => e.correct).length;
        lines.push(
          `${c.label.padEnd(18)}` +
            `${`${tReq.toFixed(1)} s`.padEnd(11)}` +
            `${`${(tReq * WALK_MS_LO).toFixed(1)}–${(tReq * WALK_MS_HI).toFixed(1)} m`.padEnd(23)}` +
            `${(Number.isFinite(rBar) ? rBar.toFixed(2) : "—").padEnd(13)}` +
            `${(eps.length ? formatProportion(dec.length, eps.length) : "— (n=0)").padEnd(40)}` +
            `${dec.length ? formatProportion(cor, dec.length) : "— (nada decidido)"}`,
        );
        summary.push({
          label: c.label,
          t: tReq,
          corr: tReq * WALK_MS_HI,
          cov: eps.length ? dec.length / eps.length : 0,
          n: eps.length,
        });
      }

      const [real, hz1, hz2] = summary;
      // O ponto de operação REALIZÁVEL de cada cadência (o T da tabela, arredondado para cima ao que
      // a suíte tem massa): é o que o dono compra. Reportado com IC e n — nunca precisão sem os dois.
      const opAt = (period: number, tMin: number): string => {
        const eps = collectEps(period, "dest", floor).eps.filter((e) => e.tS >= tMin);
        const dec = eps.filter((e) => e.decided);
        const cor = dec.filter((e) => e.correct).length;
        return eps.length < 10
          ? `n=${eps.length} — AMOSTRA PEQUENA DEMAIS PARA CONCLUIR`
          : `cobertura ${formatProportion(dec.length, eps.length)} · precisão ${
              dec.length ? formatProportion(cor, dec.length) : "— (nada decidido)"
            }`;
      };

      console.log(
        `\n═══ TAREFA 3 — TABELA DE DIMENSIONAMENTO DA COMPRA (PISO n_eff ≥ ${floor}, τ→0) ═══\n` +
          `${lines.join("\n")}\n\n` +
          `  corredor = T exigido × velocidade de caminhada = o comprimento que a CÂMERA precisa OBSERVAR\n` +
          `  (o receptor fica no FIM dele). T exigido/corredor: ARITMÉTICA de contagem — sobrevive a\n` +
          `  qualquer modelo. Cobertura/precisão: SIMULADOR (circular) ⇒ INDICATIVAS.\n\n` +
          `★ LEITURA DE COMPRA (e ela CONTRARIA a previsão do revisor sobre qual tag comprar):\n` +
          `  • tag REAL (2,5 s): T ≥ ${real.t.toFixed(1)} s ⇒ corredor ~${real.corr.toFixed(0)} m — MORTA. Não existe corredor reto e\n` +
          `    observável desse tamanho no CD. (O revisor previu ~27 m; com o piso MEDIDO é ~${real.corr.toFixed(0)} m — pior.)\n` +
          `    No ponto de operação: ${opAt(REAL_TAG_PERIOD_TICKS, real.t)}\n` +
          `  • tag 1 Hz:         T ≥ ${hz1.t.toFixed(1)} s ⇒ corredor ~${hz1.corr.toFixed(0)} m — INSTALÁVEL SÓ SE EXISTIR um corredor de\n` +
          `    ~20 m observável de ponta a ponta. (O revisor previu ~11 m — ele postulou piso 8–10; o piso\n` +
          `    MEDIDO é ${floor}, e o corredor DOBRA.) No ponto de operação: ${opAt(2, hz1.t)}\n` +
          `  • tag 2 Hz (0,5 s): T ≥ ${hz2.t.toFixed(1)} s ⇒ corredor ~${hz2.corr.toFixed(0)} m — INSTALÁVEL com folga.\n` +
          `    No ponto de operação: ${opAt(1, hz2.t)}\n\n` +
          `  ⇒ O TRADE REAL DA COMPRA (o piso medido reordena a recomendação):\n` +
          `    a nota de BATERIA (contexto, não medido aqui) diz 1 Hz ≈ 1–2 anos de CR2032 e 0,5 s ≈\n` +
          `    meses–1 ano. Mas o piso medido (${floor}, não 8–10) faz o 1 Hz exigir ~${hz1.corr.toFixed(0)} m de corredor, não ~11 m.\n` +
          `    Então NÃO é "1 Hz é obviamente o ótimo": é uma escolha entre\n` +
          `      (a) 1 Hz + corredor de ~${hz1.corr.toFixed(0)} m  — bateria boa, DEPENDE de a planta ter esse corredor;\n` +
          `      (b) 2 Hz + corredor de ~${hz2.corr.toFixed(0)} m  — cabe em qualquer planta, custa bateria.\n` +
          `    A PERGUNTA QUE DECIDE A COMPRA NÃO É DE RÁDIO, É DE PLANTA: existe um trecho de ~${hz1.corr.toFixed(0)} m em que\n` +
          `    a câmera vê o operador ANDANDO até o posto? Se sim, 1 Hz. Se não, 2 Hz.\n` +
          `  • A cadência é alavanca LINEAR no T exigido (τ→0 ⇒ morde o 1º termo da lei, T/Δt_tag):\n` +
          `    ${real.t.toFixed(1)} s → ${hz1.t.toFixed(1)} s → ${hz2.t.toFixed(1)} s para Δt_tag 2,5 → 1,0 → 0,5 s.`,
      );

      // ── Assertivas: a ARITMÉTICA da tabela (contagem — não os números do sim) ──
      // 1) O piso é o que dimensiona: T exigido = o MENOR T que alcança o piso (e 0,5 s antes, não).
      expect(maxDistinctReadings(real.t * 1000, REAL_TAG_PERIOD_S)).toBeGreaterThanOrEqual(floor);
      expect(maxDistinctReadings((real.t - 0.5) * 1000, REAL_TAG_PERIOD_S)).toBeLessThan(floor);
      // 2) LINEARIDADE em Δt_tag (a lei, 1º termo): acelerar a tag corta o T exigido na proporção.
      expect(hz1.t).toBeLessThan(real.t);
      expect(hz2.t).toBeLessThan(hz1.t);
      expect(hz1.t / real.t).toBeCloseTo(1.0 / REAL_TAG_PERIOD_S, 1);
      // 3) O VEREDITO DE INSTALAÇÃO, selado nos TRÊS regimes (o que dimensiona a compra):
      //    • tag real: corredor absurdo (>40 m) — MORTA, e pior que os 27 m previstos pelo revisor;
      //    • 1 Hz: corredor GRANDE (15–25 m) — NÃO os ~11 m previstos (o piso medido dobrou);
      //    • 2 Hz: corredor pequeno (<12 m) — o único que cabe em qualquer planta.
      expect(real.corr).toBeGreaterThan(40);
      expect(hz1.corr).toBeGreaterThan(15);
      expect(hz1.corr).toBeLessThan(25);
      expect(hz2.corr).toBeLessThan(12);
    },
    900000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ADR-015 — A POLÍTICA DE ÂNCORA: o teto de 94% é do CANAL ou da POLÍTICA? (2026-07-12)
//
// A TESE DO REVISOR, literal: "a curva 85→94% mede a precisão de UM episódio ISOLADO. Mas o portal
// não é um episódio isolado — é uma ÂNCORA DE TURNO, e o operador entra, sai, volta. A precisão não
// é propriedade do canal. É propriedade da POLÍTICA DE DECISÃO sobre o canal. O teto de 94% é o teto
// de FALAR NA PRIMEIRA OPORTUNIDADE. Não é o teto de ESPERAR DUAS CONCORDAREM."
// PREVISÃO REGISTRADA: "dupla-confirmação (2 episódios concordantes, piso ~10 cada) entrega >97% de
// precisão com cobertura de TURNO alta — melhor que qualquer piso único."
//
// A UNIDADE MUDA (é o coração do achado): a métrica NÃO é mais por episódio — é por OPERADOR.
// Cobertura de TURNO = fração de operadores ancorados; precisão = fração dos ancorados que levou a
// tag certa. Um operador = (cenário × seed × MAC-verdade) — todos os episódios daquela pessoa.
//
// ‼ CIRCULARIDADE (declarada, doutrina §5): cobertura e precisão saem do SIMULADOR (RSSI = f(dist)
//   + ruído ⇒ |r| alto POR CONSTRUÇÃO) ⇒ INDICATIVAS, nunca campo. O que NÃO é circular e dimensiona
//   a compra é a ARITMÉTICA de contagem (T exigido → corredor) e a MECÂNICA da política.
// ‼ ONDE A CIRCULARIDADE MAIS MORDE: em piso BAIXO a barra |r| é quase perfeita (n_eff=4 ⇒ |r|≥0,96)
//   — o sim CRUZA essa barra (o RSSI vem da distância), o campo não vai cruzar. Toda leitura de
//   "corredor curto porque o piso caiu" tem de vir acompanhada da barra |r| exigida. A tabela mostra.
// ‼ O "TURNO" AQUI TEM 120 s (o cenário do sim), não 8 h. Um turno real dá ao operador MUITO mais
//   oportunidades de ancorar ⇒ a cobertura de turno medida aqui é um PISO, não uma previsão. A
//   PRECISÃO não sofre desse viés.
// ‼ E OS EPISÓDIOS DE UM OPERADOR AQUI SÃO, EM SUA MAIORIA, FRAGMENTOS DA MESMA CAMINHADA (gap
//   mediano de 1,0 s — a fragmentação do tracker com ttlMs=1500, o achado #27), NÃO visitas
//   separadas por minutos. Isso é o CASO DIFÍCIL para a tese: fragmentos vizinhos compartilham o
//   viés corporal e a geometria do instante ⇒ os erros deles são os MAIS correlacionados possíveis.
//   Se a dupla-confirmação funciona AQUI, funciona a fortiori entre visitas de verdade. Ver TAREFA 0.
// ‼ RÉPLICAS DE MONTE-CARLO: cada cenário roda com SEED_REPLICATES sementes (mesmo gerador, outros
//   sorteios) — é o que dá n de operadores suficiente para o IC de Wilson dizer algo. Réplicas são
//   pessoas DIFERENTES (trajetórias distintas), não a mesma pessoa medida duas vezes.
// ‼ τ→0 (ρ=0) em todo o bloco (resíduo da tag móvel é BRANCO — residual-autocorr.ts); receptor no
//   DESTINO nas tabelas de decisão (a geometria do portal), com o BASELINE entrando na derivação do
//   piso (pooled, como na medição de episódio único).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("ADR-015 — POLÍTICA DE ÂNCORA (k-confirmação): o teto de 94% é do canal ou da política?", () => {
  const SEED_REPLICATES = 8; // sementes por cenário — Monte-Carlo, para o n de operadores existir
  const PISOS = [3, 6, 10, 14, 19] as const; // piso de n_eff POR EPISÓDIO
  const KS = [1, 2, 3] as const; // k=1 é a política ATUAL (falar na primeira oportunidade)
  const CADS = [
    { period: REAL_TAG_PERIOD_TICKS, dtS: REAL_TAG_PERIOD_S, label: "2,5 s (tag REAL)" },
    { period: 2, dtS: 1.0, label: "1,0 s (1 Hz)" },
    { period: 1, dtS: 0.5, label: "0,5 s (2 Hz)" },
  ] as const;
  const VARIANTS: PolicyVariant[] = ["concordance", "fisher"];
  const WALK_LO = 1.1; // m/s
  const WALK_HI = 1.2; // m/s
  const MIN_DEC = 10; // decisões mínimas p/ o IC de Wilson dizer algo (a régua do laudo anterior)
  const OLD_CEILING = 0.94; // o "teto do canal" que este bloco testa: 94% (precisão de episódio)

  /** Episódios da suíte etiquetados por OPERADOR, numa cadência × posição de receptor. τ→0.
   *  Memoizado: 3 cadências × 2 posições × 10 cenários × 8 seeds é caro (e determinístico). */
  const opCache = new Map<string, { eps: OperatorEpisode[]; viol: number }>();
  function collectOps(period: number, at: "base" | "dest"): { eps: OperatorEpisode[]; viol: number } {
    const key = `${period}|${at}`;
    const hit = opCache.get(key);
    if (hit) return hit;
    const vo = { rho: 0 }; // τ→0 (BRANCO — a estimativa pontual de campo)
    const dtTagS = period * TICK_S;
    const eps: OperatorEpisode[] = [];
    let viol = 0;
    for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
      for (let r = 0; r < SEED_REPLICATES; r++) {
        const seed = entry.seed + 1000 * r;
        const opts = { ...entry.opts, rssiPeriodTicks: period };
        const traj = person0Trajectory(opts, seed);
        if (traj.length < 2) continue;
        const simOpts = at === "dest" ? { ...opts, stationWorldOverride: destinationOf(traj) } : opts;
        const episodes = computeVisitEpisodes(
          visitTicksFromScenario(simulateFusionScenario(simOpts, seed)),
          vo,
        );
        viol += countingViolations(episodes, dtTagS).length; // Regra 8 — violou = BUG na fonte
        for (const e of episodes) {
          if (e.candidates.length === 0) continue;
          // O OPERADOR: a pessoa (MAC-verdade) dentro daquele cenário-semente. Sem tag → pseudo-
          // operador por trackId (o eixo "rejeitar quem-não-tem-tag", contado à parte).
          const who = e.truthTag ?? `SEM-TAG#${e.trackId}`;
          eps.push({ operator: `${entry.name}#${seed}|${who}`, episode: e });
        }
      }
    }
    const out = { eps, viol };
    opCache.set(key, out);
    return out;
  }

  /** Métrica de TURNO de uma célula (cadência × posição × variante × piso × k). */
  const cell = (
    period: number,
    at: "base" | "dest",
    variant: PolicyVariant,
    minNEff: number,
    k: number,
  ): AnchorMetrics =>
    computeAnchorMetrics(computeAnchors(collectOps(period, at).eps, variant, { k, minNEff }));

  const wl = (kk: number, n: number): number => wilsonInterval(kk, n).lo;

  // O PISO OPERACIONAL é derivado POR CADÊNCIA, na geometria do PORTAL (`cadFloor`, na TAREFA 3) —
  // porque é isso que se COMPRA: uma tag (Δt) e uma instalação. Um piso "pooled" sobre cadências e
  // posições (a receita da medição de episódio único) misturaria a tag real com a de 2 Hz e o
  // receptor do canto com o do destino — diluiria exatamente a decisão que se quer tomar.

  /** A MELHOR célula de uma política (variante × k): a de maior IC95-INFERIOR da precisão (não a de
   *  maior estimativa pontual — 13/13 não é 100%), com ≥10 âncoras. É o "teto IC-honesto" daquela
   *  política, e é o número que responde à pergunta do revisor. */
  type Best = { variant: PolicyVariant; k: number; piso: number; cad: string; lo: number; m: AnchorMetrics };
  function bestCell(variant: PolicyVariant, k: number): Best | null {
    let best: Best | null = null;
    for (const c of CADS) {
      for (const piso of PISOS) {
        const m = cell(c.period, "dest", variant, piso, k);
        if (m.anchored < MIN_DEC) continue;
        const lo = wl(m.anchoredCorrect, m.anchored);
        if (best === null || lo > best.lo) best = { variant, k, piso, cad: c.label, lo, m };
      }
    }
    return best;
  }

  it(
    "TAREFA 0 (Regra 8) — a soma de Fisher-z entre episódios é LEGÍTIMA? (dado compartilhado × erro correlacionado)",
    () => {
      const lines: string[] = [];
      let totalOverlap = 0;
      let totalPairs = 0;
      for (const c of CADS) {
        const { eps, viol } = collectOps(c.period, "dest");
        expect(viol).toBe(0); // Regra 8 na FONTE: nDistinct ≤ ⌈T/Δt_tag⌉+1 e nEff ≤ nDistinct
        const r = sharedDataRisk(eps, c.dtS);
        totalOverlap += r.overlapping;
        totalPairs += r.pairs;
        lines.push(
          `  Δt=${c.label.padEnd(17)} pares=${String(r.pairs).padStart(4)}  ` +
            `SOBREPOSIÇÃO TEMPORAL=${String(r.overlapping).padStart(3)}  ` +
            `gap<Δt_tag=${String(r.tightGaps).padStart(4)} (${pct(r.tightGaps / Math.max(1, r.pairs))}%)  ` +
            `gap mediano=${r.medianGapS.toFixed(1)} s`,
        );
      }

      // O 2º sensor, e o que REALMENTE decide a legitimidade: quando um episódio erra, o seguinte
      // REPETE o erro? (erro sistemático ⇒ a concordância não é evidência independente — é o mesmo
      // viés corporal/geometria duas vezes, e a dupla-confirmação só correlacionaria o próprio erro.)
      const failLines: string[] = [];
      const f10 = agreementOnFailure(collectOps(2, "dest").eps, 10); // 1 Hz, destino, piso 10
      // O TETO DA INDEPENDÊNCIA (model-free): para o 2º episódio REPETIR o mesmo erro ele precisa,
      // no MÍNIMO, errar. Logo, se os erros fossem independentes,
      //     P(2º repete o MESMO erro | 1º errado) ≤ P(2º errado) = taxa de erro do episódio.
      // (É um TETO, não uma igualdade — repetir a MESMA tag errada é ainda mais improvável.) A taxa
      // de erro do episódio vem da política k=1 no mesmo piso/cadência (a 1ª decisão do operador).
      const errRate = 1 - cell(2, "dest", "concordance", 10, 1).precision;
      for (const piso of [3, 10, 19]) {
        const f = agreementOnFailure(collectOps(2, "dest").eps, piso);
        failLines.push(
          `  piso ${String(piso).padStart(2)}: operadores c/ ≥2 episódios decididos = ${String(f.operators).padStart(3)}  |  ` +
            `1º CERTO → 2º concorda: ${formatProportion(f.firstRightAndAgree, f.firstRight)}  |  ` +
            `1º ERRADO → 2º REPETE O MESMO ERRO: ${formatProportion(f.firstWrongAndAgree, f.firstWrong)}`,
        );
      }

      console.log(
        `\n═══ TAREFA 0 — A INDEPENDÊNCIA, MEDIDA (a inflação que já nos pegou 2×) ═══\n` +
          `(1) DADO COMPARTILHADO entre episódios do MESMO operador (receptor no destino):\n` +
          `${lines.join("\n")}\n` +
          `  ⇒ episódios de um operador são janelas CONTÍGUAS DISJUNTAS (buildEpisodes fecha o episódio\n` +
          `    quando a pista some/troca de verdade): ${totalOverlap === 0 ? "ZERO sobreposição temporal" : `${totalOverlap} SOBREPOSIÇÕES — BUG`} em ${totalPairs} pares ⇒ NENHUMA\n` +
          `    amostra entra em dois z. NÃO é a inflação de event-metrics.ts (lá, ticks vizinhos dividiam\n` +
          `    15/16 da janela deslizante).\n` +
          `  ⚠ O VAZAMENTO QUE EXISTE, medido e DECLARADO: quando o gap entre episódios é < Δt_tag, a\n` +
          `    leitura CARREGADA no 1º tick do episódio seguinte pode ser o MESMO advertisement que\n` +
          `    fechou o anterior. Com a tag REAL (2,5 s) isso atinge a MAIORIA dos pares (gap mediano\n` +
          `    1,0 s — os "episódios" aqui são FRAGMENTOS do tracker, não visitas separadas). É no\n` +
          `    MÁXIMO 1 leitura por par (o snapshot só segura UM valor) contra n_eff de vários — um\n` +
          `    viés de 2ª ordem, não a inflação multiplicativa de antes. A 2 Hz ele ZERA.\n\n` +
          `(2) ERRO CORRELACIONADO — o risco que a disjunção temporal NÃO resolve (1 Hz, destino):\n` +
          `${failLines.join("\n")}\n` +
          `  ⇒ VEREDITO: os erros SÃO correlacionados — ${formatProportion(f10.firstWrongAndAgree, f10.firstWrong)} de repetição do MESMO erro (piso 10).\n` +
          `    O TETO DA INDEPENDÊNCIA é model-free: para repetir o MESMO erro, o 2º precisa no mínimo\n` +
          `    ERRAR ⇒ sob independência, P(repete o mesmo erro) ≤ taxa de erro do episódio = ${pct(errRate)}%.\n` +
          `    Medimos ${pct(f10.firstWrongAndAgree / Math.max(1, f10.firstWrong))}% — ${(f10.firstWrongAndAgree / Math.max(1, f10.firstWrong) / Math.max(1e-9, errRate)).toFixed(1)}× o TETO da independência. A concordância\n` +
          `    NÃO é evidência independente — é o mesmo viés corporal/geometria visto duas vezes. MAS a\n` +
          `    repetição está LONGE de 100%: ~${pct(1 - f10.firstWrongAndAgree / Math.max(1, f10.firstWrong))}% dos erros do 1º episódio SÃO pegos pelo 2º\n` +
          `    (discordância → abstenção). É por isso que a política compra precisão SEM que os episódios\n` +
          `    sejam independentes — e é por isso que ela compra MENOS do que a conta de independência\n` +
          `    (n_eff 19+19=38) promete. A soma de Fisher-z é LEGÍTIMA quanto ao DADO (disjunto), e\n` +
          `    OTIMISTA quanto ao ERRO (correlacionado) — declarado, não escondido.`,
      );

      // ── Assertivas (o VEREDITO, não números frágeis) ──
      expect(totalOverlap).toBe(0); // DADO compartilhado: ZERO (a soma de Fisher é legítima nesse eixo)
      expect(totalPairs).toBeGreaterThan(50); // a medição tem massa
      // O ERRO é correlacionado (bem acima do acaso) — o achado que impede vender a conta ingênua…
      expect(f10.firstWrongAndAgree / f10.firstWrong).toBeGreaterThan(0.2);
      // …e mesmo assim a MAIORIA dos erros é pega pela discordância (senão a política não serviria).
      expect(f10.firstWrongAndAgree / f10.firstWrong).toBeLessThan(0.6);
    },
    900000,
  );

  it(
    "TAREFA 1+2 — A TABELA QUE DECIDE: piso × k × Δt_tag (precisão e cobertura DE TURNO, IC95 Wilson)",
    () => {
      const head =
        "piso".padEnd(6) +
        "k".padEnd(4) +
        "PRECISÃO de turno (IC95, n=âncoras)".padEnd(40) +
        "COBERTURA de turno (IC95, n=operadores)".padEnd(42) +
        "cob. ÚTIL (ancorado E certo)";
      const out: string[] = [];
      for (const variant of VARIANTS) {
        for (const c of CADS) {
          const rows: string[] = [
            `\n── variante ${variant === "concordance" ? "(a) CONCORDÂNCIA" : "(b) SOMA DE FISHER-Z"} · Δt_tag = ${c.label} · receptor no DESTINO ──`,
            head,
            "-".repeat(head.length),
          ];
          for (const piso of PISOS) {
            for (const k of KS) {
              const m = cell(c.period, "dest", variant, piso, k);
              rows.push(
                `${String(piso).padEnd(6)}${String(k).padEnd(4)}` +
                  `${(m.anchored ? formatProportion(m.anchoredCorrect, m.anchored) : "— (nada ancorado)").padEnd(40)}` +
                  `${formatProportion(m.anchored, m.operators).padEnd(42)}` +
                  `${pct(m.correctTurnCoverage)}%`,
              );
            }
          }
          out.push(rows.join("\n"));
        }
      }

      // ── O VEREDITO IC-HONESTO: o TETO de cada política (maior IC95-INFERIOR da precisão) ──
      const bests = VARIANTS.flatMap((v) => KS.map((k) => bestCell(v, k))).filter(
        (b): b is Best => b !== null,
      );
      const best1 = bests.filter((b) => b.k === 1).reduce((a, b) => (b.lo > a.lo ? b : a));
      const bestK2plus = bests.filter((b) => b.k >= 2).reduce((a, b) => (b.lo > a.lo ? b : a));

      // ── A PREVISÃO REGISTRADA: piso 10, k=2, CONCORDÂNCIA ⇒ >97% de precisão? ──
      // CRITÉRIO DECLARADO ANTES DE OLHAR: a previsão se confirma numa cadência se a precisão de
      // turno PONTUAL passa de 97% E a cobertura de turno é ALTA (≥50% dos operadores), com ≥10
      // âncoras. (O ">97%" é do revisor; o "alta" é a leitura mais generosa possível de "cobertura
      // de TURNO alta" — se nem assim confirmar, não foi por régua apertada.)
      const pred = CADS.map((c) => {
        const m = cell(c.period, "dest", "concordance", 10, 2);
        const single = cell(c.period, "dest", "concordance", 19, 1);
        return {
          label: c.label,
          m,
          single,
          confirmed: m.precision > 0.97 && m.turnCoverage >= 0.5 && m.anchored >= MIN_DEC,
        };
      });
      const predConfirmed = pred.some((p) => p.confirmed);

      // O eixo separado (rejeitar quem NÃO tem tag) — a §2 mediu que a agregação POR SUSTENTAÇÃO não
      // o resolvia; a ABSTENÇÃO POR DISCORDÂNCIA é outro mecanismo. Medido à parte, sem misturar.
      const fa1 = falseAnchors(
        computeAnchors(collectOps(2, "dest").eps, "concordance", { k: 1, minNEff: 10 }),
      );
      const fa2 = falseAnchors(
        computeAnchors(collectOps(2, "dest").eps, "concordance", { k: 2, minNEff: 10 }),
      );

      console.log(
        `\n═══ TAREFA 1+2 — A TABELA QUE DECIDE (unidade = ÂNCORA/OPERADOR; τ→0; SIMULADOR ⇒ indicativa) ═══` +
          `${out.join("\n")}\n` +
          `\n★★ O TETO DE CADA POLÍTICA (a MELHOR célula de cada k — maior IC95-INFERIOR da precisão,\n` +
          `   não a maior estimativa pontual; ≥${MIN_DEC} âncoras) ★★\n` +
          bests
            .map(
              (b) =>
                `  ${(b.variant === "concordance" ? "(a) concordância" : "(b) Fisher-z").padEnd(18)} k=${b.k}  ` +
                `melhor célula: piso ${String(b.piso).padStart(2)}, Δt=${b.cad.padEnd(17)} ⇒ ` +
                `precisão ${formatProportion(b.m.anchoredCorrect, b.m.anchored).padEnd(38)} ` +
                `cobertura ${formatProportion(b.m.anchored, b.m.operators)}`,
            )
            .join("\n") +
          `\n\n  ⇒ TETO da política de EPISÓDIO ÚNICO (k=1): IC95-inf = ${pct(best1.lo)}%  ` +
          `(${best1.variant === "concordance" ? "concordância" : "Fisher-z"}, piso ${best1.piso}, ${best1.cad})\n` +
          `  ⇒ TETO da política de k≥2:                 IC95-inf = ${pct(bestK2plus.lo)}%  ` +
          `(${bestK2plus.variant === "concordance" ? "concordância" : "Fisher-z"}, k=${bestK2plus.k}, piso ${bestK2plus.piso}, ${bestK2plus.cad})\n` +
          `  ⇒ O TETO DE ${pct(OLD_CEILING)}% ERA DA POLÍTICA? ${
            bestK2plus.lo > OLD_CEILING && bestK2plus.lo >= 0.97
              ? "**SIM — DISSOLVIDO**. Nenhuma política de episódio\n" +
                `    único sustenta 97% (o melhor IC-inf é ${pct(best1.lo)}%); a k-confirmação sustenta ${pct(bestK2plus.lo)}% com\n` +
                `    cobertura de turno de ${pct(bestK2plus.m.turnCoverage)}%. A precisão É propriedade da POLÍTICA — o revisor está certo.`
              : "NÃO — o teto resistiu à política."
          }\n` +
          `\n★★ A PREVISÃO LITERAL DO REVISOR (piso ~10 por episódio, k=2 CONCORDANTES ⇒ >97%) ★★\n` +
          pred
            .map(
              (p) =>
                `  Δt=${p.label.padEnd(17)} precisão ${(p.m.anchored ? formatProportion(p.m.anchoredCorrect, p.m.anchored) : "— (nada ancorado)").padEnd(38)} ` +
                `cobertura ${formatProportion(p.m.anchored, p.m.operators).padEnd(38)} ⇒ ${p.confirmed ? "**CONFIRMA**" : "não confirma"}`,
            )
            .join("\n") +
          `\n  ⇒ VEREDITO BINÁRIO DA CÉLULA PREVISTA: ${predConfirmed ? "**SE CONFIRMA**" : "**NÃO SE CONFIRMA**"} ` +
          `(critério declarado ANTES: precisão pontual >97% E cobertura ≥50%, com ≥${MIN_DEC} âncoras).\n` +
          `    A DIREÇÃO da tese está certa e o MECANISMO funciona; o que a medição corrige é o PONTO:\n` +
          `    o piso 10 NÃO é onde a dupla-confirmação entrega 97% — e com a TAG REAL (2,5 s) a política\n` +
          `    de concordância COLAPSA (dois episódios com n_eff>10 exigiriam 2×~23 s de observação: quase\n` +
          `    nenhum operador tem isso). A célula que dissolve o teto é ${bestK2plus.variant === "concordance" ? "concordância" : "Fisher-z"} k=${bestK2plus.k}, piso ${bestK2plus.piso}, ${bestK2plus.cad}.\n` +
          `\n  ABSTENÇÃO POR DISCORDÂNCIA (o mecanismo que converte erro em silêncio) — 1 Hz, piso 10:\n` +
          `    k=1: ${cell(2, "dest", "concordance", 10, 1).abstainedByDisagreement} (por construção — o k=1 nunca compara)   ` +
          `k=2: ${cell(2, "dest", "concordance", 10, 2).abstainedByDisagreement} abstenções por discordância\n` +
          `\n★ O EIXO QUE MAIS IMPORTA PARA A MÉTRICA-QUE-MATA (<1 falso alerta/turno): rejeitar quem NÃO\n` +
          `  tem tag (1 Hz, piso 10; ${fa1.noTagOperators} pseudo-operadores SEM tag na suíte):\n` +
          `    âncoras FALSAS com k=1: ${fa1.anchored}   com k=2: ${fa2.anchored}` +
          `${fa1.anchored > 0 ? `   ⇒ ${(100 * (1 - fa2.anchored / fa1.anchored)).toFixed(0)}% de REDUÇÃO de falso alerta` : ""}\n` +
          `    (a §2 mediu que a agregação POR SUSTENTAÇÃO não resolvia este eixo — um falso rótulo\n` +
          `     sustentado virava falso evento. A ABSTENÇÃO POR DISCORDÂNCIA é outro mecanismo, e ELE resolve.)`,
      );

      // ── Assertivas ROBUSTAS (o VEREDITO, não números frágeis) ──
      // 1) População com massa.
      expect(cell(2, "dest", "concordance", 3, 1).operators).toBeGreaterThan(30);
      // 2) k=1 é o BASELINE fiel: nunca abstém por discordância (não há com quem discordar).
      expect(cell(2, "dest", "concordance", 10, 1).abstainedByDisagreement).toBe(0);
      // 3) O TRADE central: subir k NUNCA aumenta a cobertura (exige mais evidência).
      for (const c of CADS) {
        expect(cell(c.period, "dest", "concordance", 10, 2).turnCoverage).toBeLessThanOrEqual(
          cell(c.period, "dest", "concordance", 10, 1).turnCoverage,
        );
      }
      // 4) ★ O ACHADO, SELADO: NENHUMA política de episódio único sustenta 97% (IC-honesto)…
      expect(best1.lo).toBeLessThan(0.97);
      // …e a k-confirmação SUSTENTA — o teto de 94% era da POLÍTICA, não do canal.
      expect(bestK2plus.lo).toBeGreaterThanOrEqual(0.97);
      expect(bestK2plus.lo).toBeGreaterThan(best1.lo);
      expect(bestK2plus.m.turnCoverage).toBeGreaterThan(0.5); // e com cobertura de turno ALTA
      // 5) E a política ATACA a métrica-que-mata: k=2 corta o falso alerta de quem não tem tag.
      expect(fa2.anchored).toBeLessThan(fa1.anchored);
    },
    900000,
  );

  it(
    "TAREFA 3 — A COMPRA RECOMPUTADA COM A POLÍTICA: o corredor encolhe?",
    () => {
      /** MENOR T (passo 0,5 s) em que um episódio PODE cruzar o piso. ESTRITO (`> floor`), porque o
       *  gate é `nEff > minNEff` — com nDistinct == floor o episódio NUNCA decide. (A tabela do laudo
       *  anterior usava `>=`, o que subestima o T exigido em UM advertisement — corrigido aqui.) */
      const tForFloor = (dtS: number, floor: number): number => {
        for (let t = 0.5; t <= 600; t += 0.5) {
          if (maxDistinctReadings(t * 1000, dtS) > floor) return t;
        }
        return Number.POSITIVE_INFINITY;
      };
      const rBarOf = (nd: number): number =>
        nd > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (nd - 3))) : Number.NaN;

      // A LADEIRA DE ALVOS: o piso NÃO é constante da natureza — é o preço que se aceita pagar
      // (Regra 10). Sob k=2 o mesmo alvo de precisão se compra com piso MENOR ⇒ T menor ⇒ corredor
      // menor. É EXATAMENTE isso que a tabela mede.
      const TARGETS = [0.9, 0.95, 0.97] as const;
      const head =
        "alvo(IC-inf)".padEnd(14) +
        "política".padEnd(22) +
        "piso/ep".padEnd(9) +
        "Δt_tag".padEnd(18) +
        "T exig.".padEnd(9) +
        "corredor 1,1–1,2 m/s".padEnd(22) +
        "|r| exig.".padEnd(10) +
        "COBERTURA de turno".padEnd(34) +
        "PRECISÃO de turno";
      const lines = [head, "-".repeat(head.length)];
      const corridor: Record<string, number> = {}; // `${target}|${k}|${dtS}` → metros
      const floorAt: Record<string, number> = {}; // `${target}|${k}` → piso

      // O PISO É DERIVADO POR CADÊNCIA, na geometria do PORTAL (receptor no destino) — porque é isso
      // que se COMPRA: uma tag (Δt) e uma instalação. O piso "pooled" (que mistura a tag real com a
      // de 2 Hz e o receptor no canto com o do destino) dilui exatamente a decisão que se quer tomar.
      const cadFloor = (period: number, k: number, target: number): number => {
        for (let p = 3; p <= 20; p++) {
          const m = cell(period, "dest", "concordance", p, k);
          if (m.anchored >= MIN_DEC && wl(m.anchoredCorrect, m.anchored) >= target) return p;
        }
        return Number.NaN;
      };

      for (const target of TARGETS) {
        for (const k of [1, 2] as const) {
          for (const c of CADS) {
            const floor = cadFloor(c.period, k, target);
            floorAt[`${target}|${k}|${c.dtS}`] = floor;
            const pol = k === 1 ? "k=1 (ATUAL: 1ª fala)" : "k=2 (dupla-confirm.)";
            if (!Number.isFinite(floor)) {
              lines.push(
                `${`≥${pct(target)}%`.padEnd(14)}${pol.padEnd(22)}${"—".padEnd(9)}${c.label.padEnd(18)}` +
                  `IMPOSSÍVEL — nenhum piso ≤20 sustenta este alvo nesta cadência`,
              );
              continue;
            }
            const t = tForFloor(c.dtS, floor);
            const nd = maxDistinctReadings(t * 1000, c.dtS);
            const m = cell(c.period, "dest", "concordance", floor, k);
            corridor[`${target}|${k}|${c.dtS}`] = t * WALK_HI;
            lines.push(
              `${`≥${pct(target)}%`.padEnd(14)}` +
                `${pol.padEnd(22)}` +
                `${String(floor).padEnd(9)}` +
                `${c.label.padEnd(18)}` +
                `${`${t.toFixed(1)} s`.padEnd(9)}` +
                `${`${(t * WALK_LO).toFixed(1)}–${(t * WALK_HI).toFixed(1)} m`.padEnd(22)}` +
                `${rBarOf(nd).toFixed(2).padEnd(10)}` +
                `${formatProportion(m.anchored, m.operators).padEnd(34)}` +
                `${m.anchored ? formatProportion(m.anchoredCorrect, m.anchored) : "— (nada ancorado)"}`,
            );
          }
        }
      }

      // A COMPARAÇÃO SEM TRUQUE: piso 19 FIXO (o do laudo anterior) ⇒ corredor FIXO pela aritmética.
      // Só a POLÍTICA muda. É aqui que se lê o que a k-confirmação compra e o que ela paga.
      const fixedPiso19 = CADS.map((c) => {
        const t = tForFloor(c.dtS, 19);
        const m1 = cell(c.period, "dest", "concordance", 19, 1);
        const m2 = cell(c.period, "dest", "concordance", 19, 2);
        return (
          `    ${c.label.padEnd(17)} corredor ${`${(t * WALK_LO).toFixed(0)}–${(t * WALK_HI).toFixed(0)} m`.padEnd(9)} (T=${t.toFixed(1)} s)\n` +
          `      k=1: precisão ${(m1.anchored ? formatProportion(m1.anchoredCorrect, m1.anchored) : "— (nada ancorado)").padEnd(38)} cobertura ${formatProportion(m1.anchored, m1.operators)}\n` +
          `      k=2: precisão ${(m2.anchored ? formatProportion(m2.anchoredCorrect, m2.anchored) : "— (nada ancorado)").padEnd(38)} cobertura ${formatProportion(m2.anchored, m2.operators)}`
        );
      });

      const shrink = (target: number, dt: number): string => {
        const a = corridor[`${target}|1|${dt}`];
        const b = corridor[`${target}|2|${dt}`];
        const f1 = floorAt[`${target}|1|${dt}`];
        const f2 = floorAt[`${target}|2|${dt}`];
        if (!Number.isFinite(f1) && Number.isFinite(f2))
          return `IMPOSSÍVEL com episódio único → ${b.toFixed(0)} m com k=2 (piso ${f2})`;
        if (!Number.isFinite(f1) || !Number.isFinite(f2)) return "IMPOSSÍVEL em ambas";
        return `${a.toFixed(0)} m (piso ${f1}) → ${b.toFixed(0)} m (piso ${f2})` +
          `${a === b ? " — MESMO corredor: o que a política compra aqui é PRECISÃO, não metro" : ` (${(a / b).toFixed(1)}× menor)`}`;
      };

      console.log(
        `\n═══ TAREFA 3 — A TABELA DE COMPRA RECOMPUTADA COM A POLÍTICA (τ→0; concordância) ═══\n` +
          `${lines.join("\n")}\n\n` +
          `  T exigido = o MENOR episódio que PODE cruzar o piso (aritmética de contagem: ⌈T/Δt⌉+1 > piso).\n` +
          `  corredor  = T × velocidade de caminhada = o que a CÂMERA precisa OBSERVAR (receptor no fim).\n` +
          `  Com k=2 o operador precisa PASSAR 2× pelo corredor (entrada + volta do intervalo, p.ex.) —\n` +
          `  o corredor ENCOLHE, a exigência de REPETIÇÃO aparece. É a troca que a política faz.\n\n` +
          `★★ O CORREDOR ENCOLHEU? (mesmo ALVO de precisão, episódio único → dupla-confirmação) ★★\n` +
          TARGETS.map(
            (t) =>
              `  alvo ≥${pct(t)}% (IC95-inf da precisão de turno):\n` +
              `      tag REAL 2,5 s: ${shrink(t, 2.5)}\n` +
              `      1 Hz:           ${shrink(t, 1)}\n` +
              `      2 Hz:           ${shrink(t, 0.5)}`,
          ).join("\n") +
          `\n\n⚠ HONESTIDADE OBRIGATÓRIA SOBRE ESTE ENCOLHIMENTO (a coluna "|r| exigido" existe para isto):\n` +
          `  o piso cair leva a barra de correlação às alturas — em n_eff=4 o teste exige |r| ≥ 0,96. O\n` +
          `  SIMULADOR cruza essa barra (ele GERA o RSSI a partir da distância); o CAMPO não vai cruzar.\n` +
          `  ⇒ O corredor curto derivado de piso BAIXO (as linhas de alvo 90%, piso 3) é a parte MAIS\n` +
          `    circular desta medição — NÃO dimensione compra por ela. As linhas com |r| exigido ≤ ~0,6\n` +
          `    (piso ≥ 12) são as defensáveis.\n\n` +
          `★★ A COMPARAÇÃO APPLES-TO-APPLES COM A TABELA ANTERIOR (piso 19 FIXO ⇒ CORREDOR FIXO) ★★\n` +
          `  A tabela do laudo anterior (episódio único, piso 19) deu: 2,5 s → 47-52 m (MORTA) · 1 Hz →\n` +
          `  19-21 m · 2 Hz → 10-11 m. Aqueles pisos saíram da curva POR EPISÓDIO; os desta tabela saem da\n` +
          `  curva POR ÂNCORA (população diferente) — comparar os PISOS entre laudos seria maçã×laranja.\n` +
          `  O que se compara sem truque é: MESMO piso 19, MESMO corredor, k=1 × k=2 — só a POLÍTICA muda:\n` +
          fixedPiso19.join("\n") +
          `\n  ⇒ NO MESMO CORREDOR, a política troca cobertura por precisão. É a resposta honesta a "o\n` +
          `    corredor encolhe?": no alvo ALTO (≥97%), ele NÃO encolhe — ele CONTINUA ~10 m (2 Hz), mas\n` +
          `    passa a EXISTIR (com episódio único, 97% é inalcançável em qualquer corredor). O encolhimento\n` +
          `    real aparece nos alvos mais baixos, e vem com barra |r| que o campo não sustenta.`,
      );

      // ── Assertivas: a ARITMÉTICA (contagem), não os números do sim ──
      // 1) O gate é ESTRITO: com nDistinct == piso o episódio não decide (o T exigido tem de dar +1).
      expect(maxDistinctReadings(tForFloor(1.0, 10) * 1000, 1.0)).toBeGreaterThan(10);
      expect(maxDistinctReadings((tForFloor(1.0, 10) - 0.5) * 1000, 1.0)).toBeLessThanOrEqual(10);
      // 2) O PISO sob k=2 nunca é MAIOR que sob k=1 para o mesmo alvo E cadência (exigir concordância
      //    só REMOVE decisão errada — nunca adiciona). É o mecanismo do encolhimento do corredor.
      for (const t of TARGETS) {
        for (const c of CADS) {
          const f1 = floorAt[`${t}|1|${c.dtS}`];
          const f2 = floorAt[`${t}|2|${c.dtS}`];
          if (Number.isFinite(f1) && Number.isFinite(f2)) expect(f2).toBeLessThanOrEqual(f1);
        }
      }
      // 3) ★ O ALVO DE 97% (o da previsão) é IMPOSSÍVEL com episódio único em TODA cadência, e
      //    POSSÍVEL com k=2 em ALGUMA — o achado que redimensiona a compra. Se flipar, re-ler o laudo.
      for (const c of CADS) expect(Number.isFinite(floorAt[`0.97|1|${c.dtS}`])).toBe(false);
      expect(CADS.some((c) => Number.isFinite(floorAt[`0.97|2|${c.dtS}`]))).toBe(true);
      // 4) A cadência segue sendo alavanca LINEAR sobre o T exigido (a lei, 1º termo).
      expect(tForFloor(1.0, 10)).toBeLessThan(tForFloor(REAL_TAG_PERIOD_S, 10));
      expect(tForFloor(0.5, 10)).toBeLessThan(tForFloor(1.0, 10));
    },
    900000,
  );
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// ADR-015 §2 — DIVERSIDADE DE CONTEXTO: A PREVISÃO REGISTRADA DO REVISOR, TESTADA (2026-07-12)
//
// O QUE MOTIVA ESTE BLOCO. A Regra 13 nasceu de um número: agregando 2 episódios do mesmo operador,
// quando o 1º ERRA, o 2º REPETE O MESMO ERRO em 41,2% [IC95 21,6–64,0] — contra um teto model-free de
// independência de 8,8%. 4,7× acima ⇒ "n_eff 19+19=38" é FALSO como evidência independente.
//
// MAS NÓS MESMOS DECLARAMOS QUE AQUILO ERA O PIOR CASO POSSÍVEL: os "dois episódios" eram FRAGMENTOS
// DO TRACKER separados por ~1 s (gap MEDIANO medido = 1,0 s, achado #27, ttlMs=1500) — mesma pose,
// mesma sombra corporal, mesma geometria de aproximação. É quase A MESMA MEDIÇÃO DUAS VEZES.
//
// A PREVISÃO DO REVISOR (registrada ANTES desta medição, e é o que este bloco testa):
//   "A concordância-no-erro CAI MONOTONICAMENTE com a separação temporal entre episódios. Entre
//    âncoras reais separadas por minutos/horas o operador entrou por outra porta, com o corpo virado
//    de outro jeito, com a tag no outro bolso. A correlação de erro DESPENCA. Se cair de 41% para
//    perto do teto de independência em separações de MINUTOS, a política k=2 entre âncoras reais
//    funciona como a soma promete — e a compra de 2 Hz pode ser reavaliada PARA BAIXO."
//   Regra de desenho que sai disso: k=2 exige DIVERSIDADE DE CONTEXTO (separação temporal mínima),
//   não só "dois episódios". → `minSeparationMs` em anchor-policy.ts.
//
// ‼ POR QUE CENÁRIOS LONGOS (a honestidade da medição). Os FUSION_SCENARIOS pinados têm 240 passos =
//   120 s: NÃO SUSTENTAM os bins de separação longa (>5 min não existe em 120 s de cenário). Este
//   bloco estende a DURAÇÃO por OPÇÃO (`steps: LONG_STEPS`) — nunca mexendo no default pinado de
//   sim.ts (o pinning bit-a-bit dos FUSION_SCENARIOS é sagrado). Cenário = 2400 passos = 20 min.
// ‼ O QUE A SEPARAÇÃO É AQUI, E O QUE ELA NÃO É. Ela é separação DENTRO de uma caminhada contínua de
//   20 min: entre dois episódios separados por 5 min o operador está em OUTRO lugar da sala, com
//   OUTRO rumo (⇒ outro viés corporal direcional) e OUTRO offset regional. Isso é EXATAMENTE o
//   mecanismo que o revisor invoca — mas é o PISO dele, não o teto: entre âncoras de TURNO reais
//   (entrada / volta do almoço) muda também a roupa, o bolso da tag, a porta de entrada. Se a curva
//   já cair AQUI, cai a fortiori lá. Se NÃO cair aqui, a previsão está em sério apuro (mas não morta:
//   sobra a hipótese de que só a mudança de roupa/bolso decorrelaciona — que o sim não modela).
// ‼ PSEUDO-REPLICAÇÃO, declarada: um operador com m episódios decididos gera C(m,2) pares que
//   COMPARTILHAM episódios. Reportamos as DUAS réguas: TODOS os pares (n grande, IC otimista na
//   largura) e ≤1 PAR POR OPERADOR POR BIN (n honesto). A CONCLUSÃO se lê na régua conservadora.
// ‼ CIRCULARIDADE (idem todo o arco): precisão/cobertura saem do SIMULADOR ⇒ INDICATIVAS. O que NÃO é
//   circular é a ARITMÉTICA de contagem (T exigido → corredor) e a MECÂNICA da política.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("ADR-015 §2 — DIVERSIDADE DE CONTEXTO: a concordância-no-erro cai com a separação temporal?", () => {
  /** 2400 passos × 500 ms = 20 min de cenário (o default PINADO é 240 = 120 s). Opção, não default. */
  const LONG_STEPS = 2400;
  const SEED_REPLICATES = 6; // sementes por cenário (Monte-Carlo) — o n de operadores
  const PISO_REF = 10; // o piso onde os 41,2% foram medidos
  const CAD_REF = 2; // 1 Hz — a cadência onde os 41,2% foram medidos
  const MIN_DEC = 10; // âncoras mínimas p/ o IC de Wilson dizer algo
  const WALK_LO = 1.1; // m/s
  const WALK_HI = 1.2; // m/s
  const CADS = [
    { period: REAL_TAG_PERIOD_TICKS, dtS: REAL_TAG_PERIOD_S, label: "2,5 s (tag ATUAL)" },
    { period: 2, dtS: 1.0, label: "1,0 s (1 Hz)" },
    { period: 1, dtS: 0.5, label: "0,5 s (2 Hz)" },
  ] as const;
  /** Os bins de separação pedidos: 0-2 s (fragmentos), 2-10, 10-30, 30-60, 1-5 min, >5 min. */
  const EDGES_MS = [0, 2000, 10000, 30000, 60000, 300000] as const;

  /** Episódios etiquetados por OPERADOR, receptor no DESTINO, τ→0, em cenários de `LONG_STEPS`.
   *  Memoizado (determinístico e caro: 9 cenários × 6 seeds × 2 sims × 2400 ticks por cadência). */
  const opCache = new Map<number, { eps: OperatorEpisode[]; viol: number; operators: number }>();
  function collectLong(period: number): { eps: OperatorEpisode[]; viol: number; operators: number } {
    const hit = opCache.get(period);
    if (hit) return hit;
    const vo = { rho: 0 }; // τ→0 (resíduo BRANCO — a estimativa pontual de campo)
    const dtTagS = period * TICK_S;
    const eps: OperatorEpisode[] = [];
    const ops = new Set<string>();
    let viol = 0;
    for (const entry of FUSION_SCENARIOS.filter(inOverrideScope)) {
      for (let r = 0; r < SEED_REPLICATES; r++) {
        const seed = entry.seed + 1000 * r;
        const opts = { ...entry.opts, steps: LONG_STEPS, rssiPeriodTicks: period };
        const traj = person0Trajectory(opts, seed);
        if (traj.length < 2) continue;
        const sc = simulateFusionScenario({ ...opts, stationWorldOverride: destinationOf(traj) }, seed);
        const episodes = computeVisitEpisodes(visitTicksFromScenario(sc), vo);
        viol += countingViolations(episodes, dtTagS).length; // Regra 8 na FONTE
        for (const e of episodes) {
          if (e.candidates.length === 0) continue;
          const who = e.truthTag ?? `SEM-TAG#${e.trackId}`;
          const operator = `${entry.name}#${seed}|${who}`;
          if (e.truthTag !== null) ops.add(operator);
          eps.push({ operator, episode: e });
        }
      }
    }
    const out = { eps, viol, operators: ops.size };
    opCache.set(period, out);
    return out;
  }

  const cellLong = (
    period: number,
    minNEff: number,
    k: number,
    minSeparationMs?: number,
  ): AnchorMetrics =>
    computeAnchorMetrics(
      computeAnchors(collectLong(period).eps, "concordance", { k, minNEff, minSeparationMs }),
    );

  const wl = (kk: number, n: number): number => wilsonInterval(kk, n).lo;

  it(
    "TAREFA 1 — A CURVA: concordância-no-erro × SEPARAÇÃO TEMPORAL (a previsão do revisor)",
    () => {
      const { eps, viol, operators } = collectLong(CAD_REF);
      expect(viol).toBe(0); // Regra 8 na fonte: nDistinct ≤ ⌈T/Δt_tag⌉+1 e nEff ≤ nDistinct

      const all = agreementBySeparation(eps, PISO_REF, EDGES_MS);
      const one = agreementBySeparation(eps, PISO_REF, EDGES_MS, { onePairPerOperator: true });

      // O TETO GLOBAL de independência (o "8,8%" do achado): a taxa de erro do EPISÓDIO, model-free —
      // para o 2º repetir o MESMO erro, ele precisa no mínimo ERRAR. Recomputado NESTE dado.
      const errRate = 1 - cellLong(CAD_REF, PISO_REF, 1).precision;

      const fmtBin = (b: (typeof all)[number]): string =>
        `  ${b.label.padEnd(11)}` +
        `pares=${String(b.pairs).padStart(5)}  ops=${String(b.operators).padStart(4)}  ` +
        `1º ERRADO → 2º REPETE: ${(b.firstWrong ? formatAnchorProportion(b.firstWrongAndAgree, b.firstWrong) : "— (n=0)").padEnd(40)}` +
        `teto do BIN (P(2º erra)): ${(b.pairs ? `${pct(b.secondWrong / b.pairs)}%` : "—").padStart(6)}`;

      // A curva é MONOTÔNICA? (comparação sobre os bins COM dado, na régua conservadora.)
      const nonEmptyOne = one.filter((b) => b.firstWrong >= 3);
      const rateOf = (b: (typeof all)[number]): number => b.firstWrongAndAgree / b.firstWrong;
      let monotone = true;
      for (let i = 1; i < nonEmptyOne.length; i++)
        if (rateOf(nonEmptyOne[i]) > rateOf(nonEmptyOne[i - 1]) + 1e-9) monotone = false;
      const first = nonEmptyOne[0];
      const last = nonEmptyOne[nonEmptyOne.length - 1];
      // A régua A (todos os pares) é onde o n existe para o veredito ser mais que ruído: o bin dos
      // FRAGMENTOS (0-2 s) contra o bin mais SEPARADO (> 5 min) — as duas pontas da previsão.
      const allFirst = all[0];
      const allLast = all[all.length - 1];

      console.log(
        `\n═══ TAREFA 1 — A CURVA: CONCORDÂNCIA-NO-ERRO × SEPARAÇÃO TEMPORAL ═══\n` +
          `  (1 Hz · receptor no DESTINO · piso ${PISO_REF} · τ→0 · cenários de ${(LONG_STEPS * TICK_S) / 60} min · ` +
          `${operators} operadores)\n` +
          `  TETO GLOBAL de independência (model-free) = taxa de erro do episódio = ${pct(errRate)}%\n\n` +
          `── régua A: TODOS os pares (n grande; pares COMPARTILHAM episódios ⇒ IC OTIMISTA na largura) ──\n` +
          all.map(fmtBin).join("\n") +
          `\n\n── régua B (a que DECIDE): ≤1 PAR POR OPERADOR POR BIN — sem pseudo-replicação ──\n` +
          one.map(fmtBin).join("\n") +
          `\n\n★ A PREVISÃO: "cai monotonicamente e chega perto do teto de independência"\n` +
          `  bins com n≥3 (régua B): ${nonEmptyOne.map((b) => `${b.label}=${pct(rateOf(b))}%`).join(" → ")}\n` +
          `  MONOTÔNICA (não-crescente)? ${monotone ? "**SIM**" : "**NÃO**"}\n` +
          `  do 1º bin (${first.label}) ao último (${last.label}): ${pct(rateOf(first))}% → ${pct(rateOf(last))}%  ` +
          `(teto de independência ${pct(errRate)}%)\n` +
          `  DISTÂNCIA AO TETO: ${(rateOf(first) / Math.max(1e-9, errRate)).toFixed(1)}× no bin dos FRAGMENTOS → ` +
          `${(rateOf(last) / Math.max(1e-9, errRate)).toFixed(1)}× no bin mais SEPARADO\n` +
          `\n★★ VEREDITO — ACHADO NEGATIVO (vale o MESMO que um positivo, doutrina §5) ★★\n` +
          `  A PREVISÃO ESTÁ REFUTADA. A curva NÃO cai: ela é PLANA. Na régua A (n grande: ${allFirst.firstWrong}→${allLast.firstWrong}\n` +
          `  erros por bin), a concordância-no-erro vai de ${pct(rateOf(allFirst))}% nos FRAGMENTOS (0-2 s) a ${pct(rateOf(allLast))}% entre\n` +
          `  episódios separados por MAIS DE 5 MINUTOS — e o teto de independência do bin mal se move\n` +
          `  (${pct(allFirst.secondWrong / allFirst.pairs)}% → ${pct(allLast.secondWrong / allLast.pairs)}%). A razão ao teto fica em ${(rateOf(allFirst) / (allFirst.secondWrong / allFirst.pairs)).toFixed(1)}× → ${(rateOf(allLast) / (allLast.secondWrong / allLast.pairs)).toFixed(1)}×: NÃO converge para 1.\n` +
          `  ⇒ O ERRO CORRELACIONADO NÃO É UM ARTEFATO DO FRAGMENTO DE 1 s. Ele é PROPRIEDADE DO\n` +
          `    OPERADOR, não do INSTANTE: a geometria da trajetória daquela pessoa, QUAL vizinho é\n` +
          `    confundível com ela, a colocação da tag no corpo e a distribuição do viés corporal\n` +
          `    ao longo do turno são as MESMAS 5 minutos depois. Separar no tempo não separa a CAUSA.\n` +
          `  ⇒ A Regra 13 SOBREVIVE inteira, e o "n_eff 19+19=38" segue FALSO — agora não só no pior\n` +
          `    caso, mas em TODA separação medível.\n` +
          `  ⚠ O LIMITE HONESTO DESTA REFUTAÇÃO (o que ela NÃO diz): o simulador modela mudança de\n` +
          `    POSE/RUMO/REGIÃO ao longo da caminhada (e isso NÃO decorrelacionou nada), mas NÃO modela\n` +
          `    trocar de roupa, mudar a tag de bolso ou entrar por outra porta. O que está refutado é\n` +
          `    "a SEPARAÇÃO TEMPORAL, sozinha, decorrelaciona o erro". Se a decorrelação vier de\n` +
          `    trocar o BOLSO da tag, isso é um experimento de CAMPO (e uma mudança de PROCEDIMENTO),\n` +
          `    não uma propriedade do relógio — e não é o que a política k=2 compra de graça.\n`,
      );

      // ── Assertivas: a MECÂNICA, a MASSA e o ACHADO NEGATIVO selado ──
      expect(all[0].pairs).toBeGreaterThan(20); // o bin dos FRAGMENTOS (0-2 s) tem massa
      expect(nonEmptyOne.length).toBeGreaterThanOrEqual(3); // a curva tem ao menos 3 pontos com n
      // A régua conservadora nunca infla: ≤ pares da régua A, sempre.
      for (let i = 0; i < all.length; i++) expect(one[i].pairs).toBeLessThanOrEqual(all[i].pairs);
      // O teto de independência é model-free e tem de valer POR BIN (P(repete o MESMO erro) ≤ P(2º erra)).
      for (const b of all) expect(b.firstWrongAndAgree).toBeLessThanOrEqual(b.secondWrong);
      // ★ O ACHADO NEGATIVO, SELADO (se ISTO flipar, a previsão do revisor ressuscita e a compra de
      //   2 Hz volta à mesa — é o gate). Régua A (n grande), bin de separação > 5 MINUTOS:
      //   (a) a concordância-no-erro NÃO desaba: segue ≥60% da que os FRAGMENTOS de 1 s exibem…
      expect(rateOf(allLast)).toBeGreaterThan(0.6 * rateOf(allFirst));
      //   (b) …e continua MUITO acima do teto de independência DAQUELE bin (≥2×). Não converge.
      expect(rateOf(allLast)).toBeGreaterThan(2 * (allLast.secondWrong / allLast.pairs));
    },
    900000,
  );

  it(
    "TAREFA 2 — A POLÍTICA k=2 COM DIVERSIDADE vs SEM: a soma passa a render o que promete?",
    () => {
      const SEPS = [0, 10000, 30000, 60000, 300000] as const; // separação mínima exigida
      const head =
        "separação mín.".padEnd(16) +
        "PRECISÃO de turno (IC95, n=âncoras)".padEnd(40) +
        "COBERTURA de turno (IC95, n=operadores)".padEnd(42) +
        "concord.-no-erro entre os CONSUMIDOS";
      const lines: string[] = [head, "-".repeat(head.length)];
      const rows: { sep: number; m: AnchorMetrics; lo: number }[] = [];
      const { eps } = collectLong(CAD_REF);

      for (const sep of SEPS) {
        const m = cellLong(CAD_REF, PISO_REF, 2, sep);
        const lo = m.anchored ? wl(m.anchoredCorrect, m.anchored) : 0;
        rows.push({ sep, m, lo });
        // A concordância-no-erro RESULTANTE: só os pares que a política com ESTA separação consumiria
        // (gap ≥ sep) — é o sensor da Regra 13 aplicado à população que a política de fato agrega.
        const bins = agreementBySeparation(eps, PISO_REF, [sep], { onePairPerOperator: true });
        const b = bins[0];
        lines.push(
          `${(sep === 0 ? "0 (SEM divers.)" : `≥${(sep / 1000).toFixed(0)} s`).padEnd(16)}` +
            `${(m.anchored ? formatAnchorProportion(m.anchoredCorrect, m.anchored) : "— (nada ancorado)").padEnd(40)}` +
            `${formatAnchorProportion(m.anchored, m.operators).padEnd(42)}` +
            `${b.firstWrong ? formatAnchorProportion(b.firstWrongAndAgree, b.firstWrong) : "— (n=0)"}`,
        );
      }

      const semDiv = rows[0];
      const k1 = cellLong(CAD_REF, PISO_REF, 1);
      const melhor = rows.reduce((a, b) => (b.lo > a.lo && b.m.anchored >= MIN_DEC ? b : a));
      const errRate = 1 - k1.precision;

      console.log(
        `\n═══ TAREFA 2 — k=2 COM DIVERSIDADE vs SEM (1 Hz · destino · piso ${PISO_REF} · τ→0) ═══\n` +
          `${lines.join("\n")}\n\n` +
          `  BASELINE k=1 (política ATUAL, falar na 1ª oportunidade): ` +
          `precisão ${formatAnchorProportion(k1.anchoredCorrect, k1.anchored)}  ` +
          `cobertura ${formatAnchorProportion(k1.anchored, k1.operators)}\n` +
          `  teto model-free de independência (taxa de erro do episódio) = ${pct(errRate)}%\n\n` +
          `★ A DIVERSIDADE RECUPERA O QUE A SOMA PROMETE?\n` +
          `  k=2 SEM diversidade: precisão IC-inf ${pct(semDiv.lo)}%  (n=${semDiv.m.anchored} âncoras, cob. ${pct(semDiv.m.turnCoverage)}%)\n` +
          `  k=2 COM diversidade (melhor: ≥${(melhor.sep / 1000).toFixed(0)} s): precisão IC-inf ${pct(melhor.lo)}%  ` +
          `(n=${melhor.m.anchored} âncoras, cob. ${pct(melhor.m.turnCoverage)}%)\n` +
          `  ⇒ ganho de IC-inf: ${((melhor.lo - semDiv.lo) * 100).toFixed(1)} p.p.  |  ` +
          `custo em cobertura: ${((semDiv.m.turnCoverage - melhor.m.turnCoverage) * 100).toFixed(1)} p.p.\n` +
          `  ⇒ pior célula COM diversidade: IC-inf ${pct(Math.min(...rows.slice(1).map((r) => r.lo)))}% — ` +
          `ABAIXO do SEM diversidade. A dispersão entre as separações (${pct(Math.min(...rows.map((r) => r.lo)))}–${pct(Math.max(...rows.map((r) => r.lo)))}%)\n` +
          `    é do TAMANHO do "ganho": não há efeito — há RUÍDO. É exatamente o que a curva PLANA da\n` +
          `    TAREFA 1 prevê: se o erro não decorrelaciona com o tempo, EXIGIR tempo não compra nada.\n` +
          `  ⇒ A DIVERSIDADE NÃO RECUPERA O QUE A SOMA DE FISHER-Z PROMETE. O que a k=2 compra (e ela\n` +
          `    compra: ${pct(k1.precision)}% → ${pct(semDiv.m.precision)}% de precisão pontual sobre o k=1) vem da DISCORDÂNCIA\n` +
          `    virando SILÊNCIO — um mecanismo que funciona mesmo com erro correlacionado, e que já\n` +
          `    estava medido. A separação temporal é um knob NULO neste canal.\n`,
      );

      // ── Assertivas ROBUSTAS ──
      expect(semDiv.m.operators).toBeGreaterThan(30); // massa
      // 1) MECÂNICA: o k=1 é INVARIANTE à diversidade (a cadeia gulosa começa sempre no 1º elegível —
      //    não há "anterior" de quem se separar). É o pino de que o knob não mexe no baseline.
      for (const sep of SEPS)
        expect(cellLong(CAD_REF, PISO_REF, 1, sep)).toEqual(cellLong(CAD_REF, PISO_REF, 1));
      // 2) k=2 (com ou sem diversidade) nunca cobre MAIS que k=1 — o trade da agregação.
      for (const r of rows) expect(r.m.turnCoverage).toBeLessThanOrEqual(k1.turnCoverage + 1e-9);
      // 3) SEM diversidade a política ainda ancora (a comparação existe).
      expect(semDiv.m.anchored).toBeGreaterThanOrEqual(MIN_DEC);
      // 4) ★ O ACHADO NEGATIVO, SELADO: a diversidade NÃO é alavanca. O efeito dela sobre o IC-inf da
      //    precisão de turno é PEQUENO (<5 p.p. em QUALQUER separação) e não tem sinal definido — ela
      //    tanto sobe quanto DESCE. Se um dia alguma separação comprar >5 p.p., força re-exame.
      for (const r of rows) expect(Math.abs(r.lo - semDiv.lo)).toBeLessThan(0.05);
    },
    900000,
  );

  it(
    "TAREFA 3 — A COMPRA REAVALIADA: com diversidade de contexto, a tag de 2 Hz continua necessária?",
    () => {
      /** MENOR T (passo 0,5 s) em que um episódio PODE cruzar o piso — gate ESTRITO (`> floor`). */
      const tForFloor = (dtS: number, floor: number): number => {
        for (let t = 0.5; t <= 900; t += 0.5) {
          if (maxDistinctReadings(t * 1000, dtS) > floor) return t;
        }
        return Number.POSITIVE_INFINITY;
      };
      const rBarOf = (nd: number): number =>
        nd > 3 ? Math.tanh(1.96 * Math.sqrt(1 / (nd - 3))) : Number.NaN;

      const TARGETS = [0.95, 0.97] as const;
      /** A DIVERSIDADE que a compra assume: ≥60 s entre os episódios agregados. Uma âncora de turno
       *  (entrada / volta do almoço) satisfaz isso com folga de ORDENS DE GRANDEZA; é a exigência
       *  mais BARATA que já sai do bin "1-5 min" da curva. */
      const SEP_MS = 60000;

      /** O menor piso POR EPISÓDIO que sustenta o alvo (IC95-inf) nesta cadência/política. */
      const floorFor = (period: number, k: number, target: number, sep?: number): number => {
        for (let p = 3; p <= 20; p++) {
          const m = cellLong(period, p, k, sep);
          if (m.anchored >= MIN_DEC && wl(m.anchoredCorrect, m.anchored) >= target) return p;
        }
        return Number.NaN;
      };

      const head =
        "alvo".padEnd(7) +
        "política".padEnd(26) +
        "Δt_tag".padEnd(19) +
        "piso/ep".padEnd(9) +
        "T exig.".padEnd(9) +
        "corredor 1,1–1,2 m/s".padEnd(22) +
        "|r| exig.".padEnd(10) +
        "COBERTURA de turno".padEnd(34) +
        "PRECISÃO de turno";
      const lines = [head, "-".repeat(head.length)];
      const POLS = [
        { k: 1, sep: undefined, label: "k=1 (ATUAL: 1ª fala)" },
        { k: 2, sep: undefined, label: "k=2 SEM diversidade" },
        { k: 2, sep: SEP_MS, label: "k=2 COM divers. ≥60 s" },
      ] as const;
      const corr: Record<string, number> = {};
      const pisoOf: Record<string, number> = {};

      for (const target of TARGETS) {
        for (const pol of POLS) {
          for (const c of CADS) {
            const key = `${target}|${pol.label}|${c.dtS}`;
            const floor = floorFor(c.period, pol.k, target, pol.sep);
            pisoOf[key] = floor;
            if (!Number.isFinite(floor)) {
              lines.push(
                `${`≥${pct(target)}%`.padEnd(7)}${pol.label.padEnd(26)}${c.label.padEnd(19)}` +
                  `IMPOSSÍVEL — nenhum piso ≤20 sustenta este alvo nesta cadência`,
              );
              continue;
            }
            const t = tForFloor(c.dtS, floor);
            const m = cellLong(c.period, floor, pol.k, pol.sep);
            corr[key] = t * WALK_HI;
            lines.push(
              `${`≥${pct(target)}%`.padEnd(7)}${pol.label.padEnd(26)}${c.label.padEnd(19)}` +
                `${String(floor).padEnd(9)}${`${t.toFixed(1)} s`.padEnd(9)}` +
                `${`${(t * WALK_LO).toFixed(1)}–${(t * WALK_HI).toFixed(1)} m`.padEnd(22)}` +
                `${rBarOf(maxDistinctReadings(t * 1000, c.dtS)).toFixed(2).padEnd(10)}` +
                `${formatAnchorProportion(m.anchored, m.operators).padEnd(34)}` +
                `${m.anchored ? formatAnchorProportion(m.anchoredCorrect, m.anchored) : "— (nada ancorado)"}`,
            );
          }
        }
      }

      // ★ A PERGUNTA QUE DECIDE DINHEIRO: com diversidade, a tag ATUAL (2,5 s) ou a de 1 Hz atingem
      //   os alvos — tornando a compra de 2 Hz DESNECESSÁRIA?
      const reachable = (target: number, label: string, dtS: number): boolean =>
        Number.isFinite(pisoOf[`${target}|${label}|${dtS}`]);
      const DIV = "k=2 COM divers. ≥60 s";
      const veredito = TARGETS.map((t) => {
        const atual = reachable(t, DIV, REAL_TAG_PERIOD_S);
        const hz1 = reachable(t, DIV, 1);
        const hz2 = reachable(t, DIV, 0.5);
        const corrOf = (dt: number): string =>
          reachable(t, DIV, dt) ? `${corr[`${t}|${DIV}|${dt}`].toFixed(0)} m` : "IMPOSSÍVEL";
        return (
          `  alvo ≥${pct(t)}% (IC95-inf da precisão de turno), política k=2 COM diversidade:\n` +
          `      tag ATUAL (2,5 s): ${atual ? `ATINGE — corredor ~${corrOf(REAL_TAG_PERIOD_S)}` : "NÃO ATINGE"}\n` +
          `      tag 1 Hz:          ${hz1 ? `ATINGE — corredor ~${corrOf(1)}` : "NÃO ATINGE"}\n` +
          `      tag 2 Hz:          ${hz2 ? `ATINGE — corredor ~${corrOf(0.5)}` : "NÃO ATINGE"}`
        );
      });

      console.log(
        `\n═══ TAREFA 3 — A COMPRA REAVALIADA COM DIVERSIDADE DE CONTEXTO (τ→0; concordância) ═══\n` +
          `${lines.join("\n")}\n\n` +
          `  T exigido = MENOR episódio que PODE cruzar o piso (aritmética: ⌈T/Δt⌉+1 > piso — NÃO-circular).\n` +
          `  corredor  = T × velocidade de caminhada = o que a CÂMERA precisa OBSERVAR (receptor no fim).\n` +
          `  A diversidade NÃO muda o corredor de UM episódio (isso é geometria+contagem); ela só podia\n` +
          `  mudar o PISO que o alvo exige — e a tabela mostra que ela NÃO muda (ou PIORA).\n\n` +
          `★★ A PERGUNTA QUE DECIDE DINHEIRO ★★\n` +
          veredito.join("\n") +
          `\n\n★★ O QUE A DIVERSIDADE FEZ PELA COMPRA: NADA (ou pior) ★★\n` +
          TARGETS.map((t) =>
            CADS.map((c) => {
              const sem = pisoOf[`${t}|k=2 SEM diversidade|${c.dtS}`];
              const com = pisoOf[`${t}|${DIV}|${c.dtS}`];
              const f = (x: number): string => (Number.isFinite(x) ? `piso ${x}` : "IMPOSSÍVEL");
              const dir =
                !Number.isFinite(sem) || !Number.isFinite(com)
                  ? ""
                  : com === sem
                    ? "  (IGUAL — a diversidade não comprou 1 metro)"
                    : com > sem
                      ? "  ⇒ a diversidade PIOROU a compra (piso mais alto = corredor MAIOR)"
                      : "  ⇒ a diversidade BARATEOU a compra";
              return `  alvo ≥${pct(t)}% · ${c.label.padEnd(18)} SEM=${f(sem).padEnd(11)} COM=${f(com).padEnd(11)}${dir}`;
            }).join("\n"),
          ).join("\n") +
          `\n  ⇒ COERENTE COM A TAREFA 1: o erro não decorrelaciona com o tempo ⇒ exigir tempo só REMOVE\n` +
          `    âncoras (n cai ⇒ o IC de Wilson ALARGA ⇒ o IC-inf CAI) sem remover erro. A diversidade\n` +
          `    é um custo sem contrapartida NESTE canal. NÃO a inclua na compra.\n\n` +
          `⚠⚠ O CONFOUND QUE EU NÃO VOU ESCONDER (Regra 11 — reporte o que o MECANISMO comprou):\n` +
          `  Esta tabela NÃO é comparável linha-a-linha com a do laudo anterior ("≥97% só com 2 Hz,\n` +
          `  corredor 9,4–10,2 m"). Ali o "turno" tinha 120 s de cenário; aqui tem ${(LONG_STEPS * TICK_S) / 60} MIN. Um turno\n` +
          `  mais longo dá ao operador MUITAS mais oportunidades de episódio ⇒ a k=2 acha dois episódios\n` +
          `  decididos com muito mais frequência ⇒ a POPULAÇÃO ANCORADA muda (cobertura ${pct(cellLong(2, 12, 2).turnCoverage)}% a 1 Hz).\n` +
          `  ⇒ O QUE BAIXOU A COMPRA NÃO FOI A DIVERSIDADE — FOI A DURAÇÃO DO TURNO. E isso não é um\n` +
          `    truque: o laudo anterior JÁ DECLARAVA que sua cobertura de turno de 120 s era "um PISO,\n` +
          `    não uma previsão". Um turno real (8 h) é ainda mais generoso que estes ${(LONG_STEPS * TICK_S) / 60} min.\n` +
          `  ⇒ O que NÃO muda com a duração do turno (é ARITMÉTICA de contagem, não estatística): a\n` +
          `    coluna "T exig." e o "corredor". Para um MESMO piso, o corredor é o mesmo dos dois laudos.\n\n` +
          `⚠ HONESTIDADE (a coluna "|r| exig." existe para isto): piso baixo ⇒ barra de correlação\n` +
          `  altíssima (n_eff=4 ⇒ |r| ≥ 0,96). O SIMULADOR cruza (ele GERA o RSSI da distância); o CAMPO\n` +
          `  não vai cruzar. Linhas com |r| exigido ≤ ~0,6 (piso ≥ 12) são as defensáveis para compra.\n`,
      );

      // ── Assertivas: a ARITMÉTICA (não os números do sim) + o ACHADO NEGATIVO ──
      // 1) O gate é ESTRITO (T exigido tem de dar nDistinct > piso).
      expect(maxDistinctReadings(tForFloor(1.0, 10) * 1000, 1.0)).toBeGreaterThan(10);
      // 2) ★ O ACHADO NEGATIVO, SELADO: a diversidade NUNCA BARATEIA a compra — o piso exigido COM
      //    diversidade é SEMPRE ≥ o SEM (e no alvo de 97% ele SOBE: menos âncoras ⇒ IC mais largo).
      //    Isto é o oposto do que a previsão do revisor esperava. Se flipar, a previsão ressuscita.
      for (const t of TARGETS) {
        for (const c of CADS) {
          const sem = pisoOf[`${t}|k=2 SEM diversidade|${c.dtS}`];
          const com = pisoOf[`${t}|${DIV}|${c.dtS}`];
          if (Number.isFinite(sem) && Number.isFinite(com)) expect(com).toBeGreaterThanOrEqual(sem);
        }
      }
      // 3) ★ O QUE DE FATO MOVE A COMPRA (e é o que o dono precisa ler): com k=2 num turno LONGO, o
      //    alvo ≥97% deixa de exigir 2 Hz — a tag de 1 Hz o alcança. (Com k=1 NENHUMA cadência alcança
      //    97%: o teto é da POLÍTICA, como o ADR-015 já selou.)
      for (const c of CADS) expect(Number.isFinite(pisoOf[`0.97|k=1 (ATUAL: 1ª fala)|${c.dtS}`])).toBe(false);
      expect(Number.isFinite(pisoOf[`0.97|k=2 SEM diversidade|1`])).toBe(true);
      // 4) …mas a TAG ATUAL (2,5 s) segue NÃO alcançando 97% em política nenhuma — o alvo alto ainda
      //    exige TROCAR a tag (1 Hz basta; 2 Hz deixa de ser obrigatório).
      expect(Number.isFinite(pisoOf[`0.97|k=2 SEM diversidade|${REAL_TAG_PERIOD_S}`])).toBe(false);
      expect(Number.isFinite(pisoOf[`0.97|${DIV}|${REAL_TAG_PERIOD_S}`])).toBe(false);
      // 5) A cadência segue sendo alavanca LINEAR no T exigido (a lei, 1º termo) — sobrevive à política.
      expect(tForFloor(1.0, 12)).toBeLessThan(tForFloor(REAL_TAG_PERIOD_S, 12));
      expect(tForFloor(0.5, 12)).toBeLessThan(tForFloor(1.0, 12));
    },
    900000,
  );
});
