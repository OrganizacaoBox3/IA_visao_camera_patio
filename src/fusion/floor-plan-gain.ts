// BANCADA — quanto a PLANTA BAIXA vale, em número, ANTES de construir a UI que a desenha.
//
// A pergunta que decide a feature (e é a única razão deste módulo existir):
//   **quanto do problema de identidade a planta resolve SOZINHA, sem rádio nenhum?**
// (Contexto: a identidade por CORRELAÇÃO de RSSI cobre 2,5–7,6% dos episódios — o gate das Ondas 0/1.
//  ≥92% dos episódios precisam de identidade NÃO-RÁDIO. É esse buraco que a planta tenta tapar.)
//
// O que se compara, sobre o MESMO chão físico e a MESMA verdade-terreno:
//   FECHAMENTO   — o teto do "fora" que a planta mede (`foraCapacityFromPlan`), em cobertura 100/90/70%.
//   OBSTÁCULOS   — a topologia REAL (geodésica contornando o rack) contra a abstrata ("todas vizinhas").
//   OS DOIS.
//   E o CUSTO DE ERRAR: se a área observável NÃO for completa (buraco de FOV não mapeado) e ligarmos
//   o fechamento assim mesmo, quantos rótulos ERRADOS COM CARA DE CERTEZA saem? É a invariante da casa
//   que está em jogo — e é o motivo de `tagsMustBeInSomeZone` ter nascido desligada.
//
// HONESTIDADE DO MÉTODO (o que este número É e o que NÃO É):
//   - É um cenário SINTÉTICO, com a estrutura que o dono descreveu (mesas vizinhas, capacidade 1–2,
//     anônimos circulando CONSTANTEMENTE, operador circula livre). Não é dado de campo.
//   - A contagem da câmera é assumida PERFEITA. Isso é otimista e está declarado: `occupancy` errado
//     degrada tudo (risco já registrado na spec §8). O que se mede aqui é o TETO do ganho da planta.
//   - A presença de rádio (o MAC visto na área, no horizonte de minutos) é assumida completa. É a
//     restrição 4, a única que o gate não derrubou. Sem ela, nada aqui roda — a planta não substitui
//     a lista de quem está na área, ela substitui o RSSI que diz ONDE.
//   - A verdade-terreno da FÍSICA é sempre a planta COM obstáculos. Os modelos que a ignoram apenas
//     subestimam o percurso — erram para o lado de não excluir (sound).

import { assignOperators, type Topology, type ZoneObservation, type ZoneId } from "./zone-assignment";
import { analyzeFloorPlan, foraCapacityFromPlan, topologyFromPlan, type FloorPlan, type PlanAnalysis } from "./floor-plan";

// —— RNG determinístico (mulberry32) ——————————————————————————————————————————————————————————————
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const WALK_MPS = 1.2; // adulto em ambiente industrial
const CELL = 6; // lado da célula de posto (m)

/** O chão: `cols`×6 m por `rows`×6 m observável, `rows`×`cols` mesas, um RACK entre as duas linhas
 *  com passagem só na ponta direita. `coverage` encolhe cada polígono de mesa (o resto vira CORREDOR). */
export function buildPlan(
  coverage: number,
  withObstacles: boolean,
  observableIsClosed: boolean,
  rows = 2,
  cols = 3,
): FloorPlan {
  const s = Math.sqrt(Math.max(0.01, Math.min(1, coverage)));
  const pad = (CELL * (1 - s)) / 2;
  const W = cols * CELL;
  const H = rows * CELL;
  const zones = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * CELL + pad;
      const y0 = r * CELL + pad;
      const x1 = (c + 1) * CELL - pad;
      const y1 = (r + 1) * CELL - pad;
      zones.push({
        id: `M${r}${c}`,
        poly: [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
      });
    }
  }
  return {
    observable: [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: H },
      { x: 0, y: H },
    ],
    zones,
    // RACK: parede impassável do x=0 até 5/6 da largura, na divisa das linhas. Passagem só na ponta.
    obstacles:
      withObstacles && rows > 1
        ? [
            [
              { x: 0, y: CELL - 0.2 },
              { x: W - CELL * 0.85, y: CELL - 0.2 },
              { x: W - CELL * 0.85, y: CELL + 0.2 },
              { x: 0, y: CELL + 0.2 },
            ],
          ]
        : [],
    observableIsClosed,
  };
}

export type GainParams = {
  seed: number;
  runs: number;
  /** 2–5 operadores na escala (resposta do dono). */
  operators: number;
  coverage: number;
  /** Probabilidade de a conservação ter FIXADO o operador (pino). 0 = a planta sozinha. */
  pPin: number;
  /** Verdade FÍSICA: fração dos operadores que estão num BURACO não mapeado (fora do observável).
   *  >0 ⇒ a assunção `observableIsClosed` do desenhista é FALSA. É o experimento do risco. */
  pHole: number;
  /** Modelo entregue ao atribuidor. */
  closure: boolean;
  topology: "nenhuma" | "abstrata" | "planta-sem-obstaculo" | "planta-com-obstaculo";
  /** Grade de postos. Default 2×3 = 6 mesas. Quanto MAIS postos por operador, mais frouxa a ocupação
   *  — e a exclusividade tem menos como entranhar. É um dos eixos do veredito. */
  rows?: number;
  cols?: number;
  /** Probabilidade de um ANÔNIMO estar em cada posto. O dono: "anônimos circulam CONSTANTEMENTE". */
  pAnonZone?: number;
  /** O BURACO DE IDENTIDADE: há quanto tempo o operador não tem posição confirmada (o track morreu).
   *  É o que a CONTINUIDADE tem de cobrir. Curto = a planta poda muito; longo = ela não poda nada. */
  gapMinMs?: number;
  gapMaxMs?: number;
};

export type GainStats = {
  runs: number;
  /** Operadores avaliados (escala × runs). */
  operators: number;
  /** kind === "decidida" numa zona — a IDENTIDADE RESOLVIDA. É o número que decide a feature. */
  decided: number;
  /** `via: "pin"` — a conservação já sabia. NÃO é ganho da planta (existe sem ela). */
  decidedByPin: number;
  /** 🔑 `via: "exclusao"` — a identidade que as RESTRIÇÕES entranharam. **É ISTO que a planta compra.** */
  decidedByExclusion: number;
  decidedCorrect: number;
  /** ⚠️ RÓTULO ERRADO COM CARA DE CERTEZA — a invariante da casa. Só existe se uma premissa for falsa. */
  decidedWrong: number;
  /** Erros ENTRE os rótulos que a exclusividade comprou. É o número que julga o FECHAMENTO: os pinos
   *  são verdadeiros por construção nesta bancada, então TODO erro nasce da premissa de fechamento. */
  exclusionWrong: number;
  /** kind === "fora" — também é uma afirmação (ele NÃO está em posto nenhum); correta se a verdade
   *  é corredor/buraco. */
  fora: number;
  foraCorrect: number;
  ambiguous: number;
  /** Tamanho médio do conjunto de zonas possíveis nos ambíguos (1 = "quase decidido"). */
  ambiguityMean: number;
  absent: number;
  /** Runs em que as restrições se contradisseram — a falha SEGURA (não produz rótulo). */
  infeasibleRuns: number;
  decidedRate: number;
  /** decidedByExclusion / operadores — o GANHO LÍQUIDO da planta, descontado o que o pino já dava. */
  exclusionRate: number;
  precision: number;
  /** 🔑 A PRECISÃO DO QUE A PLANTA COMPRA. Com a premissa VERDADEIRA = 1 (entailment não erra). Com
   *  ela FALSA, é aqui que o estrago aparece — e não na precisão global, que os pinos maquiam. */
  exclusionPrecision: number;
};

type Truth = { token: string; where: ZoneId | "GAP" | "HOLE" };

/** Um cenário: verdade-terreno + o que a câmera/rádio observam dela. */
function scenario(p: GainParams, plan: FloorPlan, phys: PlanAnalysis, r: () => number) {
  const zoneIds = plan.zones.map((z) => z.id);
  const gapFrac = 1 - phys.coverage;
  const roster = Array.from({ length: p.operators }, (_, i) => `OP${i}`);

  const occ = new Map<ZoneId, number>(zoneIds.map((z) => [z, 0]));
  const opsIn = new Map<ZoneId, string[]>(zoneIds.map((z) => [z, []]));
  let gapOcc = 0;

  // ANÔNIMOS: circulam CONSTANTEMENTE (resposta 4 do dono) — no posto e no corredor.
  for (const z of zoneIds) if (r() < (p.pAnonZone ?? 0.35)) occ.set(z, 1);
  for (let i = 0; i < 3; i++) if (r() < 1.5 * gapFrac) gapOcc++; // corredor maior ⇒ mais gente passando

  const truth: Truth[] = [];
  for (const token of roster) {
    if (p.pHole > 0 && r() < p.pHole) {
      truth.push({ token, where: "HOLE" }); // fora do observável: a câmera NÃO o conta em lugar nenhum
      continue;
    }
    if (gapFrac > 0 && r() < 0.8 * gapFrac) {
      truth.push({ token, where: "GAP" }); // andando no corredor — a câmera O VÊ (e o conta)
      gapOcc++;
      continue;
    }
    const free = zoneIds.filter((z) => (occ.get(z) ?? 0) < 2);
    const z = (free.length > 0 ? free : zoneIds)[Math.floor(r() * (free.length > 0 ? free.length : zoneIds.length))];
    occ.set(z, (occ.get(z) ?? 0) + 1);
    opsIn.get(z)?.push(token);
    truth.push({ token, where: z });
  }

  // PINOS (conservação): só de quem está mesmo numa zona — pino falso não existe por construção aqui.
  const pinned = new Map<ZoneId, string[]>();
  for (const t of truth) {
    if (t.where === "GAP" || t.where === "HOLE") continue;
    if (r() < p.pPin) pinned.set(t.where, [...(pinned.get(t.where) ?? []), t.token]);
  }

  const zones: ZoneObservation[] = zoneIds.map((z) => ({
    zoneId: z,
    occupancy: occ.get(z) ?? 0,
    capacity: 2,
    pinned: pinned.get(z) ?? [],
  }));

  // CONTINUIDADE: onde cada operador estava há dt. Amostrado SOB A FÍSICA REAL (geodésica com
  // obstáculo) ⇒ a verdade-terreno nunca é fisicamente impossível. Um modelo que a subestima só
  // deixa de podar; jamais poda o certo.
  const ts = 1_000_000;
  const lastSeen: Record<string, { zoneId: ZoneId; ts: number }> = {};
  const gMin = p.gapMinMs ?? 5_000;
  const gMax = p.gapMaxMs ?? 40_000;
  for (const t of truth) {
    const dt = gMin + Math.floor(r() * Math.max(1, gMax - gMin)); // há quanto tempo o track morreu
    const from =
      t.where === "GAP" || t.where === "HOLE"
        ? zoneIds[Math.floor(r() * zoneIds.length)]
        : (() => {
            const ok = zoneIds.filter((z) => {
              const m = phys.geodesicM[z]?.[t.where as ZoneId];
              return m !== undefined && (m / WALK_MPS) * 1000 <= dt;
            });
            return ok[Math.floor(r() * ok.length)] ?? (t.where as ZoneId);
          })();
    lastSeen[t.token] = { zoneId: from, ts: ts - dt };
  }

  return { roster, zones, truth, gapOcc, ts, lastSeen };
}

const topoFor = (p: GainParams, phys: PlanAnalysis, plain: PlanAnalysis, zoneIds: ZoneId[]): Topology | undefined => {
  switch (p.topology) {
    case "nenhuma":
      return undefined; // HOJE: nenhuma planta ⇒ nenhuma opinião
    case "abstrata":
      // A resposta do dono, sem planta: "são mesas vizinhas, todas adjacentes" ⇒ grafo completo.
      return {
        neighbors: Object.fromEntries(zoneIds.map((z) => [z, zoneIds.filter((o) => o !== z)])),
        hopMs: Math.round((CELL / WALK_MPS) * 1000),
      };
    case "planta-sem-obstaculo":
      return topologyFromPlan(plain, WALK_MPS); // geometria, mas cega ao rack
    case "planta-com-obstaculo":
      return topologyFromPlan(phys, WALK_MPS); // a topologia REAL
  }
};

export function runGain(p: GainParams): GainStats {
  const r = rng(p.seed);
  const rows = p.rows ?? 2;
  const cols = p.cols ?? 3;
  const plan = buildPlan(p.coverage, true, true, rows, cols); // a FÍSICA tem sempre o rack
  const phys = analyzeFloorPlan(plan);
  const plain = analyzeFloorPlan(buildPlan(p.coverage, false, true, rows, cols));
  const zoneIds = plan.zones.map((z) => z.id);

  const st: GainStats = {
    runs: p.runs,
    operators: 0,
    decided: 0,
    decidedByPin: 0,
    decidedByExclusion: 0,
    decidedCorrect: 0,
    decidedWrong: 0,
    exclusionWrong: 0,
    fora: 0,
    foraCorrect: 0,
    ambiguous: 0,
    ambiguityMean: 0,
    absent: 0,
    infeasibleRuns: 0,
    decidedRate: 0,
    exclusionRate: 0,
    precision: 0,
    exclusionPrecision: 0,
  };
  let ambSum = 0;

  for (let i = 0; i < p.runs; i++) {
    const s = scenario(p, plan, phys, r);
    const res = assignOperators({
      ts: s.ts,
      zones: s.zones,
      roster: s.roster,
      radio: { present: s.roster }, // restrição 4: o MAC é visto na área (horizonte de minutos)
      lastSeen: s.lastSeen,
      topology: topoFor(p, phys, plain, zoneIds),
      options: {
        // O TETO DO FORA que a PLANTA mede: as pessoas que a câmera conta no corredor.
        foraCapacity: p.closure ? foraCapacityFromPlan(plan, s.gapOcc) : undefined,
      },
    });
    st.operators += s.roster.length;
    if (res.kind === "inviavel") {
      st.infeasibleRuns++;
      continue;
    }
    for (const pl of res.placements) {
      const t = s.truth.find((x) => x.token === pl.token);
      if (!t) continue;
      if (pl.kind === "decidida") {
        st.decided++;
        if (pl.via === "pin") st.decidedByPin++;
        else st.decidedByExclusion++;
        if (pl.zoneId === t.where) st.decidedCorrect++;
        else {
          st.decidedWrong++;
          if (pl.via === "exclusao") st.exclusionWrong++;
        }
      } else if (pl.kind === "fora") {
        st.fora++;
        if (t.where === "GAP" || t.where === "HOLE") st.foraCorrect++;
      } else if (pl.kind === "ambigua") {
        st.ambiguous++;
        ambSum += pl.zones.length;
      } else {
        st.absent++;
      }
    }
  }

  st.ambiguityMean = st.ambiguous > 0 ? ambSum / st.ambiguous : 0;
  st.decidedRate = st.operators > 0 ? st.decided / st.operators : 0;
  st.exclusionRate = st.operators > 0 ? st.decidedByExclusion / st.operators : 0;
  st.precision = st.decided > 0 ? st.decidedCorrect / st.decided : 0;
  st.exclusionPrecision =
    st.decidedByExclusion > 0 ? (st.decidedByExclusion - st.exclusionWrong) / st.decidedByExclusion : 0;
  return st;
}
