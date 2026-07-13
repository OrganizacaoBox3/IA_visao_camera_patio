// ─────────────────────────────────────────────────────────────────────────────
// eval/crossing-scenarios.mjs — os 12 cenários de TRAVESSIA (dados + geradores),
// em UM lugar só. Extraídos de eval/counting.mjs na F4 (#31) porque agora TÊM DOIS
// consumidores e não podem divergir:
//   • eval/counting.mjs        → roda no pipeline do HUB (server/analysis/*)
//   • eval/front-tournament.mjs → roda no tracker+counter do FRONT (src/vision/*)
// A regra da casa (fonte ÚNICA) vale para o SENSOR também: se o mesmo cenário for
// escrito duas vezes, um dos dois lados envelhece calado — e o torneio do front
// estaria medindo um contrato que o do hub já não tem.
//
// O que cada cenário exercita (mecanismo que decide contagem no campo): nascimento
// por score alto, sustain por score baixo (2ª passada), sobrevivência a detecção
// intermitente (TTL), histerese de 2 rodadas, filtro de micro-jitter (minMove),
// teleporte (id novo) e os 3 sensores do FIX-RASTRO (salto moderado / salto extremo /
// oclusão longa — o contrato do stream que SALTA, medido no PAYLOAD emitido).
//
// UNIDADE: os cenários são definidos em RODADAS de detecção (não em ms) — o mecanismo
// que eles testam é por-rodada (miss, salto, histerese). Quem os roda escolhe a CADÊNCIA
// (hub: 500ms/linha@2fps; front: 350ms/câmera aberta) e paga as consequências no tempo —
// é justamente o que o torneio do front mede.
// ─────────────────────────────────────────────────────────────────────────────

/** bbox normalizada; foot = bottom-center (âncora do julgamento de cruzamento). */
export const PERSON = { w: 0.06, h: 0.16 };

/** Tripwire vertical no meio do frame, seta a→b p/ CIMA → esquerda→direita = "in". */
export const WIRE = { id: "porta", a: { x: 0.5, y: 0.8 }, b: { x: 0.5, y: 0.2 } };

/** Detecção como o worker devolve: {class,score,bbox:[x,y,w,h]} norm. (o filtro de
 *  classe roda DENTRO do pipeline do hub — por isso `class` vai junto; o tracker do
 *  front recebe a lista já filtrada por classe e simplesmente ignora o campo). */
export function det(cx, footY, score) {
  return { class: "person", score, bbox: [cx - PERSON.w / 2, footY - PERSON.h, PERSON.w, PERSON.h] };
}

/** steps+1 posições lineares from→to (passo constante; nunca cai exatamente na linha). */
export function xsLinear(from, to, steps) {
  const out = [];
  for (let k = 0; k <= steps; k++) out.push(from + (k * (to - from)) / steps);
  return out;
}

/**
 * Uma "pessoa" como lane: 1 entrada por rodada (null = não detectada naquela rodada).
 * @param {Array<number|null>} xs posição x do pé por rodada (null = miss)
 * @param {{ footY?: number, score?: number|((k:number)=>number), delay?: number }} [o]
 */
export function lane(xs, o = {}) {
  const footY = o.footY ?? 0.5;
  const out = new Array(o.delay ?? 0).fill(null);
  xs.forEach((x, k) => {
    if (x == null) out.push(null);
    else out.push(det(x, footY, typeof o.score === "function" ? o.score(k) : (o.score ?? 0.8)));
  });
  return out;
}

/** Junta lanes em rodadas: rodada r = dets de todas as lanes presentes em r. */
export function rounds(...lanes) {
  const n = Math.max(...lanes.map((l) => l.length));
  const out = [];
  for (let r = 0; r < n; r++) out.push(lanes.map((l) => l[r]).filter(Boolean));
  return out;
}

const WALK = xsLinear(0.3, 0.72, 14); // passo 0.03/rodada — IoU consecutivo 0.33 ≥ 0.25 (associável)
const WALK_BACK = xsLinear(0.69, 0.27, 14);

/** Os 12 cenários: travessias CONHECIDAS → contagem esperada (+ contratos de payload). */
export const CROSSING_SCENARIOS = [
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

  // ── Sensores do FIX-RASTRO (stream que salta) — ver docs/analises/fix-rastro-tracking.md ──
  {
    name: "salto moderado (stream engasga ≤2.5s)",
    why: "contrato: gap com deslocamento ≈ vx·dt mantém o MESMO id e a travessia conta",
    // Caminhada linear 0.30→0.72 (passo 0.03/rodada) com dois engasgos de stream:
    // dets em k=0,1 (aprende velocidade), GAP (k=2,3), det k=4, GAP (k=5..8), det k=9
    // (já do outro lado da linha: 0.42→0.57 cruza no gap) e k=10..14 contínuos (sustentam
    // a histerese). Deslocamento SEMPRE ≈ vx·dt. O gap em MS depende da cadência de quem
    // roda (hub 500ms → 2.5s; front 350ms → 1.75s) — e o TTL de cada lado tem de cobri-lo.
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
    // cada salto deixa o track velho coastando até o TTL → 2..4 "máscaras" emitidas
    // ao mesmo tempo para UMA pessoa (o rastro do bug de campo).
    rounds: rounds(
      lane([0.2, 0.2, 0.2, 0.2, 0.6, 0.6, 0.6, 0.6, 0.25, 0.25, 0.25, 0.25, 0.65, 0.65, 0.65, 0.65]),
    ),
    expected: { in: 0, out: 0 },
    tracking: { maxSimultaneous: 1 }, // é UMA pessoa: nunca >1 track no payload
  },
  {
    name: "oclusão longa (5s) e reaparece longe",
    why: "id novo é OK; o track antigo some do payload em ≤2 rodadas (LOST não-emitido)",
    // Anda 0.30→0.42 (k=0..4), SOME por 10 rodadas e reaparece LONGE (x=0.25, pé em
    // y=0.75 — sem IoU com observado nem predito) andando de novo. Pré-fix, o track
    // antigo é emitido congelado em 0.42 até o TTL.
    rounds: rounds(
      lane(xsLinear(0.3, 0.42, 4)),
      lane(xsLinear(0.25, 0.37, 4), { footY: 0.75, delay: 15 }),
    ),
    expected: { in: 0, out: 0 },
    // ids emitidos até a rodada 4 (o track antigo) não podem aparecer após a rodada 4+2.
    tracking: { ghost: { vanishRound: 4, graceRounds: 2 } },
  },
];

/**
 * Checagens do PAYLOAD emitido (cenários com `tracking`) — o contrato do fix-rastro.
 * `emitted[r]` = lista de tracks emitidos na rodada r (hub: payload analysis-tracks;
 * front: retorno de tracker.update). Mesmo contrato, dois motores.
 * @returns {{fails:string[], info:string[]}}
 */
export function trackingReport(tr, emitted) {
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
