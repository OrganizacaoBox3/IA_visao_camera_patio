// ─────────────────────────────────────────────────────────────────────────────
// eval/counting.mjs — SENSOR FIM-A-FIM da CONTAGEM (o KPI) e do TRACKING
// EMITIDO: travessias esperadas × contadas E payload `analysis-tracks` sadio,
// no pipeline REAL dets → pipeline.processRound → ByteTrack → tripwire.
//
// O que mede: os MÓDULOS DE PRODUÇÃO server/analysis/pipeline.js (processRound —
// o MESMO caminho por rodada do motor: filtro de classe → exclusão/automask
// (no-op aqui) → tracking → contagem → ingest "flow" → montagem do payload
// `analysis-tracks`), bytetrack.js e counting.js (importados, nada
// reimplementado), alimentados por sequências DETERMINÍSTICAS de detecções
// sintéticas com nº de travessias CONHECIDO. Cada cenário exercita um mecanismo
// que decide contagem no campo: nascimento por score alto, sustain por score
// baixo (2ª passada), sobrevivência a detecção intermitente (TTL), histerese de
// 2 rodadas, filtro de micro-jitter (minMove) e teleporte (id novo).
//
// SENSORES DO FIX-RASTRO (docs/analises/fix-rastro-tracking.md) — o CONTRATO do
// stream que SALTA, medido no PAYLOAD EMITIDO (o que o front desenha):
//   • salto moderado (gap ≤2.5s, deslocamento ≈ vx·dt) → MESMO id, travessia conta;
//   • salto extremo → id novo é OK, mas NUNCA >1 track emitido p/ 1 pessoa;
//   • oclusão longa → o track antigo SOME do payload em ≤2 rodadas (estado LOST
//     não-emitido), em vez de coastar congelado até o TTL (~8s de "máscara fantasma").
// Contra o código PRÉ-FIX esses asserts FALHAM de propósito (prova de
// sensibilidade do sensor); ficam verdes quando o fix do tracker aterrissar.
//
// O que NÃO mede (fronteira honesta): o recall do DETECTOR (sensor: gate.mjs/
// run-eval.mjs) e travessias em vídeo real (replay de campo — extensão prevista
// em docs/analises/acuracia-modelos.md §3/Onda 2; bancada VISUAL do salto:
// scripts/make-jumpy-clip.mjs).
//
// Knobs: DERIVADOS de server/analysis/precision.js (fonte ÚNICA — o MESMO painel
// que a produção resolve) + o MESMO trackTtlMs(). Cadência (roundMs) fica local
// (knob de CUSTO, fora do painel — ANALYSIS_FPS_LINE=2). Fixos (sem env): sensor
// determinístico. NÃO copie valores à mão — mudou o painel, o sensor segue junto.
//
// Uso: npm run eval:counting  (ou node eval/counting.mjs) — PASS exit 0, FAIL exit 1.
// ─────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { createByteTracker } = require(path.join(ROOT, "server", "analysis", "bytetrack.js"));
const { createCounter } = require(path.join(ROOT, "server", "analysis", "counting.js"));
const { createPipeline } = require(path.join(ROOT, "server", "analysis", "pipeline.js"));
const { PRECISION, trackTtlMs } = require(path.join(ROOT, "server", "analysis", "precision.js"));

// ── Knobs: fonte ÚNICA = PRECISION (o MESMO que engine.js createState injeta) ─
// Antes eram literais espelhados à mão e OMITIAM reassoc/LOST — o sensor só
// COINCIDIA com produção pelos defaults internos do bytetrack.js (paridade frágil).
// Agora deriva do painel: mudou o knob lá → o sensor segue. (docs/analises/saude/01-*.)
const ROUND_MS = 500; // câmera COM tripwire roda a ANALYSIS_FPS_LINE=2 (recall×cadência) — knob de CUSTO, local
const KNOBS = {
  roundMs: ROUND_MS,
  highScore: PRECISION.detector.highScore, // nascimento de track / 1ª passada
  trackerIou: PRECISION.tracker.iouThreshold, // associação det×track
  birthIouThreshold: PRECISION.tracker.birthIouThreshold, // guarda de nascimento
  reassocDist: PRECISION.tracker.reassocDist, // re-associação 2º estágio (anti-rastro/salto) — knob 20
  reassocMaxGapMs: PRECISION.tracker.reassocMaxGapMs, // gap máx. do 2º estágio — knob 21
  lostAfterMisses: PRECISION.tracker.lostAfterMisses, // política LOST (anti-rastro) — knob 22
  ttlMs: trackTtlMs({ roundMs: ROUND_MS, gateOn: true }), // = produção (gate ligado → max(1500,1750,8000)=8000)
  minMove: PRECISION.counter.minMove, // filtro de micro-jitter do counter
  maxDist: PRECISION.counter.maxDist, // gate de teleporte do counter
  debounceMs: PRECISION.counter.debounceMs,
  minCrossingFrames: PRECISION.counter.minCrossingFrames, // histerese: lado novo sustentado 2 rodadas
};

// Tripwire vertical no meio do frame, seta a→b p/ CIMA → esquerda→direita = "in".
const WIRE = { id: "porta", a: { x: 0.5, y: 0.8 }, b: { x: 0.5, y: 0.2 } };

// ── Geradores determinísticos de detecções ("pessoa" sintética) ──────────────
const PERSON = { w: 0.06, h: 0.16 }; // bbox normalizada; foot = bottom-center (âncora do julgamento)

/** Detecção como o worker devolve: {class,score,bbox:[x,y,w,h]} norm. (o filtro de
 *  classe agora roda DENTRO do pipeline de produção — por isso `class` vai junto). */
function det(cx, footY, score) {
  return { class: "person", score, bbox: [cx - PERSON.w / 2, footY - PERSON.h, PERSON.w, PERSON.h] };
}

/** steps+1 posições lineares from→to (passo constante; nunca cai exatamente na linha). */
function xsLinear(from, to, steps) {
  const out = [];
  for (let k = 0; k <= steps; k++) out.push(from + (k * (to - from)) / steps);
  return out;
}

/**
 * Uma "pessoa" como lane: 1 entrada por rodada (null = não detectada naquela rodada).
 * @param {Array<number|null>} xs posição x do pé por rodada (null = miss)
 * @param {{ footY?: number, score?: number|((k:number)=>number), delay?: number }} [o]
 */
function lane(xs, o = {}) {
  const footY = o.footY ?? 0.5;
  const out = new Array(o.delay ?? 0).fill(null);
  xs.forEach((x, k) => {
    if (x == null) out.push(null);
    else out.push(det(x, footY, typeof o.score === "function" ? o.score(k) : (o.score ?? 0.8)));
  });
  return out;
}

/** Junta lanes em rodadas: rodada r = dets de todas as lanes presentes em r. */
function rounds(...lanes) {
  const n = Math.max(...lanes.map((l) => l.length));
  const out = [];
  for (let r = 0; r < n; r++) out.push(lanes.map((l) => l[r]).filter(Boolean));
  return out;
}

const WALK = xsLinear(0.3, 0.72, 14); // passo 0.03/rodada — IoU consecutivo 0.33 ≥ 0.25 (associável)
const WALK_BACK = xsLinear(0.69, 0.27, 14);

// ── Cenários: travessias CONHECIDAS → contagem esperada ──────────────────────
const SCENARIOS = [
  {
    name: "travessia única L→R",
    why: "caso-base do KPI: 1 pessoa cruza uma vez",
    rounds: rounds(lane(WALK)),
    expected: { in: 1, out: 0 },
  },
  {
    name: "ida e volta",
    why: "as duas direções do mesmo track (debounce não engole a volta 7s depois)",
    rounds: rounds(lane([...WALK, ...WALK_BACK])),
    expected: { in: 1, out: 1 },
  },
  {
    name: "cruzamento simultâneo em direções opostas",
    why: "2 pessoas na mesma rodada não trocam id nem contagem (matching guloso)",
    rounds: rounds(lane(WALK, { footY: 0.35 }), lane(WALK_BACK, { footY: 0.65 })),
    expected: { in: 1, out: 1 },
  },
  {
    name: "multidão escalonada (4 pessoas L→R)",
    why: "contagem N-para-N com entradas defasadas (3 rodadas entre pessoas)",
    rounds: rounds(
      lane(WALK, { footY: 0.26 }),
      lane(WALK, { footY: 0.42, delay: 3 }),
      lane(WALK, { footY: 0.58, delay: 6 }),
      lane(WALK, { footY: 0.74, delay: 9 }),
    ),
    expected: { in: 4, out: 0 },
  },
  {
    name: "detecção intermitente (miss rodada sim, rodada não)",
    why: "recall imperfeito: predição linear + TTL seguram o id e a travessia conta",
    rounds: rounds(
      // detectada em k=0,1 (aprende velocidade) e depois só nas rodadas ímpares
      lane(xsLinear(0.31, 0.63, 16).map((x, k) => (k <= 1 || k % 2 === 1 ? x : null))),
    ),
    expected: { in: 1, out: 0 },
  },
  {
    name: "score cai p/ 0.30 durante a travessia",
    why: "2ª passada do ByteTrack: score baixo SUSTENTA o track e a contagem sai",
    rounds: rounds(lane(WALK, { score: (k) => (k < 2 ? 0.8 : 0.3) })),
    expected: { in: 1, out: 0 },
  },
  {
    name: "score sempre 0.30 (nunca nasce)",
    why: "nascimento exige ≥ highScore: sem track não há contagem (piso do KPI)",
    rounds: rounds(lane(WALK, { score: 0.3 })),
    expected: { in: 0, out: 0 },
  },
  {
    name: "micro-jitter sobre a linha",
    why: "bbox oscilando ±0.008 (< minMove) sobre a linha não conta nada",
    rounds: rounds(lane([0.4, 0.43, 0.46, 0.475, 0.496, 0.504, 0.496, 0.504, 0.496, 0.504, 0.496])),
    expected: { in: 0, out: 0 },
  },
  {
    name: "teleporte por cima da linha",
    why: "salto 0.40 vira id novo (guarda de nascimento) e re-âncora — nada conta",
    rounds: rounds(lane([0.3, 0.3, 0.3, 0.3, 0.7, 0.7, 0.7, 0.7])),
    expected: { in: 0, out: 0 },
  },

  // ── Sensores do FIX-RASTRO (stream que salta) — ver header e o doc ──────────
  {
    name: "salto moderado (stream engasga ≤2.5s)",
    why: "contrato: gap com deslocamento ≈ vx·dt mantém o MESMO id e a travessia conta",
    // Caminhada linear 0.30→0.72 (passo 0.03/rodada) com dois engasgos de stream:
    // dets em k=0,1 (aprende velocidade), GAP 1.5s (k=2,3), det k=4, GAP 2.5s
    // (k=5..8), det k=9 (já do outro lado da linha: 0.42→0.57 cruza no gap) e
    // k=10..14 contínuos (sustentam a histerese). Deslocamento SEMPRE ≈ vx·dt.
    rounds: rounds(
      lane(xsLinear(0.3, 0.72, 14).map((x, k) => ([2, 3, 5, 6, 7, 8].includes(k) ? null : x))),
    ),
    expected: { in: 1, out: 0 },
    tracking: { distinctIds: 1 }, // 1 pessoa = 1 id no payload do cenário inteiro
  },
  {
    name: "salto extremo 3× (não vira rastro)",
    why: "1 pessoa teleportando: id novo é OK, mas NUNCA >1 track emitido por rodada",
    // 1 pessoa que salta 3× (0.20→0.60→0.25→0.65, saltos de 0.35-0.40 — acima de
    // maxDist e sem IoU com a predição), parada 4 rodadas em cada ponto. Pré-fix,
    // cada salto deixa o track velho coastando até o TTL (8s) → 2..4 "máscaras"
    // emitidas ao mesmo tempo para UMA pessoa (o rastro do bug de campo).
    rounds: rounds(
      lane([0.2, 0.2, 0.2, 0.2, 0.6, 0.6, 0.6, 0.6, 0.25, 0.25, 0.25, 0.25, 0.65, 0.65, 0.65, 0.65]),
    ),
    expected: { in: 0, out: 0 },
    tracking: { maxSimultaneous: 1 }, // é UMA pessoa: nunca >1 track no payload
  },
  {
    name: "oclusão longa (5s) e reaparece longe",
    why: "id novo é OK; o track antigo some do payload em ≤2 rodadas (LOST não-emitido)",
    // Anda 0.30→0.42 (k=0..4), SOME por 10 rodadas (5s) e reaparece LONGE
    // (x=0.25, pé em y=0.75 — sem IoU com observado nem predito) andando de novo.
    // Pré-fix, o track antigo é emitido congelado em 0.42 até o TTL (16 rodadas).
    rounds: rounds(
      lane(xsLinear(0.3, 0.42, 4)),
      lane(xsLinear(0.25, 0.37, 4), { footY: 0.75, delay: 15 }),
    ),
    expected: { in: 0, out: 0 },
    // ids emitidos até a rodada 4 (o track antigo) não podem aparecer após a rodada 4+2.
    tracking: { ghost: { vanishRound: 4, graceRounds: 2 } },
  },
];

// ── Rodadas via pipeline.processRound de PRODUÇÃO (o wiring do motor inteiro:
// filtro de classe → exclusão/automask (vazios) → tracker → counter → ingest →
// montagem do payload `analysis-tracks`). O que capturamos em `emitted` é
// EXATAMENTE o que o dashboard receberia — onde quer que o fix filtre o LOST
// (tracker ou pipeline), este sensor mede o resultado. ──────────────────────────
function runScenario(sc) {
  const tracker = createByteTracker({
    highScore: KNOBS.highScore,
    iouThreshold: KNOBS.trackerIou,
    birthIouThreshold: KNOBS.birthIouThreshold,
    ttlMs: KNOBS.ttlMs,
    reassocDist: KNOBS.reassocDist, // sem estes 3, o 2º estágio/LOST caíam nos defaults internos
    reassocMaxGapMs: KNOBS.reassocMaxGapMs, // do bytetrack.js — o sensor mediria outro tracker
    lostAfterMisses: KNOBS.lostAfterMisses, // se o painel mudasse (espelha engine.js:227-237)
  });
  const counter = createCounter([WIRE], {
    minMove: KNOBS.minMove,
    ttl: KNOBS.ttlMs,
    maxDist: KNOBS.maxDist,
    debounceMs: KNOBS.debounceMs,
    minCrossingFrames: KNOBS.minCrossingFrames,
  });
  // Estado mínimo por câmera — espelho dos campos de engine.js createState que o
  // pipeline toca (zonas vazias e autoMask null = caminho neutro).
  const st = {
    id: "cam-eval",
    tracker,
    counter,
    zonesAtiv: [],
    zonesExcl: [],
    autoMask: null,
    window: { frames: 0, zones: new Map() },
    rounds: [],
    detsLog: [],
  };
  const flows = []; // eventos "flow"/"cross" ingeridos (metadado persistido)
  const emitted = []; // emitted[r] = tracks do payload `analysis-tracks` da rodada r
  const pipeline = createPipeline({
    highScore: KNOBS.highScore,
    ingest: (kind, _sub, payload) => {
      if (kind === "flow") flows.push(payload);
      return Promise.resolve();
    },
    hasViewers: () => true, // sempre montar o payload — é o objeto do sensor
    emitTracks: (p) => emitted.push(p.tracks),
    cameraLabelOf: () => "cam-eval",
  });
  let now = 0;
  for (const dets of sc.rounds) {
    now += KNOBS.roundMs;
    pipeline.processRound(st, dets, now);
  }
  return { totals: counter.totals(), flows, emitted };
}

// ── Checagens do payload emitido (cenários com `tracking`) ───────────────────
function trackingReport(tr, emitted) {
  const fails = [];
  const info = [];
  const allIds = new Set();
  let maxSim = 0;
  let maxSimRound = -1;
  emitted.forEach((tracks, r) => {
    if (tracks.length > maxSim) {
      maxSim = tracks.length;
      maxSimRound = r;
    }
    for (const t of tracks) allIds.add(t.id);
  });
  if (tr.distinctIds != null) {
    info.push(`ids distintos emitidos: ${allIds.size} (contrato: ${tr.distinctIds})`);
    if (allIds.size !== tr.distinctIds)
      fails.push(
        `fragmentou o id: ${allIds.size} ids distintos no payload — salto moderado deve manter o MESMO id (${tr.distinctIds})`,
      );
  }
  if (tr.maxSimultaneous != null) {
    info.push(`máx tracks simultâneos emitidos: ${maxSim} (teto: ${tr.maxSimultaneous})`);
    if (maxSim > tr.maxSimultaneous)
      fails.push(
        `RASTRO: ${maxSim} tracks emitidos na MESMA rodada (r${maxSimRound}) para 1 pessoa (teto ${tr.maxSimultaneous})`,
      );
  }
  if (tr.ghost) {
    const { vanishRound, graceRounds } = tr.ghost;
    const oldIds = new Set();
    for (let r = 0; r <= vanishRound && r < emitted.length; r++)
      for (const t of emitted[r]) oldIds.add(t.id);
    let lastGhost = -1;
    for (let r = vanishRound + graceRounds + 1; r < emitted.length; r++)
      if (emitted[r].some((t) => oldIds.has(t.id))) lastGhost = r;
    info.push(
      lastGhost < 0
        ? `track antigo saiu do payload até a rodada ${vanishRound + graceRounds} (ok)`
        : `track antigo AINDA emitido na rodada ${lastGhost} (limite: ${vanishRound + graceRounds})`,
    );
    if (lastGhost >= 0)
      fails.push(
        `RASTRO: track que sumiu na rodada ${vanishRound} seguiu emitido até a rodada ${lastGhost} ` +
          `(limite: ${vanishRound + graceRounds} — coasting/LOST não pode ser emitido)`,
      );
  }
  return { fails, info };
}

// ── main ─────────────────────────────────────────────────────────────────────
console.log(
  `\n[eval/counting] Sensor fim-a-fim de contagem+tracking — dets sintéticas → pipeline.js (bytetrack+counting+payload) de produção`,
);
console.log(
  `  knobs: ${KNOBS.roundMs}ms/rodada (linha@2fps) · highScore ${KNOBS.highScore} · trackerIou ${KNOBS.trackerIou} · birthIou ${KNOBS.birthIouThreshold} · reassoc ${KNOBS.reassocDist}/${KNOBS.reassocMaxGapMs}ms · lost ${KNOBS.lostAfterMisses} · ttl ${KNOBS.ttlMs}ms · minMove ${KNOBS.minMove} · maxDist ${KNOBS.maxDist} · debounce ${KNOBS.debounceMs}ms · histerese ${KNOBS.minCrossingFrames}\n`,
);

let failed = 0;
const w0 = Math.max(...SCENARIOS.map((s) => s.name.length));
console.log(`  ${"CENÁRIO".padEnd(w0)}  ESPERADO  CONTADO  STATUS`);
for (const sc of SCENARIOS) {
  const { totals, emitted } = runScenario(sc);
  const okTotals = totals.in === sc.expected.in && totals.out === sc.expected.out;
  const tr = sc.tracking ? trackingReport(sc.tracking, emitted) : { fails: [], info: [] };
  const ok = okTotals && tr.fails.length === 0;
  if (!ok) failed++;
  const fmt = (t) => `${t.in}/${t.out}`;
  console.log(
    `  ${sc.name.padEnd(w0)}  ${fmt(sc.expected).padStart(8)}  ${fmt(totals).padStart(7)}  ${ok ? "OK" : "FALHOU  ←"}`,
  );
  for (const line of tr.info) console.log(`  ${" ".repeat(w0)}  · ${line}`);
  for (const f of tr.fails) console.log(`  ${" ".repeat(w0)}  ✗ ${f}`);
  if (!ok) console.log(`  ${" ".repeat(w0)}  (${sc.why})`);
}

if (failed) {
  console.error(
    `\n[eval/counting] FALHOU: ${failed} de ${SCENARIOS.length} cenário(s) fora do contrato (contagem in/out ou payload de tracks).`,
  );
  console.error(
    `       Mudou knob/lógica de tracking ou contagem? O diff acima diz QUAL mecanismo quebrou.`,
  );
  console.error(
    `       Cenários do fix-rastro FALHANDO contra código pré-fix é o esperado — ver docs/analises/fix-rastro-tracking.md.\n`,
  );
  process.exit(1);
}
console.log(
  `\n[eval/counting] OK — ${SCENARIOS.length} cenários: travessias e payload de tracks dentro do contrato em todos.\n`,
);
