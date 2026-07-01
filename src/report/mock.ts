// Camada de dados do Relatório (Etapa A: MOCK realista, em memória).
// Tudo aqui são INDICADORES (tempo/alertas/ocupação) — nunca imagens.
//
// ÍNDICE FINO: os cálculos puros vivem em ./calc/, separados por dimensão
// (atividade/leitura/objetos/fadiga/alarmes) + base comum. Este arquivo apenas
// RE-EXPORTA a API pública para os consumidores (store/csv/predict/ReportPage/
// CameraWorkspace) seguirem importando de "./mock" sem alteração.

// Base compartilhada (turnos, deltas, formatadores). `periodDays`/`inShift`
// permanecem internos ao pacote calc — por isso NÃO usamos `export *` aqui.
export { shiftOf, deltaPct, fmtMin } from "./calc/common";
export type { Shift, Period } from "./calc/common";

export * from "./calc/atividade";
export * from "./calc/leitura";
export * from "./calc/objetos";
export * from "./calc/fadiga";
export * from "./calc/alarmes";
