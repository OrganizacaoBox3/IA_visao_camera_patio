// Testes da taxonomia de alarme (server/alarm/classify.js) — foco no tipo NOVO "presenca"
// (violação de zona proibida, spec alerta-por-atividade E1). A chave de dedup do back é
// `cam|zona|tipo`: classificar certo é o que impede atividade e presença na MESMA zona de se
// suprimirem mutuamente (armadilha A3). CommonJS via createRequire, como os demais de server/.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { classify } = require("./classify");

describe("classify — tipo presenca (zona proibida)", () => {
  it("texto pinado do produtor do hub → presenca + crítico", () => {
    const r = classify("⚠ Doca 3: presença em área proibida (Cofre) há 12s");
    expect(r.tipo).toBe("presenca");
    expect(r.critico).toBe(true);
  });

  it("'presença'/'presenca' e 'proibida' classificam como presenca (antes de objetos)", () => {
    expect(classify("presença detectada na área").tipo).toBe("presenca");
    expect(classify("presenca na zona restrita").tipo).toBe("presenca");
    expect(classify("pessoa em área proibida").tipo).toBe("presenca");
  });

  it("regressão: o vocabulário antigo continua no lugar", () => {
    expect(classify("palete no chão").tipo).toBe("objetos");
    expect(classify("objeto presente na doca").tipo).toBe("objetos"); // "presente" ≠ "presença"
    expect(classify("uso de celular").tipo).toBe("fadiga");
    expect(classify("no-read na esteira").tipo).toBe("leitura");
    expect(classify("movimentação normal").tipo).toBe("atividade"); // default
  });
});
