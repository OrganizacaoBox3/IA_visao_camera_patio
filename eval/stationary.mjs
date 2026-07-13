// ─────────────────────────────────────────────────────────────────────────────
// eval/stationary.mjs — SENSOR de PESSOA PARADA sob o GATE DE MOVIMENTO (dwell,
// ocupação e sobrevivência de id — docs/analises/spec-tracking-pessoa-parada §2
// C3 / F2). Roda no MESMO rito do torneio: npm run eval:counting (importado por
// counting.mjs); standalone: node eval/stationary.mjs.
//
// O BURACO QUE FECHA (auditado na spec §0): o eval/counting.mjs só tem TRAVESSIA
// e chama pipeline.processRound TODA rodada — nunca exercita o mecanismo central
// da queixa "o marcado some": o GATE DE MOVIMENTO pulando inferência em cena
// estática (probe a cada 6s) e a morte por TTL wall-clock entre probes. Aqui a
// decisão do gate é a de PRODUÇÃO (motion.gateDecision, módulo PURO, IMPORTADO)
// num laço fiel ao engine.gateAndDispatch: rodada PULADA não chama processRound
// (sem tracker.update, sem emissão) e rodada com pool saturado nem mede o gate
// (dispatchReady false — engine.js tick). Mudar ttl/estado-estacionário SEM esta
// suite era luz verde sem medir a falha.
//
// MÉTRICAS por cenário (sobre o PAYLOAD EMITIDO — o que o dashboard vê):
//   • occupancySurvivalPct — % das emissões DURANTE o dwell com people≥1 na zona
//     (a métrica-que-mata: zona VAZIA com pessoa presente = falso alerta);
//   • idSwitchesOfStationary — ids distintos emitidos no dwell − 1 (id novo =
//     dwell zera — spec §0.2);
//   • maxEmissionGapMs — maior buraco entre emissões no dwell (o interpolador do
//     front expira em 2600ms — buraco maior = caixa SOME com track VIVO, C1);
//   • ghostTimeMs — tempo entre a saída REAL e a 1ª emissão com 0 tracks (CA-2);
//   • firstVacantMs — quando a zona vira VAZIA com a pessoa AINDA lá (falha C2).
//
// ── RÉGUA DO TORNEIO (CA-8) — PINADA A PRIORI na F2 e APERTADA pela F3 (2026-07-13),
// ── que entregou o estado ESTACIONÁRIO no tracker. Mudança só é PROMOVIDA se:
//   1. occupancySurvivalPct = 100% em TODOS os cenários (a métrica-que-mata: zona
//      VAZIA com pessoa presente = falso alerta de ociosidade). Era 10% no cenário 4
//      e 90% no 6 (as duas falhas conhecidas da F2) — a F3 zerou as duas;
//   2. NENHUMA emissão VAZIA durante o dwell (firstVacantMs == null) — o mesmo em
//      outra forma: a pessoa parada NUNCA some da zona;
//   3. idSwitchesOfStationary = 0 em TODOS (era 1 no cenário 6: o track morria por
//      RELÓGIO e renascia com id novo → o dwell zerava);
//   4. ghostTimeMs ≤ PROBE_MS (anti-ghost: o carro-fantasma do Frigate não se
//      reproduz — quem SAI some em ≤ 1 probe);
//   5. maxEmissionGapMs ≤ PROBE_MS nos cenários sem atraso injetado;
//   6. ANTI-HIJACK (CA-4, cenário 7): a pessoa NOVA que entra no raio do parado NUNCA
//      herda o id dele — e o parado mantém o SEU id do início ao fim do dwell.
// Régua "só melhora": estes asserts são de SUCESSO (não mais baselines de falha).
// Regredir QUEBRA o build — que é o ponto: a F4 (alinhar o ttl do front) e qualquer
// mexida futura em knob de tracker passam por aqui.
//
// O QUE A F3 MUDOU (medido por este sensor, antes → depois):
//   • sentada com score < highScore SEM âncora: morria aos ~11,5s de dwell e a zona
//     ficava VAZIA o resto do tempo (ocupação 10%) → 100%, 1 id, zero emissão vazia.
//     Mecanismo: a HIPÓTESE DE PARADA na associação (det em cima da caixa CONGELADA,
//     não da PREDITA — a predição de caminhada extrapolada por 6s de probe fugia do
//     frame) + 2ª passada sustentando score baixo;
//   • 2 probes cegos: morte por RELÓGIO + ID NOVO na re-detecção (dwell zerava;
//     ocupação 90%) → 100%, 0 id-switch. Mecanismo: o estacionário morre por
//     EVIDÊNCIA (rodadas ANALISADAS sem match), com o TTL só como PISO;
//   • o que JÁ passava (dwell 10min, saída limpa, probe atrasado, score baixo com
//     âncora) segue passando — a F3 não pagou o conserto com regressão.
// PENDENTE (fora da F3): maxEmissionGapMs = 6000ms > expireMs 2600 do interpolador
// do front — o track está VIVO no hub e a caixa some do dashboard durante o skip.
// É o elo C1/F1 (re-emissão coasting), medido aqui e resolvido em pipeline.js.
//
// Knobs: DERIVADOS de precision.js (fonte ÚNICA — mesmos do eval/counting.mjs).
// Determinístico: now sintético (tick × ROUND_MS), zero Date.now() no caminho
// medido, nenhuma aleatoriedade. PASS exit 0, FAIL exit 1 (standalone).
// ─────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ROOT } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { createByteTracker } = require(path.join(ROOT, "server", "analysis", "bytetrack.js"));
const { createCounter } = require(path.join(ROOT, "server", "analysis", "counting.js"));
const { createPipeline } = require(path.join(ROOT, "server", "analysis", "pipeline.js"));
const { PRECISION, trackTtlMs } = require(path.join(ROOT, "server", "analysis", "precision.js"));
const { gateDecision } = require(path.join(ROOT, "server", "analysis", "motion.js"));

// ── Knobs: fonte ÚNICA = PRECISION (mesmo bloco do counting.mjs — deriva do painel) ──
const ROUND_MS = 500; // câmera analisada a 2fps (ANALYSIS_FPS_LINE) — knob de CUSTO, local
const PROBE_MS = PRECISION.gate.probeMs; // piso de probe do gate (nunca-cego)
const MOTION_THR = PRECISION.gate.motionRatio; // fração do thumbnail p/ "há movimento"
const KNOBS = {
  highScore: PRECISION.detector.highScore,
  trackerIou: PRECISION.tracker.iouThreshold,
  birthIouThreshold: PRECISION.tracker.birthIouThreshold,
  reassocDist: PRECISION.tracker.reassocDist,
  reassocMaxGapMs: PRECISION.tracker.reassocMaxGapMs,
  lostAfterMisses: PRECISION.tracker.lostAfterMisses,
  ttlMs: trackTtlMs({ roundMs: ROUND_MS, gateOn: true }), // gate LIGADO (é o objeto do sensor) → 8000
  // Estado ESTACIONÁRIO (F3 — precision.js 23-26): o objeto DESTE sensor. Sem passá-los,
  // o eval mediria os defaults internos do bytetrack.js em vez do painel (paridade frágil).
  stationaryTolerance: PRECISION.tracker.stationaryTolerance,
  stationaryEnterRounds: PRECISION.tracker.stationaryEnterRounds,
  stationaryMaxMisses: PRECISION.tracker.stationaryMaxMisses,
  stationaryMaxMs: PRECISION.tracker.stationaryMaxMs,
  minMove: PRECISION.counter.minMove,
  maxDist: PRECISION.counter.maxDist,
  debounceMs: PRECISION.counter.debounceMs,
  minCrossingFrames: PRECISION.counter.minCrossingFrames,
};

// Zona de atividade cobrindo o posto de trabalho: o dwell acontece DENTRO dela —
// people≥1 na zona é a ocupação. Pessoa parada em x=0.60/footY=0.5 → centro do
// bbox (0.60, 0.42), dentro do retângulo.
const ZONE = { id: "z1", label: "posto", atividade: "picking", x: 0.45, y: 0.3, w: 0.3, h: 0.3 };

const PERSON = { w: 0.06, h: 0.16 }; // mesma pessoa sintética do counting.mjs
const FOOT_Y = 0.5;
const STAND_X = 0.6; // o POSTO: onde o sujeito do dwell para (âncora das métricas de id)

/** Detecção como o worker devolve (espelho do det() de counting.mjs). */
function det(cx, footY, score) {
  return { class: "person", score, bbox: [cx - PERSON.w / 2, footY - PERSON.h, PERSON.w, PERSON.h] };
}

// ── Fases da cena: a VERDADE (pessoa presente/posição) separada da saída do
// DETECTOR (score, ou null = pessoa LÁ e o detector NÃO viu) — é exatamente o
// caso de campo "sentada com score fraco/intermitente" que mata o track hoje. ──
/** anda from→to em `steps` passos de x (steps+1 ticks), detectada a cada tick */
function walk(from, to, steps, o = {}) {
  const out = [];
  for (let k = 0; k <= steps; k++)
    out.push({ pos: { x: from + (k * (to - from)) / steps, y: o.footY ?? FOOT_Y }, score: o.score ?? 0.8 });
  return out;
}
/** parada em x por n ticks; score: número | (k)=>número|null (null = miss do detector —
 *  por isso `"score" in o`, e não `??`: null é um VALOR aqui, não ausência) */
function stand(x, n, o = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const s = typeof o.score === "function" ? o.score(k) : "score" in o ? o.score : 0.8;
    out.push({ pos: { x, y: o.footY ?? FOOT_Y }, score: s });
  }
  return out;
}
/** ausente por n ticks (saiu do enquadramento) */
function gone(n) {
  return new Array(n).fill({ pos: null, score: null });
}

/** concatena fases e registra MARCOS (índice do tick onde o próximo trecho começa) */
const mark = (name) => ({ __mark: name });
function timeline(...parts) {
  const ticks = [];
  const marks = {};
  for (const p of parts) {
    if (p.__mark) marks[p.__mark] = ticks.length;
    else ticks.push(...p);
  }
  return { ticks, marks };
}

/**
 * Cola uma 2ª PESSOA (lane B) sobre a timeline da 1ª, a partir do índice `at` — o
 * sujeito do dwell continua sendo A (as métricas são dela); B é o VIZINHO que entra
 * em cena. É o que permite medir o ANTI-HIJACK (CA-4) sob o gate REAL: B só existe
 * porque se MOVE, e é o movimento dela que faz o gate inferir.
 * @param {{ticks:object[],marks:object}} tl  timeline de A
 * @param {number} at  índice do tick em que B aparece
 * @param {Array<{x:number,score:number|null}>} bTicks  posição/score de B por tick
 */
function withNeighbor(tl, at, bTicks) {
  const ticks = tl.ticks.map((t) => ({ ...t }));
  bTicks.forEach((b, k) => {
    const i = at + k;
    if (i < ticks.length) ticks[i] = { ...ticks[i], neighbor: b };
  });
  return { ticks, marks: tl.marks };
}

// ── Laço FIEL ao engine (tick de ROUND_MS): pool ocupado → nem gate (dispatchReady
// false); senão mede o "movimento" (a cena mudou vs o último tick GATEADO — o
// prevLuma do engine atualiza TODO tick gateado, inclusive nos pulos) e decide com
// o motion.gateDecision de PRODUÇÃO. PULAR = NÃO chamar processRound (a economia
// real: sem tracker.update, sem emissão). INFERIR = lastInferAt := now (espelho de
// dispatchToWorker) + pipeline.processRound com as dets do detector naquele tick. ──
function runScenario(sc) {
  const tracker = createByteTracker({
    highScore: KNOBS.highScore,
    iouThreshold: KNOBS.trackerIou,
    birthIouThreshold: KNOBS.birthIouThreshold,
    ttlMs: KNOBS.ttlMs,
    reassocDist: KNOBS.reassocDist,
    reassocMaxGapMs: KNOBS.reassocMaxGapMs,
    lostAfterMisses: KNOBS.lostAfterMisses,
    stationaryTolerance: KNOBS.stationaryTolerance,
    stationaryEnterRounds: KNOBS.stationaryEnterRounds,
    stationaryMaxMisses: KNOBS.stationaryMaxMisses,
    stationaryMaxMs: KNOBS.stationaryMaxMs,
  });
  // Sem tripwire: aqui o KPI é OCUPAÇÃO (people na zona), não travessia.
  const counter = createCounter([], {
    minMove: KNOBS.minMove,
    ttl: KNOBS.ttlMs,
    maxDist: KNOBS.maxDist,
    debounceMs: KNOBS.debounceMs,
    minCrossingFrames: KNOBS.minCrossingFrames,
  });
  const st = {
    id: "cam-eval",
    tracker,
    counter,
    zonesAtiv: [ZONE],
    zonesExcl: [],
    autoMask: null,
    window: { frames: 0, zones: new Map() },
    rounds: [],
    detsLog: [],
  };
  const emitted = []; // {now, tracks, zones} — payload `analysis-tracks` por rodada ANALISADA
  const pipeline = createPipeline({
    highScore: KNOBS.highScore,
    ingest: () => Promise.resolve(),
    hasViewers: () => true,
    emitTracks: (p) => emitted.push({ now: p.ts, tracks: p.tracks, zones: p.zones }),
    cameraLabelOf: () => "cam-eval",
  });

  let lastInferAt = 0; // espelho de st.lastInferAt (engine.js — base do sinceMs do probe)
  let prevScene = null; // espelho de st.prevLuma (hasPrev + diff do thumbnail)
  const gate = { infer: 0, skip: 0, busy: 0 };
  sc.timeline.ticks.forEach((tk, i) => {
    const now = (i + 1) * ROUND_MS;
    if (sc.poolBusy && now >= sc.poolBusy.from && now <= sc.poolBusy.to) {
      gate.busy += 1; // pool saturado: a rodada nem é gateada (dispatchReady false)
      return;
    }
    // "Thumbnail" da cena = posição visível de QUEM está em cena (a pessoa do dwell +
    // o vizinho, quando houver). Alguém que se moveu/entrou/saiu muda ~2% do thumbnail
    // (bbox ≈1% do frame ≥ motionRatio 0.005); cena idêntica = 0. O SCORE do detector
    // NÃO é pixel: pessoa LÁ que o detector não vê (score null) NÃO muda a cena — é o
    // que separa "não vi" de "não estava", a base da morte por evidência.
    const scene =
      (tk.pos ? `${tk.pos.x},${tk.pos.y}` : "") + (tk.neighbor ? `|${tk.neighbor.x}` : "");
    const dec = gateDecision({
      ratio: scene === prevScene ? 0 : 0.02,
      sinceMs: now - lastInferAt,
      threshold: MOTION_THR,
      probeMs: PROBE_MS,
      hasPrev: prevScene !== null,
    });
    prevScene = scene;
    if (!dec.infer) {
      gate.skip += 1;
      return; // rodada PULADA: fiel à produção — nada roda, nada é emitido
    }
    lastInferAt = now;
    gate.infer += 1;
    const dets = [];
    if (tk.pos && tk.score != null) dets.push(det(tk.pos.x, tk.pos.y, tk.score));
    if (tk.neighbor && tk.neighbor.score != null)
      dets.push(det(tk.neighbor.x, tk.neighbor.y ?? FOOT_Y, tk.neighbor.score));
    pipeline.processRound(st, dets, now);
  });
  return { emitted, gate, marks: sc.timeline.marks, endMs: sc.timeline.ticks.length * ROUND_MS };
}

// ── Métricas do payload emitido (ver header) ─────────────────────────────────
function measure(res) {
  const nowOf = (i) => (i + 1) * ROUND_MS;
  const mk = res.marks;
  const dwellStartMs = nowOf(mk.dwellStart);
  const dwellEndMs = nowOf(mk.dwellEnd - 1); // último tick do dwell
  const inDwell = res.emitted.filter((e) => e.now >= dwellStartMs && e.now <= dwellEndMs);
  const peopleOf = (e) => (e.zones.length ? e.zones[0].people : 0);
  const occupied = inDwell.filter((e) => peopleOf(e) >= 1).length;
  // maxGap ancorado na última emissão ANTES do dwell (a chegada andando emite).
  let prev = res.emitted.filter((e) => e.now < dwellStartMs).map((e) => e.now).pop() ?? dwellStartMs;
  let maxEmissionGapMs = 0;
  for (const e of inDwell) {
    if (e.now - prev > maxEmissionGapMs) maxEmissionGapMs = e.now - prev;
    prev = e.now;
  }
  const vacant = inDwell.find((e) => peopleOf(e) === 0);
  const last = inDwell[inDwell.length - 1];
  let ghostTimeMs = null;
  let ghostCleared = null;
  if (mk.exit != null) {
    const exitMs = nowOf(mk.exit); // 1º tick em que a pessoa NÃO está mais na cena
    const clear = res.emitted.find((e) => e.now >= exitMs && e.tracks.length === 0);
    ghostCleared = !!clear;
    ghostTimeMs = (clear ? clear.now : res.endMs) - exitMs;
  }
  // Ids emitidos POR LUGAR (dentro do dwell): quem ficou parado em `x` teve 1 id só?
  // É o que separa "a pessoa parada manteve a IDENTIDADE" de "alguém herdou o id dela"
  // quando há DUAS pessoas em cena (cenário 7 — anti-hijack). Ancorar no LUGAR é o que
  // torna a métrica de id-switch do PARADO honesta: o vizinho tem os ids dele, no lugar
  // dele, e não polui a contagem do sujeito do dwell.
  const idsNear = (x, tol = 0.02) => {
    const s = new Set();
    for (const e of inDwell) for (const t of e.tracks) if (Math.abs(t.cx - x) <= tol) s.add(t.id);
    return s;
  };
  const idsOfStationary = idsNear(STAND_X);
  return {
    gate: res.gate,
    dwellEmissions: inDwell.length,
    occupancySurvivalPct: inDwell.length ? Math.round((occupied / inDwell.length) * 1000) / 10 : 0,
    idsOfDwell: idsOfStationary.size,
    idSwitchesOfStationary: Math.max(0, idsOfStationary.size - 1),
    maxEmissionGapMs,
    firstVacantMs: vacant ? vacant.now - dwellStartMs : null,
    endOccupied: last ? peopleOf(last) >= 1 : false,
    ghostTimeMs,
    ghostCleared,
    idsNear,
  };
}

// ── Cenários. Entrada comum: anda 0.30→0.60 (passo 0.03 — IoU consecutivo
// associável) e PARA no posto. checks() = régua pinada (falhas → strings);
// info() = números/contexto impressos sempre (a documentação da baseline). ──
const ENTER = walk(0.3, 0.6, 10); // t=500..5500; última observação andando em t=5500

// Probe ATRASADO do cenário 3: o 2º probe do dwell cai em P2 = 5500 + 2·PROBE_MS
// (a essa altura a velocidade do track já zerou na 1ª re-detecção parada); o pool
// fica ocupado até a próxima rodada analisada cair em P2 + 2·PROBE_MS = gap de
// 12s desde o último match (1,5× o TTL de 8s) — o cenário CA-3 da spec.
const P2 = 5500 + 2 * PROBE_MS;
const DELAYED = { from: P2 + PROBE_MS - ROUND_MS, to: P2 + 2 * PROBE_MS - 100 };

const SCENARIOS = [
  {
    name: "dwell longo 10min (probe re-detecta 0.8)",
    why: "a queixa-mãe (CA-1): pessoa PARADA 10min — UM id do início ao fim? ocupação contínua?",
    timeline: timeline(
      ENTER,
      mark("dwellStart"),
      stand(0.6, 1200), // 10min parada; só os probes (a cada 6s) re-detectam
      mark("dwellEnd"),
      walk(0.63, 0.93, 10),
      mark("exit"),
      gone(30),
    ),
    checks: (m) => [
      ...(m.idsOfDwell === 1 ? [] : [`id fragmentou no dwell: ${m.idsOfDwell} ids (régua: 1)`]),
      ...(m.occupancySurvivalPct >= 100 ? [] : [`ocupação caiu: ${m.occupancySurvivalPct}% (régua: 100%)`]),
      ...(m.maxEmissionGapMs <= PROBE_MS ? [] : [`buraco de emissão ${m.maxEmissionGapMs}ms > probe ${PROBE_MS}ms (régua: não sobe)`]),
      ...(m.ghostTimeMs <= PROBE_MS ? [] : [`ghost ${m.ghostTimeMs}ms > ${PROBE_MS}ms (régua: não sobe)`]),
    ],
    info: (m) => [
      `1 id do início ao fim, ocupação contínua: a queixa-mãe (CA-1) fecha do lado do TRACKER`,
      `RESIDUAL (fora do tracker): buraco de ${m.maxEmissionGapMs}ms entre emissões de INFERÊNCIA > ` +
        `expireMs 2600 do interpolador. Quem preenche é a re-emissão coasting do skip (C1/F1, em ` +
        `pipeline.emitCoasting) — este sensor mede só as rodadas ANALISADAS, por isso o buraco aparece aqui.`,
    ],
  },
  {
    name: "saída limpa (ghost-time)",
    why: "CA-2 (anti-ghost): pessoa sai — em quanto tempo a ocupação emitida zera?",
    timeline: timeline(
      ENTER,
      mark("dwellStart"),
      stand(0.6, 60), // 30s parada
      mark("dwellEnd"),
      walk(0.63, 0.93, 10), // sai andando (0.93 já está fora da zona)
      mark("exit"),
      gone(30),
    ),
    checks: (m) => [
      ...(m.idsOfDwell === 1 ? [] : [`id fragmentou no dwell: ${m.idsOfDwell} ids (régua: 1)`]),
      ...(m.occupancySurvivalPct >= 100 ? [] : [`ocupação caiu: ${m.occupancySurvivalPct}% (régua: 100%)`]),
      ...(m.ghostCleared ? [] : [`ocupação NUNCA zerou após a saída (ghost ≥ ${m.ghostTimeMs}ms)`]),
      ...(m.ghostTimeMs <= PROBE_MS ? [] : [`ghost ${m.ghostTimeMs}ms > ${PROBE_MS}ms (régua: não sobe — anti carro-fantasma)`]),
    ],
    info: (m) => [
      `ghost hoje = ${m.ghostTimeMs}ms (1 emissão de graça no tick da saída + o probe seguinte zera)`,
    ],
  },
  {
    name: "probe atrasado 12s (pool saturado, re-detecção 0.8)",
    why: "CA-3: a rodada analisada salta p/ 12s (1,5× o ttl de 8s) com a pessoa lá — sobrevive?",
    timeline: timeline(ENTER, mark("dwellStart"), stand(0.6, 120), mark("dwellEnd")),
    poolBusy: DELAYED,
    checks: (m) => [
      // Sensor exercitou o atraso? (senão o cenário está medindo outra coisa)
      ...(m.maxEmissionGapMs >= 2 * PROBE_MS ? [] : [`atraso NÃO exercitado: maxGap ${m.maxEmissionGapMs}ms < ${2 * PROBE_MS}ms`]),
      ...(m.idsOfDwell === 1 ? [] : [`id trocou no probe atrasado: ${m.idsOfDwell} ids (régua: 1)`]),
      ...(m.occupancySurvivalPct >= 100 ? [] : [`ocupação caiu: ${m.occupancySurvivalPct}% (régua: 100%)`]),
    ],
    info: () => [
      `Já sobrevivia na F2 (refuta o "morre aos 8s" da spec §0.2 p/ ESTE caso: o TTL só executa DENTRO`,
      `de update() e a associação roda ANTES da poda) — a morte real exigia det FRACA/AUSENTE na rodada`,
      `analisada (cenários 4 e 6). A F3 fecha isso por CONSTRUÇÃO: o parado não tem mais relógio de morte.`,
    ],
  },
  {
    name: "senta e o score cai p/ [0.25,0.35) sem âncora",
    why: "campo: sentou e o detector só dá 0.26-0.33 — a 2ª passada deveria sustentar (CA-6)",
    timeline: timeline(
      ENTER,
      mark("dwellStart"),
      stand(0.6, 120, { score: (k) => (k % 2 ? 0.26 : 0.33) }), // 60s sentada, score sempre < highScore
      mark("dwellEnd"),
    ),
    // CONSERTADO NA F3 (era a falha nº1 da F2: morria aos ~11,5s de dwell e a zona
    // ficava VAZIA com a pessoa SENTADA lá — ocupação 10%). A predição envelhecida
    // (v de caminhada × 6s de probe) zerava o IoU e a det BAIXA não aciona 2º estágio
    // nem guarda de nascimento → 2 probes sem match → o TTL matava. Agora a HIPÓTESE DE
    // PARADA casa a det baixa com a caixa CONGELADA (2ª passada sustenta) → 100%.
    checks: (m) => [
      ...(m.occupancySurvivalPct >= 100 ? [] : [`ocupação caiu: ${m.occupancySurvivalPct}% (régua: 100%)`]),
      ...(m.idsOfDwell === 1 ? [] : [`id fragmentou no dwell: ${m.idsOfDwell} ids (régua: 1)`]),
      ...(m.firstVacantMs == null
        ? []
        : [`zona VAZIA com a pessoa sentada lá, aos ${m.firstVacantMs}ms (régua: nunca)`]),
    ],
    info: () => [
      `F3: a 2ª passada casa a det fraca com a caixa CONGELADA (a PREDITA já tinha saído do frame)`,
    ],
  },
  {
    name: "score [0.25,0.35) com âncora (1 probe alto antes)",
    why: "CA-6 (regressão): com v=0 ancorada por UMA re-detecção alta, a 2ª passada sustenta",
    timeline: timeline(
      ENTER,
      mark("dwellStart"),
      stand(0.6, 12, { score: 0.8 }), // o 1º probe do dwell re-detecta alto (zera a velocidade)
      stand(0.6, 108, { score: (k) => (k % 2 ? 0.26 : 0.33) }), // daí em diante só score baixo
      mark("dwellEnd"),
    ),
    checks: (m) => [
      ...(m.idsOfDwell === 1 ? [] : [`id fragmentou: ${m.idsOfDwell} ids (régua: 1)`]),
      ...(m.occupancySurvivalPct >= 100 ? [] : [`2ª passada NÃO sustentou: ocupação ${m.occupancySurvivalPct}% (régua: 100%)`]),
    ],
    info: () => [
      `JÁ VALE HOJE (vira regressão explícita): predita = observada (v=0) → IoU 1.0 → score baixo sustenta`,
    ],
  },
  {
    name: "2 probes cegos (det some) e re-detecta 0.8",
    why: "spec §0.2: ~2 probes sem detecção matam o track parado — id NOVO na volta, dwell zera",
    timeline: timeline(
      ENTER,
      mark("dwellStart"),
      stand(0.6, 31, { score: 0.8 }), // probes de t=11.5s e 17.5s re-detectam
      stand(0.6, 23, { score: null }), // pessoa LÁ, detector cego nos probes de 23.5s e 29.5s
      stand(0.6, 66, { score: 0.8 }), // volta a detectar do probe de 35.5s em diante
      mark("dwellEnd"),
    ),
    // CONSERTADO NA F3 (era a falha nº2 da F2: o 2º probe cego excedia o TTL — 12s >
    // 8s — e matava por RELÓGIO com a pessoa LÁ; a re-detecção nascia com ID NOVO, o
    // dwell zerava e a zona teve 1 emissão VAZIA no meio). Agora o estacionário morre
    // por EVIDÊNCIA (2 misses ≤ stationaryMaxMisses 3) e segue EMITIDO — o relógio só
    // conta como PISO, e a re-detecção volta ao MESMO id.
    checks: (m) => [
      ...(m.idSwitchesOfStationary === 0
        ? []
        : [`id-switch no dwell: ${m.idSwitchesOfStationary} (régua: 0 — o dwell não pode zerar)`]),
      ...(m.occupancySurvivalPct >= 100 ? [] : [`ocupação caiu: ${m.occupancySurvivalPct}% (régua: 100%)`]),
      ...(m.firstVacantMs == null
        ? []
        : [`zona VAZIA com a pessoa parada lá, aos ${m.firstVacantMs}ms (régua: nunca)`]),
      ...(m.endOccupied ? [] : [`re-detecção alta não recuperou a ocupação ao fim do dwell`]),
    ],
    info: () => [
      `F3: 2 probes cegos são 2 misses (≤ 3) — o parado sobrevive, segue emitido e re-associa no MESMO id`,
    ],
  },
  {
    name: "vizinho NASCE no raio do parado (anti-hijack)",
    why: "CA-4 (sentinela): B aparece a 0.12 de A PARADA, na rodada em que o detector está cego em A — B herda o id de A?",
    // A chega, para no posto (0.60) e vira ESTACIONÁRIA (probes de 11,5s e 17,5s). Na
    // rodada seguinte o detector fica CEGO em A (alguém passou na frente) e B APARECE
    // pela 1ª vez a 0.12 dela (0.72) — atrás de um rack até agora. É a receita EXATA do
    // hijack: track sem par (A), det ALTA sem par (B), gap curto (500ms ≤ 2500) e
    // distância DENTRO do raio (0.12 ≤ folga 0.12 + |v|·gap, com |v| de A = 0). Sem a
    // exclusão do estacionário do 2º estágio, o track de A re-associa com a det de B:
    // B nunca ganha id próprio, a caixa de A é ARRASTADA p/ cima dela e, quando A
    // reaparece no posto, nasce com id NOVO (o dwell dela zera). A caixa da pessoa
    // PARADA some justamente por ela estar parada — e o ímã cresce com a persistência
    // que esta frente adicionou. Esta é a sentinela desse custo.
    timeline: withNeighbor(
      timeline(
        ENTER,
        mark("dwellStart"),
        stand(0.6, 24, { score: 0.8 }), // probes de 11,5s e 17,5s → A vira ESTACIONÁRIA
        mark("neighbor"),
        stand(0.6, 2, { score: null }), // detector CEGO em A na rodada em que B aparece
        stand(0.6, 40, { score: 0.8 }), // A volta a ser detectada no posto
        mark("dwellEnd"),
      ),
      11 + 24, // índice do 1º tick de B (= o marco "neighbor")
      new Array(42).fill({ x: 0.72, score: 0.8 }), // B surge colada em A e fica lá
    ),
    checks: (m) => {
      const a = m.idsNear(0.6); // ids emitidos NO POSTO (onde A está parada)
      const b = m.idsNear(0.72); // ids emitidos onde B parou
      const shared = [...a].filter((id) => b.has(id));
      return [
        ...(a.size === 1 ? [] : [`A (parada) fragmentou: ${a.size} ids no posto (régua: 1)`]),
        ...(b.size === 1 ? [] : [`B fragmentou: ${b.size} ids (régua: 1)`]),
        ...(shared.length === 0 ? [] : [`HIJACK: id ${shared.join(",")} apareceu nos DOIS lugares`]),
        ...(m.occupancySurvivalPct >= 100 ? [] : [`ocupação caiu: ${m.occupancySurvivalPct}% (régua: 100%)`]),
        ...(m.firstVacantMs == null ? [] : [`zona VAZIA com A parada lá, aos ${m.firstVacantMs}ms (régua: nunca)`]),
      ];
    },
    info: (m) => [
      `A manteve ${m.idsNear(0.6).size} id no posto; B nasceu com id próprio (${m.idsNear(0.72).size}) — ` +
        `estacionário FORA do 2º estágio (não é herdável)`,
    ],
  },
];

/** Roda a suite inteira; imprime o relatório; retorna o nº de cenários reprovados. */
export function runStationarySuite() {
  console.log(
    `\n[eval/stationary] Sensor pessoa-parada — gate de movimento REAL (motion.gateDecision) + pipeline de produção`,
  );
  console.log(
    `  knobs: ${ROUND_MS}ms/rodada · probe ${PROBE_MS}ms · ttl ${KNOBS.ttlMs}ms · motionRatio ${MOTION_THR} · ` +
      `highScore ${KNOBS.highScore} · lost ${KNOBS.lostAfterMisses} · reassoc ${KNOBS.reassocDist}/${KNOBS.reassocMaxGapMs}ms\n`,
  );
  let failed = 0;
  const w0 = Math.max(...SCENARIOS.map((s) => s.name.length));
  for (const sc of SCENARIOS) {
    const m = measure(runScenario(sc));
    const fails = sc.checks(m);
    // Sanidade do harness: o cenário PRECISA ter exercitado o gate (rodadas puladas).
    if (m.gate.skip === 0) fails.push(`o cenário não exercitou o gate (0 rodadas puladas)`);
    if (fails.length) failed += 1;
    console.log(`  ${sc.name.padEnd(w0)}  ${fails.length ? "FALHOU  ←" : "OK"}`);
    const skipPct = Math.round((m.gate.skip / (m.gate.infer + m.gate.skip)) * 100);
    console.log(
      `  ${" ".repeat(w0)}  · gate: ${m.gate.infer} inferidas / ${m.gate.skip} puladas` +
        `${m.gate.busy ? ` / ${m.gate.busy} pool-ocupado` : ""} (${skipPct}% de economia)`,
    );
    console.log(
      `  ${" ".repeat(w0)}  · dwell: ocupação ${m.occupancySurvivalPct}% (${m.dwellEmissions} emissões) · ` +
        `${m.idsOfDwell} id(s), ${m.idSwitchesOfStationary} switch(es) · maxGap ${m.maxEmissionGapMs}ms` +
        `${m.firstVacantMs != null ? ` · 1ª emissão VAZIA aos ${m.firstVacantMs}ms` : ""}`,
    );
    if (m.ghostTimeMs != null)
      console.log(`  ${" ".repeat(w0)}  · saída: ghost ${m.ghostTimeMs}ms (zerou: ${m.ghostCleared ? "sim" : "NÃO"})`);
    for (const line of sc.info(m)) console.log(`  ${" ".repeat(w0)}  · ${line}`);
    for (const f of fails) console.log(`  ${" ".repeat(w0)}  ✗ ${f}`);
    if (fails.length) console.log(`  ${" ".repeat(w0)}  (${sc.why})`);
  }
  if (failed)
    console.error(
      `\n[eval/stationary] FALHOU: ${failed} de ${SCENARIOS.length} cenário(s) fora da régua pinada (CA-8).` +
        `\n       Mudou knob/política de tracker? A régua diz que estacionário NÃO pode piorar — ver header.`,
    );
  else
    console.log(
      `\n[eval/stationary] OK — ${SCENARIOS.length} cenários estacionários dentro da régua (baselines das falhas conhecidas documentadas acima).`,
    );
  return failed;
}

// Standalone: node eval/stationary.mjs (no rito oficial roda via counting.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runStationarySuite() ? 1 : 0);
}
