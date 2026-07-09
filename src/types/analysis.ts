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
// latencyMs (aditivo): idade captura→emissão do frame no hub (ms). O interpolador ancora o keyframe
// em `recvT - latencyMs` e extrapola pro AGORA → a caixa senta na pessoa (07-diagnostico-overlay-lag).
export type HubAnalysis = { ts: number; tracks: HubTrack[]; zones: HubZone[]; latencyMs?: number };

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
