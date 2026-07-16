// PRESENÇA DE ZONA com histerese — a decisão ESTÁVEL "o operador está/não está na zona de trabalho"
// em cima da classificação de fingerprint (fingerprint.ts), que é instantânea e oscila poll a poll.
// Núcleo PURO (sem DOM/React/relógio próprio), testável — o chamador injeta ts/now.
//
// POR QUE EXISTE (spec-zona-trabalho-ble.md, CA-1/CA-2): a classificação kNN responde "qual zona é a
// mais parecida AGORA", a cada ~2 s. Para o produto ("está na zona?", e depois taxa de ocupação),
// um poll divergente não pode piscar o estado — e confiança "baixa" NUNCA pode contar para entrar
// (invariante da casa: rótulo errado é pior que nenhum). A histerese temporal resolve os dois:
// entra-se numa zona após K polls consecutivos qualificados; sai-se após K' polls divergentes.
//
// MODELO DE 3 ESTADOS na leitura (readZonePresence):
//  · "na-zona"  — zona confirmada pela histerese (com `desde` = 1ª observação da sequência que
//                 confirmou, para o "há N min" da UI ser honesto);
//  · "fora"     — nenhuma zona confirmada (inclui o caso "classificação degradou por K' polls");
//  · "incerto"  — SEM observações há mais que o TTL (tag sumiu do pool/antenas calaram). O estado
//                 confirmado anterior fica em `zona` como última informação conhecida.
// Refinamento futuro declarado: distinguir "confiança baixa sustentada" (hoje → fora) de "sem dado"
// (hoje → incerto) se a taxa de ocupação precisar da nuance.

/** Confiança da classificação (mesma escala de fingerprint.ts). Só alta|media QUALIFICAM. */
export type ZoneConfidence = "alta" | "media" | "baixa" | "nenhuma";

/** Uma medição física nova: a zona mais parecida e a confiança daquela classificação. */
export type ZoneObservation = { ts: number; zona: string | null; confianca: ZoneConfidence };

export type ZonePresenceConfig = {
  /** Polls CONSECUTIVOS qualificados (mesma zona, confiança ≥ media) para ENTRAR na zona. */
  entrarAposPolls: number;
  /** Polls consecutivos divergentes (outra zona qualificada, ou baixa/nenhuma) para SAIR. */
  sairAposPolls: number;
  /** Sem observação há mais que isto → estado "incerto" na leitura. */
  ttlIncertoMs: number;
};

/** Defaults para o poll de ~1 s da Planta BLE (beacons com refresh ~1 s, 2026-07-15): entrar ≈ 3 s
 *  de evidência consistente, sair ≈ 3 s, incerto após 10 s mudo. K=3 é o que dá a estabilidade —
 *  o tempo absoluto escala com o poll do chamador. */
export const ZONE_PRESENCE_DEFAULTS: ZonePresenceConfig = {
  entrarAposPolls: 3,
  sairAposPolls: 3,
  ttlIncertoMs: 10_000,
};

/** Estado interno da histerese de UMA tag — serializável (o chamador guarda num Map por MAC). */
export type ZoneTrackState = {
  /** Zona confirmada atual (null = fora). */
  confirmada: string | null;
  /** ts do INÍCIO do estado confirmado atual (1ª observação da sequência que o confirmou). */
  desde: number;
  /** Alvo em construção divergente do confirmado (null = candidato a "fora"). */
  candidata: string | null;
  candidataDesde: number;
  /** Nº de polls consecutivos apontando a candidata. 0 = sem divergência em curso. */
  streak: number;
  /** ts da última observação recebida (base do TTL de "incerto"). */
  ultimaObsTs: number;
};

export function initZoneTrack(ts: number): ZoneTrackState {
  return { confirmada: null, desde: ts, candidata: null, candidataDesde: ts, streak: 0, ultimaObsTs: ts };
}

/** A observação conta para uma zona? (Regra da casa: baixa/nenhuma NUNCA qualificam — CA-2.) */
const qualifica = (o: ZoneObservation): boolean =>
  o.zona !== null && (o.confianca === "alta" || o.confianca === "media");

/**
 * Um passo da histerese. Puro: (estado, observação) → estado novo.
 * - Observação que REFORÇA o confirmado zera qualquer divergência em curso.
 * - Divergência precisa de K polls consecutivos do MESMO alvo para virar o estado
 *   (alvo = outra zona → `entrarAposPolls`; alvo = "fora" → `sairAposPolls`).
 * - Um poll divergente isolado no meio de reforços não move nada (CA-1).
 */
export function updateZoneTrack(
  s: ZoneTrackState,
  obs: ZoneObservation,
  cfg: ZonePresenceConfig = ZONE_PRESENCE_DEFAULTS,
): ZoneTrackState {
  // Reamostrar o mesmo snapshot não é nova evidência (Regra 8). Também rejeita ordem regressiva.
  if (obs.ts <= s.ultimaObsTs) return s;
  const alvo = qualifica(obs) ? obs.zona : null;

  // Reforço do estado atual → derruba divergência em curso.
  if (alvo === s.confirmada) {
    return { ...s, candidata: null, streak: 0, ultimaObsTs: obs.ts };
  }

  // Divergência: continua a streak da mesma candidata, ou começa outra.
  const mesmaCandidata = s.streak > 0 && alvo === s.candidata;
  const streak = mesmaCandidata ? s.streak + 1 : 1;
  const candidataDesde = mesmaCandidata ? s.candidataDesde : obs.ts;
  const precisa = alvo === null ? cfg.sairAposPolls : cfg.entrarAposPolls;

  if (streak >= precisa) {
    // Confirma a transição. `desde` = 1ª observação da sequência (o "há N min" nasce honesto).
    return {
      confirmada: alvo,
      desde: candidataDesde,
      candidata: null,
      candidataDesde,
      streak: 0,
      ultimaObsTs: obs.ts,
    };
  }
  return { ...s, candidata: alvo, candidataDesde, streak, ultimaObsTs: obs.ts };
}

export type ZonePresenceState = "na-zona" | "fora" | "incerto";
export type ZonePresence = {
  estado: ZonePresenceState;
  /** Zona do estado (na-zona) ou última zona conhecida (incerto); null quando fora. */
  zona: string | null;
  /** Início do estado (na-zona/fora) ou ts da última observação (incerto). */
  desde: number;
};

/** Lê a presença AGORA, aplicando o TTL de "incerto" (tag muda há mais que ttlIncertoMs). */
export function readZonePresence(
  s: ZoneTrackState,
  now: number,
  cfg: ZonePresenceConfig = ZONE_PRESENCE_DEFAULTS,
): ZonePresence {
  if (now - s.ultimaObsTs > cfg.ttlIncertoMs) {
    return { estado: "incerto", zona: s.confirmada, desde: s.ultimaObsTs };
  }
  if (s.confirmada !== null) return { estado: "na-zona", zona: s.confirmada, desde: s.desde };
  return { estado: "fora", zona: null, desde: s.desde };
}
