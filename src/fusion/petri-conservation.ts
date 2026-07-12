// CONSERVAÇÃO de identidade por zona — a camada 3 do ADR-014 (places=zonas, tokens=operadores,
// transições=cruzamentos de fronteira). Lógica PURA e determinística; sem DOM, sem rede, sem tracker.
//
// POR QUE ESTA CAMADA É PORTANTE (não decorativa): o gate das Ondas 0/1 mediu o TETO da identidade
// por RSSI — ~15,5% dos episódios, no melhor caso (tag a 2 Hz, aproximação longa). Logo ≥84,5% dos
// episódios NÃO terão identidade por CORRELAÇÃO de RSSI em cadência nenhuma. Esses 84,5% só podem
// receber identidade de fontes INDEPENDENTES da correlação: a TOPOLOGIA (este módulo), o CONJUNTO DE
// TAGS PRESENTES e as restrições de atribuição (`zone-assignment.ts`).
//
// ATENÇÃO — RETRATAÇÃO (2026-07-12): a segunda fonte prevista aqui era o PRIOR DE WORKFLOW. O dono
// respondeu: **o operador circula LIVRE**. Não há sequência esperada ⇒ o prior de rota morreu e foi
// REMOVIDO deste arquivo (ver o bloco RETRATAÇÃO no fim). O que sobrevive deste core — ocupação por
// balanço, capacidade como sensor, token segurado na morte de track (CA-2) e ambiguidade explícita —
// segue VALENDO e é o que sustenta L0/L1 SEM identidade nenhuma. Ver
// `docs/cientifica/onda2-conservacao-workflow-spec.md`.
//
// O QUE "PETRI" SIGNIFICA AQUI (YAGNI, CLAUDE.md §2): contabilidade de CONJUNTOS por zona com
// transições de fronteira. NÃO é um motor genérico de redes de Petri (sem arcos com peso, sem
// inibidores, sem alcançabilidade, sem solver). Abstração só no 3º caso.
//
// A PRECISÃO QUE NÃO PODE SER PERDIDA (ADR-014, 2º revisor): a conservação preserva o **CONJUNTO**
// de identidades presentes numa zona — NÃO o vínculo individual track↔pessoa. Com UMA pessoa por
// posto (regra Δ1: zonas na granularidade do POSTO), o conjunto DETERMINA a identidade. Com N, a
// topologia conserva {A,B,C} mas não decide qual track novo é qual. Este módulo **expõe** essa
// ambiguidade no tipo de retorno (`Identity.kind === "ambigua"`) em vez de escondê-la num chute —
// rótulo errado é pior que nenhum (invariante do arco).
//
// INVARIANTE HERDADA de zone-crossing.ts: **morte de track NÃO decrementa ocupação** (decrementar
// seria confiar no tracker, exatamente o que a H2 rejeita). A ocupação move-se só pelo BALANÇO de
// FRONTEIRA. É isso que carrega a identidade através da morte do track.
//
// Responsabilidade única: manter, por zona, o conjunto de tokens presentes e a ocupação por balanço;
// e resolver (ou declarar ambígua) a identidade de um track. Não detecta fronteira (zone-crossing.ts
// faz), não associa tag↔track (associate.ts faz), não decide estado operacional (Onda 3).

import { trackZoneEvents, type Zone, type ZoneEvent, type ZoneSample } from "./zone-crossing";

export type TokenId = string;
export type TrackId = string;

/** Um `ZoneEvent` com o track que o gerou — a fronteira é observada POR TRACK; a conservação é
 *  contabilizada POR ZONA. É o único acréscimo ao contrato de `zone-crossing.ts`. */
export type TrackZoneEvent = ZoneEvent & { trackId: TrackId };

/** Vínculo track→identidade vindo de FORA (camada 2: correlação BLE, scanner, botão, ReID...).
 *  A conservação não produz claims — ela os CONSOME e os propaga pela topologia. */
export type IdentityClaim = { ts: number; trackId: TrackId; token: TokenId };

/** Place da rede: uma zona (`zone-crossing.ts`) + a capacidade DECLARADA do posto. `capacity: 1` é a
 *  regra Δ1 do ADR-014 (zona na granularidade do posto). A capacidade NÃO altera a resolução —
 *  serve de sensor de saúde (`capacityViolations`): estourou = duas pessoas no posto OU track
 *  espúrio, e quem decide é o humano. */
export type Place = { zone: Zone; capacity?: number };

/** O que a conservação sabe sobre a identidade de um track.
 *  - `resolvida`: um token único. `via: "claim"` = alguém de fora disse; `via: "conservacao"` = a
 *    TOPOLOGIA deduziu (o conjunto da zona tinha um só candidato) — este é o ganho da camada 3.
 *  - `ambigua`: o conjunto está conservado, o VÍNCULO INDIVIDUAL não. `candidates` são os tokens que
 *    ele pode ser; `anonymousPossible` = há ocupante sem identidade na zona, então ele pode não ser
 *    nenhum dos candidatos. Não colapsar isto num chute.
 *  - `desconhecida`: nem claim, nem candidato. */
export type Identity =
  | { kind: "resolvida"; token: TokenId; via: "claim" | "conservacao" }
  | { kind: "ambigua"; zoneId: string; candidates: TokenId[]; anonymousPossible: boolean }
  | { kind: "desconhecida" };

/** Uma mudança de resolução de identidade, datada — o log determinístico do que a topologia decidiu. */
export type Resolution = { ts: number; trackId: TrackId; zoneId: string; identity: Identity };

/** Estado conservado de uma zona. `tokens.length` pode ser MAIOR que os ocupantes identificados
 *  (`occupancy − anonymous`) quando uma saída ambígua ocorreu: sabe-se que um saiu, não QUEM — o
 *  conjunto vira um SUPERCONJUNTO declarado (`supersetTokens`), nunca um palpite. */
export type PlaceState = {
  zoneId: string;
  /** Tokens que PODEM estar na zona, ordenados. Superconjunto se `supersetTokens`. */
  tokens: TokenId[];
  /** Ocupantes pelo BALANÇO de fronteira (≥ 0; nunca decrementado por morte de track). */
  occupancy: number;
  /** Ocupantes sem identidade alguma (entraram/nasceram sem claim). Veneno da determinação. */
  anonymous: number;
  /** `tokens.length > occupancy − anonymous` — houve saída ambígua; o conjunto é superconjunto. */
  supersetTokens: boolean;
  /** Vezes que a ocupação passou da capacidade declarada do posto (sensor de saúde). */
  capacityViolations: number;
};

/** Contadores de SAÚDE da conservação (o que o balanço puro de fronteira não vê — os riscos que o
 *  cabeçalho de zone-crossing.ts declara, aqui MEDIDOS). */
export type ConservationDiagnostics = {
  /** Nascidos-dentro ABSORVIDOS por um ocupante já contado (a re-detecção de quem já estava — o
   *  caso que a conservação existe para NÃO contar duas vezes). */
  bornInsideAbsorbed: number;
  /** Nascidos-dentro sem ocupante disponível: a fronteira NUNCA viu essa entrada (pessoa já presente
   *  no início da observação, ou cruzamento perdido). Vira ocupante novo — e este contador é o preço. */
  bornInsideNew: number;
  /** Tokens SEGURADOS através da morte de um track (o núcleo da H2). */
  diedInsideHeld: number;
  /** Saídas de track com identidade ambígua — cada uma degrada o conjunto da zona a superconjunto. */
  ambiguousExits: number;
  /** "saiu" com ocupação já 0: a fronteira perdeu a entrada correspondente. Clampado em 0. */
  negativeBalance: number;
};

export type ConservationResult = {
  /** Estado final por zona, ordenado por `zoneId`. */
  places: PlaceState[];
  /** Última identidade conhecida de cada track (inclusive dos que já morreram/saíram). */
  identities: Record<TrackId, Identity>;
  /** Log de MUDANÇAS de resolução, em ordem de ts. */
  resolutions: Resolution[];
  /** Última zona conhecida de cada token — o HOOK do prior de workflow (§CA-11 da spec). */
  lastZone: Record<TokenId, string>;
  diagnostics: ConservationDiagnostics;
};

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Ponte tracks → eventos (adapter fino; a fronteira continua sendo responsabilidade de zone-crossing)
// ————————————————————————————————————————————————————————————————————————————————————————————————

/** Um track observado: id + a série do PÉ (já no espaço em que os polígonos das zonas vivem). */
export type TrackSamples = { trackId: TrackId; samples: readonly ZoneSample[] };

/**
 * Roda `trackZoneEvents` (zone-crossing.ts) de cada track contra cada zona e etiqueta o `trackId`.
 * Único ponto de contato com a geometria — a conservação em si só vê eventos.
 * Saída ordenada por ts (estável), pronta para `conserveIdentities`.
 */
export function buildTrackZoneEvents(
  tracks: readonly TrackSamples[],
  places: readonly Place[],
  opts?: { confirmTicks?: number },
): TrackZoneEvent[] {
  const out: TrackZoneEvent[] = [];
  for (const t of tracks) {
    for (const p of places) {
      for (const e of trackZoneEvents(t.samples, p.zone, opts)) out.push({ ...e, trackId: t.trackId });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// Núcleo da conservação
// ————————————————————————————————————————————————————————————————————————————————————————————————

type MutPlace = {
  zoneId: string;
  capacity?: number;
  tokens: Set<TokenId>;
  occupancy: number;
  anonymous: number;
  capacityViolations: number;
  /** Tracks VIVOS dentro da zona (o tracker os enxerga agora). Ocupantes sem track vivo são
   *  exatamente os que a conservação está SEGURANDO. */
  live: Set<TrackId>;
};

const EVENT_ORDER: Record<ZoneEvent["kind"], number> = {
  // Numa colisão de ts, processa a saída ANTES da entrada: quem sai libera a vaga de quem entra
  // (evita um falso estouro de capacidade em troca de posto instantânea). Ordem fixa = determinismo.
  saiu: 0,
  "morreu-dentro": 1,
  entrou: 2,
  "nasceu-dentro": 3,
};

type Step =
  | { ts: number; order: number; seq: number; claim: IdentityClaim; ev?: undefined }
  | { ts: number; order: number; seq: number; ev: TrackZoneEvent; claim?: undefined };

const sameIdentity = (a: Identity | undefined, b: Identity): boolean => {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === "resolvida" && b.kind === "resolvida") return a.token === b.token && a.via === b.via;
  if (a.kind === "ambigua" && b.kind === "ambigua")
    return (
      a.zoneId === b.zoneId &&
      a.anonymousPossible === b.anonymousPossible &&
      a.candidates.length === b.candidates.length &&
      a.candidates.every((t, i) => t === b.candidates[i])
    );
  return true; // desconhecida === desconhecida
};

/**
 * Dobra eventos de fronteira (+ claims externos) em ESTADO CONSERVADO por zona.
 *
 * Regras (todas derivadas do ADR-014, camada 3 — nenhuma heurística nova):
 *   - "entrou": ocupação +1; se o track tem token, o token entra no conjunto; senão vira ANÔNIMO.
 *   - "saiu":   ocupação −1 (clamp 0); token do track sai do conjunto SE a identidade era resolvida;
 *               se era ambígua, NENHUM token sai (não se sabe qual) → o conjunto vira SUPERCONJUNTO.
 *   - "morreu-dentro": ocupação INALTERADA — o token fica SEGURADO na zona (o núcleo da H2).
 *   - "nasceu-dentro": se há ocupante sem track vivo, o novo track o ABSORVE (sem dupla-contagem) e
 *               herda a identidade pela topologia; se não há, é ocupante NOVO (a fronteira nunca o viu).
 *   - Resolução: candidatos = tokens da zona ainda não ligados a outro track VIVO. Um candidato único
 *               E zero anônimos ⇒ RESOLVIDA por conservação. Caso contrário ⇒ AMBÍGUA (explícita).
 *
 * Determinístico: ordena por (ts, ordem de tipo) com desempate estável pela ordem de entrada; emite
 * conjuntos ordenados. Sem NaN: só contadores inteiros com clamp — entradas com ts não-finito são
 * descartadas (não podem ser ordenadas com honestidade).
 */
export function conserveIdentities(
  events: readonly TrackZoneEvent[],
  places: readonly Place[],
  claims: readonly IdentityClaim[] = [],
): ConservationResult {
  const byId = new Map<string, MutPlace>();
  for (const p of places) {
    if (!p?.zone?.id || byId.has(p.zone.id)) continue;
    byId.set(p.zone.id, {
      zoneId: p.zone.id,
      capacity: Number.isFinite(p.capacity) ? p.capacity : undefined,
      tokens: new Set(),
      occupancy: 0,
      anonymous: 0,
      capacityViolations: 0,
      live: new Set(),
    });
  }

  const steps: Step[] = [];
  let seq = 0;
  for (const c of claims ?? []) {
    if (!c || !Number.isFinite(c.ts) || !c.trackId || !c.token) continue;
    // Claim ANTES dos eventos do mesmo ts: a identidade conhecida deve informar o cruzamento, não
    // chegar depois dele (senão uma entrada identificada seria contada como anônima e "corrigida").
    steps.push({ ts: c.ts, order: -1, seq: seq++, claim: c });
  }
  for (const e of events ?? []) {
    if (!e || !Number.isFinite(e.ts) || !e.trackId || !byId.has(e.zoneId)) continue;
    steps.push({ ts: e.ts, order: EVENT_ORDER[e.kind] ?? 9, seq: seq++, ev: e });
  }
  steps.sort((a, b) => a.ts - b.ts || a.order - b.order || a.seq - b.seq);

  const claimed = new Map<TrackId, TokenId>(); // token afirmado de FORA (camada 2)
  const bound = new Map<TrackId, TokenId>(); // token que o track ocupa hoje (claim OU conservação)
  const trackZone = new Map<TrackId, string>(); // zona onde o track está VIVO agora
  const identities: Record<TrackId, Identity> = {};
  const resolutions: Resolution[] = [];
  const lastZone: Record<TokenId, string> = {};
  const diag: ConservationDiagnostics = {
    bornInsideAbsorbed: 0,
    bornInsideNew: 0,
    diedInsideHeld: 0,
    ambiguousExits: 0,
    negativeBalance: 0,
  };

  const bumpCapacity = (pl: MutPlace) => {
    if (pl.capacity !== undefined && pl.occupancy > pl.capacity) pl.capacityViolations++;
  };

  /** Tokens da zona ainda não ligados a NENHUM track vivo — os que a conservação está segurando. */
  const freeCandidates = (pl: MutPlace, self: TrackId): TokenId[] => {
    const taken = new Set<TokenId>();
    for (const t of pl.live) {
      if (t === self) continue;
      const tok = bound.get(t);
      if (tok !== undefined) taken.add(tok);
    }
    return [...pl.tokens].filter((tk) => !taken.has(tk)).sort();
  };

  const setIdentity = (ts: number, trackId: TrackId, zoneId: string, next: Identity) => {
    if (sameIdentity(identities[trackId], next)) return;
    identities[trackId] = next;
    resolutions.push({ ts, trackId, zoneId, identity: next });
  };

  /** Resolve a identidade de um track DENTRO da zona: claim > conservação (candidato único e sem
   *  anônimo) > ambígua (conjunto conservado, vínculo não) > desconhecida. */
  const resolveInside = (ts: number, trackId: TrackId, pl: MutPlace) => {
    const claim = claimed.get(trackId);
    if (claim !== undefined) {
      bound.set(trackId, claim);
      lastZone[claim] = pl.zoneId;
      setIdentity(ts, trackId, pl.zoneId, { kind: "resolvida", token: claim, via: "claim" });
      return;
    }
    const candidates = freeCandidates(pl, trackId);
    if (candidates.length === 1 && pl.anonymous === 0) {
      const token = candidates[0];
      bound.set(trackId, token);
      lastZone[token] = pl.zoneId;
      setIdentity(ts, trackId, pl.zoneId, { kind: "resolvida", token, via: "conservacao" });
      return;
    }
    bound.delete(trackId);
    if (candidates.length === 0) {
      setIdentity(ts, trackId, pl.zoneId, { kind: "desconhecida" });
      return;
    }
    setIdentity(ts, trackId, pl.zoneId, {
      kind: "ambigua",
      zoneId: pl.zoneId,
      candidates,
      anonymousPossible: pl.anonymous > 0,
    });
  };

  for (const st of steps) {
    if (st.claim) {
      const { trackId, token, ts } = st.claim;
      claimed.set(trackId, token);
      const zid = trackZone.get(trackId);
      const pl = zid !== undefined ? byId.get(zid) : undefined;
      if (!pl) continue; // track fora de zona: o claim fica registrado e vale quando ele entrar
      // O track estava dentro sem token confirmado → ele era um dos anônimos, ou ocupava um token
      // conservado. Se o token é NOVO na zona, o ocupante anônimo dele acabou de ganhar nome.
      if (!pl.tokens.has(token)) {
        pl.tokens.add(token);
        if (pl.anonymous > 0) pl.anonymous--;
      }
      resolveInside(ts, trackId, pl);
      continue;
    }

    const ev = st.ev;
    const pl = byId.get(ev.zoneId);
    if (!pl) continue;
    const { trackId, ts } = ev;

    if (ev.kind === "entrou") {
      if (trackZone.get(trackId) === pl.zoneId) continue; // já contado dentro — não conta duas vezes
      pl.live.add(trackId);
      trackZone.set(trackId, pl.zoneId);
      pl.occupancy++;
      const claim = claimed.get(trackId);
      if (claim !== undefined) {
        if (!pl.tokens.has(claim)) pl.tokens.add(claim);
      } else {
        pl.anonymous++; // entrou pela fronteira SEM identidade: ocupante anônimo (honesto)
      }
      bumpCapacity(pl);
      resolveInside(ts, trackId, pl);
      continue;
    }

    if (ev.kind === "nasceu-dentro") {
      if (trackZone.get(trackId) === pl.zoneId) continue;
      // Ocupantes SEM track vivo = os que a conservação segura. Se há vaga, este track novo é a
      // re-detecção de um deles → NÃO incrementa ocupação (é exatamente a dupla-contagem a evitar).
      const unbound = pl.occupancy - pl.live.size;
      pl.live.add(trackId);
      trackZone.set(trackId, pl.zoneId);
      if (unbound >= 1) {
        diag.bornInsideAbsorbed++;
        const claim = claimed.get(trackId);
        if (claim !== undefined && !pl.tokens.has(claim)) {
          pl.tokens.add(claim);
          if (pl.anonymous > 0) pl.anonymous--;
        }
      } else {
        diag.bornInsideNew++; // a fronteira NUNCA viu esta entrada
        pl.occupancy++;
        const claim = claimed.get(trackId);
        if (claim !== undefined) {
          if (!pl.tokens.has(claim)) pl.tokens.add(claim);
        } else {
          pl.anonymous++;
        }
        bumpCapacity(pl);
      }
      resolveInside(ts, trackId, pl);
      continue;
    }

    if (ev.kind === "morreu-dentro") {
      if (trackZone.get(trackId) !== pl.zoneId) continue;
      pl.live.delete(trackId);
      trackZone.delete(trackId);
      // OCUPAÇÃO INALTERADA e TOKEN MANTIDO no conjunto: é a H2 — a identidade sobrevive à morte do
      // track. Só o VÍNCULO track↔token morre (o track não existe mais).
      if (bound.has(trackId)) diag.diedInsideHeld++;
      bound.delete(trackId);
      continue;
    }

    // "saiu" — o único evento que retira identidade da zona.
    if (trackZone.get(trackId) !== pl.zoneId) {
      // A fronteira viu sair quem a conservação não tinha dentro: entrada perdida.
      diag.negativeBalance++;
      continue;
    }
    pl.live.delete(trackId);
    trackZone.delete(trackId);
    if (pl.occupancy > 0) pl.occupancy--;
    else diag.negativeBalance++;

    const token = bound.get(trackId);
    const ident = identities[trackId];
    if (token !== undefined) {
      pl.tokens.delete(token);
      lastZone[token] = pl.zoneId; // a última zona CONHECIDA do operador — o hook do prior de workflow
      bound.delete(trackId);
    } else if (ident && ident.kind === "ambigua") {
      // Saiu ALGUÉM do conjunto, não se sabe QUEM → nenhum token é removido: o conjunto passa a ser
      // um SUPERCONJUNTO declarado (supersetTokens). Chutar aqui seria fabricar rótulo errado.
      diag.ambiguousExits++;
    } else if (pl.anonymous > 0) {
      pl.anonymous--; // saiu um ocupante sem identidade
    }
  }

  const out: PlaceState[] = [...byId.values()]
    .map((pl) => {
      const tokens = [...pl.tokens].sort();
      const identified = Math.max(0, pl.occupancy - pl.anonymous);
      return {
        zoneId: pl.zoneId,
        tokens,
        occupancy: pl.occupancy,
        anonymous: pl.anonymous,
        supersetTokens: tokens.length > identified,
        capacityViolations: pl.capacityViolations,
      };
    })
    .sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0));

  return { places: out, identities, resolutions, lastZone, diagnostics: diag };
}

// ————————————————————————————————————————————————————————————————————————————————————————————————
// RETRATAÇÃO — o prior de WORKFLOW foi REMOVIDO daqui (2026-07-12)
// ————————————————————————————————————————————————————————————————————————————————————————————————
//
// Este arquivo exportava `workflowPrior()` + `WorkflowModel` (matriz P(próximo posto|posto atual)).
// As respostas de domínio do dono REFUTARAM a premissa: **o operador circula LIVRE no turno** — não
// existe sequência esperada. Uma matriz de transição uniforme é INFORMAÇÃO ZERO, e as mesas são todas
// adjacentes (sem zeros estruturais). O mecanismo estava correto e testado; o MODELO que ele
// consumiria não existe e não vai existir. Manter a função seria manter um knob que só sabe devolver
// uniforme — ruído com aparência de capacidade. Removido, não rebaixado (CLAUDE.md §5, Signal×Noise).
//
// O que ficou no lugar: `zone-assignment.ts` (atribuição operador↔zona sob as 4 restrições que
// SOBREVIVERAM). `lastZone` (acima) NÃO morreu — deixou de alimentar o prior de rota e passou a
// alimentar a CONTINUIDADE FÍSICA da atribuição (de onde ele veio, e se dá tempo de chegar aqui).
//
// Proveniência completa: `docs/cientifica/onda2-conservacao-workflow-spec.md` §2.
