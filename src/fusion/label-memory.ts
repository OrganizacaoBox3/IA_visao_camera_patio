// Política de MEMÓRIA sobre a crença tag↔track — camada ACIMA do associador (associate.ts), que
// esta unidade NÃO toca (ver docs/cientifica/escopo-persistencia-rotulo.md, "Framing"). O associador
// decide, a cada tick, "quem é" com a evidência daquele instante; esta camada decide POR QUANTO TEMPO
// uma decisão confiante do associador continua VALENDO depois que a evidência fresca acaba — troca a
// unidade de cobertura de "por tick" para "por experiência" (uma pessoa parada por 10s não devia
// precisar ser re-provada 20 vezes).
//
// MÁQUINA DE ESTADOS (mínima, por track): candidata → confirmada → memória → {confirmada, quebra}.
// candidata = ainda não vimos evidência suficiente pra confiar; confirmada = rótulo falando fresco
// agora; memória = rótulo confirmado sem fala fresca no momento, ainda exibido (distinto na UI —
// ver escopo, "Honestidade visual"); quebra = crença descartada, volta a candidata (ou o track morre
// de vez, ver abaixo).
//
// MORDIDA 1 (revisão do especialista, 2026-07-10): "sem conflito" na transição candidata→confirmada
// é LOCAL ao par (track,tag) — reusa `Assignment.hadConflict`, JÁ calculado por par escolhido dentro
// de assign() (associate.ts), não o `conflictRate` agregado de tick (identity-metrics.ts). Exigir
// "nenhum conflito em NENHUM outro track no mesmo tick" tornaria a confirmação quase inatingível em
// multidão (conflictRate medido: 90-98% dos ticks em cenários de multidão) — a confirmação de A não
// pode depender de B e C disputarem um track do outro lado da cena. Usar `hadConflict` como já vem
// (por par) é reaproveitar instrumentação existente, não inventar lógica nova.
//
// MORDIDA 3 (fonte do parâmetro `memoryTimeoutMs`): a curva de reliability (Frente A) calibra
// CONFIANÇA DE ENTRADA (quando confiar o suficiente pra falar) — não tem informação sobre QUANTO
// TEMPO uma crença sobrevive sem evidência fresca num mundo onde o tracker troca de identidade. A
// fonte correta é a mineração de fragmentação de tracks (docs/analises/tags-bluetooth/PENDENCIAS.md,
// item 10): candidato v1 ~12s (zona mediana-a-p75 medida, ordem de grandeza — não valor definitivo).
//
// DECISÕES v1 EXPLÍCITAS (documentadas aqui para não virarem acidente de implementação — ver escopo,
// "Decisões v1 explícitas"):
//  - `confirmMargin` (0.4) é MAIS ESTRITO que o `minMargin` de FALA do associador (0.1 por default):
//    persistir uma crença por segundos é uma aposta maior que falar num único tick — o bar de entrada
//    é o início do bin "alta confiança" do reliability diagram (RELIABILITY_BIN_EDGES[2] em
//    identity-metrics.ts), não o piso mínimo de fala.
//  - Uma vez CONFIRMADA, continuar concordando (mesma tag) NÃO precisa re-limpar `confirmMargin` a
//    cada tick — só ENTRAR exige o bar alto; permanecer exige só não ser contradito. Do contrário a
//    persistência derrotaria o próprio propósito (re-exigir prova forte a cada 500ms de novo).
//  - Reentrada `memória → confirmada` usa o MESMO `confirmMargin`/qualificação de entrada
//    (nenhuma assimetria "porque já era confirmado antes" — assimetria não-documentada seria viés).
//  - Contradição SUSTENTADA (mesma régua de N ticks que a confirmação, `contradictTicks`) quebra a
//    crença; contradição FRACA (não qualificada — abaixo da margem ou com conflito local) NÃO derruba
//    ativamente em v1 — cai para "evidência sumiu" (memória) e o `memoryTimeoutMs` é o único backstop.
//    Erosão gradual de confiança fica para v2 (fora de escopo — sem dado ainda pra calibrar).
//  - Morte de track: a AUSÊNCIA do trackId no array de assignments de um tick é o sinal — o
//    associador só devolve Assignment para tracks CORRENTES (ver docstring de assign()), então por
//    esta altura o rastreador upstream (ByteTrack) já esgotou sua própria tolerância a flicker.
//    Quebra IMEDIATA (a crença é removida, não vira "candidata zumbi" esperando um id que não volta).
//
// LIMITAÇÃO ESTRUTURAL REGISTRADA (Mordida 2 — sentinela dupla): esta camada NÃO detecta troca
// SILENCIOSA de identidade do tracker durante `memória` (posições contínuas, sem salto físico
// detectável) — é exatamente o pior caso que a sentinela dedicada (fora deste módulo, no harness)
// precisa injetar antes do torneio. Este módulo não tem acesso a posição/velocidade do track (só ao
// que `Assignment` carrega); o proxy de "salto físico impossível" fica no chamador (harness/sim),
// que pode alimentar uma quebra externa chamando `reset()`/removendo o track da política se detectar
// o salto — não implementado aqui de propósito (responsabilidade única: só a política de memória).
//
// RETUNING v2 (ADITIVO, prescrição do especialista pós-torneio v1 — ver persistence-tournament
// .test.ts, "ACHADO HONESTO", e regime-reliability.ts): a barra "margem ≥ confirmMargin por
// confirmTicks" NUNCA fecha em multidão (margens comprimidas no regime denso). Com `confirmPolicy`
// presente, a barra de confirmação vira "PRECISÃO-IMPLICADA ≥ pStar por K ticks de fala
// qualificada" — a precisão que aquela margem historicamente ENTREGOU naquele REGIME
// (denso/esparso, curva estratificada de regime-reliability.ts). A adaptatividade EMERGE da
// condicionalização (nenhum knob "modo multidão").
//  - EMENDA v2 (janela LIMPA, `cleanWindow`): nenhum tick com hadConflict local true entre os K
//    ticks que fecham a confirmação. TRADUÇÃO DOCUMENTADA: a formulação original do especialista
//    pedia "sem proximidade física <0,4m na janela", mas esta política só vê Assignments — não tem
//    posição. `hadConflict` local (≥2 candidatos competitivos pro mesmo track — associate.ts) é o
//    proxy OBSERVÁVEL da mesma situação (disputa real por identidade); é a tradução usada aqui.
//  - O REGIME do tick chega pela `context` de step() (ADITIVO): `{ candidates }` = nº de
//    assignments avaliáveis do tick (observável em produção — é o tamanho do array). `context`
//    AUSENTE = regime esparso (documentado: chamador antigo sem instrumentação cai no regime cuja
//    curva se parece com a barra v1 — margens altas exigidas — e nunca ganha confirmação "de
//    graça" pelo caminho denso).
//  - Reentrada memória→confirmada usa a MESMA qualificação (sem assimetria — mesma regra do v1).
//  - Default (sem `confirmPolicy`) = comportamento v1 BYTE-IDÊNTICO (mesma matemática, mesmos
//    números) — os PINS de persistence-tournament.test.ts não mudam.
//  - CALIBRAÇÃO: a curva usada aqui é SINTÉTICA por enquanto (replay da suíte fixa) — exploração
//    de forma; nenhum default é promovido até a curva ter âncora real (ver regime-reliability.ts).
//
// Responsabilidade única: só a máquina de estados. Não mede (cobertura de experiência/erro-segundos/
// latência de correção vivem numa métrica separada, consumindo a saída daqui + verdade). Não sabe de
// UI, socket, nem React — mesmo padrão de associate.ts.

import type { Assignment } from "./associate";
import { impliedPrecision, tickRegime } from "./regime-reliability";
import type { RegimeReliabilityCurve } from "./regime-reliability";

export type MemoryState = "candidata" | "confirmada" | "memoria";

export type MemoryBelief = {
  trackId: number;
  state: MemoryState;
  /** Rótulo confirmado/lembrado — null em `candidata` (ainda não há crença a exibir). */
  label: string | null;
  /** true = `confirmada` (fala fresca agora); false = `memoria` (rótulo exibido sem fala fresca) ou
   *  `candidata` (nenhum rótulo). Consumido pela UI pra distinguir visualmente (escopo, "Honestidade
   *  visual") e pela métrica de erro-segundos (decomposição por estado de origem). */
  isFresh: boolean;
};

/** Barra de confirmação v2 (retuning — ver header, "RETUNING v2"): substitui a dupla
 *  (confirmMargin, confirmTicks) por "impliedPrecision(regime do tick, margem) ≥ pStar por K
 *  ticks consecutivos de fala qualificada". A curva viaja aqui dentro (calibrada FORA — a política
 *  não constrói curva, só consulta). */
export type ConfirmPolicy = {
  curve: RegimeReliabilityCurve;
  /** Precisão-implicada mínima pra um tick de fala contar como qualificado. */
  pStar: number;
  /** Nº de ticks CONSECUTIVOS qualificados (mesma tag) pra confirmar — o K da grade. */
  k: number;
  /** Emenda v2 (janela LIMPA): exige hadConflict local false em TODOS os K ticks — ver header. */
  cleanWindow: boolean;
};

export type MemoryConfig = {
  /** Margem mínima (Assignment.margin) pra uma fala contar como "qualificada" pra confirmar/reentrar
   *  /contradizer. Mais estrito que o minMargin de FALA do associador — ver header. */
  confirmMargin?: number;
  /** Nº de ticks CONSECUTIVOS de fala qualificada com a MESMA tag pra sair de candidata. */
  confirmTicks?: number;
  /** Nº de ticks CONSECUTIVOS de fala qualificada com OUTRA tag (contradição confiante) pra quebrar
   *  uma crença confirmada/em memória. */
  contradictTicks?: number;
  /** Tempo (ms) em `memoria` sem reentrada nem contradição sustentada até quebrar (candidata). */
  memoryTimeoutMs?: number;
  /** ADITIVO (retuning v2): quando presente, SUBSTITUI a barra (confirmMargin, confirmTicks) pela
   *  barra condicionada ao regime — ver header. Ausente = comportamento v1 byte-idêntico. */
  confirmPolicy?: ConfirmPolicy;
};

type ResolvedConfig = Required<Omit<MemoryConfig, "confirmPolicy">> &
  Pick<MemoryConfig, "confirmPolicy">;

const DEFAULTS: Required<Omit<MemoryConfig, "confirmPolicy">> = {
  confirmMargin: 0.4, // início do bin "alta confiança" do reliability diagram — ver header
  confirmTicks: 3,
  contradictTicks: 3,
  memoryTimeoutMs: 12000, // candidato da mineração de fragmentação — ver header (Mordida 3)
};

type TrackRecord = {
  state: MemoryState;
  label: string | null;
  streakTag: string | null;
  streak: number;
  contradictTag: string | null;
  contradictStreak: number;
  memoriaSinceTs: number | null;
};

function freshRecord(): TrackRecord {
  return {
    state: "candidata",
    label: null,
    streakTag: null,
    streak: 0,
    contradictTag: null,
    contradictStreak: 0,
    memoriaSinceTs: null,
  };
}

/** Fala "qualificada" (v1): tag falada (não-abstenção), sem conflito LOCAL (Mordida 1) e com margem
 *  no bin de alta confiança. Assignment sem instrumentação (margin/hadConflict ausentes, ex.: saída
 *  antiga) nunca qualifica — default conservador (documentado): não confirma/contradiz sem medir. */
function qualified(a: Assignment, confirmMargin: number): boolean {
  return a.tag !== null && a.hadConflict !== true && (a.margin ?? 0) >= confirmMargin;
}

/** Régua EFETIVA de um tick: o predicado de qualificação + os limiares que a máquina de estados
 *  usa neste tick. Com `confirmPolicy` o predicado é o v2 (precisão-implicada condicionada ao
 *  regime do tick — por isso a régua é POR TICK, não por instância); sem, é o v1 byte-idêntico. */
type TickPolicy = {
  qualifies: (a: Assignment) => boolean;
  confirmTicks: number;
  contradictTicks: number;
  memoryTimeoutMs: number;
};

/** Avança UM track por UM tick (função de módulo, não método — testável isolada da classe). */
function advance(rec: TrackRecord, a: Assignment, ts: number, cfg: TickPolicy): void {
  const q = cfg.qualifies(a);

  if (rec.state === "candidata") {
    if (q) {
      if (rec.streakTag === a.tag) rec.streak++;
      else {
        rec.streakTag = a.tag;
        rec.streak = 1;
      }
      if (rec.streak >= cfg.confirmTicks) {
        rec.state = "confirmada";
        rec.label = a.tag;
        rec.streak = 0;
        rec.streakTag = null;
      }
    } else {
      rec.streak = 0;
      rec.streakTag = null;
    }
    return;
  }

  if (rec.state === "confirmada") {
    if (a.tag === rec.label) {
      // concordância (mesmo fraca) mantém fresco — ver header, "permanecer não exige re-limpar a barra".
      rec.contradictTag = null;
      rec.contradictStreak = 0;
      return;
    }
    if (q) {
      // discordância CONFIANTE — contradição candidata a quebra (precisa sustentar, ver header).
      advanceContradiction(rec, a, cfg);
      return;
    }
    // evidência fresca sumiu (abstenção ou fala fraca/ambígua, não confiante o bastante pra contradizer).
    rec.state = "memoria";
    rec.memoriaSinceTs = ts;
    return;
  }

  // rec.state === "memoria"
  if (q && a.tag === rec.label) {
    rec.state = "confirmada";
    rec.memoriaSinceTs = null;
    rec.contradictTag = null;
    rec.contradictStreak = 0;
    return;
  }
  if (q) {
    advanceContradiction(rec, a, cfg);
    if (rec.state !== "memoria") return; // quebrou (ou virou confirmada de outra tag) dentro de advanceContradiction
  }
  // timeout: única saída pra contradição FRACA ou ausência de evidência (v1 — ver header).
  if (rec.memoriaSinceTs !== null && ts - rec.memoriaSinceTs >= cfg.memoryTimeoutMs) {
    rec.state = "candidata";
    rec.label = null;
    rec.memoriaSinceTs = null;
    rec.contradictStreak = 0;
    rec.contradictTag = null;
  }
}

/** Contabiliza uma discordância qualificada; quebra pra candidata (e já credita o streak da nova
 *  tag) quando sustenta por `contradictTicks` — pode inclusive já bater `confirmTicks` no mesmo tick
 *  se os dois limiares coincidirem (default: ambos 3) — comportamento intencional, documentado. */
function advanceContradiction(rec: TrackRecord, a: Assignment, cfg: TickPolicy): void {
  if (rec.contradictTag === a.tag) rec.contradictStreak++;
  else {
    rec.contradictTag = a.tag;
    rec.contradictStreak = 1;
  }
  if (rec.contradictStreak >= cfg.contradictTicks) {
    rec.state = "candidata";
    rec.label = null;
    rec.memoriaSinceTs = null;
    rec.streakTag = a.tag;
    rec.streak = rec.contradictStreak;
    rec.contradictTag = null;
    rec.contradictStreak = 0;
    if (rec.streak >= cfg.confirmTicks) {
      rec.state = "confirmada";
      rec.label = a.tag;
      rec.streak = 0;
      rec.streakTag = null;
    }
  }
}

/**
 * Política de memória com estado — UMA instância por câmera/cena (mesmo padrão de
 * TagTrackAssociator). `step()` é chamado a cada tick com a saída CORRENTE do associador.
 */
export class LabelMemoryPolicy {
  private cfg: ResolvedConfig;
  private records = new Map<number, TrackRecord>();

  constructor(cfg?: MemoryConfig) {
    this.cfg = { ...DEFAULTS, ...(cfg ?? {}) };
  }

  /** Monta a régua efetiva DESTE tick — v2 (confirmPolicy) condiciona a qualificação ao regime do
   *  tick; sem confirmPolicy é a régua v1 (byte-idêntica — mesmo predicado, mesmos limiares). */
  private tickPolicy(context?: { candidates: number }): TickPolicy {
    const cp = this.cfg.confirmPolicy;
    if (!cp) {
      return {
        qualifies: (a) => qualified(a, this.cfg.confirmMargin),
        confirmTicks: this.cfg.confirmTicks,
        contradictTicks: this.cfg.contradictTicks,
        memoryTimeoutMs: this.cfg.memoryTimeoutMs,
      };
    }
    // context ausente = regime esparso (chamador sem instrumentação — ver header, RETUNING v2).
    const regime = tickRegime(context?.candidates ?? 0, cp.curve.denseMinCandidates);
    return {
      qualifies: (a) =>
        a.tag !== null &&
        (!cp.cleanWindow || a.hadConflict !== true) &&
        impliedPrecision(cp.curve, regime, a.margin ?? 0) >= cp.pStar,
      confirmTicks: cp.k,
      contradictTicks: this.cfg.contradictTicks,
      memoryTimeoutMs: this.cfg.memoryTimeoutMs,
    };
  }

  /**
   * Processa um tick: `assignments` é a saída de `TagTrackAssociator.assign()` para os tracks
   * CORRENTES (associate.ts só devolve Assignment pra tracks vivos — ver docstring de assign()).
   * Tracks conhecidos AUSENTES deste array são tratados como mortos (ver header) e removidos.
   * `context` (ADITIVO, retuning v2): `{ candidates }` = nº de candidatos avaliáveis do tick
   * (tamanho do array de assignments em produção) — estratifica o regime denso/esparso quando
   * `confirmPolicy` está configurada; ausente = esparso (documentado no header). Sem
   * `confirmPolicy`, `context` é ignorado.
   */
  step(
    ts: number,
    assignments: readonly Assignment[],
    context?: { candidates: number },
  ): MemoryBelief[] {
    const pol = this.tickPolicy(context);
    const seen = new Set<number>();
    const out: MemoryBelief[] = [];
    for (const a of assignments) {
      seen.add(a.trackId);
      let rec = this.records.get(a.trackId);
      if (!rec) {
        rec = freshRecord();
        this.records.set(a.trackId, rec);
      }
      advance(rec, a, ts, pol);
      out.push({
        trackId: a.trackId,
        state: rec.state,
        label: rec.state === "candidata" ? null : rec.label,
        isFresh: rec.state === "confirmada",
      });
    }
    for (const id of this.records.keys()) {
      if (!seen.has(id)) this.records.delete(id); // morte de track — ver header
    }
    return out;
  }

  reset(): void {
    this.records.clear();
  }
}
