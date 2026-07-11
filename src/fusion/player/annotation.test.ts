import { describe, expect, it } from "vitest";
import {
  annotationSummary,
  assignTag,
  clearAssignment,
  exportSessionTruth,
  importSessionTruth,
  initialAnnotationState,
} from "./annotation";
import type { SessionTruth } from "../session-loader";

describe("annotation (modo anotação — núcleo puro)", () => {
  it("estado inicial: nenhuma atribuição", () => {
    expect(initialAnnotationState()).toEqual({ assignments: {} });
    expect(exportSessionTruth(initialAnnotationState())).toEqual({});
  });

  it("assignTag() atribui MAC a um track sem mutar o estado anterior", () => {
    const s0 = initialAnnotationState();
    const s1 = assignTag(s0, 7, "aa:bb:cc:dd:ee:ff");
    expect(s1.assignments[7]).toBe("aa:bb:cc:dd:ee:ff");
    expect(s0.assignments).toEqual({}); // imutável
  });

  it("assignTag(null) marca pessoa SEM tag — diferente de não anotar", () => {
    const s = assignTag(initialAnnotationState(), 3, null);
    expect(s.assignments[3]).toBeNull();
    expect(3 in s.assignments).toBe(true);
    expect(exportSessionTruth(s)).toEqual({ 3: null });
  });

  it("reatribuir sobrescreve a atribuição anterior", () => {
    let s = assignTag(initialAnnotationState(), 1, "AA:AA:AA:AA:AA:AA");
    s = assignTag(s, 1, "BB:BB:BB:BB:BB:BB");
    expect(s.assignments[1]).toBe("BB:BB:BB:BB:BB:BB");
    s = assignTag(s, 1, null); // mudou de ideia: era pessoa sem tag
    expect(s.assignments[1]).toBeNull();
  });

  it("clearAssignment() remove a chave (volta a NÃO anotado, não a 'sem tag')", () => {
    let s = assignTag(initialAnnotationState(), 5, "AA:BB:CC:DD:EE:FF");
    s = assignTag(s, 6, null);
    const cleared = clearAssignment(s, 5);
    expect(5 in cleared.assignments).toBe(false);
    expect(cleared.assignments[6]).toBeNull(); // as outras ficam
    expect(s.assignments[5]).toBe("AA:BB:CC:DD:EE:FF"); // imutável
  });

  it("clearAssignment() de track não anotado é no-op (devolve o MESMO estado)", () => {
    const s = assignTag(initialAnnotationState(), 1, "AA:BB:CC:DD:EE:FF");
    expect(clearAssignment(s, 99)).toBe(s);
  });

  it("exportSessionTruth() normaliza MAC a MAIÚSCULO e sem espaços nas pontas", () => {
    let s = assignTag(initialAnnotationState(), 1, " aa:bb:cc:dd:ee:ff ");
    s = assignTag(s, 2, null);
    expect(exportSessionTruth(s)).toEqual({ 1: "AA:BB:CC:DD:EE:FF", 2: null });
  });

  it("importSessionTruth() retoma uma anotação salva, editável em seguida", () => {
    const saved: SessionTruth = { 1: "AA:BB:CC:DD:EE:FF", 2: null };
    let s = importSessionTruth(saved);
    expect(s.assignments).toEqual(saved);
    s = assignTag(s, 3, "CC:CC:CC:CC:CC:CC"); // continua de onde parou
    expect(exportSessionTruth(s)).toEqual({ ...saved, 3: "CC:CC:CC:CC:CC:CC" });
    expect(saved).toEqual({ 1: "AA:BB:CC:DD:EE:FF", 2: null }); // import não compartilha referência
  });

  it("round-trip: export → import → export é idêntico", () => {
    let s = assignTag(initialAnnotationState(), 10, "aa:00:bb:11:cc:22");
    s = assignTag(s, 11, null);
    s = assignTag(s, 12, "DD:EE:FF:00:11:22");
    const first = exportSessionTruth(s);
    const second = exportSessionTruth(importSessionTruth(first));
    expect(second).toEqual(first);
  });

  it("annotationSummary() conta com-tag, sem-tag e total (ausentes não contam)", () => {
    expect(annotationSummary(initialAnnotationState())).toEqual({
      withTag: 0,
      withoutTag: 0,
      total: 0,
    });
    let s = assignTag(initialAnnotationState(), 1, "AA:BB:CC:DD:EE:FF");
    s = assignTag(s, 2, "BB:CC:DD:EE:FF:00");
    s = assignTag(s, 3, null);
    expect(annotationSummary(s)).toEqual({ withTag: 2, withoutTag: 1, total: 3 });
    s = clearAssignment(s, 2);
    expect(annotationSummary(s)).toEqual({ withTag: 1, withoutTag: 1, total: 2 });
  });
});
