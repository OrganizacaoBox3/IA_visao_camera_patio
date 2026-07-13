// ─────────────────────────────────────────────────────────────────────────────
// eval/front-tournament.mjs — TORNEIO do ttlMs do FRONT (spec-tracking-pessoa-parada
// F4 / PENDENCIAS #31). Roda no MESMO rito: npm run eval:counting (importado por
// counting.mjs); standalone: node eval/front-tournament.mjs.
//
// POR QUE ELE EXISTE: o #31 sempre disse "NÃO promover o ttl do front direto —
// alinhar via TORNEIO". O torneio era CEGO para pessoa parada; a F2/F3 abriram os
// olhos dele (eval/stationary.mjs), mas do lado do HUB. Este harness é o lado do
// FRONT — o caminho B da auditoria: câmera SEM hub (fallback/nó local), onde o
// tracker que decide é src/vision/bytetrack.ts com os knobs de src/config.ts.
//
// O QUE ELE MEDE (código de PRODUÇÃO do front, importado — nada reimplementado):
//   src/vision/bytetrack.ts + src/vision/counting.ts, com o tracker montado EXATAMENTE
//   como CameraWorkspace.updateTracks o monta (os MESMOS 7 knobs — ver checkWiring()).
//   Node 24 importa .ts nativamente (type stripping); os knobs saem de src/config.ts
//   (fonte ÚNICA do front, como precision.js é a do hub).
//
// A DIFERENÇA DE CENÁRIO (por que o torneio do hub não serve aqui):
//   • o front NÃO tem gate de movimento (a economia de CPU é do hub): sem probe, o
//     update roda a CADA rodada de detecção;
//   • e ele tem DUAS cadências, não uma (CameraWorkspace):
//       – FULL  (câmera aberta): objectIntervalMs = 350ms  → tracking + CONTAGEM
//         (countingActive = hasWires && mode === "full");
//       – TILE  (mosaico do dashboard): TILE_OBJECT_INTERVAL_MS = 4000ms → só tracking
//         (ocupação/pessoas por zona) — e é o que o operador FICA OLHANDO.
//   Um ttl CONSTANTE tem de servir aos dois. (O hub não tem esse problema: lá o ttl é
//   DERIVADO da cadência — precision.trackTtlMs = max(1500, roundMs×3.5, probe+2000).)
//
// ── RÉGUA DO TORNEIO — PINADA A PRIORI (escrita ANTES de rodar; rito da casa) ───────
// BASE = a config de HOJE (ttl 1500, pré-F4) — constante deste arquivo, NÃO lida do
// config (a régua não pode derivar com o que ela julga). Um candidato só é PROMOVIDO
// se, em AMBOS os regimes (FULL e TILE) e em TODOS os cenários:
//   R1. a ocupação da pessoa PARADA não CAI vs a base (e onde a base é 100%, segue 100%);
//   R2. não INTRODUZ emissão VAZIA no dwell (zona vazia com a pessoa lá) onde a base não tinha;
//   R3. os id-switches do parado NÃO SOBEM vs a base;
//   R4. o ghost (ocupação-fantasma após a saída) NÃO SOBE vs a base;
//   R5. IDENTIDADE ENTRE PESSOAS: zero herança de id — nem o vizinho herda o id do parado
//       (anti-hijack, CA-4), nem quem REOCUPA o posto herda o id de quem saiu (a "troca de
//       operador": limiar operacional PINADO em 5s — a troca mais rápida crível num posto,
//       com a saída da 1ª NÃO vista pelo detector). É o custo conhecido de subir o ttl: o
//       arco já mediu o ímã de id-hijack crescer 12%→100% com ttl 1500→12000 (spec §2 C2);
//   R6. a CONTAGEM de travessia (os 12 cenários, regime FULL) não regride: in/out exatos +
//       os contratos de payload do fix-rastro (distinctIds / maxSimultaneous / ghost).
// DESEMPATE entre os que passam (o que a F4 quer COMPRAR, declarado antes de medir):
//   O1. maior janela de OCLUSÃO CEGA que o parado sobrevive MANTENDO o id (blindSurvivalMs);
//   O2. sobrevivência do operador em movimento LENTO a UMA rodada de detecção perdida;
//   empate → MENOR ttl (menor janela de herança de id — R5 é o risco que o ttl compra).
// Achado NEGATIVO vale igual ao positivo: se ninguém passa, o front FICA COMO ESTÁ.
//
// ── GATE (o que quebra o build daqui pra frente) ────────────────────────────────────
// O torneio roda SEMPRE e o gate é auto-consistente: `APP_CONFIG.people.track.ttlMs`
// tem de ser o VENCEDOR do torneio pela régua acima. Mudou o knob no config sem passar
// pela régua? O build cai e a TABELA abaixo diz por quê. Mudou o tracker/uma política?
// A mesma tabela re-decide. (É o espelho do que eval/stationary.mjs faz pelo hub.)
//
// Determinístico: relógio sintético (tick × roundMs), zero Date.now(), zero aleatoriedade.
// PASS exit 0, FAIL exit 1 (standalone).
// ─────────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "./lib.mjs";
import { WIRE, CROSSING_SCENARIOS, trackingReport } from "./crossing-scenarios.mjs";

const src = (...p) => pathToFileURL(path.join(ROOT, "src", ...p)).href;
const { createByteTracker } = await import(src("vision", "bytetrack.ts"));
const { createCounter } = await import(src("vision", "counting.ts"));
const { APP_CONFIG } = await import(src("config.ts"));

const T = APP_CONFIG.people.track;
const HIGH = APP_CONFIG.people.scoreThreshold; // corte da 1ª passada/nascimento (0.4)
const BASE_TTL = 1500; // a config PRÉ-F4 — referência FIXA da régua (não lida do config)
// A varredura pedida no #31 (1500/3000/6000/8000) + 4000 e 5000: a primeira rodada mostrou
// a virada ENTRE 3000 e 6000, e reportar só os pontos pedidos esconderia a FRONTEIRA (Regra
// 10: reporte a curva, não o ponto). 4000 = a cadência do mosaico — é lá que a coisa vira.
const CANDIDATES = [1500, 3000, 4000, 5000, 6000, 8000];
const SWAP_MS = 5000; // R5: troca de operador no posto (limiar operacional pinado)

// ── FIDELIDADE DO MODELO (o sensor do sensor) ────────────────────────────────
// O torneio só vale se ele montar o tracker como a PRODUÇÃO monta. Dois fatos do
// CameraWorkspace.tsx são load-bearing e vivem FORA do meu alcance (outro dono de
// arquivo): a cadência do mosaico e QUAIS knobs chegam ao createByteTracker. Se um
// deles mudar, este harness passa a medir um front que não existe — então ele LÊ os
// dois da fonte e quebra alto em vez de mentir baixo.
function checkWiring() {
  const cw = readFileSync(path.join(ROOT, "src", "CameraWorkspace.tsx"), "utf8");
  const bt = readFileSync(path.join(ROOT, "src", "vision", "bytetrack.ts"), "utf8");
  const fails = [];
  const tile = Number(/TILE_OBJECT_INTERVAL_MS\s*=\s*(\d+)/.exec(cw)?.[1]);
  if (tile !== TILE_MS)
    fails.push(
      `cadência do mosaico mudou: TILE_OBJECT_INTERVAL_MS = ${tile}ms (o torneio modela ${TILE_MS}ms)`,
    );
  // Os 4 knobs ESTACIONÁRIOS não são passados por updateTracks (o front herda os DEFAULTS
  // internos do bytetrack.ts). Enquanto for assim, o config só DOCUMENTA esses 4 — e o
  // torneio tem de rodar com os defaults, não com o config. As duas metades desta verdade
  // são checadas: (a) o wiring segue ausente; (b) os valores ainda COINCIDEM (paridade por
  // VALOR). Ligar os 4 em updateTracks é a pendência #F4-w (ver PENDENCIAS).
  const call = /createByteTracker\(\{[\s\S]*?\}\)/.exec(cw)?.[0] ?? "";
  const wired = /stationary(Tolerance|EnterRounds|MaxMisses|MaxMs)/.test(call);
  if (wired)
    fails.push(
      `updateTracks agora PASSA os knobs estacionários — o torneio precisa passá-los também (pendência #F4-w resolvida)`,
    );
  for (const [k, v] of Object.entries({
    stationaryTolerance: T.stationaryTolerance,
    stationaryEnterRounds: T.stationaryEnterRounds,
    stationaryMaxMisses: T.stationaryMaxMisses,
    stationaryMaxMs: T.stationaryMaxMs,
  })) {
    const def = Number(new RegExp(`opts\\.${k} \\?\\? ([0-9.]+)`).exec(bt)?.[1]);
    if (def !== v)
      fails.push(
        `paridade por VALOR quebrada: config.${k}=${v} × default do bytetrack.ts=${def} — ` +
          `sem o wiring, quem MANDA é o default (o config estaria mentindo)`,
      );
  }
  return fails;
}

// ── Os dois regimes do front (CameraWorkspace) ───────────────────────────────
const TILE_MS = 4000; // TILE_OBJECT_INTERVAL_MS (checado em checkWiring)
const REGIMES = [
  { key: "full", label: "câmera ABERTA", roundMs: APP_CONFIG.detection.objectIntervalMs, counting: true },
  { key: "tile", label: "mosaico (tile)", roundMs: TILE_MS, counting: false },
];

/** Tracker montado como CameraWorkspace.updateTracks monta (só o ttl entra em torneio). */
function makeTracker(ttlMs) {
  return createByteTracker({
    highScore: HIGH,
    iouThreshold: T.iouThreshold,
    ttlMs,
    birthIouThreshold: T.birthIouThreshold,
    reassocDist: T.reassocDist,
    reassocMaxGapMs: T.reassocMaxGapMs,
    lostAfterMisses: T.lostAfterMisses,
    // os 4 estacionários NÃO vão — updateTracks também não os passa (defaults; ver checkWiring)
  });
}

// ── Cena sintética (espelha eval/stationary.mjs — mesma pessoa, mesma zona) ───
const ZONE = { x: 0.45, y: 0.3, w: 0.3, h: 0.3 }; // posto de trabalho
const PERSON = { w: 0.06, h: 0.16 };
const FOOT_Y = 0.5;
const STAND_X = 0.6; // o POSTO (âncora das métricas de identidade)
const WALK_SPEED = 0.06; // norm/s — operador andando (cena de ~10m → ~0.6 m/s)
const SLOW_SPEED = 0.02; // norm/rodada — o movimento LENTO que o IoU ainda liga (O2)

const det = (cx, footY, score) => ({
  score,
  bbox: [cx - PERSON.w / 2, footY - PERSON.h, PERSON.w, PERSON.h],
});
const inZone = (t) =>
  t.cx >= ZONE.x && t.cx <= ZONE.x + ZONE.w && t.cy >= ZONE.y && t.cy <= ZONE.y + ZONE.h;
/** nº de rodadas que cobrem `ms` nesta cadência (≥1 — o tempo é a verdade, a rodada é o instrumento). */
const R = (ms, roundMs) => Math.max(1, Math.round(ms / roundMs));

/** anda from→to na velocidade de caminhada, 1 posição por rodada */
function walk(from, to, roundMs, o = {}) {
  const steps = Math.max(1, Math.round((Math.abs(to - from) / WALK_SPEED) * (1000 / roundMs)));
  const out = [];
  for (let k = 0; k <= steps; k++)
    out.push({ pos: { x: from + (k * (to - from)) / steps, y: o.footY ?? FOOT_Y }, score: 0.8 });
  return out;
}
/** parada em x por `ms`; score: número | (k)=>número|null (null = detector CEGO com a pessoa LÁ) */
function stand(x, ms, roundMs, o = {}) {
  const out = [];
  for (let k = 0; k < R(ms, roundMs); k++) {
    const s = typeof o.score === "function" ? o.score(k) : "score" in o ? o.score : 0.8;
    out.push({ pos: { x, y: FOOT_Y }, score: s });
  }
  return out;
}
/** ausente por `ms` (saiu de cena) */
const gone = (ms, roundMs) => new Array(R(ms, roundMs)).fill({ pos: null, score: null });

const mark = (name) => ({ __mark: name });
function timeline(...parts) {
  const ticks = [];
  const marks = {};
  for (const p of parts.flat()) {
    if (p.__mark) marks[p.__mark] = ticks.length;
    else ticks.push(p);
  }
  return { ticks, marks };
}
/** cola uma 2ª pessoa (o VIZINHO/o SUBSTITUTO) sobre a timeline da 1ª a partir de `at` */
function withNeighbor(tl, at, bTicks) {
  const ticks = tl.ticks.map((t) => ({ ...t }));
  bTicks.forEach((b, k) => {
    const i = at + k;
    if (i < ticks.length) ticks[i] = { ...ticks[i], neighbor: b };
  });
  return { ticks, marks: tl.marks };
}

// ── O laço do FRONT: SEM gate — toda rodada de detecção chama update() (é o que
// CameraWorkspace faz em trackingStage quando freshDets). `stall` = rodada que NÃO
// aconteceu (aba em background / rodada LR lenta): o relógio anda e o update não roda
// — o teste de que a morte do parado é por EVIDÊNCIA, não por relógio (CA-3). ──
function runScenario(sc, ttlMs, roundMs) {
  const tracker = makeTracker(ttlMs);
  const emitted = [];
  sc.timeline.ticks.forEach((tk, i) => {
    const now = (i + 1) * roundMs;
    if (sc.stall && now >= sc.stall.from && now <= sc.stall.to) return; // rodada não aconteceu
    const dets = [];
    if (tk.pos && tk.score != null) dets.push(det(tk.pos.x, tk.pos.y, tk.score));
    if (tk.neighbor && tk.neighbor.score != null)
      dets.push(det(tk.neighbor.x, tk.neighbor.y ?? FOOT_Y, tk.neighbor.score));
    // SNAPSHOT obrigatório: update() devolve os objetos VIVOS do tracker (mutados a cada
    // rodada). Guardar a referência faria toda emissão do histórico "virar" o estado FINAL
    // do track — o histórico inteiro passaria a mentir a última leitura. (No hub isso não
    // aparece porque o pipeline monta um payload novo por rodada; aqui o payload sou eu.)
    emitted.push({
      now,
      tracks: tracker.update(dets, now, HIGH).map((t) => ({ id: t.id, cx: t.cx, cy: t.cy })),
    });
  });
  return { emitted, marks: sc.timeline.marks, endMs: sc.timeline.ticks.length * roundMs };
}

// ── Métricas do que foi EMITIDO (o que o dashboard desenha e conta) ───────────
function measure(res, roundMs) {
  const nowOf = (i) => (i + 1) * roundMs;
  const mk = res.marks;
  const dwellStartMs = nowOf(mk.dwellStart);
  const dwellEndMs = nowOf(mk.dwellEnd - 1);
  const inDwell = res.emitted.filter((e) => e.now >= dwellStartMs && e.now <= dwellEndMs);
  const peopleOf = (e) => e.tracks.filter(inZone).length;
  const occupied = inDwell.filter((e) => peopleOf(e) >= 1).length;
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
    // GHOST = da SAÍDA DE CENA (1º tick sem a pessoa no frame) até a 1ª emissão com ZERO
    // tracks — o carro-fantasma do Frigate (caixa congelada sobrevivendo a quem já foi
    // embora). Medir sobre `tracks.length` e não sobre a zona é o que separa "saiu da zona"
    // (geometria) de "o tracker ainda acha que ela está lá" (o que o ttl controla).
    const exitMs = nowOf(mk.exit);
    const clear = res.emitted.find((e) => e.now >= exitMs && e.tracks.length === 0);
    ghostCleared = !!clear;
    ghostTimeMs = (clear ? clear.now : res.endMs) - exitMs;
  }
  // Ids emitidos POR LUGAR: quem ficou parado em `x` teve UM id só? Ancorar no LUGAR é o
  // que torna o id-switch do parado honesto quando há DUAS pessoas em cena (o vizinho tem
  // os ids dele, no lugar dele — e não polui a contagem do sujeito do dwell).
  const idsNear = (x, tol = 0.02, from = -Infinity, to = Infinity) => {
    const s = new Set();
    for (const e of res.emitted)
      if (e.now >= from && e.now <= to)
        for (const t of e.tracks) if (Math.abs(t.cx - x) <= tol) s.add(t.id);
    return s;
  };
  const idsOfDwell = idsNear(STAND_X, 0.02, dwellStartMs, dwellEndMs);
  const distinctIds = new Set(res.emitted.flatMap((e) => e.tracks.map((t) => t.id)));
  return {
    dwellEmissions: inDwell.length,
    occupancyPct: inDwell.length ? Math.round((occupied / inDwell.length) * 1000) / 10 : 0,
    idsOfDwell: idsOfDwell.size,
    idSwitches: Math.max(0, idsOfDwell.size - 1),
    maxEmissionGapMs,
    firstVacantMs: vacant ? vacant.now - dwellStartMs : null,
    endOccupied: last ? peopleOf(last) >= 1 : false,
    ghostTimeMs,
    ghostCleared,
    distinctIds: distinctIds.size,
    idsNear,
    marks: mk,
    nowOf,
  };
}

// ── Cenários (TEMPO é a verdade; a rodada é o instrumento — cada um se re-resolve
// na cadência do regime). Os 6 primeiros espelham eval/stationary.mjs (mesma queixa,
// outro motor); os 2 últimos são o CUSTO do ttl (herança de id) e o que ele COMPRA. ──
function scenarios(roundMs) {
  const ENTER = walk(0.3, STAND_X, roundMs);
  const EXIT = walk(0.63, 0.93, roundMs);
  const dwell = (ms, o) => stand(STAND_X, ms, roundMs, o);
  return [
    {
      key: "dwell10min",
      name: "dwell 10min (detector vê sempre)",
      why: "CA-1: pessoa PARADA 10min — UM id do início ao fim? ocupação contínua?",
      timeline: timeline(ENTER, mark("dwellStart"), dwell(600_000), mark("dwellEnd"), EXIT, mark("exit"), gone(15_000, roundMs)),
    },
    {
      key: "saida",
      name: "saída limpa (ghost)",
      why: "CA-2 (anti-ghost): a pessoa sai — em quanto tempo a ocupação emitida zera?",
      timeline: timeline(ENTER, mark("dwellStart"), dwell(30_000), mark("dwellEnd"), EXIT, mark("exit"), gone(30_000, roundMs)),
    },
    {
      key: "stall",
      name: "rodada NÃO rodou (stall 6s)",
      why: "CA-3: aba em 2º plano/rodada lenta — o parado morre por RELÓGIO? (não pode: 'não vi' ≠ 'não estava')",
      timeline: timeline(ENTER, mark("dwellStart"), dwell(60_000), mark("dwellEnd")),
      stallAfterDwellMs: 6000,
    },
    {
      key: "sentada",
      name: "sentada, score [0.25,0.35) sem âncora",
      why: "CA-6: sentou e o detector só dá 0.26-0.33 — a 2ª passada sustenta?",
      timeline: timeline(
        ENTER,
        mark("dwellStart"),
        dwell(60_000, { score: (k) => (k % 2 ? 0.26 : 0.33) }),
        mark("dwellEnd"),
      ),
    },
    {
      key: "cega",
      name: "oclusão CEGA 2s (empilhadeira passa)",
      why: "O1: o detector fica cego 2s com a pessoa LÁ — ela volta com o MESMO id (dwell não zera)?",
      timeline: timeline(
        ENTER,
        mark("dwellStart"),
        dwell(20_000),
        dwell(2000, { score: null }), // pessoa LÁ, detector cego (algo passou na frente)
        dwell(30_000),
        mark("dwellEnd"),
      ),
    },
    {
      key: "hijack",
      name: "vizinho NASCE no raio do parado",
      why: "CA-4 (sentinela): B aparece a 0.12 de A PARADA, na rodada em que o detector está cego em A — B herda o id de A?",
      timeline: (() => {
        const tl = timeline(
          ENTER,
          mark("dwellStart"),
          dwell(20_000),
          mark("neighbor"),
          dwell(roundMs, { score: null }), // detector CEGO em A na rodada em que B aparece
          dwell(30_000),
          mark("dwellEnd"),
        );
        return withNeighbor(
          tl,
          tl.marks.neighbor,
          new Array(R(31_000, roundMs)).fill({ x: 0.72, score: 0.8 }),
        );
      })(),
    },
    {
      key: "reocupado",
      name: `posto REOCUPADO ${SWAP_MS / 1000}s depois (herança de id)`,
      why: "R5: A some sem ser vista saindo; B chega ANDANDO e para no MESMO posto — B ganha id PRÓPRIO ou herda o de A?",
      // O custo conhecido de subir o ttl. A caixa CONGELADA de A segue viva (LOST) até o
      // ttl e continua ELEGÍVEL à associação por IoU (1ª passada) — a det de B pousando em
      // cima dela casa com IoU ~1.0 e VENCE o pareamento guloso contra a predição da
      // própria B. B perde o id, a permanência dela nasce com o relógio de A.
      timeline: (() => {
        const bWalk = walk(0.3, STAND_X, roundMs); // B entra andando (nasce com id PRÓPRIO, longe)
        const tl = timeline(
          ENTER,
          mark("dwellStart"),
          dwell(30_000),
          mark("dwellEnd"),
          mark("exit"),
          gone(SWAP_MS + (bWalk.length + 2) * roundMs, roundMs),
        );
        // B chega ao posto EXATAMENTE SWAP_MS após a última detecção de A: a caminhada dela
        // termina nesse instante (o marco é a CHEGADA — é ELA que o R5 pina). Se a caminhada
        // for mais longa que a troca, B já vem ANDANDO enquanto A ainda está lá (o substituto
        // atravessando o corredor) — realista, e ela nasce com id PRÓPRIO longe do posto.
        const arriveIdx = tl.marks.exit + R(SWAP_MS, roundMs);
        return withNeighbor(
          tl,
          Math.max(0, arriveIdx - (bWalk.length - 1)),
          [...bWalk.map((t) => ({ x: t.pos.x, score: 0.8 })), ...new Array(R(20_000, roundMs)).fill({ x: STAND_X, score: 0.8 })],
        );
      })(),
    },
    {
      key: "lento",
      name: "operador em movimento LENTO perde 1 rodada",
      why: "O2: quem se move devagar (não é 'parado') e o detector pisca UMA rodada — o id sobrevive?",
      // O que o ttl compra na cadência LENTA: no mosaico (4s/rodada) UMA rodada perdida já
      // são 8s desde o último match — acima de QUALQUER ttl < 8000, o track MÓVEL morre por
      // relógio e a pessoa renasce com id novo (dwell/permanência zeram) toda vez que o
      // detector pisca. É o caso mais comum do mosaico, não um corner case.
      timeline: (() => {
        const ticks = [];
        for (let k = 0; k < 10; k++) ticks.push({ pos: { x: 0.5 + k * SLOW_SPEED, y: FOOT_Y }, score: 0.8 });
        ticks[5] = { pos: { x: 0.5 + 5 * SLOW_SPEED, y: FOOT_Y }, score: null }; // 1 rodada cega
        return { ticks, marks: { dwellStart: 0, dwellEnd: ticks.length } };
      })(),
      moverOnly: true, // a métrica aqui é distinctIds (1 pessoa = 1 id), não ocupação
    },
  ];
}

/** stall injetado DEPOIS do dwell começar (o relógio anda, a rodada não roda). */
function withStall(sc, roundMs) {
  if (!sc.stallAfterDwellMs) return sc;
  const from = (sc.timeline.marks.dwellStart + R(20_000, roundMs)) * roundMs;
  return { ...sc, stall: { from, to: from + sc.stallAfterDwellMs } };
}

// ── Curvas (Regra 10: reporte a CURVA, não o ponto) ──────────────────────────
/** Maior janela de oclusão CEGA (ms) que o PARADO sobrevive mantendo o MESMO id. */
function blindSurvivalMs(ttlMs, roundMs) {
  const ENTER = walk(0.3, STAND_X, roundMs);
  let best = 0;
  for (let blind = roundMs; blind <= 40_000; blind += roundMs) {
    const tl = timeline(
      ENTER,
      mark("dwellStart"),
      stand(STAND_X, 20_000, roundMs),
      stand(STAND_X, blind, roundMs, { score: null }),
      stand(STAND_X, 10_000, roundMs),
      mark("dwellEnd"),
    );
    const m = measure(runScenario({ timeline: tl }, ttlMs, roundMs), roundMs);
    if (m.idsOfDwell !== 1) break; // perdeu a identidade nesta janela → a anterior é o teto
    best = blind;
  }
  return best;
}
/** Menor intervalo de TROCA (ms) em que o substituto NÃO herda o id (a janela de herança). */
function leakWindowMs(ttlMs, roundMs) {
  for (let swap = roundMs; swap <= 30_000; swap += roundMs) {
    if (!leaks(ttlMs, roundMs, swap)) return swap;
  }
  return Infinity;
}
/** O substituto que chega `swapMs` após a última detecção de A herda o id de A? */
function leaks(ttlMs, roundMs, swapMs) {
  const bWalk = walk(0.3, STAND_X, roundMs);
  const tl = timeline(
    walk(0.3, STAND_X, roundMs),
    mark("dwellStart"),
    stand(STAND_X, 30_000, roundMs),
    mark("dwellEnd"),
    mark("exit"),
    gone(swapMs + (bWalk.length + 2) * roundMs, roundMs),
  );
  const arriveIdx = tl.marks.exit + R(swapMs, roundMs);
  const withB = withNeighbor(
    tl,
    Math.max(0, arriveIdx - (bWalk.length - 1)),
    [...bWalk.map((t) => ({ x: t.pos.x, score: 0.8 })), ...new Array(R(20_000, roundMs)).fill({ x: STAND_X, score: 0.8 })],
  );
  const m = measure(runScenario({ timeline: withB }, ttlMs, roundMs), roundMs);
  const idsA = m.idsOfDwell === 1 ? [...m.idsNear(STAND_X, 0.02, m.nowOf(tl.marks.dwellStart), m.nowOf(tl.marks.dwellEnd - 1))] : [];
  const arriveMs = m.nowOf(arriveIdx);
  const idsB = [...m.idsNear(STAND_X, 0.02, arriveMs + roundMs, Infinity)];
  return idsB.length > 0 && idsA.length > 0 && idsB.some((id) => idsA.includes(id));
}

// ── Travessia (regime FULL — é onde a contagem existe: countingActive = mode "full") ──
function runCrossing(sc, ttlMs, roundMs) {
  const tracker = makeTracker(ttlMs);
  const counter = createCounter([WIRE], {
    minMove: T.counterMinMove,
    ttl: T.counterTtlMs,
    maxDist: T.counterMaxDist,
    debounceMs: T.debounceMs,
    minCrossingFrames: T.minCrossingFrames,
  });
  const emitted = [];
  let now = 0;
  for (const dets of sc.rounds) {
    now += roundMs;
    // CameraWorkspace: a lista já vem filtrada por CLASSE e normalizada; o counter roda na
    // cadência das RODADAS de detecção (freshDets) com os tracks EMITIDOS, âncora no PÉ.
    const tracks = tracker.update(
      dets.map((d) => ({ score: d.score, bbox: d.bbox })),
      now,
      HIGH,
    );
    counter.update(
      tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, foot: t.foot })),
      now,
    );
    emitted.push(tracks);
  }
  return { totals: counter.totals(), emitted };
}

/** Roda TUDO para um (regime, ttl): cenários + curvas + travessia. */
function evaluate(regime, ttlMs) {
  const { roundMs, counting } = regime;
  const byKey = {};
  for (const sc of scenarios(roundMs)) {
    byKey[sc.key] = { sc, m: measure(runScenario(withStall(sc, roundMs), ttlMs, roundMs), roundMs) };
  }
  const crossing = counting
    ? CROSSING_SCENARIOS.map((sc) => {
        const { totals, emitted } = runCrossing(sc, ttlMs, roundMs);
        const tr = sc.tracking ? trackingReport(sc.tracking, emitted) : { fails: [], info: [] };
        const ok = totals.in === sc.expected.in && totals.out === sc.expected.out && !tr.fails.length;
        return { sc, totals, ok, fails: tr.fails };
      })
    : [];
  return {
    byKey,
    crossing,
    crossingFails: crossing.filter((c) => !c.ok).length,
    blindMs: blindSurvivalMs(ttlMs, roundMs),
    leakMs: leakWindowMs(ttlMs, roundMs),
    leakAtSwap: leaks(ttlMs, roundMs, SWAP_MS),
  };
}

// ── A RÉGUA (R1-R6), aplicada candidato × BASE, no mesmo regime ───────────────
function ruleFails(cand, base, regime) {
  const f = [];
  for (const key of Object.keys(cand.byKey)) {
    const c = cand.byKey[key].m;
    const b = base.byKey[key].m;
    const at = `[${regime.key}/${key}]`;
    if (cand.byKey[key].sc.moverOnly) {
      if (c.distinctIds > b.distinctIds)
        f.push(`${at} R3: ids da MESMA pessoa subiram: ${c.distinctIds} (base ${b.distinctIds})`);
      continue;
    }
    if (c.occupancyPct < b.occupancyPct)
      f.push(`${at} R1: ocupação do parado CAIU: ${c.occupancyPct}% (base ${b.occupancyPct}%)`);
    if (b.firstVacantMs == null && c.firstVacantMs != null)
      f.push(`${at} R2: INTRODUZIU zona VAZIA com a pessoa lá, aos ${c.firstVacantMs}ms`);
    if (c.idSwitches > b.idSwitches)
      f.push(`${at} R3: id-switch do parado subiu: ${c.idSwitches} (base ${b.idSwitches})`);
    if (c.ghostTimeMs != null && b.ghostTimeMs != null && c.ghostTimeMs > b.ghostTimeMs)
      f.push(`${at} R4: ghost subiu: ${c.ghostTimeMs}ms (base ${b.ghostTimeMs}ms)`);
    if (key === "hijack") {
      const a = c.idsNear(STAND_X);
      const bIds = c.idsNear(0.72);
      const shared = [...a].filter((id) => bIds.has(id));
      if (shared.length) f.push(`${at} R5: HIJACK — id ${shared.join(",")} apareceu nos DOIS lugares`);
    }
  }
  if (cand.leakAtSwap && !base.leakAtSwap)
    f.push(
      `[${regime.key}/reocupado] R5: HERANÇA DE ID — quem reocupou o posto ${SWAP_MS / 1000}s depois ` +
        `HERDOU o id de quem saiu (janela de herança medida: ${fmtMs(cand.leakMs)})`,
    );
  if (cand.crossingFails > base.crossingFails)
    f.push(`[${regime.key}] R6: contagem regrediu em ${cand.crossingFails} cenário(s) de travessia`);
  return f;
}

const fmtMs = (v) => (v === Infinity ? "∞" : v == null ? "—" : `${v}ms`);
const pad = (s, n) => String(s).padEnd(n);
const padS = (s, n) => String(s).padStart(n);

/** Roda o torneio inteiro; imprime as tabelas; retorna o nº de falhas do GATE. */
export function runFrontTournament() {
  console.log(
    `\n[eval/front] TORNEIO do ttlMs do FRONT (#31/F4) — tracker de PRODUÇÃO do front ` +
      `(src/vision/bytetrack.ts) com os knobs de src/config.ts`,
  );
  const wiring = checkWiring();
  if (wiring.length) {
    console.error(`\n[eval/front] FIDELIDADE QUEBRADA — o harness não modela mais o front real:`);
    for (const w of wiring) console.error(`  ✗ ${w}`);
    return wiring.length;
  }
  console.log(
    `  regimes: FULL ${REGIMES[0].roundMs}ms/rodada (tracking + contagem) · TILE ${TILE_MS}ms/rodada ` +
      `(só tracking — o mosaico) · SEM gate de movimento (é o hub que economiza CPU)\n` +
      `  base da régua: ttl ${BASE_TTL}ms (a config pré-F4) · troca de posto pinada em ${SWAP_MS}ms\n`,
  );

  const results = {}; // regime.key → ttl → evaluate()
  for (const rg of REGIMES) {
    results[rg.key] = {};
    for (const ttl of CANDIDATES) results[rg.key][ttl] = evaluate(rg, ttl);
  }

  // ── TABELA por regime ──────────────────────────────────────────────────────
  for (const rg of REGIMES) {
    console.log(`  ── regime ${rg.label} (${rg.roundMs}ms/rodada) ${"─".repeat(46 - rg.label.length)}`);
    console.log(
      `  ${pad("ttlMs", 7)}${padS("ocup.parada", 12)}${padS("vazia", 7)}${padS("id-switch", 10)}` +
        `${padS("ghost", 8)}${padS("travessia", 11)}${padS("oclusão OK", 12)}${padS("movedor", 9)}${padS("herança id", 12)}`,
    );
    for (const ttl of CANDIDATES) {
      const e = results[rg.key][ttl];
      const occ = Math.min(...Object.values(e.byKey).filter((v) => !v.sc.moverOnly).map((v) => v.m.occupancyPct));
      const vacancies = Object.values(e.byKey).filter((v) => !v.sc.moverOnly && v.m.firstVacantMs != null).length;
      const sw = Object.values(e.byKey).filter((v) => !v.sc.moverOnly).reduce((a, v) => a + v.m.idSwitches, 0);
      const gh = e.byKey.saida.m.ghostTimeMs;
      const cross = rg.counting ? `${CROSSING_SCENARIOS.length - e.crossingFails}/${CROSSING_SCENARIOS.length}` : "n/a";
      const mover = e.byKey.lento.m.distinctIds === 1 ? "ok" : `${e.byKey.lento.m.distinctIds} ids`;
      console.log(
        `  ${pad(ttl + (ttl === T.ttlMs ? "*" : ""), 7)}${padS(occ + "%", 12)}${padS(vacancies, 7)}${padS(sw, 10)}` +
          `${padS(fmtMs(gh), 8)}${padS(cross, 11)}${padS(fmtMs(e.blindMs), 12)}${padS(mover, 9)}${padS(`<${fmtMs(e.leakMs)}`, 12)}`,
      );
    }
    console.log(
      `  ${" ".repeat(2)}(ocup.parada = MENOR ocupação entre os cenários · vazia = nº de cenários com zona VAZIA ` +
        `e pessoa dentro\n   id-switch = soma dos switches do parado · oclusão OK = maior janela cega com o MESMO id (O1)\n` +
        `   movedor = o operador em movimento LENTO mantém 1 id após perder 1 rodada? (O2)\n` +
        `   herança id = troca de posto ABAIXO disso herda o id (R5; menor é melhor) · * = o valor no config hoje)\n`,
    );
  }

  // ── A RÉGUA decide ─────────────────────────────────────────────────────────
  console.log(`  ── a RÉGUA (R1-R6, candidato × base ${BASE_TTL}ms, nos DOIS regimes) ────────────`);
  const verdict = {};
  for (const ttl of CANDIDATES) {
    const fails = REGIMES.flatMap((rg) => ruleFails(results[rg.key][ttl], results[rg.key][BASE_TTL], rg));
    verdict[ttl] = fails;
    console.log(`  ttl ${pad(ttl, 6)} ${fails.length ? "REPROVADO" : "passa"}`);
    for (const f of fails) console.log(`           ✗ ${f}`);
  }
  const passers = CANDIDATES.filter((t) => !verdict[t].length);
  // Desempate declarado: O1 (oclusão cega) + O2 (movedor lento sobrevive) somados nos dois
  // regimes; empate → MENOR ttl (menor janela de herança).
  const gainOf = (ttl) =>
    REGIMES.reduce((a, rg) => {
      const e = results[rg.key][ttl];
      return a + e.blindMs + (e.byKey.lento.m.distinctIds === 1 ? rg.roundMs * 10 : 0);
    }, 0);
  const winner = passers.sort((a, b) => gainOf(b) - gainOf(a) || a - b)[0];
  console.log(
    `\n  VENCEDOR pela régua: ttl ${winner}ms` +
      (passers.length > 1 ? ` (entre os que passam: ${passers.join(", ")} — desempate por O1+O2)` : "") +
      `\n  config hoje: ttl ${T.ttlMs}ms ${T.ttlMs === winner ? "= o vencedor ✓" : "≠ o vencedor ✗"}\n`,
  );

  // ── Detalhe por cenário do VENCEDOR (é aqui que os RESIDUAIS aparecem — o que o ttl
  // NÃO conserta não pode sumir do relatório só porque a régua passou). ──────────────
  for (const rg of REGIMES) {
    console.log(`  ── detalhe do vencedor (ttl ${winner}) — ${rg.label} ${"─".repeat(30 - rg.label.length)}`);
    const e = results[rg.key][winner];
    for (const [key, { sc, m }] of Object.entries(e.byKey)) {
      const line = sc.moverOnly
        ? `ids da mesma pessoa: ${m.distinctIds} (contrato: 1)`
        : `ocupação ${m.occupancyPct}% · ${m.idsOfDwell} id(s) · ${m.idSwitches} switch` +
          `${m.firstVacantMs != null ? ` · zona VAZIA com a pessoa lá aos ${m.firstVacantMs}ms ←` : ""}` +
          `${m.ghostTimeMs != null ? ` · ghost ${fmtMs(m.ghostTimeMs)}` : ""}`;
      console.log(`  ${pad(key, 12)} ${line}`);
    }
  }
  console.log(
    `\n  RESIDUAL declarado (NÃO é o ttl — não adianta subi-lo): na oclusão CEGA a caixa do parado\n` +
      `  sai da EMISSÃO após stationaryMaxMisses (${T.stationaryMaxMisses}) rodadas sem match = ` +
      `${T.stationaryMaxMisses * REGIMES[0].roundMs}ms na câmera aberta.\n` +
      `  O track SOBREVIVE (o ttl faz o seu trabalho: o id volta o MESMO), mas a caixa PISCA e a zona\n` +
      `  fica VAZIA nesse intervalo. Quem conserta é a GRAÇA DE EMISSÃO (stationaryMaxMisses), que hoje\n` +
      `  o CameraWorkspace nem passa ao tracker (default interno) — pendência #F4-w, outro dono de arquivo.\n`,
  );

  if (T.ttlMs !== winner) {
    console.error(
      `[eval/front] FALHOU: APP_CONFIG.people.track.ttlMs = ${T.ttlMs}ms, mas o TORNEIO elege ${winner}ms.` +
        `\n       Promova o vencedor em src/config.ts — ou mude a RÉGUA (no cabeçalho deste arquivo)` +
        `\n       explicando por quê. Knob de tracker do front NÃO se muda sem passar por aqui (#31).\n`,
    );
    return 1;
  }
  console.log(
    `[eval/front] OK — o ttl do front (${T.ttlMs}ms) é o vencedor do torneio nos dois regimes.\n`,
  );
  return 0;
}

// Standalone: node eval/front-tournament.mjs (no rito oficial roda via counting.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runFrontTournament() ? 1 : 0);
}
