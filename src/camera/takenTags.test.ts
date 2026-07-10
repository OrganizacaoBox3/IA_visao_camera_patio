// Testes do helper PURO de ocupação de tags na calibração (src/camera/takenTags.ts).
// Cenário real do painel: 4 âncoras de canto + 1 tag de referência; o TagPicker desabilita as ocupadas.
import { describe, it, expect } from "vitest";
import { takenTags } from "./takenTags";

const M1 = "48:87:2D:9D:CE:89";
const M2 = "48:87:2D:9D:CE:5C";
const M3 = "48:87:2D:9D:CE:5D";
const M4 = "48:87:2D:9D:CE:3C";
const REF = "AA:BB:CC:DD:EE:FF";
const CORNERS = [M1, M2, M3, M4];

describe("takenTags — passo âncoras (canto N)", () => {
  it("âncoras dos OUTROS cantos ocupam, com papel legível 1-based", () => {
    const t = takenTags(CORNERS, null, { step: "ancoras", corner: 0 });
    expect(t.get(M2)).toBe("âncora do canto 2");
    expect(t.get(M3)).toBe("âncora do canto 3");
    expect(t.get(M4)).toBe("âncora do canto 4");
    expect(t.size).toBe(3);
  });

  it("a âncora do PRÓPRIO canto NÃO ocupa (fica habilitada/selecionada, trocável)", () => {
    const t = takenTags(CORNERS, null, { step: "ancoras", corner: 2 });
    expect(t.has(M3)).toBe(false); // canto 3 em edição → sua própria âncora livre
    expect(t.get(M1)).toBe("âncora do canto 1");
  });

  it("a tag de referência ocupa nos cantos", () => {
    const t = takenTags(CORNERS, REF, { step: "ancoras", corner: 0 });
    expect(t.get(REF)).toBe("tag de referência");
  });

  it("cantos sem âncora ('') não entram no mapa", () => {
    const t = takenTags([M1, "", "", ""], null, { step: "ancoras", corner: 1 });
    expect(t.size).toBe(1);
    expect(t.get(M1)).toBe("âncora do canto 1");
  });
});

describe("takenTags — passo referência (vice-versa)", () => {
  it("TODAS as âncoras de canto ocupam; a própria referência não", () => {
    const t = takenTags(CORNERS, REF, { step: "referencia" });
    expect(t.get(M1)).toBe("âncora do canto 1");
    expect(t.get(M2)).toBe("âncora do canto 2");
    expect(t.get(M3)).toBe("âncora do canto 3");
    expect(t.get(M4)).toBe("âncora do canto 4");
    expect(t.has(REF)).toBe(false); // referência é a seleção corrente do passo, não ocupada
    expect(t.size).toBe(4);
  });
});

describe("takenTags — normalização de MAC", () => {
  it("chaves sempre em MAIÚSCULO, mesmo com entrada minúscula (cantos e referência)", () => {
    const t = takenTags([M1.toLowerCase(), "", "", ""], REF.toLowerCase(), {
      step: "ancoras",
      corner: 1,
    });
    expect(t.get(M1)).toBe("âncora do canto 1");
    expect(t.get(REF)).toBe("tag de referência");
    expect(t.has(M1.toLowerCase())).toBe(false); // lookup é pelo MAC MAIÚSCULO
  });
});
