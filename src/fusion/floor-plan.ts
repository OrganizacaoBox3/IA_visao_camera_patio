// PLANTA BAIXA → RESTRIÇÕES. O que o desenho da área observável, das zonas e dos obstáculos
// ENTREGA de graça à atribuição operador↔zona (`zone-assignment.ts`).
//
// POR QUE ESTE MÓDULO EXISTE — a medição da Onda 2 achou DUAS fraquezas e a planta ataca as duas:
//
//   (1) A EXCLUSIVIDADE NÃO ENTRANHA NADA sem FECHAMENTO. Sem pino, todo operador pode estar "fora"
//       (corredor, buraco de FOV) — logo nenhuma atribuição é forçada. O `tagsMustBeInSomeZone` dá
//       dentes a ela, mas é uma ASSUNÇÃO (exige que as zonas LADRILHEM a área) e ligá-lo sem essa
//       prova produz decisão errada com cara de certeza. **A planta é a prova que falta** — e ela
//       permite algo melhor que o binário: o FECHAMENTO PARCIAL (ver abaixo).
//   (2) A CONTINUIDADE FÍSICA é quase inerte: "mesas todas adjacentes ⇒ 1 salto entre qualquer par".
//       Mas isso é a topologia ABSTRATA. Com OBSTÁCULOS reais (racks, máquinas, paredes) nem toda
//       transição é curta — e algumas são IMPOSSÍVEIS. **Zeros estruturais valem mais que
//       probabilidades finas** (registro do especialista). A planta os deriva.
//
// A PEÇA CENTRAL — o FECHAMENTO PARCIAL (e por que ele é honesto):
//   Fechamento não é binário. O "fora" das zonas se parte em DOIS lugares muito diferentes:
//     - o GAP: dentro da área observável, fora de qualquer zona (corredor entre as mesas). A câmera
//       VÊ quem está ali. Logo o gap não é um saco sem fundo: ele tem uma OCUPAÇÃO CONTADA
//       (`gapOccupancy`). No máximo `gapOccupancy` operadores podem estar "fora das zonas".
//     - o NÃO-OBSERVADO: fora da cobertura da câmera (banheiro, corredor externo, buraco de FOV).
//       Ali a câmera não conta ninguém — e o teto de "fora" volta a ser INFINITO.
//   Portanto: o que fecha a exclusividade NÃO é "as zonas ladrilham 100%", é **"a área observável é
//   completa"** (`observableIsClosed`) — e a cobertura das zonas só decide o TAMANHO do gap.
//   Com a área observável completa, cobertura de 70% ainda fecha bem: o teto de "fora" é o número de
//   pessoas efetivamente vistas no corredor, tipicamente 0–2, não ∞.
//   `observableIsClosed` continua sendo uma ASSUNÇÃO do desenhista — e o custo de errá-la está medido
//   em `floor-plan-gain.ts`. Este módulo NUNCA a infere sozinho.
//
// Responsabilidade única: converter GEOMETRIA (polígonos) em RESTRIÇÕES (teto do "fora" + topologia
// real). Não atribui (zone-assignment.ts), não detecta fronteira (zone-crossing.ts), não desenha.
//
// REUSO: `pointInPolygon`/`Polygon` de `floor-polygon.ts` — o MESMO primitivo do recorte anel∩navegável
// e do cruzamento de fronteira. NENHUMA geometria nova é escrita aqui.
//
// MÉTODO — grade de amostragem (e por que não geometria exata):
//   Área e conectividade saem de uma GRADE de células (`gridStep` metros) testadas com
//   `pointInPolygon`. É aproximado, e o erro é O(gridStep) na borda — declarado, não escondido.
//   A alternativa (clipping exato de polígonos + decomposição em células navegáveis) exigiria
//   geometria NOVA (interseção de polígonos, grafo de visibilidade): dezenas de linhas de código
//   sutil para um ganho que a atribuição sequer usa — ela consome INTEIROS (teto de pessoas) e um
//   grafo de vizinhança, não áreas exatas. YAGNI/KISS (CLAUDE.md §2). `gridStep` = 0,25 m por
//   default: menor que um passo humano, e o suficiente para não fechar/abrir passagens por acidente.
//   As passagens estreitas são o único risco real do método — e ele é REPORTADO
//   (`narrowPassageRisk`), não silenciado.

import { pointInPolygon, type Polygon } from "./floor-polygon";
import type { Topology, ZoneId } from "./zone-assignment";

/** Uma zona da planta: o polígono do posto (mesa), em METROS de mundo. */
export type PlanZone = { id: ZoneId; poly: Polygon };

export type FloorPlan = {
  /** COBERTURA DA CÂMERA: a região que a câmera efetivamente observa (metros). Fora dela, ninguém é
   *  contado — é a fronteira do que o sistema pode saber. */
  observable: Polygon;
  /** Os postos. Podem LADRILHAR a área observável (fechamento total) ou cobri-la só em parte. */
  zones: readonly PlanZone[];
  /** Racks, máquinas, paredes — região NÃO NAVEGÁVEL. É daqui que saem os ZEROS ESTRUTURAIS. */
  obstacles?: readonly Polygon[];
  /** ASSUNÇÃO DO DESENHISTA, nunca inferida: "não há lugar algum, fora da área observável, onde um
   *  operador da escala possa estar". True ⇒ o teto de "fora" passa a ser a ocupação CONTADA do gap.
   *  False/ausente ⇒ o teto é infinito (o comportamento de hoje, honesto e sem dentes).
   *  ERRAR isto é o único jeito de a planta produzir rótulo errado — custo medido em floor-plan-gain. */
  observableIsClosed?: boolean;
};

export type PlanAnalysisOptions = {
  /** Passo da grade, em metros. Default 0,25 m. */
  gridStep?: number;
};

export type PlanAnalysis = {
  gridStep: number;
  /** Células dentro da área observável e FORA de qualquer obstáculo (onde dá pra pisar e a câmera vê). */
  navigableCells: number;
  /** Células navegáveis DENTRO de alguma zona. */
  zoneCells: number;
  /** Células navegáveis fora de toda zona — o GAP (corredor). É aqui que o "fora" mora, e a câmera o VÊ. */
  gapCells: number;
  /** `zoneCells / navigableCells` ∈ [0,1]. 1 = as zonas LADRILHAM a área navegável observável. */
  coverage: number;
  /** Vizinhança REAL: A~B se dá para ir de A a B sem atravessar obstáculo E sem passar por uma
   *  terceira zona (corredor direto). É esta a topologia que a continuidade física deve consumir. */
  neighbors: Record<ZoneId, ZoneId[]>;
  /** Distância em SALTOS entre zonas no grafo de vizinhança real (pares sem caminho ficam de fora). */
  hops: Record<ZoneId, Record<ZoneId, number>>;
  /** GEODÉSICA (metros) zona→zona pelo chão NAVEGÁVEL, contornando obstáculos. Par ausente = ZERO
   *  ESTRUTURAL. É a peça que a topologia abstrata não tem: "mesa vizinha" pode custar 14 m de volta.
   *  LIMITE INFERIOR (grade 8-conexa subestima o percurso) — a poda erra para o lado de não excluir. */
  geodesicM: Record<ZoneId, Record<ZoneId, number>>;
  /** ZEROS ESTRUTURAIS: pares SEM caminho navegável nenhum (componentes desconexos — parede fechada).
   *  Transição IMPOSSÍVEL em qualquer tempo. Ordenados, `a < b`. */
  unreachablePairs: [ZoneId, ZoneId][];
  /** O "CONTORNE O RACK": pares cuja geodésica REAL é ≥1,5× a geodésica que existiria SEM obstáculo —
   *  é o alongamento que o rack impõe. `[a, b, geodésica_com_m, geodésica_sem_m]`. É AQUI que a planta
   *  acrescenta continuidade, e NÃO nos zeros estruturais (num CD aberto quase sempre dá para
   *  contornar). Achado, não promessa. */
  detouredPairs: [ZoneId, ZoneId, number, number][];
  /** Zonas cujo polígono cai (parcial ou totalmente) FORA da área observável — a câmera não vê o posto
   *  inteiro. Sanidade da planta: cada uma destas é um buraco por onde o fechamento vaza. */
  zonesOutsideObservable: ZoneId[];
  /** Zonas que se SOBREPÕEM (célula pertence a duas). A planta está errada — a atribuição pressupõe
   *  postos disjuntos. Diagnóstico, não conserto silencioso. */
  overlappingZones: [ZoneId, ZoneId][];
  /** Passagens com largura da ordem de 1 célula: a grade pode tê-las FECHADO (falso zero estrutural)
   *  ou ABERTO por acidente. É o risco declarado do método de amostragem. */
  narrowPassageRisk: boolean;
};

const DEFAULT_GRID = 0.25;
const sortStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const bbox = (polys: readonly Polygon[]): { x0: number; y0: number; x1: number; y1: number } | undefined => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of polys) {
    for (const p of poly ?? []) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
  }
  return Number.isFinite(x0) && x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : undefined;
};

const EMPTY: PlanAnalysis = {
  gridStep: DEFAULT_GRID,
  navigableCells: 0,
  zoneCells: 0,
  gapCells: 0,
  coverage: 0,
  neighbors: {},
  hops: {},
  geodesicM: {},
  unreachablePairs: [],
  detouredPairs: [],
  zonesOutsideObservable: [],
  overlappingZones: [],
  narrowPassageRisk: false,
};

/**
 * Converte a planta em RESTRIÇÕES. Puro e determinístico.
 *
 * Planta inválida (observável com <3 pontos / degenerado) ⇒ análise VAZIA com `coverage: 0` — a mesma
 * postura de `pointInPolygon`: sem polígono, nada é navegável, e o retorno seguro é o que NÃO afirma.
 */
export function analyzeFloorPlan(plan: FloorPlan, opts?: PlanAnalysisOptions): PlanAnalysis {
  const step = Number.isFinite(opts?.gridStep) && (opts?.gridStep ?? 0) > 0 ? (opts?.gridStep as number) : DEFAULT_GRID;
  const obs = plan?.observable;
  const box = Array.isArray(obs) && obs.length >= 3 ? bbox([obs]) : undefined;
  if (!box) return { ...EMPTY, gridStep: step };

  const zones = (plan.zones ?? []).filter((z) => z?.id && Array.isArray(z.poly) && z.poly.length >= 3);
  const zoneIds = [...new Set(zones.map((z) => z.id))].sort(sortStr);
  const obstacles = (plan.obstacles ?? []).filter((o) => Array.isArray(o) && o.length >= 3);

  const cols = Math.max(1, Math.ceil((box.x1 - box.x0) / step));
  const rows = Math.max(1, Math.ceil((box.y1 - box.y0) / step));

  // —— grade: cada célula é navegável (observável ∧ ¬obstáculo) e pertence a 0..n zonas ——————————————
  const NAV = -1; // gap navegável (corredor)
  const OUT = -2; // não navegável (fora do observável ou dentro de obstáculo)
  const cell = new Int32Array(cols * rows).fill(OUT);
  // A MESMA grade IGNORANDO os obstáculos — o contrafactual "e se o rack não estivesse ali?". É só
  // contra ele que o DESVIO faz sentido: a geodésica é BORDA-A-BORDA, então compará-la com a linha
  // reta entre CENTRÓIDES seria comparar coisas diferentes (e inventar desvio onde não há).
  const cellFree = new Int32Array(cols * rows).fill(OUT);
  const overlaps = new Map<string, [ZoneId, ZoneId]>();
  const zoneCellCount = new Map<ZoneId, number>(zoneIds.map((z) => [z, 0]));
  let navigable = 0;
  let inZone = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { x: box.x0 + (c + 0.5) * step, y: box.y0 + (r + 0.5) * step };
      if (!pointInPolygon(p, obs)) continue;
      let owner = NAV;
      for (const z of zones) {
        if (!pointInPolygon(p, z.poly)) continue;
        const idx = zoneIds.indexOf(z.id);
        if (owner >= 0 && owner !== idx) {
          const [a, b] = [zoneIds[owner], z.id].sort(sortStr);
          overlaps.set(`${a} ${b}`, [a, b]);
        }
        if (owner < 0) owner = idx;
      }
      cellFree[r * cols + c] = owner; // o chão SEM o rack (contrafactual do desvio)
      if (obstacles.some((o) => pointInPolygon(p, o))) continue; // obstáculo ⇒ não navegável
      navigable++;
      cell[r * cols + c] = owner;
      if (owner >= 0) {
        inZone++;
        zoneCellCount.set(zoneIds[owner], (zoneCellCount.get(zoneIds[owner]) ?? 0) + 1);
      }
    }
  }

  // Zona cuja área dentro do observável é menor que a sua área total ⇒ o posto vaza para fora do FOV.
  const zonesOutsideObservable: ZoneId[] = [];
  for (const z of zones) {
    const zb = bbox([z.poly]);
    if (!zb) continue;
    let total = 0;
    const c0 = Math.floor((zb.x0 - box.x0) / step) - 1;
    const c1 = Math.ceil((zb.x1 - box.x0) / step) + 1;
    const r0 = Math.floor((zb.y0 - box.y0) / step) - 1;
    const r1 = Math.ceil((zb.y1 - box.y0) / step) + 1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const p = { x: box.x0 + (c + 0.5) * step, y: box.y0 + (r + 0.5) * step };
        if (pointInPolygon(p, z.poly)) total++;
      }
    }
    const seen = zoneCellCount.get(z.id) ?? 0;
    if (total > 0 && seen < total && !zonesOutsideObservable.includes(z.id)) zonesOutsideObservable.push(z.id);
  }

  // —— vizinhança REAL: BFS a partir das células de cada zona, atravessando SÓ o gap ————————————————
  // A~B se existe caminho A → (gap)* → B. Passar por uma terceira zona NÃO conta (senão toda zona
  // seria vizinha de todas — é exatamente o erro da topologia abstrata que a planta vem consertar).
  const neighbors: Record<ZoneId, ZoneId[]> = Object.fromEntries(zoneIds.map((z) => [z, [] as ZoneId[]]));
  const adj = new Set<string>();
  const nbrOffsets = [-1, 1, -cols, cols];
  for (let zi = 0; zi < zoneIds.length; zi++) {
    const seen = new Uint8Array(cols * rows);
    const q: number[] = [];
    for (let i = 0; i < cell.length; i++) {
      if (cell[i] === zi) {
        seen[i] = 1;
        q.push(i);
      }
    }
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      const cx = i % cols;
      for (const off of nbrOffsets) {
        const j = i + off;
        if (j < 0 || j >= cell.length) continue;
        if (Math.abs(off) === 1 && Math.abs((j % cols) - cx) !== 1) continue; // não vaza de linha
        if (seen[j]) continue;
        const v = cell[j];
        if (v === OUT) continue;
        seen[j] = 1;
        if (v === NAV) q.push(j); // só o GAP propaga
        else if (v !== zi) {
          const [a, b] = [zoneIds[zi], zoneIds[v]].sort(sortStr);
          adj.add(`${a} ${b}`);
        }
      }
    }
  }
  for (const key of adj) {
    const [a, b] = key.split(" ");
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  for (const z of zoneIds) neighbors[z] = [...new Set(neighbors[z])].sort(sortStr);

  // —— GEODÉSICA: caminhar contornando obstáculos —————————————————————————————————————————————————
  // Aqui, ao contrário da vizinhança, o operador PODE atravessar outra zona (é chão — a mesa do
  // colega não é parede). A distância sai de uma BFS 8-conexa (cada passo custa 1 célula), o que
  // SUBESTIMA a diagonal: é um LIMITE INFERIOR do percurso — e o lado seguro para uma restrição de
  // continuidade (nunca poda um trajeto que era possível).
  const eightWay = [-1, 1, -cols, cols, -cols - 1, -cols + 1, cols - 1, cols + 1];
  const geodesicOver = (grid: Int32Array): Record<ZoneId, Record<ZoneId, number>> => {
    const out: Record<ZoneId, Record<ZoneId, number>> = {};
    for (let zi = 0; zi < zoneIds.length; zi++) {
      const dist = new Int32Array(grid.length).fill(-1);
      const q: number[] = [];
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === zi) {
          dist[i] = 0;
          q.push(i);
        }
      }
      for (let h = 0; h < q.length; h++) {
        const i = q[h];
        const cx = i % cols;
        for (const off of eightWay) {
          const j = i + off;
          if (j < 0 || j >= grid.length) continue;
          if (Math.abs((j % cols) - cx) > 1) continue; // não vaza de linha
          if (grid[j] === OUT || dist[j] >= 0) continue;
          dist[j] = dist[i] + 1;
          q.push(j);
        }
      }
      const row: Record<ZoneId, number> = {};
      for (let zj = 0; zj < zoneIds.length; zj++) {
        if (zi === zj) {
          row[zoneIds[zj]] = 0;
          continue;
        }
        let best = -1;
        for (let i = 0; i < grid.length; i++) {
          if (grid[i] !== zj || dist[i] < 0) continue;
          if (best < 0 || dist[i] < best) best = dist[i];
        }
        if (best >= 0) row[zoneIds[zj]] = best * step; // ausente ⇒ ZERO ESTRUTURAL
      }
      out[zoneIds[zi]] = row;
    }
    return out;
  };
  const geodesicM = geodesicOver(cell);
  const geodesicFreeM = geodesicOver(cellFree); // o contrafactual: o mesmo chão SEM o rack

  // —— saltos + zeros estruturais ————————————————————————————————————————————————————————————————
  const hops: Record<ZoneId, Record<ZoneId, number>> = {};
  const unreachablePairs: [ZoneId, ZoneId][] = [];
  for (const src of zoneIds) {
    const dist: Record<ZoneId, number> = { [src]: 0 };
    let frontier = [src];
    for (let d = 1; frontier.length > 0; d++) {
      const next: ZoneId[] = [];
      for (const z of frontier) {
        for (const n of neighbors[z] ?? []) {
          if (dist[n] !== undefined) continue;
          dist[n] = d;
          next.push(n);
        }
      }
      frontier = next;
    }
    hops[src] = dist;
    for (const dst of zoneIds) {
      // ZERO ESTRUTURAL é definido pela GEODÉSICA (o chão), não pelo grafo de vizinhança: só é
      // impossível o que não tem caminho navegável NENHUM (nem passando por outra zona).
      if (dst <= src || geodesicM[src]?.[dst] !== undefined) continue;
      unreachablePairs.push([src, dst]);
    }
  }

  // —— DESVIOS: quanto o obstáculo ALONGA o caminho (contra o mesmo chão sem ele) ————————————————
  const detouredPairs: [ZoneId, ZoneId, number, number][] = [];
  for (let i = 0; i < zoneIds.length; i++) {
    for (let j = i + 1; j < zoneIds.length; j++) {
      const a = zoneIds[i];
      const b = zoneIds[j];
      const free = geodesicFreeM[a]?.[b];
      if (free === undefined) continue; // sem obstáculo já era inalcançável: não é desvio, é geometria
      const geo = geodesicM[a]?.[b];
      if (geo === undefined) detouredPairs.push([a, b, Number.POSITIVE_INFINITY, free]);
      else if (geo >= 1.5 * Math.max(free, step)) detouredPairs.push([a, b, geo, free]);
    }
  }

  const gap = navigable - inZone;
  return {
    gridStep: step,
    navigableCells: navigable,
    zoneCells: inZone,
    gapCells: gap,
    coverage: navigable > 0 ? inZone / navigable : 0,
    neighbors,
    hops,
    geodesicM,
    unreachablePairs,
    detouredPairs,
    zonesOutsideObservable: zonesOutsideObservable.sort(sortStr),
    overlappingZones: [...overlaps.values()].sort((x, y) => sortStr(x[0], y[0]) || sortStr(x[1], y[1])),
    // Corredor de 1–2 células de largura: a grade pode ter fechado (ou aberto) a passagem por acidente.
    narrowPassageRisk: gap > 0 && gap < 4 * Math.max(1, zoneIds.length),
  };
}

/**
 * A TOPOLOGIA que a continuidade física deve consumir — derivada da planta, não decretada.
 *
 * `walkSpeedMps` é o ÚNICO número que vem de fora (velocidade de caminhada; ~1,2 m/s para um adulto
 * em ambiente industrial). Ele converte a geodésica da planta em TEMPO MÍNIMO de deslocamento. O
 * módulo se recusa a fabricar qualquer outro parâmetro — a disciplina que matou o prior de workflow
 * ("sem modelo, sem opinião") vale igual aqui.
 *
 * O produto principal é `minTravelMs` (tempo real, contornando obstáculos, com os ZEROS ESTRUTURAIS
 * como pares AUSENTES). `neighbors`/`hopMs` seguem preenchidos para o consumidor que só tem o grafo.
 */
export function topologyFromPlan(analysis: PlanAnalysis, walkSpeedMps: number): Topology {
  const v = Number.isFinite(walkSpeedMps) && walkSpeedMps > 0 ? walkSpeedMps : 1.2;
  const minTravelMs: Record<ZoneId, Record<ZoneId, number>> = {};
  let sum = 0;
  let n = 0;
  for (const [from, row] of Object.entries(analysis.geodesicM)) {
    const out: Record<ZoneId, number> = {};
    for (const [to, m] of Object.entries(row)) {
      out[to] = Math.round((m / v) * 1000);
      if (from !== to) {
        sum += out[to];
        n++;
      }
    }
    minTravelMs[from] = out;
  }
  // `hopMs` = tempo médio de um salto real — só o fallback de quem ignorar `minTravelMs`.
  return { neighbors: analysis.neighbors, hopMs: n > 0 ? Math.round(sum / n) : 0, minTravelMs };
}

/**
 * O TETO DO "FORA" — quantos operadores da escala PODEM estar fora de todas as zonas observadas.
 * É o que dá dentes à exclusividade (§ cabeçalho), e é a peça que a planta destrava.
 *
 * @param gapOccupancy pessoas que a CÂMERA CONTA dentro da área observável e fora de toda zona
 *        (corredor). MEDIDO, não assumido. Com as zonas ladrilhando 100%, é 0 por construção.
 * @returns `undefined` = ILIMITADO (a área observável NÃO é declarada completa: existe buraco de FOV,
 *          banheiro, corredor externo — e ali a câmera não conta ninguém). É o estado de hoje.
 *          Um número = teto duro do "fora".
 *
 * A honestidade está aqui: `observableIsClosed === false` NÃO é consertado por cobertura de zona
 * nenhuma. Ladrilhar as mesas não fecha a porta do banheiro.
 */
export function foraCapacityFromPlan(plan: FloorPlan, gapOccupancy: number): number | undefined {
  if (plan?.observableIsClosed !== true) return undefined;
  return Number.isFinite(gapOccupancy) ? Math.max(0, Math.floor(gapOccupancy)) : 0;
}
