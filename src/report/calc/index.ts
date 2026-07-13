// Barrel do pacote de CÁLCULO do Relatório — agregações puras por dimensão
// (atividade/leitura/objetos/fadiga/alarmes/fluxo) + base comum. Tudo aqui são
// INDICADORES (tempo/alertas/ocupação/cruzamentos) — nunca imagens.
//
// TURNO: o `shiftOf(hour)` hardcoded (06/14/22) MORREU — a fonte é o cadastro e a resolução é do
// servidor (server/shift-clock.js). O que se exporta é a LEITURA do carimbo (`shiftKeyOf`,
// `shiftStateOf`, `inShift`) + o rótulo/opções do filtro, e `legacyShiftOf` SÓ p/ dado antigo.
// `periodDays` é exportado (consumido por store/aggregate — fonte única da janela).

export {
  ALL_SHIFTS,
  LEGACY_SHIFTS,
  legacyShiftOf,
  shiftStateOf,
  shiftKeyOf,
  inShift,
  shiftLabelOf,
  legacyShiftsIn,
  shiftOptions,
  deltaPct,
  fmtMin,
  periodDays,
} from "./common";
export type {
  Shift,
  ShiftFilter,
  ShiftStamp,
  ShiftRow,
  ShiftState,
  ShiftDef,
  Period,
} from "./common";

export * from "./atividade";
export * from "./leitura";
export * from "./objetos";
export * from "./fadiga";
export * from "./alarmes";
export * from "./flow";
