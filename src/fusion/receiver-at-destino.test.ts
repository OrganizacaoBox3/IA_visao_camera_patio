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
import { describe, expect, it } from "vitest";
import { simulateFusionScenario } from "./sim";
import type { SimFusionScenario, SimOpts } from "./sim";
import { FUSION_SCENARIOS } from "./replay-fusion";
import { buildFusionFrame } from "./frame";
import { computeVisitEpisodes, computeVisitMetrics } from "./visit-metrics";
import type { VisitMetrics, VisitTick, VisitTrackObs } from "./visit-metrics";
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

/** Métrica de visita HONESTA (ρ=0,7 default) para um cenário com a estação em `receiver`. */
function metricsAt(entry: ScenarioEntry, receiver?: Pt): VisitMetrics {
  return computeVisitMetrics(ticksAt(entry, receiver));
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
      const median = (xs: number[]): number => {
        if (xs.length === 0) return 0;
        const s = [...xs].sort((a, b) => a - b);
        return s[s.length >> 1];
      };
      const TICK_S = 0.5;

      type CadRow = {
        period: number;
        hz: number;
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

      function sweepCadence(period: number): CadRow {
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
          const episodes = computeVisitEpisodes(ticks).filter((e) => e.truthTag !== null);
          const m = computeVisitMetrics(ticks);
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
        return {
          period,
          hz: 1 / (period * TICK_S),
          withTag,
          medNTicks: median(nTicksAll),
          medNeff: median(neffAll),
          maxNeff,
          reachNeff,
          dec,
          cor,
          eps,
          rBarAtMax,
          byDur: buckets.map((b) => ({
            label: b.label,
            medNeff: median(b.neffs),
            count: b.neffs.length,
          })),
        };
      }

      const cad2 = sweepCadence(2); // 1 Hz — cadência atual (advertising real)
      const cad1 = sweepCadence(1); // 2 Hz — refresh dobrado (máximo no tick de 500ms)

      const fmtRow = (r: CadRow): string =>
        `${r.hz.toFixed(0)} Hz (period=${r.period})`.padEnd(20) +
        `${String(r.withTag).padStart(5)}   ` +
        `${r.medNTicks.toFixed(0).padStart(6)}   ` +
        `${r.medNeff.toFixed(2).padStart(7)}   ` +
        `${r.maxNeff.toFixed(2).padStart(7)}   ` +
        `${String(r.reachNeff).padStart(9)}   ` +
        `${String(r.dec).padStart(4)}/${String(r.eps).padStart(4)}   ` +
        `${(r.eps === 0 ? 0 : (100 * r.dec) / r.eps).toFixed(1).padStart(6)}%   ` +
        `${(r.dec === 0 ? 0 : (100 * r.cor) / r.dec).toFixed(1).padStart(6)}%   ` +
        `${r.rBarAtMax.toFixed(2)}`;

      const head =
        "cadência RSSI".padEnd(20) +
        "  eps   medDur   medNeff   maxNeff   reachN>3   dec/eps    cob%     prec%   |r|@maxNeff";
      console.log(
        `\nVARREDURA DE CADÊNCIA (estação NO DESTINO, ρ=0,7 HONESTO, pooled sobre a suíte):\n` +
          `${head}\n${"-".repeat(head.length)}\n${fmtRow(cad2)}\n${fmtRow(cad1)}`,
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
});
