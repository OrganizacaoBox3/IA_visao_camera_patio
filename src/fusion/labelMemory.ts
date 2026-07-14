// MEMÓRIA do rótulo tag↔track — uma camada ACIMA do associador (associate.ts NÃO é tocado; ver
// docs/cientifica/escopo-persistencia-rotulo.md, "Framing"). O associador é uma função por-JANELA:
// quando o operador PARA, a correlação RSSI×distância morre (sem movimento não há sinal — física
// medida, não bug) e o assign devolve tag=null. Sem memória, o nome PISCA só na caminhada e SOME no
// instante em que a pessoa para — exatamente o cenário de registro de performance (operador parado
// numa área) onde ele mais precisa ficar.
//
// O QUE ESTA CAMADA FAZ: SEGURA um rótulo CONFIRMADO na caixa do track enquanto o track viver,
// mesmo sem evidência fresca. Muda a UNIDADE de "por tick de decisão" para "por tempo de track".
//
// INVARIANTE DE HONESTIDADE (cravada pelo dono, não-negociável): rótulo ERRADO é PIOR que rótulo
// NENHUM. Por isso, três travas — nenhuma é enfeite, cada uma fecha um modo de mentir:
//  1. SÓ CONFIRMADO PERSISTE. Um palpite de 1 tick nunca é segurado: confirmar exige
//     `confirmThreshold` falas confiantes CONSECUTIVAS da MESMA tag, cada uma SEM conflito local
//     (`hadConflict === false` — Mordida 1 do escopo: conflito é do PAR, não o agregado de tick).
//     Candidato que não reconfirma no tick seguinte simplesmente SOME (zero persistência de palpite).
//  2. QUEDA POR CONFLITO / QUEDA POR MORTE. O rótulo segurado cai NA HORA quando: (a) o track some
//     dos tracks vivos do hub; (b) o assign fresco dá uma tag DIFERENTE, com confiança, para o mesmo
//     track (id-switch VISÍVEL); (c) a MESMA tag é confirmada em OUTRO track (id-switch guard — o
//     mais recente/forte vence, o outro cai; sem isso um rótulo se duplicaria em dois tracks).
//  3. TTL DE MEMÓRIA (`holdMs`). Sem NENHUMA reconfirmação por holdMs, a crença decai. É o único
//     backstop contra o PIOR caso da Mordida 2 do escopo: id-switch SILENCIOSO durante a "memória"
//     (o tracker troca de ID no meio de um cruzamento, posições contínuas, nenhum salto detectável)
//     — a crença velha cavalgaria um track que trocou de dono sem deixar rastro. holdMs limita por
//     quanto tempo ela pode mentir antes de a falta de evidência a matar.
//
// Determinístico e PURO: sem React, sem DOM, sem socket, sem Date.now (o tempo ENTRA por `now`).
// Responsabilidade única: a política de memória sobre a crença. A associação mora em associate.ts;
// o timing (tick de 500ms) mora em useTagFusion.ts.

/** O que o assign fresco diz sobre UM track neste tick — o subconjunto de Assignment que a memória
 *  consome. `tag: null` = "não sei" (o associador se absteve). `hadConflict` é a flag POR PAR do
 *  associador (margem daquele track contra seus concorrentes DAQUELE tick) — ausente = sem conflito
 *  (retrocompat com chamador que não instrumenta). */
export type FreshObservation = {
  tag: string | null;
  confidence: number;
  hadConflict?: boolean;
};

/** Estado interno da crença sobre UM track. `candidata` nunca é exibida (é o contador de falas
 *  consecutivas rumo à confirmação); `confirmada` é o que a caixa mostra e o que sobrevive à parada. */
type BeliefState = "candidata" | "confirmada";
type Belief = {
  tag: string;
  /** Falas confiantes CONSECUTIVAS da mesma tag acumuladas (reseta ao trocar de tag / ao não falar). */
  confirmations: number;
  /** Instante (ms, relógio de `now`) da última fala confiante — a régua do TTL (holdMs). */
  lastConfirmAt: number;
  /** Confiança da última fala confiante — desempate do id-switch guard (o "mais forte" vence). */
  lastConfidence: number;
  state: BeliefState;
};

export type LabelMemoryConfig = {
  /** Falas confiantes CONSECUTIVAS (mesma tag, sem conflito) para CONFIRMAR — deixa de ser palpite.
   *  Default 2: o mínimo que já NÃO é "1 tick" (a trava nº1). Não sobe mais porque o associador fala
   *  em CORRIDAS durante o movimento (a cobertura de ~34% dos ticks do harness vem em rajadas, não
   *  esparsa), então 2 consecutivas é barato de atingir andando e caro de atingir por ruído; 3+
   *  começaria a comer a cobertura real sem fechar nenhum buraco de honestidade novo (o conflito e o
   *  TTL já cobrem o resto). */
  confirmThreshold?: number;
  /** Piso de confiança de uma fala para contar rumo à confirmação/reconfirmação. Default 0.5 = o
   *  MESMO minConfidence do associador (associate.ts): uma fala não-null já cruzou esse piso, então
   *  na prática é um contrato explícito ("confirmar usa a mesma barra que falar"), não um 2º filtro
   *  — as travas reais da memória são hadConflict + consecutividade + TTL. Existe para não confiar
   *  em fala fraca caso o minConfidence do associador seja afrouxado por deploy. */
  confirmConfidence?: number;
  /** TTL da memória (ms): sem reconfirmação por este tempo, a crença confirmada decai. Default
   *  12000 = a ordem de grandeza da INSTABILIDADE REAL do tracker medida na mineração de
   *  fragmentação (docs/cientifica/escopo-persistencia-rotulo.md, Mordida 3: zona mediana-a-p75 do
   *  gap morte→renascimento ~12s). É o número que decide quanto tempo uma crença sem evidência
   *  fresca pode cavalgar um track antes de a ausência de evidência a matar — vem da física do
   *  tracker, NÃO da curva de reliability (que calibra a ENTRADA da crença, não a sobrevivência).
   *  Conservador de propósito: mais curto = menos erro-segundos no pior caso (Mordida 2), ao custo
   *  de segurar o nome por menos tempo numa parada muito longa. */
  holdMs?: number;
};

const DEFAULTS: Required<LabelMemoryConfig> = {
  confirmThreshold: 2,
  confirmConfidence: 0.5,
  holdMs: 12000,
};

/**
 * Política de memória de rótulo. Uma instância por câmera/associador (mesma vida do
 * TagTrackAssociator em useTagFusion — nasce e é resetada junto). Todo o estado é interno e
 * explícito; a única entrada de tempo é o `now` de `update`.
 */
export class LabelMemory {
  private cfg: Required<LabelMemoryConfig>;
  private beliefs = new Map<number, Belief>();

  constructor(cfg?: LabelMemoryConfig) {
    this.cfg = { ...DEFAULTS, ...(cfg ?? {}) };
  }

  reset(): void {
    this.beliefs.clear();
  }

  /**
   * Avança a memória um tick e devolve o mapa trackId→rótulo A EXIBIR (só os CONFIRMADOS, incluindo
   * os segurados sem evidência fresca). Ordem das etapas (cada uma fecha um modo de erro):
   *  A. MORTE — track fora dos vivos do hub some da memória (queda imediata, trava nº2a);
   *  B. FALA — aplica o assign fresco por track (confirma / reconfirma / conflito, travas nº1 e 2b);
   *  C. SILÊNCIO — track vivo sem fala confiante: candidato SOME, confirmado é SEGURADO (o hold);
   *  D. TTL — confirmado sem reconfirmação por holdMs decai (trava nº3);
   *  E. ID-SWITCH GUARD — mesma tag confirmada em >1 track: o mais recente/forte vence (trava nº2c).
   *
   * @param fresh       trackId → o que o assign disse neste tick (tags null incluídas).
   * @param liveTrackIds trackIds vivos no hub AGORA (a autoridade sobre a vida do track).
   * @param now         instante do tick (ms) — determinístico, sem relógio interno.
   */
  update(
    fresh: ReadonlyMap<number, FreshObservation>,
    liveTrackIds: ReadonlySet<number>,
    now: number,
  ): Map<number, string> {
    const { confirmThreshold, confirmConfidence, holdMs } = this.cfg;

    // A. MORTE do track (trava nº2a): o tracker perdeu a pessoa → a crença cai na hora.
    for (const id of [...this.beliefs.keys()]) if (!liveTrackIds.has(id)) this.beliefs.delete(id);

    // B. FALA fresca por track.
    for (const [id, obs] of fresh) {
      if (!liveTrackIds.has(id)) continue; // assign de um track já morto — ignora (defensivo)
      const confident =
        obs.tag !== null && obs.hadConflict !== true && obs.confidence >= confirmConfidence;
      const b = this.beliefs.get(id);

      if (confident) {
        const tag = obs.tag as string;
        if (b && b.tag === tag) {
          // MESMA tag reconfirmada: acumula, renova o TTL, promove ao cruzar o limiar.
          b.confirmations++;
          b.lastConfirmAt = now;
          b.lastConfidence = obs.confidence;
          if (b.confirmations >= confirmThreshold) b.state = "confirmada";
        } else {
          // Tag NOVA neste track — inclui o CONFLITO (trava nº2b): se havia um rótulo confirmado
          // DIFERENTE, ele cai AQUI (é sobrescrito por um candidato fresco da nova tag; não fica o
          // velho). A nova tag precisa reconfirmar do zero antes de ser exibida.
          this.beliefs.set(id, {
            tag,
            confirmations: 1,
            lastConfirmAt: now,
            lastConfidence: obs.confidence,
            state: confirmThreshold <= 1 ? "confirmada" : "candidata",
          });
        }
      } else if (b && b.state === "candidata") {
        // Candidato que não reconfirmou (null, conflito, ou fraco) → SOME. Zero persistência de
        // palpite único (trava nº1). Confirmado NÃO cai aqui: é o hold (tratado no silêncio/TTL).
        this.beliefs.delete(id);
      }
    }

    // C. SILÊNCIO: track vivo que o assign NEM reportou neste tick (buraco de frame). Candidato
    // some; confirmado é segurado (o hold) — o TTL abaixo é quem decide o fim.
    for (const [id, b] of this.beliefs)
      if (!fresh.has(id) && b.state === "candidata") this.beliefs.delete(id);

    // D. TTL (trava nº3): confirmado sem reconfirmação por holdMs decai.
    for (const [id, b] of [...this.beliefs])
      if (b.state === "confirmada" && now - b.lastConfirmAt > holdMs) this.beliefs.delete(id);

    // E. ID-SWITCH GUARD (trava nº2c): a MESMA tag não pode estar confirmada em dois tracks. O mais
    // RECENTE (lastConfirmAt) vence; empate → o mais FORTE (lastConfidence); empate → menor trackId
    // (determinístico). Os perdedores caem.
    this.resolveTagConflicts();

    // Saída: só os CONFIRMADOS (candidata nunca é exibida).
    const out = new Map<number, string>();
    for (const [id, b] of this.beliefs) if (b.state === "confirmada") out.set(id, b.tag);
    return out;
  }

  /** Mantém no máximo UM track confirmado por tag (o mais recente/forte); derruba os demais. */
  private resolveTagConflicts(): void {
    const winnerByTag = new Map<string, number>(); // tag → trackId vencedor corrente
    for (const [id, b] of this.beliefs) {
      if (b.state !== "confirmada") continue;
      const cur = winnerByTag.get(b.tag);
      if (cur === undefined) {
        winnerByTag.set(b.tag, id);
        continue;
      }
      const other = this.beliefs.get(cur)!;
      // Quem VENCE fica; o outro cai.
      if (this.beats(b, id, other, cur)) {
        this.beliefs.delete(cur);
        winnerByTag.set(b.tag, id);
      } else {
        this.beliefs.delete(id);
      }
    }
  }

  /** `a` (track idA) vence `b` (track idB) pela disputa da mesma tag: mais recente > mais forte >
   *  menor trackId (todos determinísticos, sem sorteio). */
  private beats(a: Belief, idA: number, b: Belief, idB: number): boolean {
    if (a.lastConfirmAt !== b.lastConfirmAt) return a.lastConfirmAt > b.lastConfirmAt;
    if (a.lastConfidence !== b.lastConfidence) return a.lastConfidence > b.lastConfidence;
    return idA < idB;
  }
}
