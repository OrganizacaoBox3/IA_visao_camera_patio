// Tipos do CONTRATO do espelho de análise do hub — evento socket `analysis-tracks` (ADR-009).
// Módulo NEUTRO (sem React/DOM): o shape do evento é contrato ADITIVO (CLAUDE.md §3) — campos
// novos sempre OPCIONAIS; nunca quebrar os existentes. O CameraWorkspace RE-EXPORTA estes tipos
// (compat: importadores existentes seguem funcionando; migram para cá em onda própria).

/** Track calculado pelo MOTOR DO HUB (D-FINE + ByteTrack server-side), emitido @1fps (volatile). */
export type HubTrack = {
  id: number;
  /** bbox normalizado [x,y,w,h] 0..1 (mesma convenção de Track.bbox). */
  bbox: [number, number, number, number];
  cx: number;
  cy: number;
  zone: string | null;
  /** Score real da detecção 0..1. Ausente = hub antigo → tratar como 1 (retrocompat). */
  score?: number;
  /** Velocidade do Kalman do tracker: normalizada 0..1 POR SEGUNDO (mesma convenção do bbox).
   *  Alimenta o dead-reckoning DISPLAY-ONLY do overlay. Ausente = hub antigo → interpolação
   *  por 2 keyframes (retrocompat). */
  vx?: number;
  vy?: number;
};

export type HubZone = { id: string; label: string; people: number; occupied: boolean };

/** Zona PROIBIDA no FIO (`analysis-tracks.zonesProibidas`): `presenca` é o estado VIOLADA da
 *  MÁQUINA do motor (histerese/dwell), não `people > 0` cru. Estruturalmente compatível com o
 *  `HubZoneState` de `camera/draw.ts` — lá é o que o DESENHO exige; aqui, o que o FIO carrega. */
export type HubProhibitedZone = { id: string; label: string; people: number; presenca: boolean };

// latencyMs (aditivo): idade captura→emissão do frame no hub (ms). O interpolador ancora o keyframe
// em `recvT - latencyMs` e extrapola pro AGORA → a caixa senta na pessoa (07-diagnostico-overlay-lag).
export type HubAnalysis = {
  ts: number;
  tracks: HubTrack[];
  zones: HubZone[];
  latencyMs?: number;
  /** RE-EMISSÃO de rodada pulada pelo gate de movimento (pipeline `emitCoasting`): a bbox é a da
   *  ÚLTIMA observação, não dado novo. Opcional: hub antigo não coasting ⇒ ausente ≡ `false`. */
  coasting?: boolean;
  /** Estado por zona proibida da câmera (o canvas acende VIOLADA). Opcional: hub antigo não emite o
   *  campo ⇒ AUSENTE (≠ `[]`, que é "câmera sem zona proibida") e o desenho fica em ARMADA quieta. */
  zonesProibidas?: HubProhibitedZone[];
};

// Payload do hub mais velho que isto é STALE (motor reiniciando/rede caída): não desenhar caixa
// morta — deixa expirar/limpar. FONTE ÚNICA (Onda 4 da spec-overlay-tempo-real): era duplicado em
// useHubAnalysis.ts e TrackOverlay.tsx (TODO antigo); os consumidores importam daqui. O `ts`
// comparado é o de RECEPÇÃO local (useDashboardSocket grava Date.now()) — imune a skew hub×cliente.
export const HUB_TRACKS_STALE_MS = 5000;

/** Track do pipeline do CLIENTE (local ou espelho do hub) — alimenta presença/zona/counter/desenho. */
export type Track = {
  id: number;
  cx: number;
  cy: number;
  /** PÉ do bbox (bottom-center, normalizado) — âncora da contagem por linha. */
  foot: { x: number; y: number };
  bbox: [number, number, number, number];
  firstSeen: number;
  lastSeen: number;
  zone: string | null;
  score: number;
  /** Velocidade do Kalman (0..1/s), passthrough do HubTrack — DISPLAY-ONLY (contagem/zonas não usam). */
  vx?: number;
  vy?: number;
};
