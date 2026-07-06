// Barrel do pacote de CÁLCULO do Relatório — agregações puras por dimensão
// (atividade/leitura/objetos/fadiga/alarmes/fluxo) + base comum. Tudo aqui são
// INDICADORES (tempo/alertas/ocupação/cruzamentos) — nunca imagens.
//
// `periodDays` é exportado (consumido por store/aggregate — fonte única da janela);
// `inShift` permanece interno ao pacote — por isso NÃO usamos `export *` do common.

export { shiftOf, deltaPct, fmtMin, periodDays } from "./common";
export type { Shift, Period } from "./common";

export * from "./atividade";
export * from "./leitura";
export * from "./objetos";
export * from "./fadiga";
export * from "./alarmes";
export * from "./flow";
