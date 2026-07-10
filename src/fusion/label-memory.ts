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
// Responsabilidade única: só a máquina de estados. Não mede (cobertura de experiência/erro-segundos/
// latência de correção vivem numa métrica separada, consumindo a saída daqui + verdade). Não sabe de
// UI, socket, nem React — mesmo padrão de associate.ts.

import type { Assignment } from "./associate";

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
};

const DEFAULTS: Required<MemoryConfig> = {
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

/** Fala "qualificada": tag falada (não-abstenção), sem conflito LOCAL (Mordida 1) e com margem no
 *  bin de alta confiança. Assignment sem instrumentação (margin/hadConflict ausentes, ex.: saída
 *  antiga) nunca qualifica — default conservador (documentado): não confirma/contradiz sem medir. */
function qualified(a: Assignment, confirmMargin: number): boolean {
  return a.tag !== null && a.hadConflict !== true && (a.margin ?? 0) >= confirmMargin;
}

/** Avança UM track por UM tick (função de módulo, não método — testável isolada da classe). */
function advance(rec: TrackRecord, a: Assignment, ts: number, cfg: Required<MemoryConfig>): void {
  const q = qualified(a, cfg.confirmMargin);

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
function advanceContradiction(rec: TrackRecord, a: Assignment, cfg: Required<MemoryConfig>): void {
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
  private cfg: Required<MemoryConfig>;
  private records = new Map<number, TrackRecord>();

  constructor(cfg?: MemoryConfig) {
    this.cfg = { ...DEFAULTS, ...(cfg ?? {}) };
  }

  /**
   * Processa um tick: `assignments` é a saída de `TagTrackAssociator.assign()` para os tracks
   * CORRENTES (associate.ts só devolve Assignment pra tracks vivos — ver docstring de assign()).
   * Tracks conhecidos AUSENTES deste array são tratados como mortos (ver header) e removidos.
   */
  step(ts: number, assignments: readonly Assignment[]): MemoryBelief[] {
    const seen = new Set<number>();
    const out: MemoryBelief[] = [];
    for (const a of assignments) {
      seen.add(a.trackId);
      let rec = this.records.get(a.trackId);
      if (!rec) {
        rec = freshRecord();
        this.records.set(a.trackId, rec);
      }
      advance(rec, a, ts, this.cfg);
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
