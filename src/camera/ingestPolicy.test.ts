// Teste da tabela ÚNICA da ADR-009 (ingestPolicy.ts). Fixa o invariante que antes vivia em 6
// call-sites do rAF: com o MOTOR DO HUB ligado, só FLOW e ATIV são suprimidos (o motor os grava);
// alarme/leitura/passagem/objetos/fadiga permanecem locais. Engine local grava tudo.
import { describe, it, expect } from "vitest";
import { shouldIngest, type IngestKind } from "./ingestPolicy";

const ALL: IngestKind[] = ["flow", "ativ", "alert", "reads", "pass", "object", "fadiga"];

describe("shouldIngest (ADR-009)", () => {
  it("engine local: grava TODOS os kinds (pipeline local é a única fonte)", () => {
    for (const k of ALL) expect(shouldIngest(k, "local")).toBe(true);
  });

  it("engine hub: suprime SÓ flow e ativ (o motor grava os mesmos indicadores)", () => {
    expect(shouldIngest("flow", "hub")).toBe(false);
    expect(shouldIngest("ativ", "hub")).toBe(false);
  });

  it("engine hub: alarme de ociosidade segue local (o motor não grava alarmes)", () => {
    expect(shouldIngest("alert", "hub")).toBe(true);
  });

  it("engine hub: leitura/passagem/objetos/fadiga seguem locais (motor não cobre esses modos)", () => {
    expect(shouldIngest("reads", "hub")).toBe(true);
    expect(shouldIngest("pass", "hub")).toBe(true);
    expect(shouldIngest("object", "hub")).toBe(true);
    expect(shouldIngest("fadiga", "hub")).toBe(true);
  });
});
