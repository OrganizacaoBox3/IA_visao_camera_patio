// ATRIBUIÇÃO OPERADOR↔ZONA sob restrições — o núcleo da Onda 2 RE-ESCOPADA.
//
// POR QUE ESTE MÓDULO EXISTE (e o que ele SUBSTITUI): a Onda 2 nasceu apostando em CONSERVAÇÃO
// TOPOLÓGICA + PRIOR DE WORKFLOW. As respostas de domínio do dono (2026-07-12) REFUTARAM o prior:
// o operador **circula LIVRE** no turno (não há sequência esperada ⇒ a matriz de transição é
// UNIFORME ⇒ informação ZERO) e os postos são **mesas vizinhas, todas adjacentes** (⇒ não há zeros
// estruturais na topologia). O `workflowPrior` foi REMOVIDO de `petri-conservation.ts` — não
// rebaixado, removido: um prior uniforme é um módulo que não decide nada. Ver
// `docs/cientifica/onda2-conservacao-workflow-spec.md` §2 (retratação) para a proveniência.
//
// A MUDANÇA DE NÍVEL: o problema de atribuição migra do TICK (tag↔track a 500 ms — onde o Hungarian
// já fracassou) para a ZONA (operador↔zona, horizonte de MINUTOS). No nível da zona a estrutura é
// pequena (poucos operadores, capacidade 1–2) e as restrições são REAIS.
//
// AS 4 RESTRIÇÕES QUE SOBREVIVERAM (e são de graça):
//   1. ESCALA DO TURNO — o prior é sobre os 3 operadores de hoje, não sobre os 20 do cadastro.
//   2. EXCLUSIVIDADE — um operador está em EXATAMENTE UM lugar. Restrição GLOBAL: se X está fixado
//      na mesa 4, X NÃO está na mesa 7 — e isso pode COLAPSAR a ambiguidade da mesa 7. É aqui que a
//      atribuição paga (por PROPAGAÇÃO a partir de pinos confiáveis, não sozinha — ver §HONESTIDADE).
//   3. CONTINUIDADE FÍSICA — ninguém se teleporta (alcançabilidade por saltos × tempo decorrido).
//   4. CONJUNTO DE TAGS PRESENTES — o scan BLE devolve os MACs presentes na área. Isso é IDENTIDADE
//      DE GRAÇA: sem correlação, sem movimento, sem n_eff. **Só detecção.** É a peça que nunca foi
//      explorada e a única que sobreviveu intacta ao gate das Ondas 0/1.
//
// E O ANÔNIMO É UM DESTINO LEGÍTIMO: nº mínimo de anônimos = pessoas(câmera) − tags(rádio). Se a
// câmera vê 2 na mesa 4 e só 1 tag está presente, UMA DELAS é visitante. O dustbin, finalmente no
// nível certo (zona, não tick).
//
// HONESTIDADE — a força REAL de cada restrição (medida ao implementar, não prometida):
//   - EXCLUSIVIDADE sozinha NÃO ENTRANHA NADA: sem pinos e sem fechamento, todo operador pode estar
//     "fora" (corredor, banheiro, zona sem câmera) e nenhuma atribuição é forçada. Ela **poda** o
//     espaço; ela só **decide** quando combinada com (a) um pino da conservação, (b) saturação de
//     ocupação, ou (c) o fechamento `tagsMustBeInSomeZone`. Isto está exposto em `foraPossivel`.
//   - CONTINUIDADE é FRACA neste CD: se todas as mesas são adjacentes, a distância topológica entre
//     qualquer par é 1 salto — a restrição só exclui quando o tempo decorrido é menor que UM salto.
//     Mantida porque é de graça e porque endurece quando houver zonas distantes (doca × mezanino).
//   - AUSÊNCIA de rádio é evidência FRACA no tick (advertising perdido) mas FORTE no horizonte de
//     MINUTOS (uma tag a 1 Hz tem ~60 chances/min de ser vista). Por isso a ausência é usada aqui —
//     e SÓ aqui. Contradição pino×rádio é DIAGNÓSTICO (`pinnedNotDetected`), não decisão silenciosa.
//
// Responsabilidade única: dado um SNAPSHOT (ocupação por zona + escala + tags presentes + pinos),
// devolver o que as restrições ENTRANHAM (decidido), o que elas deixam AMBÍGUO (conjunto de zonas
// possíveis) e quantos ocupantes são ANÔNIMOS. Não detecta fronteira (zone-crossing.ts), não conta
// pessoas (petri-conservation.ts), não correlaciona RSSI (associate.ts), não inventa workflow.
//
// Puro, determinístico, sem NaN. Ambiguidade EXPOSTA no tipo de retorno — nunca um chute.

import type { ConservationResult, Place, TokenId } from "./petri-conservation";

export type ZoneId = string;

/** Sentinela interna: "em nenhuma zona observada". Destino LEGÍTIMO (corredor, fora do FOV, pausa) —
 *  não é falha. NUL não pode aparecer num id real, então não colide. */
const FORA = "\u0000FORA";

/** O que a CÂMERA vê numa zona, no horizonte da atribuição (minutos).
 *  `occupancy` vem do balanço de fronteira (`PlaceState.occupancy`) — pessoas, não tracks. */
export type ZoneObservation = {
  zoneId: ZoneId;
  /** Pessoas CONTADAS pela câmera nesta zona. Teto físico de operadores atribuíveis aqui. */
  occupancy: number;
  /** Capacidade declarada do posto (1–2). SENSOR DE SAÚDE, não restrição dura — mesma semântica de
   *  `petri-conservation.ts`: estourou = duas pessoas no posto OU track espúrio, e quem decide é o
   *  humano. Restringir a busca por ela seria confiar num número declarado contra o que a câmera vê. */
  capacity?: number;
  /** Tokens FIXADOS aqui por evidência forte e independente (conservação por zona / claim BLE).
   *  É o gatilho da EXCLUSIVIDADE: um pino aqui APAGA esse operador de todas as outras zonas. */
  pinned?: readonly TokenId[];
};

/** O CONJUNTO DE TAGS PRESENTES — identidade de graça (restrição 4). `present` é a UNIÃO do scan
 *  sobre a janela do horizonte (não um tick): é isso que torna a AUSÊNCIA informativa.
 *  `nearZones` é locality GROSSEIRA e OPCIONAL (receptor por posto): "esta tag foi vista pelo
 *  receptor destas zonas". É SET-MEMBERSHIP, não RSSI — nenhum número de potência entra aqui. */
export type RadioPresence = {
  present: readonly TokenId[];
  nearZones?: Readonly<Record<TokenId, readonly ZoneId[]>>;
};

/** Continuidade física (restrição 3). Ausente ⇒ tudo alcançável (ausência de modelo = ausência de
 *  opinião). `hopMs` = tempo MÍNIMO plausível para atravessar uma aresta de vizinhança. */
export type Topology = {
  neighbors: Readonly<Record<ZoneId, readonly ZoneId[]>>;
  hopMs: number;
  /** A TOPOLOGIA REAL, quando há PLANTA BAIXA (`floor-plan.ts`): tempo MÍNIMO de deslocamento
   *  zona→zona, contornando os obstáculos. Quando presente para a zona de origem, VENCE
   *  `neighbors`/`hopMs` — porque "mesa vizinha" no abstrato pode ser "dar a volta no rack" no real.
   *
   *  Um par AUSENTE do mapa é um ZERO ESTRUTURAL: não existe caminho navegável — transição
   *  IMPOSSÍVEL em qualquer tempo. É o que a planta acrescenta e a topologia abstrata não tem.
   *
   *  Os tempos são LIMITE INFERIOR (a geodésica sai de uma grade 8-conexa, que subestima o percurso):
   *  a poda erra sempre para o lado de NÃO excluir. Nunca se descarta um trajeto que era possível. */
  minTravelMs?: Readonly<Record<ZoneId, Readonly<Record<ZoneId, number>>>>;
};

/** Última zona conhecida de cada operador e QUANDO (vem de `ConservationResult.lastZone`, datado). */
export type LastSeen = Readonly<Record<TokenId, { zoneId: ZoneId; ts: number }>>;

export type AssignmentOptions = {
  /** FECHAMENTO TOTAL: assumir que toda tag presente está DENTRO de alguma zona observada. Só é
   *  verdade se as zonas ladrilham a área observada E não há buraco de FOV. Default `false`
   *  (honesto: "fora" continua possível). Açúcar para `foraCapacity: 0` — e é uma ASSUNÇÃO, por isso
   *  é explícita. */
  tagsMustBeInSomeZone?: boolean;
  /** FECHAMENTO PARCIAL — o teto de quantos operadores da escala podem estar FORA de todas as zonas
   *  observadas. É o modelo honesto que a PLANTA BAIXA destrava (`floor-plan.ts`,
   *  `foraCapacityFromPlan`): o corredor entre as mesas está DENTRO do campo da câmera, então quem
   *  está ali é CONTADO — o "fora" deixa de ser um saco sem fundo e vira um place com ocupação
   *  medida. `undefined` = ILIMITADO (o comportamento de hoje: há buraco de FOV / banheiro / corredor
   *  externo onde ninguém é contado). `0` ≡ `tagsMustBeInSomeZone`.
   *
   *  NOTA (a lição que a medição deu): o que fecha a exclusividade não é "as zonas ladrilham 100%",
   *  é "a área OBSERVÁVEL é completa". Com a área completa, cobertura de 70% já fecha quase tanto
   *  quanto 100% — porque o teto passa a ser o punhado de pessoas vistas no corredor, não ∞. */
  foraCapacity?: number;
  /** Teto de nós da busca. Estourou ⇒ o resultado deixa de ser entailment e degrada para os
   *  domínios (superconjunto SÃO — nunca uma decisão inventada). Default 200_000. */
  searchBudget?: number;
};

export type AssignmentInput = {
  ts: number;
  zones: readonly ZoneObservation[];
  /** ESCALA DO TURNO (restrição 1): quem está trabalhando hoje. Ninguém fora dela é atribuível. */
  roster: readonly TokenId[];
  radio: RadioPresence;
  lastSeen?: LastSeen;
  topology?: Topology;
  options?: AssignmentOptions;
};

/** Onde as restrições colocam um operador.
 *  - `decidida`: TODA atribuição viável o põe nesta zona (entailment, não palpite). `via: "pin"` =
 *    a conservação já o fixou; `via: "exclusao"` = as restrições eliminaram todas as outras opções.
 *  - `ambigua`: mais de um destino viável. `zones` = as zonas possíveis; `foraPossivel` = ele também
 *    pode não estar em zona nenhuma. Não colapsar num chute.
 *  - `fora`: nenhuma atribuição viável o põe em zona alguma (está na área, mas não num posto observado).
 *  - `ausente`: a tag NÃO apareceu no scan do horizonte ⇒ não está na área. Evidência forte no
 *    horizonte de minutos, mas NÃO é prova (tag sem bateria / desligada / sombra de rádio). */
export type Placement =
  | { kind: "decidida"; token: TokenId; zoneId: ZoneId; via: "pin" | "exclusao" }
  | { kind: "ambigua"; token: TokenId; zones: ZoneId[]; foraPossivel: boolean }
  | { kind: "fora"; token: TokenId }
  | { kind: "ausente"; token: TokenId };

/** O que as restrições dizem sobre uma zona. `certain ⊆ possible`. */
export type ZoneAssignment = {
  zoneId: ZoneId;
  occupancy: number;
  /** Operadores em TODA atribuição viável (o que a zona SABE). */
  certain: TokenId[];
  /** Operadores em ALGUMA atribuição viável (o que a zona ADMITE). */
  possible: TokenId[];
  /** Ocupantes SEM identidade = `occupancy − operadores atribuídos`, em faixa sobre as atribuições
   *  viáveis. `min > 0` ⇒ há PROVA de anônimo nesta zona (visitante/empilhadeira/manutenção). */
  anonymous: { min: number; max: number };
  /** `occupancy > capacity` — sensor de saúde (não altera a atribuição). */
  capacityViolation: boolean;
};

export type AssignmentDiagnostics = {
  /** Σ ocupação — pessoas contadas pela câmera nas zonas observadas. */
  peopleCounted: number;
  /** Operadores da ESCALA cuja tag apareceu no scan (o conjunto de tags presentes ∩ escala). */
  tagsPresent: number;
  /** A CONTA DO DONO: anônimos mínimos na área = max(0, pessoas − tags). Piso, não estimativa. */
  anonymousFloor: number;
  /** pessoas − tags < 0: MAIS TAG QUE GENTE. Sinal de patologia — tag esquecida na bancada, operador
   *  fora do FOV da câmera, ou subcontagem do detector. Diagnóstico, nunca silêncio. */
  tagsExceedPeople: number;
  /** Tags vistas que NÃO estão na escala (visitante com tag, turno anterior). Não são atribuíveis —
   *  contam como ANÔNIMOS (com tag) para efeito de ocupação. */
  offRoster: TokenId[];
  /** Operadores FIXADOS por conservação cuja tag NÃO apareceu no rádio. Contradição pino×rádio: a
   *  topologia diz que está lá, o rádio não o viu. Vence o PINO (evidência independente e posicional);
   *  o rádio silencioso pode ser bateria/sombra. Exposto, não escondido. */
  pinnedNotDetected: TokenId[];
  capacityViolations: number;
  /** O TETO DO "FORA" efetivamente aplicado. `"ilimitado"` = nenhum fechamento (hoje); um número =
   *  quantos operadores podem, no máximo, estar fora de todas as zonas (a planta o mede). */
  foraCapacity: number | "ilimitado";
  /** Atribuições viáveis enumeradas. 1 ⇒ o cenário é totalmente determinado. */
  solutions: number;
  /** Orçamento de busca estourado ⇒ NÃO houve entailment: `certain`/`decidida` caem para o que os
   *  domínios já garantiam. Nunca produz decisão que a busca não provou. */
  budgetExceeded: boolean;
};

export type AssignmentResult =
  | { kind: "ok"; ts: number; placements: Placement[]; zones: ZoneAssignment[]; diagnostics: AssignmentDiagnostics }
  /** As restrições se CONTRADIZEM (ex.: dois pinos numa zona de 1 pessoa contada). Não se inventa uma
   *  saída: devolve-se as razões para o humano/diagnóstico. */
  | { kind: "inviavel"; ts: number; reasons: string[]; diagnostics: AssignmentDiagnostics };

const DEFAULT_BUDGET = 200_000;

const sortStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Alcançabilidade `from → to` em `elapsedMs` (restrição 3). Sem topologia, sem `hopMs` positivo ou
 *  com tempo incoerente ⇒ `true` (sem opinião — nunca uma restrição inventada). */
function reachable(topo: Topology | undefined, from: ZoneId, to: ZoneId, elapsedMs: number): boolean {
  if (!topo || from === to) return true;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return true; // dado incoerente: não opinar

  // A PLANTA vence a topologia abstrata: tempo real de deslocamento contornando obstáculos.
  const travel = topo.minTravelMs?.[from];
  if (travel !== undefined) {
    const t = travel[to];
    if (t === undefined) return false; // ZERO ESTRUTURAL: não há caminho navegável — nunca é possível
    return Number.isFinite(t) ? elapsedMs >= t : false;
  }

  const hop = Number.isFinite(topo.hopMs) && topo.hopMs > 0 ? topo.hopMs : 0;
  if (hop <= 0) return true;
  const budget = Math.floor(elapsedMs / hop);
  if (budget <= 0) return false; // teleporte: nem um salto caberia no tempo decorrido
  let frontier: ZoneId[] = [from];
  const seen = new Set<ZoneId>([from]);
  for (let d = 0; d < budget && frontier.length > 0; d++) {
    const next: ZoneId[] = [];
    for (const z of frontier) {
      for (const n of topo.neighbors?.[z] ?? []) {
        if (n === to) return true;
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
  }
  return false;
}

/**
 * ATRIBUIÇÃO OPERADOR↔ZONA sob as 4 restrições sobreviventes.
 *
 * Semântica (a única honesta): enumera TODAS as atribuições viáveis e devolve o que elas
 * ENTRANHAM — um operador só é `decidida` se TODA solução viável o põe naquela zona. O resto é
 * `ambigua` com o conjunto exato de destinos possíveis (incluindo "fora"). Nenhum score, nenhum
 * limiar, nenhum desempate arbitrário: se as restrições não decidem, o sistema DIZ que não decidem.
 *
 * Sem solver genérico (YAGNI/CLAUDE.md §2): a estrutura é pequena (poucos operadores, ocupação 1–2)
 * e a busca é um DFS com poda por ocupação. Orçamento de nós fecha a porta ao patológico.
 */
export function assignOperators(input: AssignmentInput): AssignmentResult {
  const ts = Number.isFinite(input?.ts) ? input.ts : 0;
  const opts = input?.options ?? {};
  const budgetMax = Number.isFinite(opts.searchBudget) && (opts.searchBudget ?? 0) > 0
    ? Math.floor(opts.searchBudget as number)
    : DEFAULT_BUDGET;

  // —— zonas (dedup, ocupação saneada) ————————————————————————————————————————————————————————————
  const zoneById = new Map<ZoneId, { zoneId: ZoneId; occupancy: number; capacity?: number; pinned: TokenId[] }>();
  for (const z of input?.zones ?? []) {
    if (!z?.zoneId || zoneById.has(z.zoneId)) continue;
    const occ = Number.isFinite(z.occupancy) ? Math.max(0, Math.floor(z.occupancy)) : 0;
    zoneById.set(z.zoneId, {
      zoneId: z.zoneId,
      occupancy: occ,
      capacity: Number.isFinite(z.capacity) ? z.capacity : undefined,
      pinned: [...new Set((z.pinned ?? []).filter((t): t is TokenId => typeof t === "string" && t.length > 0))].sort(sortStr),
    });
  }
  const zoneIds = [...zoneById.keys()].sort(sortStr);

  // —— escala × rádio (restrições 1 e 4) ——————————————————————————————————————————————————————————
  const roster = new Set((input?.roster ?? []).filter((t): t is TokenId => typeof t === "string" && t.length > 0));
  const present = new Set((input?.radio?.present ?? []).filter((t): t is TokenId => typeof t === "string" && t.length > 0));
  const offRoster = [...present].filter((t) => !roster.has(t)).sort(sortStr);

  const pinOf = new Map<TokenId, ZoneId>();
  const reasons: string[] = [];
  for (const zid of zoneIds) {
    const z = zoneById.get(zid);
    if (!z) continue;
    for (const t of z.pinned) {
      const prev = pinOf.get(t);
      if (prev !== undefined && prev !== zid) {
        // EXCLUSIVIDADE violada na ENTRADA: a conservação fixou o mesmo operador em duas zonas.
        reasons.push(`exclusividade: token ${t} fixado em ${prev} e ${zid}`);
        continue;
      }
      pinOf.set(t, zid);
    }
    if (z.pinned.length > z.occupancy) {
      reasons.push(`zona ${zid}: ${z.pinned.length} tokens fixados > ${z.occupancy} pessoa(s) contada(s)`);
    }
  }

  // Um pino é evidência INDEPENDENTE do rádio (topologia/claim). Ele torna o operador atribuível
  // mesmo que o scan não o tenha visto — e a contradição fica REGISTRADA, não resolvida em silêncio.
  const pinnedNotDetected = [...pinOf.keys()].filter((t) => !present.has(t) && roster.has(t)).sort(sortStr);
  const assignable = [...roster].filter((t) => present.has(t) || pinOf.has(t)).sort(sortStr);
  const absent = [...roster].filter((t) => !present.has(t) && !pinOf.has(t)).sort(sortStr);

  // —— diagnóstico de contagem (a conta do dono) ——————————————————————————————————————————————————
  const peopleCounted = zoneIds.reduce((a, z) => a + (zoneById.get(z)?.occupancy ?? 0), 0);
  const tagsPresent = [...roster].filter((t) => present.has(t)).length;
  const capacityViolations = zoneIds.filter((z) => {
    const zz = zoneById.get(z);
    return zz?.capacity !== undefined && zz.occupancy > zz.capacity;
  }).length;

  // —— o TETO DO "FORA" (fechamento total, parcial ou nenhum) ————————————————————————————————————
  // `tagsMustBeInSomeZone` é açúcar de `foraCapacity: 0`. Sem nenhum dos dois, o "fora" é ILIMITADO —
  // o estado honesto de hoje, em que a exclusividade poda mas não entranha.
  const foraLimit: number = opts.tagsMustBeInSomeZone === true
    ? 0
    : Number.isFinite(opts.foraCapacity) && (opts.foraCapacity as number) >= 0
      ? Math.floor(opts.foraCapacity as number)
      : Number.POSITIVE_INFINITY;

  const diagnostics: AssignmentDiagnostics = {
    peopleCounted,
    tagsPresent,
    anonymousFloor: Math.max(0, peopleCounted - tagsPresent),
    tagsExceedPeople: Math.max(0, tagsPresent - peopleCounted),
    offRoster,
    pinnedNotDetected,
    capacityViolations,
    foraCapacity: Number.isFinite(foraLimit) ? foraLimit : "ilimitado",
    solutions: 0,
    budgetExceeded: false,
  };

  // —— domínios (as restrições 2/3/4 podam ANTES da busca) ————————————————————————————————————————
  const closure = foraLimit <= 0; // fechamento TOTAL: "fora" nem entra no domínio
  const domains: { token: TokenId; values: string[] }[] = [];
  for (const token of assignable) {
    const pin = pinOf.get(token);
    if (pin !== undefined) {
      domains.push({ token, values: [pin] }); // pino: destino único (e exclui o token das demais zonas)
      continue;
    }
    const near = input?.radio?.nearZones?.[token];
    const localized = Array.isArray(near) && near.length > 0 ? new Set(near) : undefined;
    const seen = input?.lastSeen?.[token];
    const values = zoneIds.filter((zid) => {
      const z = zoneById.get(zid);
      if (!z || z.occupancy <= 0) return false; // câmera não vê ninguém aqui: ninguém para identificar
      if (localized && !localized.has(zid)) return false; // locality do receptor (set-membership)
      if (seen && !reachable(input.topology, seen.zoneId, zid, ts - seen.ts)) return false; // continuidade
      return true;
    });
    if (!closure) values.push(FORA);
    if (values.length === 0) reasons.push(`token ${token}: nenhuma zona viável (locality/continuidade/ocupação)`);
    domains.push({ token, values });
  }

  if (reasons.length > 0) {
    return { kind: "inviavel", ts, reasons: [...new Set(reasons)].sort(sortStr), diagnostics };
  }

  // —— busca: enumera TODAS as atribuições viáveis (exclusividade é estrutural: 1 valor por operador) —
  // O "FORA" é apenas mais um place — com um TETO (`foraLimit`). Quando a planta o mede (as pessoas
  // que a câmera conta no corredor), a exclusividade passa a entranhar sem fingir fechamento perfeito.
  const limit = new Map<string, number>(zoneIds.map((z) => [z, zoneById.get(z)?.occupancy ?? 0]));
  limit.set(FORA, foraLimit);
  const count = new Map<string, number>(zoneIds.map((z) => [z, 0]));
  count.set(FORA, 0);
  const valuesSeen = new Map<TokenId, Set<string>>(domains.map((d) => [d.token, new Set<string>()]));
  const zoneMin = new Map<ZoneId, number>(zoneIds.map((z) => [z, Number.POSITIVE_INFINITY]));
  const zoneMax = new Map<ZoneId, number>(zoneIds.map((z) => [z, 0]));
  const chosen: string[] = new Array<string>(domains.length).fill(FORA);
  let solutions = 0;
  let nodes = 0;
  let budgetExceeded = false;

  const recordSolution = (): void => {
    solutions++;
    for (let i = 0; i < domains.length; i++) valuesSeen.get(domains[i].token)?.add(chosen[i]);
    for (const z of zoneIds) {
      const c = count.get(z) ?? 0;
      if (c < (zoneMin.get(z) ?? Number.POSITIVE_INFINITY)) zoneMin.set(z, c);
      if (c > (zoneMax.get(z) ?? 0)) zoneMax.set(z, c);
    }
  };

  const dfs = (i: number): void => {
    if (budgetExceeded) return;
    if (++nodes > budgetMax) {
      budgetExceeded = true;
      return;
    }
    if (i === domains.length) {
      recordSolution();
      return;
    }
    for (const v of domains[i].values) {
      const c = (count.get(v) ?? 0) + 1;
      // Nem a zona (teto = pessoas que a câmera vê nela) nem o FORA (teto = pessoas que a câmera vê
      // no corredor, ou ∞ sem planta) podem receber mais operadores do que comportam.
      if (c > (limit.get(v) ?? 0)) continue;
      count.set(v, c);
      chosen[i] = v;
      dfs(i + 1);
      count.set(v, c - 1);
      if (budgetExceeded) return;
    }
  };
  dfs(0);

  diagnostics.solutions = solutions;
  diagnostics.budgetExceeded = budgetExceeded;

  if (budgetExceeded) {
    // Sem entailment provado: cai para os DOMÍNIOS — superconjunto SÃO das soluções. Um operador só
    // continua `decidida` se o domínio dele já era único (o pino, tipicamente).
    for (const d of domains) valuesSeen.set(d.token, new Set(d.values));
    for (const z of zoneIds) {
      const forced = domains.filter((d) => d.values.length === 1 && d.values[0] === z).length;
      const admits = domains.filter((d) => d.values.includes(z)).length;
      zoneMin.set(z, forced);
      zoneMax.set(z, Math.min(limit.get(z) ?? 0, admits));
    }
  } else if (solutions === 0) {
    return {
      kind: "inviavel",
      ts,
      reasons: ["nenhuma atribuição satisfaz simultaneamente ocupação, exclusividade, locality e continuidade"],
      diagnostics,
    };
  }

  // —— saída: entailment (decidido) × ambiguidade (declarada) ————————————————————————————————————
  const placements: Placement[] = [];
  for (const d of domains) {
    const vs = [...(valuesSeen.get(d.token) ?? new Set<string>())];
    const zonesPoss = vs.filter((v) => v !== FORA).sort(sortStr);
    const foraPossivel = vs.includes(FORA);
    if (zonesPoss.length === 1 && !foraPossivel) {
      placements.push({
        kind: "decidida",
        token: d.token,
        zoneId: zonesPoss[0],
        via: pinOf.has(d.token) ? "pin" : "exclusao",
      });
    } else if (zonesPoss.length === 0) {
      placements.push({ kind: "fora", token: d.token });
    } else {
      placements.push({ kind: "ambigua", token: d.token, zones: zonesPoss, foraPossivel });
    }
  }
  for (const t of absent) placements.push({ kind: "ausente", token: t });
  placements.sort((a, b) => sortStr(a.token, b.token));

  const zones: ZoneAssignment[] = zoneIds.map((zid) => {
    const z = zoneById.get(zid);
    const occ = z?.occupancy ?? 0;
    const possible = domains.filter((d) => valuesSeen.get(d.token)?.has(zid)).map((d) => d.token).sort(sortStr);
    const certain = domains
      .filter((d) => {
        const vs = valuesSeen.get(d.token);
        return vs !== undefined && vs.size === 1 && vs.has(zid);
      })
      .map((d) => d.token)
      .sort(sortStr);
    const maxAssigned = Math.min(occ, zoneMax.get(zid) ?? 0);
    const minAssigned = Math.min(occ, Number.isFinite(zoneMin.get(zid) ?? 0) ? (zoneMin.get(zid) as number) : 0);
    return {
      zoneId: zid,
      occupancy: occ,
      certain,
      possible,
      // ANÔNIMO como destino legítimo: o que a câmera vê e o rádio/atribuição não explicam.
      anonymous: { min: Math.max(0, occ - maxAssigned), max: Math.max(0, occ - minAssigned) },
      capacityViolation: z?.capacity !== undefined && occ > z.capacity,
    };
  });

  return { kind: "ok", ts, placements, zones, diagnostics };
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Ponte com a CONSERVAÇÃO (o que sobreviveu do core da Onda 2)
// ————————————————————————————————————————————————————————————————————————————————————————————————

/**
 * Converte o estado conservado (`conserveIdentities`) nas observações de zona da atribuição.
 *
 * `occupancy` vem do BALANÇO de fronteira (é o que sustenta L0/L1 sem identidade nenhuma).
 * `pinned` só recebe os tokens de zonas cujo conjunto NÃO é superconjunto (`supersetTokens === false`):
 * quando a conservação já declarou que o conjunto é um SUPERCONJUNTO (houve saída ambígua), ela não
 * sabe que aqueles tokens ainda estão lá — e um pino falso é pior que nenhum pino. O token
 * "possivelmente ainda ali" volta a ser um candidato comum, e a atribuição decide (ou declara ambíguo).
 */
export function zoneObservationsFromConservation(
  result: Pick<ConservationResult, "places">,
  places: readonly Place[] = [],
): ZoneObservation[] {
  const capacity = new Map<ZoneId, number | undefined>();
  for (const p of places) {
    if (p?.zone?.id) capacity.set(p.zone.id, Number.isFinite(p.capacity) ? p.capacity : undefined);
  }
  return (result?.places ?? [])
    .map((pl) => ({
      zoneId: pl.zoneId,
      occupancy: pl.occupancy,
      capacity: capacity.get(pl.zoneId),
      pinned: pl.supersetTokens ? [] : [...pl.tokens].sort(sortStr),
    }))
    .sort((a, b) => sortStr(a.zoneId, b.zoneId));
}
