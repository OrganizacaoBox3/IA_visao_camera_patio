// ─────────────────────────────────────────────────────────────────────────────
// eval/counting.mjs — SENSOR FIM-A-FIM da CONTAGEM (o KPI): travessias
// esperadas × contadas no pipeline REAL dets → ByteTrack → tripwire.
//
// O que mede: os MÓDULOS DE PRODUÇÃO server/analysis/bytetrack.js e counting.js
// (importados, nada reimplementado), ligados com o MESMO wiring e knobs do motor
// (engine.js createState/processDets), alimentados por sequências DETERMINÍSTICAS
// de detecções sintéticas com nº de travessias CONHECIDO. Cada cenário exercita
// um mecanismo que decide contagem no campo: nascimento por score alto, sustain
// por score baixo (2ª passada), sobrevivência a detecção intermitente (TTL),
// histerese de 2 rodadas, filtro de micro-jitter (minMove) e teleporte (id novo).
//
// O que NÃO mede (fronteira honesta): o recall do DETECTOR (sensor: gate.mjs/
// run-eval.mjs) e travessias em vídeo real (replay de campo — extensão prevista
// em analises/acuracia-modelos.md §3/Onda 2; este harness fecha o elo
// dets→contagem que não tinha sensor nenhum).
//
// Knobs: espelho dos DEFAULTS de produção — dono canônico:
// server/analysis/precision.js (+ cadência de câmera COM linha ANALYSIS_FPS_LINE=2
// e TTL derivado trackTtlMs: max(1500, 3.5·round, probe 6s+2s)). Fixos de
// propósito (sem env): sensor determinístico. Mudou o default lá → atualize AQUI.
//
// Uso: npm run eval:counting  (ou node eval/counting.mjs) — PASS exit 0, FAIL exit 1.
// ─────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./lib.mjs";

const require = createRequire(import.meta.url);
const { createByteTracker } = require(path.join(ROOT, "server", "analysis", "bytetrack.js"));
const { createCounter } = require(path.join(ROOT, "server", "analysis", "counting.js"));

// ── Knobs (espelho de engine.js createState — ver header) ───────────────────
const KNOBS = {
  roundMs: 500, // câmera COM tripwire roda a ANALYSIS_FPS_LINE=2 (recall×cadência)
  highScore: 0.35, // nascimento de track / 1ª passada (ANALYSIS_HIGH_SCORE)
  trackerIou: 0.25, // associação det×track (engine.js → createByteTracker)
  ttlMs: 8000, // max(1500, 3.5·1000, 6000+2000) — sobrevive ao piso de PROBE do gate de movimento
  minMove: 0.01, // filtro de micro-jitter do counter
  maxDist: 0.35, // gate de teleporte do counter
  debounceMs: 800,
  minCrossingFrames: 2, // histerese: lado novo sustentado 2 rodadas
};

// Tripwire vertical no meio do frame, seta a→b p/ CIMA → esquerda→direita = "in".
const WIRE = { id: "porta", a: { x: 0.5, y: 0.8 }, b: { x: 0.5, y: 0.2 } };

// ── Geradores determinísticos de detecções ("pessoa" sintética) ──────────────
const PERSON = { w: 0.06, h: 0.16 }; // bbox normalizada; foot = bottom-center (âncora do julgamento)

/** Detecção como o worker devolve pós-filtro de classe: {score, bbox:[x,y,w,h]} norm. */
function det(cx, footY, score) {
  return { score, bbox: [cx - PERSON.w / 2, footY - PERSON.h, PERSON.w, PERSON.h] };
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
];

// ── Pipeline por rodada — MESMO wiring de engine.js processDets ──────────────
function runScenario(sc) {
  const tracker = createByteTracker({
    highScore: KNOBS.highScore,
    iouThreshold: KNOBS.trackerIou,
    ttlMs: KNOBS.ttlMs,
  });
  const counter = createCounter([WIRE], {
    minMove: KNOBS.minMove,
    ttl: KNOBS.ttlMs,
    maxDist: KNOBS.maxDist,
    debounceMs: KNOBS.debounceMs,
    minCrossingFrames: KNOBS.minCrossingFrames,
  });
  let now = 0;
  const events = [];
  for (const dets of sc.rounds) {
    now += KNOBS.roundMs;
    const tracks = tracker.update(dets, now, KNOBS.highScore);
    events.push(
      ...counter.update(
        tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, foot: t.foot })),
        now,
      ),
    );
  }
  return { totals: counter.totals(), events };
}

// ── main ─────────────────────────────────────────────────────────────────────
console.log(
  `\n[eval/counting] Sensor fim-a-fim de contagem — dets sintéticas → bytetrack.js → counting.js (produção)`,
);
console.log(
  `  knobs: ${KNOBS.roundMs}ms/rodada (linha@2fps) · highScore ${KNOBS.highScore} · trackerIou ${KNOBS.trackerIou} · ttl ${KNOBS.ttlMs}ms · minMove ${KNOBS.minMove} · maxDist ${KNOBS.maxDist} · debounce ${KNOBS.debounceMs}ms · histerese ${KNOBS.minCrossingFrames}\n`,
);

let failed = 0;
const w0 = Math.max(...SCENARIOS.map((s) => s.name.length));
console.log(`  ${"CENÁRIO".padEnd(w0)}  ESPERADO  CONTADO  STATUS`);
for (const sc of SCENARIOS) {
  const { totals } = runScenario(sc);
  const ok = totals.in === sc.expected.in && totals.out === sc.expected.out;
  if (!ok) failed++;
  const fmt = (t) => `${t.in}/${t.out}`;
  console.log(
    `  ${sc.name.padEnd(w0)}  ${fmt(sc.expected).padStart(8)}  ${fmt(totals).padStart(7)}  ${ok ? "OK" : "FALHOU  ←"}`,
  );
  if (!ok) console.log(`  ${" ".repeat(w0)}  (${sc.why})`);
}

if (failed) {
  console.error(
    `\n[eval/counting] FALHOU: ${failed} de ${SCENARIOS.length} cenário(s) com contagem ≠ esperado (in/out).`,
  );
  console.error(
    `       Mudou knob/lógica de tracking ou contagem? O diff acima diz QUAL mecanismo quebrou.\n`,
  );
  process.exit(1);
}
console.log(
  `\n[eval/counting] OK — ${SCENARIOS.length} cenários: travessias contadas = esperadas em todos.\n`,
);
