// ── A COSTURA (seam) do ADR-012 — domínio de localização ──────────────────────────────
//
// Este arquivo é o CONTRATO estável entre "quem calcula onde está uma entidade" e "quem
// mostra isso". Decisão do ADR-012 (docs/analises/decisoes/ADR-012-abordagem-cientifica-
// viabilidade.md): o motor científico futuro (factor graph) é uma trilha à parte. Para não
// acoplar a UI ao motor de hoje, a fronteira é este tipo `LocatedEntity`.
//
// Regra da costura: TANTO o heurístico atual (via `./adapters`) QUANTO o motor de amanhã
// (futuro, em docs/cientifica/) produzem `LocatedEntity[]`. A UI só consome isso — nunca
// sabe (nem deve saber) quem calculou a posição. Trocar o produtor não toca a UI.

export type LatLon = { lat: number; lon: number };

/**
 * Uma entidade localizável (hoje: uma tag Bluetooth/AirTag) já reduzida ao que a UI precisa.
 * Saída ÚNICA da costura: o produtor (heurístico ou motor) é intercambiável; este formato não.
 */
export type LocatedEntity = {
  /** Chave estável da entidade — o MAC da tag. */
  id: string;
  /** Rótulo cadastrado (a pessoa/ativo) ou, na ausência, o próprio MAC. */
  label: string;
  /** Última posição conhecida (geo). `null` quando ainda não há posição. */
  position: LatLon | null;
  /** Incerteza em metros (raio), quando a fonte fornece. `null` se desconhecida. */
  accuracyM: number | null;
  /** Timestamp (epoch-ms) da última observação que produziu este estado. */
  seenAt: number;
  /** Visível AGORA (em alcance neste instante) vs. apenas última posição conhecida. */
  live: boolean;
  /** Como a posição foi obtida. "fusion" fica reservado ao motor futuro. */
  source: "gps" | "fusion" | "unknown";

  // ── Reservado para o motor (ADR-012) ────────────────────────────────────────────────
  // Campos que o factor graph vai popular; adicionados de forma ADITIVA quando existir, sem
  // quebrar consumidores atuais (que os ignoram). Documentados aqui para fixar o formato:
  //   • covariance?: [number, number, number]  // covariância 2x2 da posição (σxx, σxy, σyy), metros²
  //   • revision?: number                       // versão monotônica do estado (para diffs/otimização)
  //   • velocity?: LatLon                        // estimativa de deslocamento (motor de fusão)
};
