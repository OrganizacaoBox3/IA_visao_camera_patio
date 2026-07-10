// Contrato de EVIDÊNCIA (dev.md §1) — a ENTRADA do motor de localização, no modelo AirTag.
// Um "relatório do coletor" = o GPS do celular num instante + as tags que ele vê agora. É exatamente o
// que o TC22 já envia ao hub (/api/bt/reading). A costura do ADR-012 fixa a SAÍDA (LocatedEntity); este
// arquivo fixa a ENTRADA — juntos, o motor (heurístico de hoje ou factor graph de amanhã) é plugável.
//
// Reservado ao motor: fatores de câmera (detecção no chão via homografia) e de mapa (paredes/corredores)
// entram como NOVOS tipos de observação, de forma aditiva, sem quebrar consumidores atuais.
import type { LatLon } from "./entity";

/** Uma tag avistada num relatório (leitura BLE): id + RSSI, rótulo opcional. */
export type TagSighting = { tagId: string; rssi: number; label?: string };

/** Relatório de UM coletor móvel num instante (o "batch de evidência" de hoje). */
export type CollectorReport = {
  /** Timestamp de CAPTURA na borda (ms) — nunca o de chegada (dev.md §2). */
  ts: number;
  /** GPS do celular no instante. */
  collectorPos: LatLon;
  /** Incerteza do GPS (raio, m), quando o aparelho fornece. */
  accuracyM?: number;
  /** Tags em alcance neste instante. */
  seen: TagSighting[];
};

/** Um lote de evidência. Hoje = 1 coletor; multi-coletor entra aditivo (array) numa fase futura. */
export type EvidenceBatch = CollectorReport;
