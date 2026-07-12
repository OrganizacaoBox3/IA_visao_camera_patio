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
  maxDistinctReadings,
} from "./visit-metrics";
import type { VisitEpisode, VisitMetrics, VisitTick, VisitTrackObs } from "./visit-metrics";
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
