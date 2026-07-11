// Bancada de simulação (docs/cientifica/simulador.md) — Fase 3, §6: núcleo PURO do modo anotação.
// O player é o anotador do teste de campo: selecionar track → atribuir tag (MAC) ou "pessoa SEM
// tag" → exportar `SessionTruth`, que `replayFusionSession` já consome sem nenhuma cola nova.
//
// Por que SÓ o núcleo puro entra agora (sem UI): o player de hoje só abre cenários SINTÉTICOS —
// e anotar sintético não faz sentido, a verdade-terreno já nasce pronta lá (truthTagByTrack em
// cada tick). A integração na página React fica para quando a Fase 1.5 (abrir gravação REAL no
// player) chegar; o valor desta entrega é a lógica pronta e TESTADA para o dia do teste de campo
// — anotar o roteiro de 6 min em minutos, no sofá, depois da caminhada (§6).
//
// Semântica herdada de SessionTruth (session-loader.ts): a atribuição tem TRÊS estados e a
// diferença importa na métrica —
//   • mac (string)  → track anotado como a pessoa portando ESSA tag;
//   • null          → track anotado como pessoa SEM tag (decisão explícita do anotador);
//   • chave AUSENTE → track NÃO anotado — a métrica o ignora como fantasma.
// `clearAssignment` devolve ao terceiro estado (desfaz a anotação), NÃO ao segundo.
// MACs saem MAIÚSCULOS no export — a mesma convenção do session-loader ("a identidade da tag é
// SEMPRE o MAC em MAIÚSCULO, porque a verdade-terreno é anotada por MAC").
//
// Responsabilidade única: o estado da anotação em progresso. Estado imutável, funções puras —
// mesmo padrão de playback-transport.ts neste diretório. Sem DOM, sem canvas, sem React.
import type { SessionTruth } from "../session-loader";

export type AnnotationState = {
  /** Atribuições em progresso: trackId → MAC da tag (null = pessoa SEM tag).
   *  Track sem chave = ainda não anotado. */
  assignments: Record<number, string | null>;
};

export function initialAnnotationState(): AnnotationState {
  return { assignments: {} };
}

/** Atribui a tag `mac` ao track (ou `null` = "pessoa sem tag" — decisão explícita, diferente de
 *  não anotar). Reatribuir sobrescreve — o anotador muda de ideia vendo o replay. */
export function assignTag(s: AnnotationState, trackId: number, mac: string | null): AnnotationState {
  return { assignments: { ...s.assignments, [trackId]: mac } };
}

/** Desfaz a anotação do track — ele volta a AUSENTE (fantasma pra métrica), não a "sem tag". */
export function clearAssignment(s: AnnotationState, trackId: number): AnnotationState {
  if (!(trackId in s.assignments)) return s;
  const assignments = { ...s.assignments };
  delete assignments[trackId];
  return { assignments };
}

/** Exporta o `SessionTruth` que `replayFusionSession` consome. MACs normalizados a MAIÚSCULO
 *  (e sem espaços nas pontas) AQUI — o estado em edição guarda o que o anotador digitou; a
 *  convenção do session-loader vale na fronteira de saída. */
export function exportSessionTruth(s: AnnotationState): SessionTruth {
  const truth: SessionTruth = {};
  for (const [trackId, mac] of Object.entries(s.assignments)) {
    truth[Number(trackId)] = mac === null ? null : mac.trim().toUpperCase();
  }
  return truth;
}

/** Retoma uma anotação salva (o export anterior) — sessão longa se anota em mais de uma sentada. */
export function importSessionTruth(truth: SessionTruth): AnnotationState {
  return { assignments: { ...truth } };
}

export type AnnotationSummary = {
  /** Tracks anotados com uma tag (mac string). */
  withTag: number;
  /** Tracks anotados explicitamente como pessoa SEM tag (null). */
  withoutTag: number;
  /** Total anotado (withTag + withoutTag) — tracks ausentes não contam. */
  total: number;
};

/** Contagens pra UI futura mostrar o progresso da anotação ("12 com tag, 3 sem tag"). */
export function annotationSummary(s: AnnotationState): AnnotationSummary {
  let withTag = 0;
  let withoutTag = 0;
  for (const mac of Object.values(s.assignments)) {
    if (mac === null) withoutTag++;
    else withTag++;
  }
  return { withTag, withoutTag, total: withTag + withoutTag };
}
