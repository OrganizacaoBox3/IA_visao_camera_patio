// Tipos dos EVENTOS de leitura — contrato entre o LeituraProcessor (produtor) e quem grava o
// histórico (report/store). LGPD: só códigos/indicadores, nunca imagens.
//
// FAXINA (ADR-016): o antigo agregador multi-câmera por ponto que vivia aqui (store singleton
// pushRead/pushPass/snapshot/resetCluster) foi REMOVIDO — era write-only em produção (snapshot()
// nunca era lido fora do teste). A dedup por câmera continua no LeituraProcessor; o histórico é
// gravado direto em report/store pelo CameraWorkspace.

export type ReadEvent = {
  cameraId: string;
  cameraLabel: string;
  ponto: string;
  code: string;
  format: string;
  ts: number;
};

export type PassEvent = { cameraId: string; ponto: string; ts: number };
