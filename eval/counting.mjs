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
// PESSOA PARADA (spec-tracking-pessoa-parada C3/F2): os cenários abaixo são de
// TRAVESSIA e chamam processRound TODA rodada — não exercitam o gate de
// movimento/probe/skip nem aferem ocupação. Esse buraco é coberto pela suite de
// eval/stationary.mjs (gate simulado com motion.gateDecision de produção +
// métricas de ocupação/ghost/id-switch, régua CA-8 pinada lá), que roda JUNTO
// neste mesmo rito (npm run eval:counting) — o torneio deixou de ser cego.
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
import { runStationarySuite } from "./stationary.mjs";
import { runFrontTournament } from "./front-tournament.mjs";
import { WIRE, CROSSING_SCENARIOS, trackingReport } from "./crossing-scenarios.mjs";

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

// Tripwire, geradores e os 12 cenários: fonte ÚNICA em eval/crossing-scenarios.mjs — os
// MESMOS cenários rodam no torneio do FRONT (eval/front-tournament.mjs). Escrever a lista
// duas vezes deixaria um dos dois lados envelhecer calado (o front mediria um contrato que
// o hub já não tem). O que fica AQUI é o que é do HUB: o wiring do pipeline de produção.
const SCENARIOS = CROSSING_SCENARIOS;

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

// ── Cenários ESTACIONÁRIOS (pessoa parada × gate de movimento — spec C3/F2):
// suite própria em stationary.mjs (gate simulado fiel ao engine.gateAndDispatch +
// régua CA-8 pinada); roda no MESMO rito p/ o torneio nunca mais ser cego a dwell.
const stationaryFailed = runStationarySuite();

// ── O OUTRO LADO: o tracker do FRONT (spec F4/#31). Tudo acima mede o HUB; o caminho B
// (câmera sem hub) roda src/vision/bytetrack.ts com os knobs de src/config.ts — e nunca
// teve gate. Agora tem: o torneio elege o ttl do front pela régua e o CI barra quem mudar
// o knob por fora dela. Um rito, dois motores.
const frontFailed = runFrontTournament();

if (failed || stationaryFailed || frontFailed) {
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
  }
  if (stationaryFailed)
    console.error(
      `\n[eval/counting] FALHOU: ${stationaryFailed} cenário(s) ESTACIONÁRIO(s) fora da régua CA-8 — ver [eval/stationary] acima.\n`,
    );
  if (frontFailed)
    console.error(
      `\n[eval/counting] FALHOU: o ttl do FRONT (src/config.ts) não é o vencedor do torneio — ver [eval/front] acima.\n`,
    );
  process.exit(1);
}
console.log(
  `\n[eval/counting] OK — ${SCENARIOS.length} cenários de travessia + suite estacionária (hub) + torneio do ttl (front) dentro do contrato/régua.\n`,
);
