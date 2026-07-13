// ─────────────────────────────────────────────────────────────────────────────
// eval/multi-antena.mjs — TORNEIO DA 2ª ANTENA (H4 / laudo-2026-07-13 P6).
// Standalone: `node eval/multi-antena.mjs`  (Node 24 importa .ts nativamente)
//
// O QUE ELE MEDE (código de PRODUÇÃO importado — nada reimplementado):
//   src/fusion/sim.ts (2 estações com posição própria)  →  src/fusion/frame.ts
//   (buildFusionFrame: geometria por fonte)  →  src/fusion/associate.ts
//   (TagTrackAssociator: partição por fonte + soma de Fisher-z)  →
//   src/fusion/identity-metrics.ts (precisão/cobertura/conflito).
//   O laço de replay é FIEL ao useTagFusion de produção: tick sem BLE é PULADO;
//   com BLE, push(buildFusionFrame(...)) + assign(ts).
//
// OS 4 BRAÇOS (a decomposição da Regra 11 — nunca só o agregado):
//   A        — só a estação A no pool. É o CAMPO DE HOJE (1 antena).
//   B        — só a estação B. O controle: a 2ª antena SOZINHA é melhor/pior?
//   A+B OFF  — as duas no pool, multiSourceFisher DESLIGADO. É o que a produção
//              faria HOJE se o S24 entrasse no ar: o align() casa por ts e, no
//              empate (as duas postam no MESMO frame), fica com a PRIMEIRA da
//              ordem de inserção ⇒ o RSSI da 2ª antena é DESCARTADO EM SILÊNCIO.
//              Este braço EXISTE para medir o preço desse descarte.
//   A+B ON   — as duas no pool com multiSourceFisher LIGADO (partitionBySource
//              antes do align; cada fonte correlaciona o SEU RSSI contra a SUA
//              distância — distByStation). É o candidato à promoção.
//
// ── RÉGUA DO TORNEIO — PINADA A PRIORI (escrita ANTES de rodar; rito da casa) ──
//   R1. precisão(A+B ON) ≥ max(precisão(A), precisão(B))  — em TODO cenário com
//       fala (rótulo errado é pior que rótulo nenhum: a 2ª antena não pode
//       comprar cobertura pagando com erro).
//   R2. cobertura(A+B ON) ≥ 1,5 × max(cobertura(A), cobertura(B))  — no AGREGADO
//       (soma de correct / soma de opportunities). Somar antena tem de PAGAR;
//       ganho marginal não justifica o hardware.
//   R3. conflito(A+B ON) ≤ 0,6 × min(conflito(A), conflito(B))  — no AGREGADO.
//       O 2º eixo radial tem de QUEBRAR o empate, não só reponderá-lo.
//   R4. (HONESTIDADE, não promoção — Regra 13) agreementOnFailure entre A e B
//       MEDIDO e reportado contra um teto model-free de independência. Se os
//       erros forem correlacionados, "n_eff = n_A + n_B" é FALSO como evidência
//       independente — somar como se fossem independentes publica número errado.
//
// ── REGRAS DA CASA APLICADAS AQUI ─────────────────────────────────────────────
//   Regra 8 (deduplique ANTES da estatística): a decisão do associador é emitida
//     a cada 500 ms sobre uma janela de 8 s — ticks consecutivos com a MESMA
//     decisão são a MESMA decisão re-emitida, NÃO evidência nova. Os pontos
//     (precisão/cobertura) saem no nível de TICK (comparável aos outros torneios
//     da casa), mas TODO intervalo de Wilson sai sobre o n DEDUPLICADO por
//     episódio (corrida maximal de ticks consecutivos com o mesmo veredito para
//     o mesmo trackId). Intervalo sobre n de tick seria estreito por construção.
//   Regra 9 (o pipeline RESOLVE o parâmetro?): a suíte roda em DOIS regimes de
//     cadência — o default do sim (1 Hz, 2,5× OTIMISTA vs a tag real) e o da
//     FÍSICA MEDIDA (REAL_TAG_PERIOD_TICKS = 2,5 s). O número que vale para o
//     campo é o do 2º.
//   PONTO CEGO DECLARADO: a 2ª antena NÃO EXISTE no campo. Toda cobertura aqui é
//     de SIMULADOR — circular por construção (o sim gera o RSSI com o mesmo
//     modelo log-distância que o motor pressupõe). O que é campo é o τ e a
//     cadência. NÃO vender esta cobertura como medida.
// ─────────────────────────────────────────────────────────────────────────────
import { register } from "node:module";
// O Node executa .ts nativamente, mas não resolve import sem extensão (como o front escreve) —
// ver eval/ts-ext-resolve.mjs. Registrar ANTES de importar o código de produção (daí o import
// dinâmico logo abaixo): nada é reimplementado aqui, é o motor de verdade que roda.
register("./ts-ext-resolve.mjs", import.meta.url);
const { simulateFusionScenario, REAL_TAG_PERIOD_TICKS } = await import("../src/fusion/sim.ts");
const { buildFusionFrame } = await import("../src/fusion/frame.ts");
const { TagTrackAssociator } = await import("../src/fusion/associate.ts");
const { computeIdentityMetrics } = await import("../src/fusion/identity-metrics.ts");

const STEPS = 240; // 120 s — a janela de 8 s precisa de amostra farta depois do warmup
const A = { id: "est-a", world: { x: 0, y: 0 } }; // canto próximo do chão 8×6
const B = { id: "est-b", world: { x: 8, y: 6 } }; // canto OPOSTO → outro eixo radial
// SENTINELA de instalação (aviso M4 da spec): estações praticamente CO-LOCALIZADAS. A geometria é
// a mesma ⇒ o 2º eixo radial não existe ⇒ nenhum ganho esperado. Se o torneio "ganhar" aqui, é
// artefato (mais amostras do MESMO eixo), não a física da 2ª antena.
const B_COLOC = { id: "est-b", world: { x: 0.4, y: 0.3 } };

const SCENARIOS = [
  { name: "canonico", opts: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint" }, seed: 42, stations: [A, B] },
  { name: "bloco", opts: { steps: STEPS, people: 3, tagged: 2, walk: "bloco" }, seed: 42, stations: [A, B] },
  { name: "cruzamento", opts: { steps: STEPS, people: 2, tagged: 2, walk: "cruzamento", idSwitchOnCross: true }, seed: 7, stations: [A, B] },
  { name: "multidao", opts: { steps: STEPS, people: 6, tagged: 4, walk: "waypoint" }, seed: 123, stations: [A, B] },
  { name: "ruido-alto", opts: { steps: STEPS, people: 3, tagged: 2, walk: "waypoint", rssiNoiseDb: 8 }, seed: 42, stations: [A, B] },
  // O CASO DOMINANTE DO CAMPO (41,9% do silêncio — laudo de 2026-07-13): pessoa PARADA.
  { name: "parado", opts: { steps: STEPS, people: 3, tagged: 2, walk: "parado" }, seed: 42, stations: [A, B] },
  // Sentinela de instalação: 2 antenas no MESMO canto (geometria degenerada).
  { name: "bloco-colocadas", opts: { steps: STEPS, people: 3, tagged: 2, walk: "bloco" }, seed: 42, stations: [A, B_COLOC] },
  // SENTINELA DA REGRA 13: viés CORPORAL direcional ligado — o único mecanismo do simulador capaz
  // de gerar ERRO COMPARTILHADO entre as duas antenas (a mesma geometria de corpo/vizinho, vista
  // por duas antenas). Sem ele, o sim sorteia um ε INDEPENDENTE por estação, e a concordância-no-
  // erro é independente POR CONSTRUÇÃO — ver a nota do ponto cego no relatório de R4.
  {
    name: "bloco-corpo",
    opts: {
      steps: STEPS, people: 3, tagged: 2, walk: "bloco",
      bodyBias: { meanDb: 6, peakDb: 20, angWidthDeg: 60 },
      tagPlacement: { 0: "bolso-esq", 1: "bolso-esq" },
    },
    seed: 42,
    stations: [A, B],
  },
];

// ─────────────────────────── replay (fiel ao useTagFusion) ───────────────────────────

/** Filtra o pool de leituras por fonte (undefined = pool inteiro). */
function poolOf(readings, only) {
  return only === undefined ? readings : readings.filter((r) => r.stationId === only);
}

/**
 * DIAGNÓSTICO (pós-hoc, EXPLORATÓRIO — NÃO faz parte da régua a priori): suprime a CÓPIA. O
 * simulador (fiel ao snapshot da produção) REPETE o último RSSI a cada tick entre atualizações
 * reais da tag — o sample-and-hold do B1/B2/B3 do laudo. Este filtro deixa passar só a leitura
 * FRESCA (valor mudou desde a última daquele par mac×estação).
 *
 * POR QUE ELE EXISTE: o peso de Fisher do motor é `n_alinhados − 3` — e `n_alinhados` conta
 * CÓPIAS. Na cadência REAL (2,5 s), 16 pontos de janela carregam ~3,6 medições distintas: o motor
 * pondera as duas fontes por um n 4,4× INFLADO. É a Regra 8 violada DENTRO da soma de evidências.
 * Este braço mede o contrafactual "e se o app mandasse só o que mudou?" (P1/P2 da Onda 1).
 */
function freshOnly(readings, state) {
  const out = [];
  for (const r of readings) {
    const k = `${r.mac}|${r.stationId ?? ""}`;
    if (state.get(k) === r.rssi) continue; // cópia do último valor → informação ZERO
    state.set(k, r.rssi);
    out.push(r);
  }
  return out;
}

/**
 * Roda o associador REAL sobre o cenário, com o pool e a geometria de UM braço.
 * `only` = id da estação única (braços A/B) ou undefined (pool completo).
 * `stationsPx` = geometria por fonte (só nos braços de pool completo).
 */
function replay(sc, { only, cfg, stationPx, stationsPx, fresh }) {
  const assoc = new TagTrackAssociator(cfg);
  const ticks = [];
  const holdState = new Map();
  for (const tick of sc.ticks) {
    let readings = poolOf(tick.readings, only);
    if (fresh) readings = freshOnly(readings, holdState); // braço diagnóstico (ver freshOnly)
    if (readings.length === 0) continue; // produção pula o tick sem BLE (useTagFusion)
    assoc.push(buildFusionFrame(tick.tracks, readings, sc.H, tick.ts, stationPx, undefined, stationsPx));
    ticks.push({ ts: tick.ts, assignments: assoc.assign(tick.ts), truthTagByTrack: tick.truthTagByTrack });
  }
  return { ticks, metrics: computeIdentityMetrics(ticks) };
}

// ─────────────────────────── estatística honesta ───────────────────────────

/** Wilson 95% (z=1,96). n=0 → [0,1] (não sabemos nada, e dizemos isso). */
function wilson(k, n) {
  if (n === 0) return [0, 1];
  const z = 1.959963984540054;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
}

const pct = (x) => (100 * x).toFixed(1);
const ci = (k, n) => {
  const [lo, hi] = wilson(k, n);
  return `${pct(k / (n || 1))}% [${pct(lo)}–${pct(hi)}] n=${n}`;
};

/**
 * REGRA 8 — DEDUPLICAÇÃO ANTES DA ESTATÍSTICA. Colapsa, por trackId, corridas maximais de ticks
 * consecutivos com o MESMO veredito (mesmo rótulo, ou "abstenção") num ÚNICO episódio. É CONTAGEM,
 * não modelo: o associador re-emite a cada 500 ms uma decisão tirada de uma janela de 8 s — 16
 * ticks consecutivos idênticos são UMA decisão, não 16 evidências.
 * Devolve, por episódio: { trackId, tag, truth } — a base dos intervalos de Wilson.
 */
function dedupEpisodes(ticks, warmupMs = 8000) {
  const last = new Map(); // trackId → último veredito emitido
  const out = [];
  for (const t of ticks) {
    if (t.ts < warmupMs) continue;
    for (const a of t.assignments) {
      if (!(a.trackId in t.truthTagByTrack)) continue; // track fantasma
      const truth = t.truthTagByTrack[a.trackId];
      const key = `${a.tag ?? "∅"}|${truth ?? "∅"}`;
      if (last.get(a.trackId) === key) continue; // mesma decisão re-emitida → NÃO é evidência nova
      last.set(a.trackId, key);
      out.push({ trackId: a.trackId, tag: a.tag, truth });
    }
  }
  return out;
}

/** correct/wrong/opportunities sobre EPISÓDIOS deduplicados (a base honesta do Wilson). */
function tally(eps) {
  let correct = 0, wrong = 0, opportunities = 0;
  for (const e of eps) {
    if (e.truth !== null) {
      opportunities++;
      if (e.tag === e.truth) correct++;
      else if (e.tag !== null) wrong++;
    } else if (e.tag !== null) wrong++; // falso-rótulo em quem não tem tag: erro grave
  }
  return { correct, wrong, opportunities, spoke: correct + wrong };
}

/**
 * REGRA 13 — DADO INDEPENDENTE ≠ ERRO INDEPENDENTE.
 * Sobre as decisões (episódio-deduplicado, por (trackId, tag-verdade)) em que A e B FALARAM os
 * dois: quando A ERRA, com que frequência B comete o MESMO erro (o mesmo rótulo errado)?
 *
 * TETO MODEL-FREE de independência: se o rótulo de B fosse sorteado da PRÓPRIA distribuição
 * marginal de rótulos de B (mesma população de decisões), a coincidência esperada com o rótulo
 * errado de A seria Σ_d P̂_B(rótulo = L_A(d)) / N. Nenhum modelo do canal — só as marginais
 * OBSERVADAS. É o mesmo desenho do 8,8% que a doutrina cita.
 */
function agreementOnFailure(ticksA, ticksB, warmupMs = 8000) {
  // Alinha por (ts, trackId): as duas antenas decidem sobre os MESMOS ticks e as MESMAS pistas.
  const decOf = (ticks) => {
    const m = new Map();
    for (const t of ticks) {
      if (t.ts < warmupMs) continue;
      for (const a of t.assignments) {
        if (!(a.trackId in t.truthTagByTrack)) continue;
        m.set(`${t.ts}|${a.trackId}`, { tag: a.tag, truth: t.truthTagByTrack[a.trackId], trackId: a.trackId, ts: t.ts });
      }
    }
    return m;
  };
  const mA = decOf(ticksA);
  const mB = decOf(ticksB);

  // Dedup (Regra 8) no par: só conta quando o PAR (veredito de A, veredito de B) MUDA.
  const lastPair = new Map();
  const pairs = [];
  for (const [k, a] of mA) {
    const b = mB.get(k);
    if (!b) continue;
    const sig = `${a.tag ?? "∅"}|${b.tag ?? "∅"}|${a.truth ?? "∅"}`;
    if (lastPair.get(a.trackId) === sig) continue;
    lastPair.set(a.trackId, sig);
    pairs.push({ a, b });
  }

  const bothSpoke = pairs.filter((p) => p.a.tag !== null && p.b.tag !== null);
  const aWrong = bothSpoke.filter((p) => p.a.tag !== p.a.truth);
  const same = aWrong.filter((p) => p.b.tag === p.a.tag);

  // Marginal OBSERVADA de B (sobre as decisões em que B falou) — o teto model-free.
  const bLabels = bothSpoke.map((p) => p.b.tag);
  const freq = new Map();
  for (const l of bLabels) freq.set(l, (freq.get(l) ?? 0) + 1);
  const n = bLabels.length || 1;
  const ceiling = aWrong.length === 0 ? 0
    : aWrong.reduce((s, p) => s + (freq.get(p.a.tag) ?? 0) / n, 0) / aWrong.length;

  return { nPairs: pairs.length, nBothSpoke: bothSpoke.length, nAWrong: aWrong.length, nSame: same.length, ceiling };
}

// ─────────────────────────── o torneio ───────────────────────────

function runRegime(label, rssiPeriodTicks) {
  console.log(`\n${"═".repeat(100)}\nREGIME: ${label}  (rssiPeriodTicks=${rssiPeriodTicks} → Δt=${(rssiPeriodTicks * 0.5).toFixed(1)}s entre leituras FRESCAS)\n${"═".repeat(100)}`);

  const agg = { A: {}, B: {}, OFF: {}, ON: {}, "A~fresh": {}, "ON~fresh": {} };
  for (const k of Object.keys(agg)) agg[k] = { correct: 0, wrong: 0, opportunities: 0, conflict: 0, ticks: 0, epC: 0, epW: 0, epO: 0 };
  const failRows = [];

  console.log(
    ["cenário".padEnd(17), "braço".padEnd(9), "prec%", "cob%", "confl%", "certo", "errado", "absteve", "id-sw"].join("  "),
  );
  console.log("-".repeat(100));

  for (const s of SCENARIOS) {
    const sc = simulateFusionScenario({ ...s.opts, rssiPeriodTicks, stations: s.stations }, s.seed);
    const pxA = sc.stationsPx[s.stations[0].id];
    const pxAll = sc.stationsPx;

    const arms = {
      A: replay(sc, { only: s.stations[0].id, cfg: {}, stationPx: pxA }),
      B: replay(sc, { only: s.stations[1].id, cfg: {}, stationPx: sc.stationsPx[s.stations[1].id] }),
      OFF: replay(sc, { only: undefined, cfg: {}, stationPx: pxA, stationsPx: pxAll }),
      ON: replay(sc, { only: undefined, cfg: { multiSourceFisher: true }, stationPx: pxA, stationsPx: pxAll }),
      // EXPLORATÓRIOS (pós-hoc — fora da régua): sem o sample-and-hold (só leitura FRESCA).
      "A~fresh": replay(sc, { only: s.stations[0].id, cfg: {}, stationPx: pxA, fresh: true }),
      "ON~fresh": replay(sc, { only: undefined, cfg: { multiSourceFisher: true }, stationPx: pxA, stationsPx: pxAll, fresh: true }),
    };

    for (const [name, r] of Object.entries(arms)) {
      const m = r.metrics;
      console.log(
        [
          (name === "A" ? s.name : "").padEnd(17),
          name.padEnd(9),
          pct(m.precision).padStart(5),
          pct(m.coverage).padStart(5),
          pct(m.conflictRate).padStart(6),
          String(m.correct).padStart(5),
          String(m.wrong).padStart(6),
          String(m.abstained).padStart(7),
          String(m.idSwitches).padStart(5),
        ].join("  "),
      );
      const a = agg[name];
      a.correct += m.correct; a.wrong += m.wrong; a.opportunities += m.opportunities;
      a.conflict += m.conflictRate * m.ticksEvaluated; a.ticks += m.ticksEvaluated;
      const t = tally(dedupEpisodes(r.ticks));
      a.epC += t.correct; a.epW += t.wrong; a.epO += t.opportunities;
    }

    // R4 — Regra 13, ENTRE AS ESTAÇÕES.
    failRows.push({ name: s.name, ...agreementOnFailure(arms.A.ticks, arms.B.ticks) });
    console.log("-".repeat(100));
  }

  // ── AGREGADO + a régua ──
  const P = (a) => (a.correct + a.wrong === 0 ? 1 : a.correct / (a.correct + a.wrong));
  const C = (a) => (a.opportunities === 0 ? 0 : a.correct / a.opportunities);
  const K = (a) => (a.ticks === 0 ? 0 : a.conflict / a.ticks);

  console.log("\nAGREGADO (todos os cenários) — ponto no nível de TICK; Wilson sobre n DEDUPLICADO (Regra 8):");
  for (const name of ["A", "B", "OFF", "ON", "A~fresh", "ON~fresh"]) {
    const a = agg[name];
    console.log(
      `  ${name.padEnd(4)} precisão ${pct(P(a)).padStart(5)}%  cobertura ${pct(C(a)).padStart(5)}%  conflito ${pct(K(a)).padStart(5)}%` +
        `   │ dedup: precisão ${ci(a.epC, a.epC + a.epW)} · cobertura ${ci(a.epC, a.epO)}`,
    );
  }

  console.log("\nRÉGUA (pinada a priori):");
  const bestPrec = Math.max(P(agg.A), P(agg.B));
  const bestCov = Math.max(C(agg.A), C(agg.B));
  const bestConf = Math.min(K(agg.A), K(agg.B));
  const r1 = P(agg.ON) >= bestPrec - 1e-9;
  const r2 = C(agg.ON) >= 1.5 * bestCov - 1e-9;
  const r3 = K(agg.ON) <= 0.6 * bestConf + 1e-9;
  console.log(`  R1 precisão(A+B ON) ≥ max(A,B):     ${pct(P(agg.ON))}% vs ${pct(bestPrec)}%   → ${r1 ? "PASSA" : "FALHA"}`);
  console.log(`  R2 cobertura(A+B ON) ≥ 1,5× melhor: ${pct(C(agg.ON))}% vs ${pct(1.5 * bestCov)}%   → ${r2 ? "PASSA" : "FALHA"}`);
  console.log(`  R3 conflito(A+B ON) ≤ 0,6× melhor:  ${pct(K(agg.ON))}% vs ${pct(0.6 * bestConf)}%   → ${r3 ? "PASSA" : "FALHA"}`);
  console.log(`  VEREDITO DA PROMOÇÃO: ${r1 && r2 && r3 ? "PROMOVER" : "NÃO PROMOVER (régua a priori não satisfeita)"}`);

  console.log("\nO PREÇO DO align() (A+B com o knob OFF — o que a produção faria HOJE com o S24 no ar):");
  console.log(`  cobertura OFF ${pct(C(agg.OFF))}%  vs  A sozinha ${pct(C(agg.A))}%  → a 2ª antena rende ${pct(C(agg.OFF) - C(agg.A))} p.p. (o RSSI dela é descartado no empate de ts)`);

  console.log("\nR4 — REGRA 13: agreementOnFailure ENTRE AS ESTAÇÕES (quando A erra, B repete o MESMO erro?)");
  console.log("  cenário".padEnd(20) + "A errou (dedup)".padEnd(17) + "B repetiu".padEnd(11) + "concordância-no-erro [Wilson 95%]".padEnd(36) + "teto model-free");
  let tSame = 0, tWrong = 0, tCeilW = 0;
  for (const f of failRows) {
    const line = f.nAWrong === 0
      ? "— (A não errou com os dois falando)"
      : ci(f.nSame, f.nAWrong);
    console.log(`  ${f.name.padEnd(18)}${String(f.nAWrong).padEnd(17)}${String(f.nSame).padEnd(11)}${line.padEnd(36)}${pct(f.ceiling)}%`);
    tSame += f.nSame; tWrong += f.nAWrong; tCeilW += f.ceiling * f.nAWrong;
  }
  const ceilAgg = tWrong ? tCeilW / tWrong : 0;
  console.log(`  ${"TOTAL".padEnd(18)}${String(tWrong).padEnd(17)}${String(tSame).padEnd(11)}${ci(tSame, tWrong).padEnd(36)}${pct(ceilAgg)}%`);
  if (tWrong > 0) {
    const ratio = ceilAgg > 0 ? (tSame / tWrong) / ceilAgg : Infinity;
    console.log(`  ⇒ ${(tSame / tWrong * 100).toFixed(1)}% contra um teto de independência de ${pct(ceilAgg)}%  =  ${ratio.toFixed(1)}× acima.`);
    console.log(`  ⇒ A DISCORDÂNCIA pega ${(100 - (tSame / tWrong) * 100).toFixed(1)}% dos erros de A — é o que a agregação DE FATO compra.`);
    console.log(`  ⇒ "n_eff = n_A + n_B" é FALSO como evidência independente. Somar assim publica número errado.`);
  }
  console.log("  ⚠ PONTO CEGO (Regra 9): este simulador sorteia um ε INDEPENDENTE por estação e não");
  console.log("    tem mecanismo de erro compartilhado além da geometria — ele é ESTRUTURALMENTE INCAPAZ");
  console.log("    de reproduzir o 4,7×-acima-do-teto medido no CAMPO. Concordância ≈ teto aqui é uma");
  console.log("    PROPRIEDADE DO SIM, não evidência de independência no campo. Só o campo decide isto.");
  return { r1, r2, r3, P: P(agg.ON), C: C(agg.ON) };
}

console.log("TORNEIO DA 2ª ANTENA — H4 (multi-antena) · " + new Date().toISOString().slice(0, 10));
console.log("⚠ COBERTURA DE SIMULADOR (circular por construção — o sim gera o RSSI com o mesmo modelo");
console.log("  log-distância que o motor pressupõe). A 2ª antena NÃO EXISTE no campo. NÃO vender isto");
console.log("  como cobertura medida. O que é campo é o τ e a cadência da tag.");

runRegime("SIM default (1 Hz — 2,5× OTIMISTA vs a tag real)", 2);
runRegime("FÍSICA MEDIDA (tag real ~2,5 s)", REAL_TAG_PERIOD_TICKS);
