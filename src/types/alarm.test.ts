// Testes do helper PURO de emissão estruturada do alerta (armadilha A3 da spec
// alerta-por-atividade): deriva { cameraId, zona } do TEXTO dos emissores legados resolvendo o
// rótulo contra as câmeras vivas. Conservador por design: sem match exato → {} (o servidor segue
// com o fallback de regex de alarm/keys.js).
import { describe, it, expect } from "vitest";
import { alertMetaFromText } from "./alarm";

const CAMS = [
  { id: "cam-1", label: "Doca 3" },
  { id: "cam-2", label: "Recebimento" },
];

describe("alertMetaFromText — derivação estrutural do texto legado", () => {
  it("padrão inatividade '⚠ <câmera>: msg' → cameraId (sem zona)", () => {
    expect(alertMetaFromText("⚠ Doca 3: Espera sem movimentação há 5m 00s.", CAMS)).toEqual({
      cameraId: "cam-1",
    });
  });

  it("padrão fadiga-por-zona '⚠ <câmera> · <zona>: msg' → cameraId + zona", () => {
    expect(alertMetaFromText("⚠ Doca 3 · Posto A: Fadiga", CAMS)).toEqual({
      cameraId: "cam-1",
      zona: "Posto A",
    });
  });

  it("marcador ✋ (ack de fadiga) também resolve a câmera", () => {
    expect(alertMetaFromText("✋ Recebimento: alerta reconhecido (gesto 👍)", CAMS)).toEqual({
      cameraId: "cam-2",
    });
  });

  it("rótulo sem match EXATO → {} (o servidor mantém o parse dele)", () => {
    expect(alertMetaFromText("⚠ Doca 33: parada", CAMS)).toEqual({});
    expect(alertMetaFromText("⚠ doca 3: parada", CAMS)).toEqual({}); // case-sensitive de propósito
  });

  it("texto sem o separador ': ' → {}", () => {
    expect(alertMetaFromText("mensagem livre sem local", CAMS)).toEqual({});
    expect(alertMetaFromText("", CAMS)).toEqual({});
  });
});
